import concurrent.futures
import copy
import io
import json
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from core import Problem
from email_preview_config import EmailPreviewConfig, PROJECT, HOST, ORIGIN, OWNER, AUDIENCE, PROFILE, ORGANIZATION
from email_preview import create_preview_application, load_application
from email_preview_iap import IapVerifier, CERT_URL
from email_preview_policy import EmailPreviewPolicy
from email_action_fixtures import FixtureActionService, FixtureIdentity


def preview_env():
    now = time.time()
    return dict(K_SERVICE='relay-email-preview', K_REVISION='synthetic-preview-00001',
        RELAY_EMAIL_PREVIEW_EXECUTION='approved', RELAY_LIVE_ENABLED='approved', RELAY_FIREBASE_MODE='staging',
        RELAY_FIREBASE_PROJECT=PROJECT, RELAY_FIRESTORE_DATABASE='(default)', RELAY_ACTIVATION_SCOPE=PROJECT + '/(default)',
        RELAY_PUBLIC_ORIGIN=ORIGIN, RELAY_API_HOST=HOST, RELAY_AUTH_API_KEY='synthetic-public-config-key-12345',
        RELAY_EMAIL_PREVIEW_RECIPIENT=OWNER, RELAY_AUTH_DELIVERY='approved', RELAY_SYNTHETIC_ONLY='true',
        RELAY_EMAIL_PREVIEW_RUN_ID='email-20261020t000000z-abcdef12', RELAY_EMAIL_PREVIEW_STARTS_AT=str(now - 10),
        RELAY_EMAIL_PREVIEW_EXPIRES_AT=str(now + 1200))


def invoke(app, path='/', method='GET', data=None, **overrides):
    raw = json.dumps(data).encode() if data is not None else b''
    env = dict(HTTP_HOST=HOST, PATH_INFO=path, REQUEST_METHOD=method, QUERY_STRING='',
        CONTENT_TYPE='application/json', CONTENT_LENGTH=str(len(raw)), HTTP_ORIGIN=ORIGIN)
    env.update({'wsgi.url_scheme': 'https', 'wsgi.input': io.BytesIO(raw)})
    env.update(overrides)
    captured = {}
    def start(status, headers): captured.update(status=int(status.split()[0]), headers=dict(headers))
    captured['body'] = b''.join(app(env, start))
    return captured


class ConfigurationAndTransport(unittest.TestCase):
    def setUp(self):
        self.env = preview_env(); self.context = patch.dict(os.environ, self.env, clear=True); self.context.start(); self.addCleanup(self.context.stop)
        self.guard = EmailPreviewConfig.from_environment()

    def test_exact_config_cannot_activate_original_or_other_service_or_inbox(self):
        for key, value in [('K_SERVICE', 'relay-api-staging'), ('RELAY_EMAIL_PREVIEW_RECIPIENT', 'other@example.test'),
                           ('RELAY_PUBLIC_ORIGIN', 'https://evil.test'), ('RELAY_EMAIL_PREVIEW_EXECUTION', 'disabled'),
                           ('GOOGLE_APPLICATION_CREDENTIALS', '/tmp/key.json'), ('RELAY_SYNTHETIC_ONLY', 'false')]:
            with self.subTest(key=key), patch.dict(os.environ, {key: value}), self.assertRaises(ValueError): EmailPreviewConfig.from_environment()
        for value in ['nan', 'inf', str(self.guard.starts_at + 1801), str(self.guard.starts_at)]:
            with patch.dict(os.environ, RELAY_EMAIL_PREVIEW_EXPIRES_AT=value), self.assertRaises(ValueError): EmailPreviewConfig.from_environment()

    def test_disabled_entry_does_not_instantiate_identity_or_iap(self):
        with patch.dict(os.environ, RELAY_EMAIL_PREVIEW_EXECUTION='disabled'), patch('email_preview.create_preview_service') as factory:
            self.assertEqual(invoke(load_application())['status'], 503)
            factory.assert_not_called()

    def test_missing_or_forged_iap_denies_before_lazy_provider_factory(self):
        factory = Mock(); verifier = Mock(side_effect=Problem('Owner IAP required', 403))
        app = create_preview_application(self.guard, verifier, factory)
        self.assertEqual(invoke(app, '/api/signup', 'POST', {})['status'], 403)
        factory.assert_not_called()
        self.assertEqual(invoke(app, '/healthz')['status'], 200)
        self.assertEqual(verifier.call_count, 1)

    def test_window_and_route_deny_before_sdk_and_global_controls(self):
        factory = Mock(); app = create_preview_application(self.guard, lambda env: {}, factory)
        for path in ['/api/people', '/api/demo', '/api/password', '/api/recovery/complete']:
            self.assertEqual(invoke(app, path, 'POST', {})['status'], 403)
        with patch('email_preview_config.time.time', return_value=self.guard.expires_at):
            self.assertEqual(invoke(app, '/api/signup', 'POST', {})['status'], 503)
        self.assertEqual(invoke(app, '/api/preview')['status'], 200)
        self.assertEqual(invoke(app, '/api/preview', QUERY_STRING='mode=verifyEmail&oobCode=synthetic')['status'], 422)
        self.assertEqual(invoke(app, '/api/preview', HTTP_HOST='evil.test')['status'], 403)
        self.assertEqual(invoke(app, '/api/preview', **{'wsgi.url_scheme': 'http'})['status'], 403)
        factory.assert_not_called()

    def test_static_traversal_and_private_cache_headers(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'preview.html').write_text('<h1>Synthetic preview</h1>')
            factory = Mock(); app = create_preview_application(self.guard, lambda env: {}, factory, directory)
            response = invoke(app)
            self.assertEqual(response['status'], 200)
            self.assertEqual(response['headers']['Cache-Control'], 'private, no-store')
            self.assertEqual(response['headers']['Referrer-Policy'], 'no-referrer')
            self.assertIn("frame-ancestors 'none'", response['headers']['Content-Security-Policy'])
            for path in ['/assets/../../requirements.firebase.txt', '/src/EmailAction.jsx', '/preview.html']:
                self.assertEqual(invoke(app, path)['status'], 404)
            factory.assert_not_called()


class SignedIap(unittest.TestCase):
    def setUp(self):
        # Ephemeral synthetic fixture signing key, never stored or operational.
        self.key = ec.generate_private_key(ec.SECP256R1())
        public = self.key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
        self.session = Mock(); self.session.get.return_value = SimpleNamespace(status_code=200, content=json.dumps({'fixture': public}).encode())
        self.verify = IapVerifier(self.session)

    def token(self, **claims):
        now = time.time()
        data = dict(iss='https://cloud.google.com/iap', aud=AUDIENCE, email=OWNER, sub='synthetic-google-sub', iat=now - 5, exp=now + 300)
        data.update(claims)
        return jwt.encode(data, self.key, algorithm='ES256', headers={'kid': 'fixture'})

    def test_valid_signature_identity_and_cached_pinned_certificate_request(self):
        env = {'HTTP_X_GOOG_IAP_JWT_ASSERTION': self.token()}
        self.assertEqual(self.verify(env)['email'], OWNER); self.verify(env)
        self.session.get.assert_called_once_with(CERT_URL, timeout=5, allow_redirects=False, verify=True)

    def test_wrong_identity_issuer_audience_time_and_lifetime_fail_closed(self):
        for claims in [dict(email='sample-18ae18f2@example.invalid'), dict(aud='other-service'), dict(iss='https://evil.test'),
                       dict(exp=time.time() - 60), dict(iat=time.time() + 60), dict(exp=time.time() + 900)]:
            with self.subTest(claims=list(claims)), self.assertRaises(Problem): self.verify({'HTTP_X_GOOG_IAP_JWT_ASSERTION': self.token(**claims)})

    def test_missing_unsigned_unknown_key_and_tampered_assertions_fail(self):
        valid = self.token()
        for value in ['', 'not-a-jwt', valid[:-15] + 'aaaaaaaaaaaaaaa', jwt.encode({'email': OWNER}, 'synthetic-only-secret-at-least-thirty-two-bytes', algorithm='HS256')]:
            with self.assertRaises(Problem): self.verify({'HTTP_X_GOOG_IAP_JWT_ASSERTION': value, 'HTTP_X_GOOG_AUTHENTICATED_USER_EMAIL': 'accounts.google.com:' + OWNER})

    def test_redirect_or_certificate_failure_never_accepts_assertion(self):
        self.session.get.return_value = SimpleNamespace(status_code=302, content=b'{}')
        with self.assertRaises(Problem): self.verify({'HTTP_X_GOOG_IAP_JWT_ASSERTION': self.token()})


class PolicyIssuer(FixtureIdentity):
    def __init__(self):
        super().__init__(); self.sends = []; self.fail_send = False
    def verify(self, token): return self.user, dict(uid=self.user.uid, email=self.user.email)
    def rest(self, action, data):
        if action == 'sendOobCode':
            self.sends.append(data['requestType'])
            if self.fail_send: raise RuntimeError('Synthetic lost send acknowledgement')
            return {}
        return super().rest(action, data)


class PolicyFixture(EmailPreviewPolicy, FixtureActionService):
    def __init__(self):
        FixtureActionService.__init__(self)
        self.identity = PolicyIssuer()
        self.open = True
        def assert_open():
            if not self.open: raise Problem('Window closed', 503)
        self.guard = SimpleNamespace(owner_email=self.identity.user.email, run_id='synthetic-policy', expires_at=1234,
                                     delivery=True, max_calls=100, assert_open=assert_open)
        self.configure_preview()
        self.admit_request('/api/signup', None)
        self.run(lambda c: c.control_put('preview_controls', 'run', c.control_get('preview_controls', 'run') | dict(uid='fixture-owner')))


class DurablePolicy(unittest.TestCase):
    def setUp(self): self.s = PolicyFixture()
    def rejected(self, operation, status):
        with self.assertRaises(Problem) as result: operation()
        self.assertEqual(result.exception.status, status)

    def test_two_concurrent_verification_requests_have_one_send(self):
        def send(_):
            try: self.s.identity.verification('synthetic-token', self.s.guard.owner_email); return 200
            except Problem as error: return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: results = sorted(pool.map(send, range(2)))
        self.assertEqual(results, [200, 409]); self.assertEqual(self.s.provider.sends, ['VERIFY_EMAIL'])

    def test_send_ack_loss_and_new_service_cannot_resend(self):
        self.s.provider.fail_send = True
        with self.assertRaises(RuntimeError): self.s.identity.verification('synthetic-token', self.s.guard.owner_email)
        restarted = PolicyFixture(); restarted.store = self.s.store; restarted.provider = self.s.provider; restarted.identity.provider = self.s.provider
        self.rejected(lambda: restarted.identity.verification('synthetic-token', self.s.guard.owner_email), 409)
        self.assertEqual(self.s.provider.sends, ['VERIFY_EMAIL'])

    def test_reset_requires_prior_verified_signin_and_one_attempt(self):
        self.rejected(lambda: self.s.request_recovery(dict(email=self.s.guard.owner_email)), 403)
        self.assertEqual(self.s.provider.sends, [])
        self.s.provider.user.email_verified = True
        self.s.run(lambda c: c.control_put('preview_controls', 'run', c.control_get('preview_controls', 'run') | dict(signed_in=True)))
        self.s.request_recovery(dict(email=self.s.guard.owner_email)); self.s.request_recovery(dict(email=self.s.guard.owner_email))
        self.assertEqual(self.s.provider.sends, ['PASSWORD_RESET'])

    def test_foreign_addresses_uid_and_provider_admin_operations_deny(self):
        self.rejected(lambda: self.s.identity.user_by_email('other@example.test'), 403)
        self.rejected(lambda: self.s.identity.user('different-uid'), 403)
        self.rejected(lambda: self.s.identity.rest('sendOobCode', dict(requestType='EMAIL_SIGNIN', email=self.s.guard.owner_email)), 403)
        self.rejected(lambda: self.s.identity.rest('update', dict(emailVerified=True, localId='fixture-owner')), 403)
        self.rejected(lambda: self.s.identity.change_password('fixture-owner', 'synthetic-password'), 403)
        self.rejected(lambda: self.s.dispatch(None, 'POST', '/api/people', {}, {}), 403)
        self.assertEqual(self.s.provider.sends, [])

    def test_expiry_closed_control_and_request_budget_stop_writes_and_sends(self):
        before = copy.deepcopy(self.s.store.controls)
        self.s.open = False
        self.rejected(lambda: self.s.identity.verification('synthetic-token', self.s.guard.owner_email), 503)
        self.rejected(lambda: self.s.admit_request('/api/signin', None), 503)
        self.assertEqual(self.s.store.controls, before)
        self.s.open = True
        self.s.run(lambda c: c.control_put('preview_controls', 'run', c.control_get('preview_controls', 'run') | dict(calls=100)))
        self.rejected(lambda: self.s.admit_request('/api/signin', None), 429)
        self.s.run(lambda c: c.control_put('preview_controls', 'run', c.control_get('preview_controls', 'run') | dict(enabled=False)))
        self.rejected(lambda: self.s.identity.verification('synthetic-token', self.s.guard.owner_email), 503)
        self.assertEqual(self.s.provider.sends, [])

    def test_default_email_policy_stays_synthetic(self):
        ordinary = FixtureActionService()
        self.assertFalse(ordinary.identity_email_allowed(OWNER))
        self.assertTrue(ordinary.identity_email_allowed('synthetic@example.test'))


if __name__ == '__main__': unittest.main()
