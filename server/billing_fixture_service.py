"""Emulator-only application wiring; no transport or configuration for live use."""
import hashlib
import hmac
import json
import re
import secrets
from datetime import timedelta
from core import Problem, require
from lemon_billing import EVENTS, STATUSES, parse_time


class SyntheticTransport:
    """A deterministic test double; no network methods or provider credentials."""
    def checkout(self, ref, variant):
        return 'https://fixture.lemonsqueezy.com/checkout/custom/' + ref
    def portal(self, sub):
        return 'https://fixture.lemonsqueezy.com/subscription/' + sub + '/fixture'
    def __init__(self): self.snapshots = {}; self.checkout_outcomes = {}
    def snapshot(self, sub): return self.snapshots.get(sub)
    def checkout_outcome(self, ref): return self.checkout_outcomes.get(ref)


class SyntheticBilling:
    def __init__(self, service, secret, plans, store_id='42'):
        # Fail closed even if someone tries to wire this to a live service.
        require(service.guard.project.startswith('demo-') and
                getattr(service.guard, 'firestore_host', '').startswith('127.0.0.1:'),
                'Synthetic billing requires a loopback emulator.', 503)
        require(isinstance(secret, bytes) and bool(secret), 'Fixture secret required.', 503)
        self.service, self.secret, self.plans, self.store_id = service, secret, plans, str(store_id)
        self.transport = SyntheticTransport()

    def status(self, c, actor):
        row = c.control_get('billing_orgs', actor['org']) or {}
        pending = c.control_get('billing_pending', actor['org'])
        return {'status': row.get('status', 'none'), 'ends_at': row.get('ends_at'),
                'entitled': self.entitled(row), 'checkout_available':actor['role']=='owner' and bool(self.plans) and not row and not pending,
                'portal_available':actor['role']=='owner' and bool(row.get('subscription')), 'plans': [
                    {k:p[k] for k in ('id','name','amount_minor','currency','interval')} for p in self.plans]}

    def entitled(self, row):
        if not row.get('checked_at') or self.service.now() >= parse_time(row['checked_at']) + timedelta(hours=24): return False
        status = row.get('status')
        if status in ('active', 'on_trial'): return True
        return status == 'cancelled' and bool(row.get('ends_at')) and self.service.now() < parse_time(row['ends_at'])

    def check(self, c, actor):
        require(self.access(c,actor),
                'An active subscription is required. Ask your owner to review billing.', 402)

    def access(self,c,actor):return self.entitled(c.control_get('billing_orgs',actor['org']) or {})

    def checkout(self, c, actor, data):
        require(actor['role'] == 'owner', 'Only the organization owner can manage billing.', 403)
        choices = [p for p in self.plans if p['id'] == data.get('plan')]
        require(len(choices)==1, 'Plan is unavailable.', 422)
        existing = c.control_get('billing_orgs', actor['org']) or {}
        pending=c.control_get('billing_pending', actor['org'])
        require(not pending, 'An existing checkout must be reconciled before starting another.',409)
        if existing:
            require(existing.get('checked_at') and self.service.now()<parse_time(existing['checked_at'])+timedelta(hours=24),
                    'Refresh billing status before starting another checkout.',409)
        ended_cancel = existing.get('status')=='cancelled' and existing.get('ends_at') and self.service.now()>=parse_time(existing['ends_at'])
        require(not existing or ended_cancel or existing.get('status') in ('expired','unpaid'),
                'Manage the existing subscription before starting another checkout.', 409)
        ref = secrets.token_urlsafe(32)
        c.control_put('billing_refs', ref, {'org':actor['org'], 'variant':str(choices[0]['variant_id']),
                                          'expires':(self.service.now()+timedelta(hours=1)).isoformat()})
        c.control_put('billing_pending',actor['org'],{'ref':ref})
        return {'url': self.transport.checkout(ref, choices[0]['variant_id'])}

    def portal(self, c, actor):
        require(actor['role'] == 'owner', 'Only the organization owner can manage billing.', 403)
        row = c.control_get('billing_orgs', actor['org']) or {}
        require(bool(row.get('subscription')), 'No subscription found.', 404)
        return {'url': self.transport.portal(row['subscription'])}

    def reconcile_checkout(self, c, actor):
        require(actor['role']=='owner','Only the organization owner can manage billing.',403)
        pending=c.control_get('billing_pending',actor['org']) or {}
        ref=pending.get('ref');require(bool(ref),'No pending checkout found.',404)
        binding=c.control_get('billing_refs',ref) or {}
        outcome=self.transport.checkout_outcome(ref)
        require(binding.get('org')==actor['org'] and not binding.get('subscription') and
                outcome == 'confirmed_expired_unpayable_unpaid',
                'Checkout outcome is uncertain. Contact support before retrying.',409)
        c.control_put('billing_refs',ref,binding|{'closed':True})
        c.control_put('billing_pending',actor['org'],None)
        return {'status':'closed'}

    def reconcile(self, c, actor):
        require(actor['role']=='owner','Only the organization owner can manage billing.',403)
        row=c.control_get('billing_orgs',actor['org']) or {}
        require(bool(row.get('subscription')),'No subscription found.',404)
        snapshot=self.transport.snapshot(row['subscription'])
        require(snapshot and snapshot.get('subscription')==row['subscription'] and
                snapshot.get('status') in STATUSES and snapshot.get('variant') in {str(p['variant_id']) for p in self.plans},
                'Provider reconciliation is unavailable.',503)
        updated=parse_time(snapshot['updated_at']);old=parse_time(row['updated_at'])
        require(updated>=old,'Provider state is older than saved state.',409)
        if snapshot.get('ends_at'):parse_time(snapshot['ends_at'])
        binding=c.control_get('billing_refs',row['checkout_ref']) or {}
        # Fixture snapshot must explicitly establish the original reference;
        # a real adapter must also independently verify checkout/order, store,
        # mode, customer and purchase time before clearing quarantine.
        require(snapshot.get('checkout_ref')==row['checkout_ref'] and binding.get('org')==actor['org'] and
                binding.get('subscription')==row['subscription'], 'Checkout reconciliation is incomplete.',409)
        c.control_put('billing_refs',row['checkout_ref'],binding|{'quarantined':False})
        c.control_put('billing_orgs',actor['org'],row|snapshot|{'provider_status':snapshot['status'],'checked_at':self.service.now().isoformat()})
        return {'status':snapshot['status']}

    def webhook(self, raw, signature):
        require(isinstance(raw,bytes) and len(raw)<=262144 and
                isinstance(signature,str) and re.fullmatch(r'[0-9a-f]{64}',signature) is not None,
                'Invalid webhook.', 400)
        require(hmac.compare_digest(hmac.new(self.secret,raw,hashlib.sha256).hexdigest(),signature),
                'Invalid webhook signature.', 401)
        try:
            payload=json.loads(raw); meta=payload['meta']; data=payload['data']; a=data['attributes']
            ref=meta['custom_data']['relay_ref']; sub=str(data['id']); variant=str(a['variant_id'])
            updated=parse_time(a['updated_at']); ends=a.get('ends_at')
            if ends is not None:parse_time(ends)
            if (meta['event_name'] not in EVENTS or data['type']!='subscriptions' or
                a['status'] not in STATUSES or str(a['store_id'])!=self.store_id or a['test_mode'] is not True or
                not isinstance(ref,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',ref) or not sub.isdigit()):
                raise ValueError()
        except (KeyError,TypeError,ValueError):raise Problem('Invalid webhook payload.',400) from None
        digest=hashlib.sha256(raw).hexdigest()
        def apply(c):
            if c.control_get('billing_events',digest):return {'result':'duplicate'}
            binding=c.control_get('billing_refs',ref)
            require(binding and not binding.get('closed') and binding.get('subscription',sub)==sub,'Checkout binding mismatch.',403)
            org=binding['org']; previous=c.control_get('billing_orgs',org) or {}
            sub_owner=c.control_get('billing_subscriptions',sub)
            require(not sub_owner or sub_owner['org']==org,'Subscription binding mismatch.',403)
            late=False
            if not binding.get('subscription'):
                require(binding['variant']==variant, 'Checkout is mismatched; reconcile.',409)
                late=self.service.now()>=parse_time(binding['expires'])
            if previous:
                if previous['subscription']!=sub:
                    ended=previous['status']=='cancelled' and previous.get('ends_at') and self.service.now()>=parse_time(previous['ends_at'])
                    require(not binding.get('subscription') and (previous['status'] in ('expired','unpaid') or ended),
                            'Subscription requires reconciliation.',409)
                    previous={}
            if previous:
                previous_time=parse_time(previous['updated_at'])
                if updated==previous_time:
                    require(previous.get('provider_status',previous['status'])==a['status'] and previous['variant']==variant and previous.get('ends_at')==ends,
                            'Conflicting provider state requires reconciliation.',409)
                    c.control_put('billing_events',digest,{'result':'duplicate_snapshot'});return {'result':'duplicate_snapshot'}
                if updated<previous_time:
                    c.control_put('billing_events',digest,{'result':'stale'});return {'result':'stale'}
            # Unknown variants must immediately deny access pending reconciliation.
            known=variant in {str(p['variant_id']) for p in self.plans}
            quarantined=late or not known or bool(binding.get('quarantined'))
            c.control_put('billing_refs',ref,binding|{'subscription':sub,'quarantined':quarantined})
            c.control_put('billing_subscriptions',sub,{'org':org})
            pending=c.control_get('billing_pending',org)
            if pending and pending.get('ref')==ref:c.control_put('billing_pending',org,None)
            c.control_put('billing_orgs',org,{'subscription':sub,'checkout_ref':ref,'variant':variant,'provider_status':a['status'],'status':a['status'] if known and not quarantined else 'reconciliation_required',
                'ends_at':ends,'updated_at':a['updated_at'],'checked_at':self.service.now().isoformat()})
            c.control_put('billing_events',digest,{'result':'applied'})
            return {'result':'applied'}
        return self.service.run(apply)
