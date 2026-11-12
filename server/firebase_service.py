"""Native Auth/Firestore implementation of the existing server-authorized domain.

Default initialization is synthetic and emulator-only. The distinct staging
factory injects explicitly guarded SDK dependencies after owner activation.
"""
import hmac
import json
import secrets
import threading
import time
from zoneinfo import ZoneInfo
from contextlib import contextmanager
from datetime import datetime, timedelta
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore
from google.api_core.exceptions import Aborted,ServiceUnavailable,DeadlineExceeded
from core import Service,Problem,require,settings,text,uid,UTC
from identity import session_key
from firebase_config import EmulatorConfig
from firebase_auth import FirebaseIdentity
from firebase_repository import FirestoreRepository
from analytics_cache import AnalyticsCache
from identity_lifecycle import IdentityLifecycle


class NeedsIdentity(Exception): pass


class FirebaseService(IdentityLifecycle,Service):
    cookie_name='__session'
    def __init__(self,guard=None,identity=None,client=None):
        require((guard is None)==(identity is None)==(client is None),'Inject all guarded dependencies together.',500)
        self.guard=guard or EmulatorConfig.from_environment()
        self.guard.assert_current()
        self.identity=identity or FirebaseIdentity(self.guard)
        self.client=client or firestore.Client(project=self.guard.project,credentials=AnonymousCredentials())
        if isinstance(self.guard,EmulatorConfig):
            target=self.client._firestore_api.transport._host
            require(target==self.guard.firestore_host,'Firestore transport is outside the emulator.',503)
        self.local=threading.local()
        # Bound the pinned SDK RPC surface, rather than replacing Transaction's
        # private no-argument _commit implementation. Each wrapper uses this
        # service's thread-local deadline, so concurrent requests stay separate.
        def bounded_rpc(original,cleanup=False):
            def invoke(*args,**kwargs):
                deadline=getattr(self.local,'deadline',None)
                if deadline is not None:
                    remaining=deadline-time.monotonic()
                    if not cleanup:require(remaining>0,'The request deadline was reached. Refresh saved state before retrying.',503)
                    kwargs.update(retry=None,timeout=1 if cleanup else min(15,remaining))
                return original(*args,**kwargs)
            return invoke
        api=self.client._firestore_api
        for name in ('begin_transaction','commit','rollback'):
            setattr(api,name,bounded_rpc(getattr(api,name),name=='rollback'))
        self.analytics_cache=AnalyticsCache()
        self.cache_enabled=True
        self.now=lambda:datetime.now(UTC)
        if getattr(self.guard,'workspace_trial_required',False):
            from workspace_trial import WorkspaceTrial
            self.workspace_trial=WorkspaceTrial(self)

    def run(self,operation):
        self.guard.assert_current()
        deadline=getattr(self.local,'deadline',None)
        require(deadline is None or deadline>time.monotonic(),'The request deadline was reached. Refresh saved state before retrying.',503)
        require(not getattr(self.local,'unit',None),'Nested Firestore transactions are unsupported.',500)
        attempts=[];completed=[]
        @firestore.transactional
        def execute(transaction):
            unit=FirestoreRepository(self.client,transaction,self.guard,getattr(self.local,'deadline',None))
            self.local.unit=unit
            try:
                result=operation(unit)
                unit.flush()
                completed[:]=unit.after_commit
                return result
            finally:
                attempts.append(unit.metrics.copy())
                self.local.metrics={name:sum(r[name] for r in attempts) for name in unit.metrics}
                self.local.metrics['transaction_attempts']=len(attempts)
                self.local.metrics['estimated_document_read_ops']=sum(r['document_reads']+r['query_documents']+r['empty_queries'] for r in attempts)
                self.local.unit=None
        # This pinned SDK retries Aborted during commit, but propagates Aborted
        # from a read in the callback. Restart the complete rolled-back unit for
        # that case as well; never replay only the write portion.
        retry_limit=2 if hasattr(self.guard,'max_tenants') else 4
        for attempt in range(retry_limit):
            try:
                transaction=self.client.transaction(max_attempts=2 if hasattr(self.guard,'max_tenants') else 8)
                result=execute(transaction)
                for callback in completed:
                    try:callback()
                    except Exception:
                        # Cache installation is optional, and must never turn a
                        # successfully committed operation into an HTTP error.
                        self.local.metrics['cache_install_failures']=self.local.metrics.get('cache_install_failures',0)+1
                return result
            except Aborted:
                if attempt==retry_limit-1:raise Problem('Concurrent storage contention. Refresh and retry.',503) from None
                time.sleep((attempt+1)*0.05+secrets.randbelow(50)/1000)
            except (ServiceUnavailable,DeadlineExceeded):
                raise Problem('Local Firestore is unavailable. Refresh to check saved state before retrying.',503) from None
            except ValueError as error:
                # The pinned SDK tries rollback even when BeginTransaction did
                # not obtain an ID. Preserve the original denial/timeout instead
                # of exposing that secondary cleanup error as a validation 422.
                if isinstance(error.__context__,Problem):raise error.__context__ from None
                if isinstance(error.__context__,(ServiceUnavailable,DeadlineExceeded)):
                    raise Problem('Storage request unavailable. Refresh saved state before retrying.',503) from None
                if isinstance(error.__cause__,Aborted):raise Problem('Concurrent storage contention. Refresh and retry.',503) from None
                raise

    @contextmanager
    def connect(self):
        unit=getattr(self.local,'unit',None)
        require(unit is not None,'Firestore operations require a transaction.',500)
        yield unit

    def credentials(self,data):
        email=text(data.get('email'),'Email',254).lower()
        require(self.identity_email_allowed(email),self.identity_email_error)
        password=data.get('password','')
        require(isinstance(password,str) and 12<=len(password)<=128,'Use a password of 12–128 characters.')
        return email,password,text(data.get('name'),'Name')

    def user(self,c,data):
        email,_,name=self.credentials(data)
        prepared=getattr(self.local,'prepared_identity',None)
        if prepared is None:raise NeedsIdentity()
        require(prepared.email==email,'Prepared identity does not match this request.',403)
        profile=dict(id=prepared.uid,email=email,name=name,org=c.org)
        job=c.control_get('provisioning_jobs',email)
        if getattr(self.guard,'safe_member_jobs',False):
            require(job and job.get('uid')==prepared.uid and job.get('state')=='provider_started',
                    'Account provisioning requires reconciliation.',409)
        if getattr(self.guard,'require_mailbox_password_setup',False):
            state=c.security(prepared.uid)
            c.security_put(prepared.uid,state|dict(mailbox_password_setup_required=True))
        c.identity_put(profile)
        if job:c.control_put('provisioning_jobs',email,job|dict(state='committed',completed=time.time()))
        return profile

    def signup(self,data):
        return self.provision_signup(data)

    def counter_check(self,names,record=False,clear=False):
        def check(c):
            now=time.time()
            for name,limit,window in names:
                values=[v for v in c.counter(name)['attempts'] if v>now-window]
                if not record and not clear:require(len(values)<limit,'Too many attempts. Try again later.',429)
                if record:values.append(now)
                if clear:values=[]
                row=dict(attempts=values[-limit:])
                if getattr(self.guard,'per_actor_limits',False):row['expires_at']=datetime.now(UTC)+timedelta(seconds=window+86400)
                c.counter_put(name,row)
        self.run(check)

    def signin(self,data,client='local'):
        email=data.get('email','');password=data.get('password','')
        require(isinstance(email,str) and len(email)<=254 and isinstance(password,str) and len(password)<=128,'Invalid credentials.',401)
        email=email.strip().lower()
        names=[('signin/'+email,8,600),('client/'+client,30,300)]
        self.consume_limits(names)
        try:
            signed=self.identity.rest('signInWithPassword',dict(email=email,password=password,returnSecureToken=True))
            user,claims=self.identity.verify(signed['idToken'])
        except Problem:
            raise
        if not user.email_verified:return self.identity.verification(signed['idToken'],email)
        self.counter_check([names[0]],clear=True)
        def login(c):
            security=c.security(user.uid)
            require(not security['blocked'],'Credential recovery is pending. Contact the operator.',401)
            require(not security.get('mailbox_password_setup_required',False),'Complete password setup from your email before signing in.',403)
            profile=c.identity_get(user.uid)
            if profile is None:
                intent=c.intent_get(user.uid)
                require(intent is not None and intent['email']==user.email,'No organization membership exists for this identity.',403)
                job=c.control_get('provisioning_jobs',user.email)
                if getattr(self.guard,'reserve_on_verified_login',False):
                    expected=('password_ready','password_set_waiting_verification') if getattr(self.guard,'require_mailbox_password_setup',False) else ('reserved',)
                    require(job and job.get('kind')=='signup' and job.get('uid')==user.uid and
                            job.get('state') in expected,'Complete password setup from your email before signing in.',403)
                    capacity=c.control_get('pilot_capacity','global') or dict(reserved=0)
                    require(capacity['reserved']<self.guard.max_tenants,'Workspace capacity is currently full.',409)
                    c.control_put('pilot_capacity','global',dict(reserved=capacity['reserved']+1))
                org=uid();c.org_add(org,intent['organization'],intent['settings'])
                profile=dict(id=user.uid,email=user.email,name=intent['name'],org=org)
                c.identity_put(profile);c.member_add(org,user.uid,'owner',[],[],None)
                c.policy_add(dict(org=org,effective='0001-01-01',revision=0,policy=json.dumps(intent['settings']),actor=user.uid,created=time.time()))
                c.intent_delete(user.uid)
                if job:c.control_put('provisioning_jobs',user.email,job|dict(state='committed',completed=time.time()))
            c.bind_org(profile['org'])
            membership=c.member_get(profile['org'],user.uid)
            require(membership and membership['enabled'],'Sign in to continue.',401)
            token=secrets.token_urlsafe(32);now=time.time()
            require(0<=now-claims['auth_time']<=300,'Sign in again to establish a recent session.',401)
            c.session_add(dict(token=session_key(token),user=user.uid,org=profile['org'],csrf=secrets.token_urlsafe(32),expires=now+43200,id=uid(),created=now,last_seen=now,auth_time=claims['auth_time'],valid_after=user.tokens_valid_after_timestamp,credential_epoch=security['epoch']))
            return token
        return self.run(login)

    def preflight(self,token):
        require(isinstance(token,str) and len(token)<=200,'Sign in to continue.',401)
        row=self.run(lambda c:c.session_get(session_key(token)))
        require(row is not None,'Sign in to continue.',401)
        user=self.identity.user(row['user'])
        require(not user.disabled and user.email_verified and user.tokens_valid_after_timestamp==row['valid_after'],'Sign in to continue.',401)
        return user

    def actor(self,c,token):
        row=c.session_get(session_key(token));now=time.time()
        user=getattr(self.local,'verified_user',None)
        require(row and user and row['user']==user.uid and row['valid_after']==user.tokens_valid_after_timestamp and row['expires']>now and row['last_seen']>now-1800,'Sign in to continue.',401)
        security=c.security(user.uid)
        require(not security['blocked'] and row.get('credential_epoch',0)==security['epoch'],'Sign in to continue.',401)
        c.bind_org(row['org'])
        require(c.org_get(row['org']) is not None,'Organization unavailable.',403)
        profile=c.identity_get(row['user']);membership=c.member_get(row['org'],row['user'])
        require(profile and profile['org']==row['org'] and membership and membership['enabled'],'Sign in to continue.',401)
        if now-row['last_seen']>=60:
            c.stage(c.client.collection('sessions').document(row['token']),row | dict(last_seen=now))
        return dict(id=user.uid,email=profile['email'],name=profile['name'],org=row['org'],role=membership['role'],branches=json.loads(membership['branches']),areas=json.loads(membership['areas']),employee=membership['employee'],csrf=row['csrf'],session_id=row['id'])

    def dispatch(self,token,method,path,data,query,csrf=None):
        user=self.preflight(token)
        preflight_reads=self.local.metrics['estimated_document_read_ops']
        self.local.verified_user=user
        self.local.cacheable_analytics=method=='GET' and path=='/api/analytics'
        try:
            if method=='POST' and path=='/api/password':return self.password_change(token,data,csrf)
            operation=lambda c:super(FirebaseService,self).dispatch(token,method,path,data,query,csrf)
            try:return self.run(operation)
            except NeedsIdentity:
                require(method=='POST' and path=='/api/members','Unexpected identity creation.',500)
                actor=self.run(lambda c:self.actor(c,token))
                def authorize(c):
                    # Run the original authorization, CSRF, target-role and
                    # scope checks against this transaction's current state.
                    try:operation(c)
                    except NeedsIdentity:return
                    raise Problem('Member authorization could not be verified.',403)
                prepared=self.prepare_member(actor,data,authorize)
                self.local.prepared_identity=prepared
                try:
                    return self.run(operation)
                except Exception:
                    if getattr(self.guard,'safe_member_jobs',False):
                        from member_provisioning import mark_for_review
                        mark_for_review(self,data.get('email','').strip().lower(),prepared.uid)
                    raise
                finally:self.local.prepared_identity=None
        finally:
            self.local.verified_user=None
            self.local.cacheable_analytics=False
            self.local.metrics['preflight_read_ops']=preflight_reads
            self.local.metrics['estimated_document_read_ops']+=preflight_reads

    def analytics(self,c,a,week,branch=None,override=None):
        if not self.cache_enabled or not getattr(self.local,'cacheable_analytics',False) or override is not None:
            return super().analytics(c,a,week,branch,override)
        require(a['role']!='employee','Manager analytics are outside your role.',403)
        allowed=self.scope(c,a,branch)
        selected=tuple(sorted({branch} if branch else allowed))
        org=c.org_get(a['org'])
        calendar_day=str(self.now().astimezone(ZoneInfo(json.loads(org['settings'])['timezone'])).date())
        slot=(a['org'],a['id'],a['role'],selected,week)
        fingerprint=(org['policy_revision'],org['hierarchy_revision'],calendar_day,c.analytics_revisions(a['org']))
        cached=self.analytics_cache.get(slot,fingerprint)
        if cached:
            value,computed_at=cached;status='version-validated reuse'
        else:
            value=super().analytics(c,a,week,branch,override)
            computed_at=self.now().isoformat();status='computed from transactional inputs'
            saved=__import__('copy').deepcopy(value)
            c.after_commit.append(lambda:self.analytics_cache.put(slot,fingerprint,saved,computed_at))
        self.local.analytics_cache_status=status
        return value | dict(freshness=dict(cache=status,computed_at=computed_at,validated_at=self.now().isoformat(),max_cache_age_seconds=self.analytics_cache.MAX_AGE_SECONDS,input_scope='requested schedules and complete employee rest/day/week constraint windows',requires_domain_writers=True))

    def password_change(self,token,data,csrf):
        def authorized(c):
            actor=self.actor(c,token)
            require(isinstance(csrf,str) and hmac.compare_digest(csrf,actor['csrf']),'Refresh your session before making changes.',403)
            return actor
        actor=self.run(authorized)
        name=[('password/'+actor['id'],8,600)]
        self.consume_limits(name)
        current=data.get('current_password','');password=data.get('password','')
        require(isinstance(current,str) and len(current)<=128,'Current password is incorrect.',401)
        require(isinstance(password,str) and 12<=len(password)<=128 and password!=current,'Use a different password of 12–128 characters.')
        try:
            signed=self.identity.rest('signInWithPassword',dict(email=actor['email'],password=current,returnSecureToken=True))
            proven,claims=self.identity.verify(signed['idToken'])
            require(proven.uid==actor['id'] and 0<=time.time()-claims['auth_time']<=300,'Current password is incorrect.',401)
        except Problem:
            raise Problem('Current password is incorrect.',401) from None
        operation=secrets.token_hex(24)
        epoch=self.begin_transition(actor['id'],operation,'password-change')
        self.identity.change_password(actor['id'],password)
        def cleanup(c):
            c.bind_org(actor['org']);c.session_delete_user(actor['id']);self.audit(c,actor,'password.change',actor['id'])
        self.run(cleanup)
        self.finish_transition(actor['id'],operation,epoch)
        self.counter_check(name,clear=True)
        return dict(changed=True,signed_out=True)

    def put(self,c,org,kind,data):
        limit=getattr(self.guard,'max_staff',None) if kind=='employee' else getattr(self.guard,'max_branches',None) if kind=='branch' else None
        if limit is not None:
            old=c.entity_get(org,kind,data['id'])
            if kind=='employee' and getattr(self.guard,'count_active_staff',False):
                increases=bool(data.get('active',True)) and (old is None or not old.get('active',True))
                if increases:
                    require(sum(bool(row.get('active',True)) for row in c.entity_rows(org,kind))<limit,
                            f'Your plan supports up to {limit} active staff. Deactivate an existing staff member before adding or reactivating another.',409)
                    c._org_fence(org,'pilot_capacity_revision')
            elif old is None:
                require(len(c.entity_rows(org,kind))<limit,'The branch or staff capacity has been reached.',409)
                c._org_fence(org,'pilot_capacity_revision')
        return super().put(c,org,kind,data)
