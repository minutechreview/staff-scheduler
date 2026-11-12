"""Disabled production billing orchestration over a transactional unit of work.

No factory loads this module or constructs a provider from environment. The
provider call is outside retryable transactions. Binding paid subscriptions
requires a separately supplied authoritative verifier and remains unavailable.
"""
import hashlib
import hmac
import json
import re
import secrets
from datetime import timedelta
from core import Problem, require
from lemon_provider import ProviderError
from lemon_billing import EVENTS, STATUSES, parse_time


class BillingCoordinator:
    def __init__(self, service, provider, plans, webhook_secret=None, binding_verifier=None):
        self.service,self.provider,self.plans=service,provider,plans
        self.webhook_secret=webhook_secret
        self.binding_verifier=binding_verifier

    def webhook(self,raw,signature):
        require(isinstance(self.webhook_secret,bytes) and bool(self.webhook_secret), 'Billing webhook is disabled.',503)
        require(isinstance(raw,bytes) and len(raw)<=262144 and isinstance(signature,str) and
                re.fullmatch(r'[0-9a-f]{64}',signature) is not None,'Invalid webhook.',400)
        require(hmac.compare_digest(hmac.new(self.webhook_secret,raw,hashlib.sha256).hexdigest(),signature),
                'Invalid webhook signature.',401)
        try:
            payload=json.loads(raw);meta=payload['meta'];data=payload['data'];a=data['attributes']
            ref=meta['custom_data']['relay_ref'];sub=str(data['id']);variant=str(a['variant_id']);status=a['status']
            updated=parse_time(a['updated_at']);ends=a.get('ends_at')
            if ends is not None:parse_time(ends)
            if (meta['event_name'] not in EVENTS or data['type']!='subscriptions' or status not in STATUSES or
                str(a['store_id'])!=self.provider.store_id or a['test_mode'] is not self.provider.test_mode or
                not isinstance(ref,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',ref) or not sub.isdigit()):raise ValueError()
        except (KeyError,TypeError,ValueError):raise Problem('Invalid webhook payload.',400) from None
        digest=hashlib.sha256(raw).hexdigest()
        def apply(c):
            if c.control_get('billing_events',digest):return {'result':'duplicate'}
            binding=c.control_get('billing_refs',ref)
            require(binding and binding.get('state') in ('reserved','created','bound') and binding.get('subscription',sub)==sub,
                    'Checkout requires review.',409)
            org=binding['org'];owner=c.control_get('billing_subscriptions',sub)
            require(not owner or owner['org']==org,'Subscription requires review.',409)
            previous=c.control_get('billing_orgs',org) or {}
            if previous and previous.get('subscription')!=sub:
                old=c.control_get('billing_history',sub)
                if old:
                    # Events for an archived subscription must never replace
                    # its successor, even if delivered much later.
                    old_time=parse_time(old['updated_at'])
                    if updated>old_time:
                        c.control_put('billing_history',sub,old|{'provider_status':status,'updated_at':a['updated_at'],'ends_at':ends,'variant':variant})
                    contradictory=(updated>old_time and status!='expired') or (updated==old_time and
                        (old.get('provider_status',old.get('status'))!=status or old.get('variant')!=variant or old.get('ends_at')!=ends))
                    if contradictory:
                        conflict={'old_subscription':sub,'old_ref':ref,'new_subscription':previous['subscription'],'new_ref':previous['checkout_ref']}
                        c.control_put('billing_conflicts',org,conflict)
                        new_binding=c.control_get('billing_refs',previous['checkout_ref'])
                        if new_binding:c.control_put('billing_refs',previous['checkout_ref'],new_binding|{'verified':False})
                        c.control_put('billing_orgs',org,previous|{'status':'reconciliation_required'})
                    c.control_put('billing_events',digest,{'result':'old_subscription'})
                    return {'result':'old_subscription'}
                require(binding.get('replaces')==previous.get('subscription'),'Subscription requires review.',409)
                if previous.get('status')!='expired':
                    c.control_put('billing_conflicts',org,{'old_subscription':previous['subscription'],
                        'old_ref':previous['checkout_ref'],'new_subscription':sub,'new_ref':ref})
                c.control_put('billing_history',previous['subscription'],previous)
                previous={}
            if previous:
                old=parse_time(previous['updated_at'])
                if updated<old:
                    c.control_put('billing_events',digest,{'result':'stale'});return {'result':'stale'}
                if updated==old:
                    require(previous.get('provider_status')==status and previous.get('variant')==variant and previous.get('ends_at')==ends,
                            'Subscription requires reconciliation.',409)
                    c.control_put('billing_events',digest,{'result':'duplicate_snapshot'});return {'result':'duplicate_snapshot'}
            known=variant in {str(p['variant_id']) for p in self.plans}
            verified=bool(binding.get('verified')) and known and not c.control_get('billing_conflicts',org)
            c.control_put('billing_refs',ref,binding|{'state':'bound','subscription':sub,'verified':verified})
            c.control_put('billing_subscriptions',sub,{'org':org})
            c.control_put('billing_orgs',org,{'subscription':sub,'checkout_ref':ref,'variant':variant,'provider_status':status,
                'status':status if verified else 'reconciliation_required','ends_at':ends,'updated_at':a['updated_at'],
                'checked_at':self.service.now().isoformat()})
            c.control_put('billing_events',digest,{'result':'applied'})
            return {'result':'applied'}
        return self.service.run(apply)

    def _with_user(self, token, operation):
        user=self.service.preflight(token)
        self.service.local.verified_user=user
        try:return self.service.run(operation)
        finally:self.service.local.verified_user=None

    def _owner(self,c,token,csrf):
        actor=self.service.actor(c,token)
        require(actor['role']=='owner','Only the organization owner can manage billing.',403)
        require(hmac.compare_digest(csrf or '',actor['csrf']),'Refresh your session before making changes.',403)
        return actor

    def access(self,c,actor):
        row=c.control_get('billing_orgs',actor['org']) or {}
        if not row.get('checked_at') or self.service.now()>=parse_time(row['checked_at'])+timedelta(hours=24):return False
        if row.get('status') in ('active','on_trial'):return True
        return row.get('status')=='cancelled' and bool(row.get('ends_at')) and self.service.now()<parse_time(row['ends_at'])

    def check(self,c,actor):
        require(self.access(c,actor),'An active subscription is required. Ask your owner to review billing.',402)

    def status(self,token):
        def read(c):
            actor=self.service.actor(c,token);org=actor['org']
            row=c.control_get('billing_orgs',org) or {};pending=c.control_get('billing_pending',org);conflict=c.control_get('billing_conflicts',org)
            replaceable=row.get('status')=='expired' and callable(self.binding_verifier)
            return {'status':row.get('status','none'), 'checkout_available':actor['role']=='owner' and bool(self.plans) and (not row or replaceable) and not pending and not conflict,
                    'portal_available':actor['role']=='owner' and bool(row.get('subscription')),
                    'plans':[{k:p[k] for k in ('id','name','amount_minor','currency','interval')} for p in self.plans]}
        return self._with_user(token,read)

    def checkout(self,token,csrf,plan_id):
        matches=[p for p in self.plans if p.get('id')==plan_id]
        require(len(matches)==1 and str(matches[0].get('variant_id','')).isdigit(),'Plan unavailable.',422)
        variant=str(matches[0]['variant_id']);ref=secrets.token_urlsafe(32)
        expires=(self.service.now()+timedelta(minutes=30)).isoformat()
        def inspect(c):
            actor=self._owner(c,token,csrf);org=actor['org'];row=c.control_get('billing_orgs',org)
            binding=c.control_get('billing_refs',row['checkout_ref']) if row and row.get('checkout_ref') else None
            return org,row,binding
        inspected_org,old,old_binding=self._with_user(token,inspect)
        if old:
            require(old.get('status')=='expired' and old_binding and old_binding.get('verified') and
                    callable(self.binding_verifier),'Existing subscription requires reconciliation.',409)
            try:snapshot=self.provider.subscription(old['subscription'],deadline=getattr(self.service.local,'deadline',None))
            except ProviderError:raise Problem('Provider status unavailable.',503) from None
            require(snapshot.get('status')=='expired' and snapshot.get('ends_at') and
                    self.service.now()>=parse_time(snapshot['ends_at']) and
                    parse_time(snapshot.get('updated_at'))>=parse_time(old['updated_at']) and
                    self.binding_verifier(inspected_org,old,old_binding,snapshot) is True,
                    'Existing subscription requires reconciliation.',409)
        def reserve(c):
            actor=self._owner(c,token,csrf);org=actor['org']
            require(org==inspected_org and c.control_get('billing_orgs',org)==old,'Billing state changed. Refresh and retry.',409)
            if old:
                require(c.control_get('billing_refs',old['checkout_ref'])==old_binding,'Billing state changed. Refresh and retry.',409)
            require(not c.control_get('billing_conflicts',org),'Billing conflict requires reconciliation.',409)
            require(not c.control_get('billing_pending',org),'Existing checkout requires reconciliation.',409)
            c.control_put('billing_pending',org,{'ref':ref,'state':'reserved'})
            c.control_put('billing_refs',ref,{'org':org,'variant':variant,'expires':expires,'state':'reserved',
                                             'replaces':old['subscription'] if old else None})
            return org
        org=self._with_user(token,reserve)
        try:response=self.provider.create_checkout(variant,ref,expires,deadline=getattr(self.service.local,'deadline',None))
        except ProviderError:
            # The reservation remains, even for apparent failures. Never
            # duplicate an uncertain provider operation automatically.
            raise Problem('Checkout could not be confirmed. Contact support before retrying.',503) from None
        def consistent(c,binding):
            current=c.control_get('billing_orgs',org)
            if c.control_get('billing_conflicts',org):return False
            old_unchanged=not old or c.control_get('billing_refs',old['checkout_ref'])==old_binding
            if current==old:return old_unchanged
            # A signed webhook may arrive before checkout finalization. Its
            # new binding remains quarantined until separately verified.
            return bool(binding.get('state')=='bound' and current and current.get('checkout_ref')==ref and
                        old_unchanged and (not old or c.control_get('billing_history',old['subscription'])==old))
        def finalize(c):
            pending=c.control_get('billing_pending',org);binding=c.control_get('billing_refs',ref)
            require(pending and pending.get('ref')==ref and binding and binding.get('org')==org and
                    binding.get('state') in ('reserved','bound') and
                    binding.get('checkout_id',response['id'])==response['id'],'Checkout requires reconciliation.',409)
            unchanged=consistent(c,binding)
            c.control_put('billing_refs',ref,binding|{'state':'bound' if binding['state']=='bound' else 'created',
                'checkout_id':response['id'],'quarantined':not unchanged or binding.get('quarantined',False)})
            c.control_put('billing_pending',org,pending|{'state':'created'})
            return unchanged,binding['state']=='bound'
        unchanged,already_bound=self.service.run(finalize)
        require(unchanged,'Billing changed. Checkout requires reconciliation.',409)
        require(not already_bound,'Payment confirmation is pending. Check billing status before retrying.',409)
        def authorize(c):
            actor=self._owner(c,token,csrf);binding=c.control_get('billing_refs',ref)
            require(actor['org']==org and binding and consistent(c,binding) and
                    binding.get('checkout_id')==response['id'] and not binding.get('quarantined'),
                    'Checkout requires reconciliation.',409)
        self._with_user(token,authorize)
        return {'url':response['url']}

    def portal(self,token,csrf):
        def select(c):
            actor=self._owner(c,token,csrf);row=c.control_get('billing_orgs',actor['org']) or {}
            require(bool(row.get('subscription')),'No subscription found.',404)
            return actor['org'],row['subscription']
        org,sub=self._with_user(token,select)
        try:url=self.provider.portal(sub,deadline=getattr(self.service.local,'deadline',None))
        except ProviderError:raise Problem('Billing portal is temporarily unavailable.',503) from None
        def recheck(c):
            actor=self._owner(c,token,csrf);row=c.control_get('billing_orgs',org) or {}
            require(actor['org']==org and row.get('subscription')==sub,'Billing status changed. Retry.',409)
        self._with_user(token,recheck)
        return {'url':url}

    def reconcile_organization(self,org,verifier):
        """Read provider outside transactions, then recheck exact saved state."""
        require(callable(verifier),'Provider binding verification is unavailable.',503)
        def read(c):
            row=c.control_get('billing_orgs',org)
            return row,c.control_get('billing_refs',row['checkout_ref']) if row and row.get('checkout_ref') else None,c.control_get('billing_conflicts',org)
        before,before_binding,conflict=self.service.run(read)
        require(not conflict,'Both subscriptions require reconciliation.',409)
        require(before and before.get('subscription'),'No subscription to reconcile.',404)
        require(before_binding and before_binding.get('checkout_id') and before_binding.get('org')==org and before_binding.get('subscription')==before['subscription'],
                'Checkout binding requires review.',409)
        try:snapshot=self.provider.subscription(before['subscription'],deadline=getattr(self.service.local,'deadline',None))
        except ProviderError:raise Problem('Provider status unavailable.',503) from None
        # The verifier must independently establish checkout/order ownership;
        # custom checkout data alone is not an authoritative tenant binding.
        require(verifier(org,before,before_binding,snapshot) is True,'Subscription binding requires review.',409)
        status=snapshot.get('status');variant=str(snapshot.get('variant_id',''))
        require(status in STATUSES and variant in {str(p['variant_id']) for p in self.plans},'Subscription requires review.',409)
        updated=parse_time(snapshot.get('updated_at'));ends=snapshot.get('ends_at')
        if ends is not None:parse_time(ends)
        def apply(c):
            current=c.control_get('billing_orgs',org)
            require(current==before,'Billing state changed. Reconcile again.',409)
            require(not c.control_get('billing_conflicts',org),'Both subscriptions require reconciliation.',409)
            require(updated>=parse_time(current['updated_at']),'Provider status is older than stored state.',409)
            binding=c.control_get('billing_refs',current['checkout_ref'])
            require(binding==before_binding,
                    'Checkout binding changed. Reconcile again.',409)
            pending=c.control_get('billing_pending',org)
            if pending and pending.get('ref')==current['checkout_ref']:
                c.control_put('billing_pending',org,None)
            c.control_put('billing_refs',current['checkout_ref'],binding|{'verified':True})
            c.control_put('billing_orgs',org,current|{'status':status,'provider_status':status,'variant':variant,'ends_at':ends,
                'updated_at':snapshot['updated_at'],'checked_at':self.service.now().isoformat()})
        self.service.run(apply)
        return {'status':status}

    def reconcile_pending(self,org,verifier):
        """Clear only a proven expired, nonpayable and unpaid checkout."""
        require(callable(verifier),'Checkout outcome verification is unavailable.',503)
        def read(c):
            pending=c.control_get('billing_pending',org)
            return pending,c.control_get('billing_refs',pending['ref']) if pending else None
        pending,binding=self.service.run(read)
        require(pending and binding and binding.get('checkout_id') and not binding.get('subscription'),
                'Checkout outcome requires review.',409)
        try:snapshot=self.provider.checkout(binding['checkout_id'],deadline=getattr(self.service.local,'deadline',None))
        except ProviderError:raise Problem('Provider status unavailable.',503) from None
        require(snapshot.get('expires_at') and self.service.now()>=parse_time(snapshot['expires_at']) and
                verifier(org,binding,snapshot) is True,'Checkout outcome requires review.',409)
        def close(c):
            require(c.control_get('billing_pending',org)==pending and c.control_get('billing_refs',pending['ref'])==binding,
                    'Checkout changed. Reconcile again.',409)
            c.control_put('billing_refs',pending['ref'],binding|{'state':'closed'})
            c.control_put('billing_pending',org,None)
        self.service.run(close)
        return {'status':'closed'}

    def reconcile_replacement_conflict(self,org,verifier):
        """Resolve both subscriptions only with independent provider evidence."""
        require(callable(verifier),'Conflict verification is unavailable.',503)
        def read(c):
            conflict=c.control_get('billing_conflicts',org)
            if not conflict:return (None,)*5
            return (conflict,c.control_get('billing_orgs',org),c.control_get('billing_history',conflict['old_subscription']),
                    c.control_get('billing_refs',conflict['old_ref']),c.control_get('billing_refs',conflict['new_ref']))
        before=self.service.run(read);conflict,current,old,old_binding,new_binding=before
        require(conflict and current and old and old_binding and new_binding and
                current.get('subscription')==conflict['new_subscription'] and
                old_binding.get('org')==org and new_binding.get('org')==org and
                old_binding.get('subscription')==conflict['old_subscription'] and
                new_binding.get('subscription')==conflict['new_subscription'] and
                old_binding.get('checkout_id') and new_binding.get('checkout_id'),
                'Subscription conflict requires review.',409)
        try:
            old_snapshot=self.provider.subscription(conflict['old_subscription'],deadline=getattr(self.service.local,'deadline',None))
            new_snapshot=self.provider.subscription(conflict['new_subscription'],deadline=getattr(self.service.local,'deadline',None))
        except ProviderError:raise Problem('Provider status unavailable.',503) from None
        new_variant=str(new_snapshot.get('variant_id',''));new_status=new_snapshot.get('status')
        require(old_snapshot.get('status')=='expired' and old_snapshot.get('ends_at') and
                self.service.now()>=parse_time(old_snapshot['ends_at']) and
                parse_time(old_snapshot.get('updated_at'))>=parse_time(old['updated_at']) and
                new_status in STATUSES and new_variant in {str(p['variant_id']) for p in self.plans} and
                parse_time(new_snapshot.get('updated_at'))>=parse_time(current['updated_at']) and
                verifier(org,before,old_snapshot,new_snapshot) is True,
                'Subscription conflict requires review.',409)
        if new_snapshot.get('ends_at') is not None:parse_time(new_snapshot['ends_at'])
        def apply(c):
            require(read(c)==before,'Billing state changed. Reconcile again.',409)
            pending=c.control_get('billing_pending',org)
            if pending and pending.get('ref')==conflict['new_ref']:c.control_put('billing_pending',org,None)
            c.control_put('billing_refs',conflict['new_ref'],new_binding|{'verified':True})
            c.control_put('billing_history',conflict['old_subscription'],old|{'provider_status':'expired',
                'updated_at':old_snapshot['updated_at'],'ends_at':old_snapshot['ends_at']})
            c.control_put('billing_orgs',org,current|{'status':new_status,'provider_status':new_status,'variant':new_variant,
                'updated_at':new_snapshot['updated_at'],'ends_at':new_snapshot.get('ends_at'),'checked_at':self.service.now().isoformat()})
            c.control_put('billing_conflicts',org,None)
        self.service.run(apply)
        return {'status':new_status}


def scheduled_reconcile(coordinator, items, verifier=None):
    """Bounded entrypoint, disabled until a verified provider binding exists."""
    if verifier is None:raise Problem('Scheduled billing reconciliation is disabled.',503)
    if not isinstance(items,list) or len(items)>100:raise Problem('Invalid reconciliation batch.',400)
    return [coordinator.reconcile_organization(item,verifier) for item in items]
