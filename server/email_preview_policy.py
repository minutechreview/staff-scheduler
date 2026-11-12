"""One identity, isolated records, one send attempt per purpose; no live factory."""
import time
from core import Problem, require
from email_preview_config import PROFILE, ORGANIZATION


class NamespacedClient:
    def __init__(self, client, run_id):
        self.base = client
        self.root = client.collection('email_previews').document(run_id)

    def collection(self, name):
        require(isinstance(name, str) and name.replace('_', '').isalnum() and '/' not in name,
                'Invalid preview collection.', 403)
        return self.root.collection(name)

    def __getattr__(self, name):
        if name in ['_firestore_api', 'transaction', 'get_all']: return getattr(self.base, name)
        raise AttributeError(name)


class EmailPreviewPolicy:
    def configure_preview(self):
        self.provider = self.identity
        self.identity = BudgetedPreviewIdentity(self.provider, self)

    def dispatch(self, token, method, path, data, query, csrf=None):
        require((method, path) in [('GET', '/api/me'), ('POST', '/api/signout')],
                'This operation is outside the email acceptance scope.', 403)
        return super().dispatch(token, method, path, data, query, csrf)

    def identity_email_allowed(self, email):
        return email == self.guard.owner_email

    def preview_state(self, c, create=False):
        self.guard.assert_open()
        state = c.control_get('preview_controls', 'run')
        if state is None and create:
            state = dict(run_id=self.guard.run_id, expires_at=self.guard.expires_at, enabled=True, calls=0)
        require(state and state.get('enabled') is True and state.get('run_id') == self.guard.run_id and
                state.get('expires_at') == self.guard.expires_at, 'This preview is closed or requires operator review.', 503)
        return state

    def assert_preview_open(self):
        self.run(lambda c: self.preview_state(c))

    def admit_request(self, path, token):
        self.guard.assert_open()
        def admit(c):
            state = self.preview_state(c, create=True)
            require(state['calls'] < self.guard.max_calls, 'The preview request budget is exhausted.', 429)
            c.control_put('preview_controls', 'run', state | dict(calls=state['calls'] + 1))
        self.run(admit)

    def provision_signup(self, data):
        require(set(data) == {'email', 'password', 'name', 'organization'} and
                data['name'] == PROFILE and data['organization'] == ORGANIZATION,
                'Use only the approved fictional preview profile.', 403)
        return super().provision_signup(data)

    def ensure_reserved_identity(self, job, email, password, name):
        def pin(c):
            state = self.preview_state(c)
            require(state.get('uid') in (None, job['uid']), 'The preview identity changed.', 409)
            c.control_put('preview_controls', 'run', state | dict(uid=job['uid']))
        self.run(pin)
        # Never adopt or reset an existing account merely because email matches.
        self.assert_preview_open()
        try:
            existing = self.provider.user_by_email(email)
        except Problem as error:
            if error.status != 401: raise
        else:
            require(existing.uid == job['uid'], 'The test address already exists. Stop for operator review.', 409)
        return super().ensure_reserved_identity(job, email, password, name)

    def assert_preview_user(self, user):
        require(self.identity_email_allowed(user.email), 'This identity is outside the preview scope.', 403)
        state = self.run(lambda c: self.preview_state(c))
        require(state.get('uid') == user.uid and not user.disabled, 'The exact reserved preview identity is required.', 403)
        return user

    def signin(self, data, client='preview'):
        require(self.identity_email_allowed(data.get('email', '').strip().lower()) if isinstance(data.get('email'), str) else False,
                'This identity is outside the preview scope.', 403)
        result = super().signin(data, client)
        if isinstance(result, str):
            def mark(c):
                state = self.preview_state(c)
                c.control_put('preview_controls', 'run', state | dict(signed_in=True))
            self.run(mark)
        return result

    def request_recovery(self, data):
        require(self.identity_email_allowed(data.get('email')), 'This identity is outside the preview scope.', 403)
        state = self.run(lambda c: self.preview_state(c))
        require(state.get('signed_in') is True, 'Verify and sign in before requesting the one reset message.', 403)
        return super().request_recovery(data)

    def inspect_email_action(self, mode, code):
        result = super().inspect_email_action(mode, code)
        self.assert_preview_user(self.provider.user_by_email(result['email']))
        return result


class BudgetedPreviewIdentity:
    def __init__(self, provider, service): self.provider, self.service = provider, service

    def user(self, uid):
        state = self.service.run(lambda c: self.service.preview_state(c))
        require(state.get('uid') == uid, 'This identity is outside the preview scope.', 403)
        return self.service.assert_preview_user(self.provider.user(uid))

    def user_by_email(self, email):
        require(self.service.identity_email_allowed(email), 'This identity is outside the preview scope.', 403)
        self.service.assert_preview_open()
        return self.service.assert_preview_user(self.provider.user_by_email(email))

    def verify(self, token):
        self.service.assert_preview_open()
        user, claims = self.provider.verify(token)
        return self.service.assert_preview_user(user), claims

    def create(self, email, password, name, uid=None):
        require(self.service.identity_email_allowed(email) and name == PROFILE, 'This identity is outside the preview scope.', 403)
        def claim(c):
            state = self.service.preview_state(c)
            require(state.get('uid') == uid and not state.get('create_attempted'), 'Identity creation already attempted. Stop for review.', 409)
            c.control_put('preview_controls', 'run', state | dict(create_attempted=True))
        self.service.run(claim)
        self.service.guard.assert_open()
        return self.service.assert_preview_user(self.provider.create(email, password, name, uid=uid))

    def rest(self, action, data):
        self.service.assert_preview_open()
        if action == 'sendOobCode':
            kind = data.get('requestType')
            if kind == 'VERIFY_EMAIL':
                require(set(data) == {'requestType', 'idToken'}, 'Invalid verification request.', 403)
                self.verify(data['idToken'])
            elif kind == 'PASSWORD_RESET':
                require(set(data) == {'requestType', 'email'}, 'Invalid reset request.', 403)
                user = self.user_by_email(data['email'])
                require(user.email_verified, 'Verify before requesting reset.', 403)
            else: raise Problem('This message purpose is forbidden.', 403)
            def claim(c):
                state = self.service.preview_state(c)
                if kind == 'PASSWORD_RESET': require(state.get('signed_in') is True, 'Sign in before requesting reset.', 403)
                require(c.control_get('preview_send_attempts', kind) is None,
                        'This message was already attempted. No resend is permitted.', 409)
                c.control_put('preview_send_attempts', kind, dict(state='reserved', at=time.time()))
            self.service.run(claim)
            # Reserve first; failures, lost acknowledgements and restarts never replay.
            self.service.guard.assert_open()
            return self.provider.rest(action, data)
        if action == 'signInWithPassword':
            require(set(data) == {'email', 'password', 'returnSecureToken'} and
                    self.service.identity_email_allowed(data.get('email')), 'This identity is outside the preview scope.', 403)
        elif action in ['update', 'resetPassword']:
            permitted = {'oobCode'} if action == 'update' or 'newPassword' not in data else {'oobCode', 'newPassword'}
            require(set(data) == permitted, 'Invalid preview action fields.', 403)
            if action == 'update' or 'newPassword' in data:
                mode = 'verifyEmail' if action == 'update' else 'resetPassword'
                self.service.inspect_email_action(mode, data['oobCode'])
        else: raise Problem('This provider operation is forbidden.', 403)
        self.service.guard.assert_open()
        return self.provider.rest(action, data)

    def verification(self, token, email):
        require(self.service.identity_email_allowed(email), 'This identity is outside the preview scope.', 403)
        self.rest('sendOobCode', dict(requestType='VERIFY_EMAIL', idToken=token))
        return dict(verification_required=True, message='The single verification message was requested. No resend is available.')

    def reset_delivery(self, email): self.rest('sendOobCode', dict(requestType='PASSWORD_RESET', email=email))

    def revoke(self, uid):
        self.user(uid)
        return self.provider.revoke(uid)

    def change_password(self, *args, **kwargs): raise Problem('Use the approved reset action only.', 403)
    def delete(self, *args, **kwargs): raise Problem('Preview account deletion is forbidden.', 403)


def make_preview_service(guard, identity, client):
    from firebase_service import FirebaseService
    class PreviewService(EmailPreviewPolicy, FirebaseService): pass
    service = PreviewService(guard=guard, identity=identity, client=NamespacedClient(client, guard.run_id))
    service.configure_preview()
    return service
