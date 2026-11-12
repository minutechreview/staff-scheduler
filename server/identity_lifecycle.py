"""Durable provider/Firestore boundaries. No passwords, links or OOB codes stored."""
import hashlib
import hmac
import json
import secrets
import time
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from core import Problem, require, settings, text, uid
from acceptance_invite import claim as claim_invite


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def recovery_available(service):
    return (callable(getattr(service, 'request_recovery', None)) and
            getattr(getattr(service, 'guard', None), 'delivery', True) is True)


def email_actions_available(service):
    # Delivery controls new messages. Valid previously issued links can still
    # complete; global application/pilot admission remains enforced separately.
    return (callable(getattr(service, 'check_email_action', None)) and
            callable(getattr(service, 'complete_email_action', None)))


def action_fields(data):
    mode, code = data.get('mode'), data.get('code')
    require(mode in ('verifyEmail', 'resetPassword'), 'This email action is unsupported.', 422)
    require(isinstance(code, str) and 1 <= len(code) <= 1024 and
            all(33 <= ord(char) <= 126 for char in code),
            'This link is invalid, expired or already used.', 401)
    return mode, code


class IdentityLifecycle:
    identity_email_error = 'This pilot uses synthetic .test identities only.'
    def identity_email_allowed(self, email):
        return isinstance(email, str) and '@' in email and email.endswith('.test')

    @contextmanager
    def request_context(self):
        self.local.deadline = time.monotonic() + 45
        try:
            yield
        finally:
            self.local.deadline = None

    def consume_limits(self, names):
        """Reserve attempts atomically before work, including successful attempts."""
        def consume(c):
            now = time.time()
            for name, limit, window in names:
                values = [v for v in c.counter(name)['attempts'] if v > now - window]
                require(len(values) < limit, 'Too many attempts. Try again later.', 429)
                row=dict(attempts=values + [now])
                if getattr(self.guard,'per_actor_limits',False):
                    row['expires_at']=datetime.now(timezone.utc)+timedelta(seconds=window+86400)
                c.counter_put(name,row)
        self.run(consume)

    def admit_request(self, path, token):
        def enabled(c):
            control = c.control_get('pilot_controls', 'global') or {}
            require(control.get('enabled', False), 'Staging is paused pending approved pilot configuration.', 503)
        self.run(enabled)
        limits = [('api/global', 180, 60)]
        if token:
            limits.append(('api/session/' + digest(token), 90, 60))
        self.consume_limits(limits)

    def provision_signup(self, data):
        email, password, name = self.credentials(data)
        if hasattr(self.guard, 'delivery'):
            require(self.guard.delivery, 'Signup delivery is disabled pending owner approval.', 503)
        limits = [('signup/' + email, 3, 3600)]
        if hasattr(self.guard, 'max_tenants'):
            limits.append(('signup/global', 10, 3600))
        self.consume_limits(limits)
        intent = dict(email=email, name=name, organization=text(data.get('organization'), 'Organization'),
                      settings=settings(data.get('settings', {})), created=time.time())
        fingerprint = digest(json.dumps({k: v for k, v in intent.items() if k != 'created'}, sort_keys=True))
        if getattr(self.guard,'reserve_on_verified_login',False):
            intent['expires_at']=datetime.now(timezone.utc)+timedelta(days=30)
        def reserve(c):
            job = c.control_get('provisioning_jobs', email)
            if job:
                require(job['kind'] == 'signup' and job['fingerprint'] == fingerprint,
                        'Account provisioning requires reconciliation.', 409)
                require(c.identity_get(job['uid']) is None, 'This account is already registered.', 409)
                claim_invite(c,self.guard,job,fingerprint)
                if getattr(self.guard,'reserve_on_verified_login',False) and c.intent_get(job['uid']) is None:
                    c.intent_add(job['uid'],intent)
                return job
            if hasattr(self.guard, 'max_tenants') and not getattr(self.guard, 'reserve_on_verified_login', False):
                capacity = c.control_get('pilot_capacity', 'global') or dict(reserved=0)
                require(capacity['reserved'] < self.guard.max_tenants, 'The synthetic pilot tenant limit has been reached.', 409)
                c.control_put('pilot_capacity', 'global', dict(reserved=capacity['reserved'] + 1))
            job = dict(uid=uid(), kind='signup', fingerprint=fingerprint, state='reserved', created=time.time())
            claim_invite(c,self.guard,job,fingerprint)
            c.control_put('provisioning_jobs', email, job)
            c.intent_add(job['uid'], intent)
            return job
        job = self.run(reserve)
        self.ensure_reserved_identity(job, email, password, name)
        signed = self.identity.rest('signInWithPassword', dict(email=email, password=password, returnSecureToken=True))
        user, _ = self.identity.verify(signed['idToken'])
        require(user.uid == job['uid'], 'Account provisioning requires reconciliation.', 409)
        return self.identity.verification(signed['idToken'], email)

    def ensure_reserved_identity(self, job, email, password, name):
        try:
            user = self.identity.user(job['uid'])
        except Problem as error:
            if error.status != 401:
                raise
            user = self.identity.create(email, password, name, uid=job['uid'])
        require(user.uid == job['uid'] and user.email == email and not user.disabled,
                'Reserved identity mismatch. Operator reconciliation is required.', 409)
        # A prior successful provider creation may have lost its response. Prove
        # password possession before recovering it; never link an account by email.
        signed = self.identity.rest('signInWithPassword', dict(email=email, password=password, returnSecureToken=True))
        proven, _ = self.identity.verify(signed['idToken'])
        require(proven.uid == job['uid'], 'Reserved identity mismatch.', 409)
        return proven

    def prepare_member(self, actor, data, authorize):
        if getattr(self.guard,'safe_member_jobs',False):
            from member_provisioning import prepare
            return prepare(self,actor,data,authorize)
        email, password, name = self.credentials(data)
        payload = {k: v for k, v in data.items() if k != 'password'}
        fingerprint = digest(json.dumps(dict(actor=actor['id'], org=actor['org'], data=payload), sort_keys=True))
        def reserve(c):
            authorize(c)
            job = c.control_get('provisioning_jobs', email)
            if job:
                require(job['kind'] == 'member' and job['fingerprint'] == fingerprint,
                        'Account provisioning requires reconciliation.', 409)
                require(c.identity_get(job['uid']) is None, 'This account is already registered.', 409)
                return job
            if hasattr(self.guard, 'max_members'):
                capacity = c.control_get('pilot_member_capacity', actor['org']) or dict(reserved=1)
                require(capacity['reserved'] < self.guard.max_members, 'The synthetic pilot account limit has been reached.', 409)
                c.control_put('pilot_member_capacity', actor['org'], dict(reserved=capacity['reserved'] + 1))
            job = dict(uid=uid(), kind='member', fingerprint=fingerprint, state='reserved',
                       org=actor['org'], actor=actor['id'], created=time.time())
            c.control_put('provisioning_jobs', email, job)
            return job
        job=self.run(reserve)
        # The provider is outside Firestore's transaction. This recheck narrows
        # the race, but a later demotion can still leave an orphan identity.
        self.run(authorize)
        return self.ensure_reserved_identity(job, email, password, name)

    def begin_transition(self, user, operation, kind, action_ident=None, activation_email=None, expected_reclaim=None, reclaim=None):
        def begin(c):
            activation_snapshot=None
            if activation_email is not None and c.identity_get(user) is None:
                job=c.control_get('provisioning_jobs',activation_email)
                intent=c.intent_get(user)
                require(job and job.get('uid')==user and job.get('kind')=='signup' and
                        job.get('state') in ('reserved','password_ready','password_set_waiting_verification'),
                        'Account activation requires reconciliation.',409)
                actual=bool(job.get('reclaim_requested') or intent is None)
                require(actual==expected_reclaim,'Workspace details changed. Check the link again.',409)
                if actual:
                    require(reclaim is not None,'Complete your workspace details.',422)
                    activation_snapshot=dict(email=activation_email,name=reclaim['name'],organization=reclaim['organization'],settings=settings({}),created=time.time())
                else:
                    require(intent and intent.get('email')==activation_email,'Account activation requires reconciliation.',409)
                    activation_snapshot=dict(intent)
                activation_snapshot['expires_at']=datetime.now(timezone.utc)+timedelta(days=30)
            if action_ident:
                require(c.control_get('email_action_attempts', action_ident) is None,
                        'This action was already submitted. Check sign-in or request a fresh link.', 409)
            state = c.security(user)
            if state['blocked']:
                if state.get('operation') == operation:
                    if action_ident:
                        c.control_put('email_action_attempts', action_ident, dict(state='submitted', created=time.time()))
                    return state['epoch']
                # A fresh provider-validated recovery code can supersede a stale
                # uncertain transition. A concurrent old completion is fenced out.
                require(kind == 'recovery' and time.time() - state['started'] >= 120,
                        'Credential recovery is pending. Retry with a fresh recovery code after two minutes.', 409)
            state = dict(epoch=state['epoch'] + 1, blocked=True, operation=operation, kind=kind,
                         started=time.time())
            if activation_snapshot is not None:
                state['activation_intent']=activation_snapshot
                state['activation_reclaim']=bool(expected_reclaim)
            c.security_put(user, state)
            if action_ident:
                c.control_put('email_action_attempts', action_ident, dict(state='submitted', created=time.time()))
            return state['epoch']
        return self.run(begin)

    def finish_transition(self, user, operation, epoch, activation_email=None, activation_verified=True, reclaim=None):
        def finish(c):
            state = c.security(user)
            require(state['blocked'] and state['epoch'] == epoch and state['operation'] == operation,
                    'Credential transition changed concurrently.', 409)
            if activation_email is not None and c.identity_get(user) is None:
                intent=c.intent_get(user)
                job=c.control_get('provisioning_jobs',activation_email)
                snapshot=state.get('activation_intent')
                require(snapshot and snapshot.get('email')==activation_email and job and job.get('uid')==user
                        and job.get('kind')=='signup' and job.get('state') in ('reserved','password_ready','password_set_waiting_verification'),
                        'Account activation requires reconciliation.',409)
                # Refresh the retained intent even if the old document still
                # exists: its prior TTL may already be due for deletion.
                c.intent_replace(user,snapshot)
                next_state='password_ready' if activation_verified else 'password_set_waiting_verification'
                c.control_put('provisioning_jobs',activation_email,job|dict(state=next_state,password_ready_at=time.time(),reclaim_requested=False))
            final=dict(epoch=epoch, blocked=False, completed=time.time())
            if activation_email is not None and not activation_verified:
                final['awaiting_email_verification']=True
            c.security_put(user,final)
        self.run(finish)

    def request_recovery(self, data):
        # A known global disabled state is not an ambiguous provider outcome.
        # Stop before reserving counters, storing intents or touching identity.
        require(recovery_available(self), 'Recovery delivery is disabled pending owner approval.', 503)
        email = data.get('email', '')
        require(isinstance(email, str) and 3 <= len(email.strip()) <= 254, 'Enter a valid synthetic address.')
        email = email.strip().lower()
        require(self.identity_email_allowed(email), self.identity_email_error)
        self.consume_limits([('recovery/global', 15, 3600), ('recovery/' + email, 3, 3600)])
        # Persist delivery intent before provider work. A timeout is ambiguous and
        # never retried automatically: retrying could send duplicate messages.
        # One pseudonymous status per address avoids accumulating a new record
        # containing a raw email for every recovery request.
        ident = digest('recovery-delivery/' + email)
        def delivery_status(state):
            row=dict(state=state,created=time.time())
            if getattr(self.guard,'per_actor_limits',False):
                row['expires_at']=datetime.now(timezone.utc)+timedelta(days=30)
            return row
        self.run(lambda c: c.control_put('recovery_delivery', ident, delivery_status('pending')))
        state = 'submitted'
        try:
            if hasattr(self.identity, 'reset_delivery'):
                self.identity.reset_delivery(email)
            else:
                self.identity.rest('sendOobCode', dict(requestType='PASSWORD_RESET', email=email))
        except Exception:
            state = 'needs-review'
        self.run(lambda c: c.control_put('recovery_delivery', ident,delivery_status(state)))
        return dict(message='If this identity is eligible, recovery instructions will be available through the configured delivery method.')

    def inspect_email_action(self, mode, code):
        result = self.identity.rest('resetPassword', dict(oobCode=code))
        expected = {'verifyEmail': 'VERIFY_EMAIL', 'resetPassword': 'PASSWORD_RESET'}[mode]
        require(result.get('requestType') == expected,
                'This link is invalid, expired or already used.', 401)
        email = result.get('email', '')
        require(self.identity_email_allowed(email),
                self.identity_email_error, 403)
        return result

    def check_email_action(self, data):
        mode, code = action_fields(data)
        self.consume_limits([('email/action/check', 30, 600)])
        verified=self.inspect_email_action(mode, code)
        previous = self.run(lambda c: c.control_get('email_action_attempts', digest(mode + '/' + code)))
        # No email, UID, code, session or tenant profile is returned.
        result=dict(valid=True, mode=mode, submitted_before=previous is not None)
        if mode=='resetPassword' and getattr(self.guard,'require_mailbox_password_setup',False):
            def reclaim_required(c):
                job=c.control_get('provisioning_jobs',verified['email'])
                return bool(job and job.get('kind')=='signup' and c.identity_get(job['uid']) is None and
                            (job.get('reclaim_requested') or c.intent_get(job['uid']) is None))
            result['workspace_details_required']=self.run(reclaim_required)
        return result

    def claim_email_action(self, mode, code):
        ident = digest(mode + '/' + code)
        def claim(c):
            require(c.control_get('email_action_attempts', ident) is None,
                    'This action was already submitted. Check sign-in or request a fresh link.', 409)
            c.control_put('email_action_attempts', ident, dict(state='submitted', created=time.time()))
        self.run(claim)
        return ident

    def finish_email_action(self, ident):
        self.run(lambda c: c.control_put('email_action_attempts', ident,
                 dict(state='completed', completed=time.time())))

    def complete_email_action(self, data):
        mode, code = action_fields(data)
        if mode == 'resetPassword':
            return self.complete_recovery(data)
        self.consume_limits([('email/action/verify', 15, 600)])
        verified=self.inspect_email_action(mode, code)
        ident = self.claim_email_action(mode, code)
        # Only code application; no administrative emailVerified override.
        self.identity.rest('update', dict(oobCode=code))
        self.finish_email_action(ident)
        if getattr(self.guard,'require_mailbox_password_setup',False):
            email=verified['email']
            provider_user=self.identity.user_by_email(email)
            require(provider_user.email==email and provider_user.email_verified,'Account activation requires reconciliation.',409)
            def finish_reclaim(c):
                job=c.control_get('provisioning_jobs',email)
                state=c.security(provider_user.uid)
                if c.identity_get(provider_user.uid) is not None and state.get('awaiting_email_verification'):
                    c.security_put(provider_user.uid,{k:v for k,v in state.items() if k!='awaiting_email_verification'})
                    return True
                if not job or job.get('state')!='password_set_waiting_verification':return False
                intent=c.intent_get(job['uid'])
                require(job.get('kind')=='signup' and job.get('uid')==provider_user.uid and intent and intent.get('email')==email,
                        'Account activation requires reconciliation.',409)
                c.control_put('provisioning_jobs',email,job|dict(state='password_ready',verified_at=time.time()))
                return True
            if self.run(finish_reclaim):return dict(verified=True,sign_in_required=True)
            self.request_recovery(dict(email=verified['email']))
            return dict(verified=True,password_setup_required=True,sign_in_required=True)
        return dict(verified=True, sign_in_required=True)

    def complete_recovery(self, data):
        _, code = action_fields(dict(mode='resetPassword', code=data.get('code', '')))
        password = data.get('password', '')
        require(isinstance(password, str) and 12 <= len(password) <= 128, 'Use a password of 12–128 characters.')
        self.consume_limits([('recovery/complete', 15, 600)])
        # Check purpose before touching credential epochs. A verification code
        # accidentally opened as reset must never block the account.
        verified = self.inspect_email_action('resetPassword', code)
        email = verified.get('email', '')
        user = self.identity.user_by_email(email)
        require(not user.disabled, 'Recovery cannot be completed.', 401)
        def eligible(c):
            profile = c.identity_get(user.uid)
            if profile is None:
                # A verified signup may not have an application profile until
                # its first sign-in. Admit only the exact reserved identity;
                # never infer membership or link identities by email alone.
                intent=c.intent_get(user.uid)
                job=c.control_get('provisioning_jobs',email)
                verified_or_reclaim=(user.email_verified or getattr(self.guard,'require_mailbox_password_setup',False))
                require(verified_or_reclaim and user.email==email and
                        ((intent and intent.get('email')==email) or (intent is None and getattr(self.guard,'require_mailbox_password_setup',False))) and
                        job and job.get('kind')=='signup' and job.get('uid')==user.uid and
                        (not getattr(self.guard,'require_mailbox_password_setup',False) or
                         job.get('state') in ('reserved','password_ready','password_set_waiting_verification')),
                        'Recovery cannot be completed.',401)
                return bool(getattr(self.guard,'require_mailbox_password_setup',False) and (job.get('reclaim_requested') or intent is None))
            require(profile['email'] == email, 'Recovery cannot be completed.', 401)
            c.bind_org(profile['org'])
            member = c.member_get(profile['org'], user.uid)
            require(member and member['enabled'], 'Recovery cannot be completed.', 401)
        needs_reclaim=self.run(eligible)
        reclaim=None
        if needs_reclaim:
            reclaim=dict(name=text(data.get('name'),'Your name'),organization=text(data.get('organization'),'Organization'))
        # Reserve before changing epochs. Concurrent duplicate submissions must
        # not re-block an account whose first reset already completed.
        ident = digest('resetPassword/' + code)
        operation = digest('reset/' + code)
        epoch = self.begin_transition(user.uid, operation, 'recovery', action_ident=ident,
                                      activation_email=email if getattr(self.guard,'require_mailbox_password_setup',False) else None,
                                      expected_reclaim=needs_reclaim,reclaim=reclaim)
        # Any provider failure leaves the epoch blocked: no old opaque session
        # survives even if the provider transition happened within the same second.
        self.identity.rest('resetPassword', dict(oobCode=code, newPassword=password))
        self.identity.revoke(user.uid)
        self.finish_transition(user.uid, operation, epoch,
                               activation_email=email if getattr(self.guard,'require_mailbox_password_setup',False) else None,
                               activation_verified=user.email_verified,reclaim=reclaim)
        self.finish_email_action(ident)
        if getattr(self.guard,'require_mailbox_password_setup',False) and not user.email_verified:
            current=self.identity.user(user.uid)
            require(current.uid==user.uid and current.email==email and not current.disabled,'Recovery cannot be completed.',401)
            if current.email_verified:return dict(changed=True,signed_out=True)
            signed=self.identity.rest('signInWithPassword',dict(email=email,password=password,returnSecureToken=True))
            try:self.identity.verification(signed['idToken'],email)
            except Problem:
                current=self.identity.user(user.uid)
                if current.uid==user.uid and current.email==email and current.email_verified and not current.disabled:
                    return dict(changed=True,signed_out=True)
                raise
            return dict(changed=True,signed_out=True,verification_required=True)
        return dict(changed=True, signed_out=True)
