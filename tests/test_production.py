"""Offline guard and WSGI boundary tests; no cloud credentials or HTTP calls."""
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from core import Service
from production_app import create_application, load_application
from production_config import ProductionConfig

SAFE = dict(RELAY_FIREBASE_MODE='staging', RELAY_LIVE_ENABLED='approved',
            RELAY_FIREBASE_PROJECT='fixture-project', RELAY_FIRESTORE_DATABASE='relay-saas-staging',
            RELAY_ACTIVATION_SCOPE='fixture-project/relay-saas-staging', K_SERVICE='relay-api-staging', K_REVISION='fixture-001',
            RELAY_PUBLIC_ORIGIN='https://relay-fixture.web.app',
            RELAY_API_HOST='relay-api-staging-123456789012.us-central1.run.app',
            RELAY_AUTH_API_KEY='synthetic-public-fixture-key-12345')


class ProductionGuardTests(unittest.TestCase):
    def test_disabled_factory_does_not_import_live_sdk(self):
        with patch.dict(os.environ, {}, clear=True):
            before = set(sys.modules)
            app = load_application()
            status = []
            body = app({}, lambda s, h: status.append(s))
            self.assertTrue(status[0].startswith('503'))
            self.assertNotIn('firebase_live', set(sys.modules) - before)
            self.assertNotIn('firebase_admin', set(sys.modules) - before)
            self.assertNotIn(b'fixture', body[0])

    def test_explicit_guard_safe_scope_and_secret_repr(self):
        with patch.dict(os.environ, SAFE, clear=True):
            guard = ProductionConfig.from_environment()
            self.assertFalse(guard.delivery)
            self.assertNotIn(SAFE['RELAY_AUTH_API_KEY'], repr(guard))
            guard.assert_auth_url('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword')
            for url in ('http://identitytoolkit.googleapis.com/x', 'https://identitytoolkit.googleapis.com.evil.test/x',
                        'https://a:b@identitytoolkit.googleapis.com/x', 'https://identitytoolkit.googleapis.com:444/x'):
                with self.subTest(url=url), self.assertRaises(ValueError): guard.assert_auth_url(url)

    def test_mixed_environment_original_database_host_and_unapproved_fail(self):
        bad = [('RELAY_LIVE_ENABLED', ''), ('RELAY_FIREBASE_MODE', 'emulator'), ('RELAY_FIRESTORE_DATABASE', '(default)'),
               ('RELAY_FIREBASE_PROJECT', 'demo-fixture'), ('RELAY_ACTIVATION_SCOPE', 'other/relay-saas-staging'),
               ('K_SERVICE', 'legacy-api'), ('K_REVISION', ''), ('RELAY_AUTH_API_KEY', ''),
               ('RELAY_PUBLIC_ORIGIN', 'https://fixture-project.web.app'), ('RELAY_PUBLIC_ORIGIN', 'https://x.test/path'),
               ('RELAY_PUBLIC_ORIGIN', 'https://a:b@x.test'), ('RELAY_PUBLIC_ORIGIN', 'http://x.test'),
               ('RELAY_PUBLIC_ORIGIN', 'https://x.test:443'), ('RELAY_API_HOST', 'x.test'),
               ('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9099'), ('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8089'),
               ('GOOGLE_APPLICATION_CREDENTIALS', '/must-not-read'), ('FIREBASE_CONFIG', '{}'),
               ('GCE_METADATA_HOST', 'evil.test'), ('HTTPS_PROXY', 'https://evil.test'),
               ('GOOGLE_CLOUD_PROJECT', 'other'), ('RELAY_SYNTHETIC_ONLY', 'false'), ('RELAY_AUTH_DELIVERY', 'yes')]
        for key, value in bad:
            with self.subTest(key=key, value=value), patch.dict(os.environ, SAFE | {key: value}, clear=True), self.assertRaises(ValueError):
                ProductionConfig.from_environment()

    def test_configuration_mutation_fails_closed(self):
        with patch.dict(os.environ, SAFE, clear=True):
            guard = ProductionConfig.from_environment()
            os.environ['RELAY_FIRESTORE_DATABASE'] = '(default)'
            with self.assertRaises(ValueError): guard.assert_current()

    def test_real_cloud_run_host_formats(self):
        for host in ('relay-api-staging-123456789012.us-central1.run.app',
                     'relay-api-staging-fixture-uc.a.run.app',
                     'tag---relay-api-staging-123456789012.us-central1.run.app'):
            with self.subTest(host=host), patch.dict(os.environ, SAFE | {'RELAY_API_HOST': host}, clear=True):
                guard = ProductionConfig.from_environment()
                self.assertEqual(guard.hosts, {'relay-fixture.web.app', host})

    def test_malformed_cloud_run_hosts_fail_closed(self):
        hosts = ('', 'run.app', 'https://relay-api.run.app', 'a@relay-api.run.app',
                 'relay-api.run.app:443', 'relay-api.run.app/path', 'relay-api.run.app?x=1',
                 'relay-api.run.app#fragment', 'relay-api.run.app.evil.test', 'relay-api.evilrun.app',
                 'relay-api..run.app', '.relay-api.run.app', 'relay-api.run.app.',
                 '-relay-api.run.app', 'relay-api-.run.app', 'Relay-api.run.app',
                 'relay-api.run.app\n', 'a' * 64 + '.run.app', ('a' * 61 + '.') * 4 + 'run.app',
                 'relay-api/run.app')
        for host in hosts:
            with self.subTest(host=host), patch.dict(os.environ, SAFE | {'RELAY_API_HOST': host}, clear=True):
                with self.assertRaises(ValueError): ProductionConfig.from_environment()

    def test_default_database_only_in_exact_isolated_project(self):
        approved = SAFE | {'RELAY_FIREBASE_PROJECT': 'relay-saas-stg-746234651365',
                           'RELAY_FIRESTORE_DATABASE': '(default)',
                           'RELAY_ACTIVATION_SCOPE': 'relay-saas-stg-746234651365/(default)'}
        with patch.dict(os.environ, approved, clear=True):
            self.assertEqual(ProductionConfig.from_environment().database, '(default)')
        for project in ('scheduler-sbx', 'fixture-project', 'relay-saas-stg-746234651366'):
            with self.subTest(project=project), patch.dict(os.environ, approved | {
                    'RELAY_FIREBASE_PROJECT': project, 'RELAY_ACTIVATION_SCOPE': project + '/(default)'}, clear=True):
                with self.assertRaises(ValueError): ProductionConfig.from_environment()
        for scope in ('UNAPPROVED', 'scheduler-sbx/(default)', 'relay-saas-stg-746234651365/relay-saas-staging'):
            with self.subTest(scope=scope), patch.dict(os.environ, approved | {'RELAY_ACTIVATION_SCOPE': scope}, clear=True):
                with self.assertRaises(ValueError): ProductionConfig.from_environment()


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.service = Service(Path(self.temp.name) / 'synthetic.sqlite3')
        self.service.admit_request = lambda path, token: None
        with patch.dict(os.environ, SAFE, clear=True): self.config = ProductionConfig.from_environment()
        self.app = create_application(self.service, self.config)

    def tearDown(self): self.temp.cleanup()

    def request(self, method, path, data=None, extra=None):
        raw = json.dumps(data).encode() if data is not None else b''
        target, _, query = path.partition('?')
        environ = dict(REQUEST_METHOD=method, PATH_INFO=target, QUERY_STRING=query, HTTP_HOST='relay-fixture.web.app',
                       HTTP_ORIGIN=self.config.origin, CONTENT_TYPE='application/json', CONTENT_LENGTH=str(len(raw)))
        environ.update({'wsgi.url_scheme': 'https', 'wsgi.input': io.BytesIO(raw)})
        environ.update(extra or {})
        result = []
        body = self.app(environ, lambda status, headers: result.append((int(status.split()[0]), dict(headers))))
        return result[0][0], result[0][1], json.loads(b''.join(body))

    def signup(self, suffix):
        status, headers, me = self.request('POST', '/api/signup', dict(name='Synthetic', organization='Synthetic',
                email=suffix+'@fixture.test', password='fictional-only-123'))
        self.assertEqual(status, 201)
        return dict(HTTP_COOKIE=headers['Set-Cookie'].split(';')[0], HTTP_X_CSRF_TOKEN=me['user']['csrf']), me

    def test_secure_cookie_no_token_private_headers(self):
        _, h, body = self.request('POST', '/api/signup', dict(name='Synthetic', organization='Synthetic',
                                  email='cookie@fixture.test', password='fictional-only-123'))
        for value in ('__session=', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=43200'):
            self.assertIn(value, h['Set-Cookie'])
        self.assertIn('no-store', h['Cache-Control']); self.assertIn('private', h['Cache-Control'])
        self.assertNotIn('token', body); self.assertNotIn('password', body['user'])

    def test_real_sessions_csrf_and_signout(self):
        h, _ = self.signup('session')
        self.assertEqual(self.request('GET', '/api/me', extra=h)[0], 200)
        self.assertEqual(self.request('POST', '/api/demo', {}, {'HTTP_COOKIE': h['HTTP_COOKIE']})[0], 403)
        self.assertEqual(self.request('POST', '/api/demo', {}, h)[0], 200)
        status, cookies, _ = self.request('POST', '/api/signout', {}, h)
        self.assertEqual(status, 200); self.assertIn('Max-Age=0', cookies['Set-Cookie'])
        self.assertEqual(self.request('GET', '/api/me', extra=h)[0], 401)

    def test_host_origin_tls_and_spoofed_forward_headers(self):
        h, _ = self.signup('origin')
        for extra in ({'HTTP_HOST':'evil.test'}, {'HTTP_ORIGIN':'https://evil.test'}, {'HTTP_ORIGIN':''},
                      {'wsgi.url_scheme':'http', 'HTTP_X_FORWARDED_PROTO':'https'},
                      {'HTTP_HOST':'evil.test', 'HTTP_X_FORWARDED_HOST':'relay-fixture.web.app'},
                      {'HTTP_SEC_FETCH_SITE':'cross-site'}):
            with self.subTest(extra=extra): self.assertEqual(self.request('POST', '/api/demo', {}, h | extra)[0], 403)

    def test_cloud_run_request_host_requires_exact_configured_hostname(self):
        h, _ = self.signup('api-host')
        host = self.config.api_host
        self.assertEqual(self.request('GET', '/api/me', extra=h | {'HTTP_HOST': host})[0], 200)
        for denied in (host + '.evil.test', 'different.us-central1.run.app', host + ':443',
                       'user@' + host, 'tag---' + host):
            with self.subTest(host=denied):
                self.assertEqual(self.request('GET', '/api/me', extra=h | {
                    'HTTP_HOST': denied, 'HTTP_X_FORWARDED_HOST': host})[0], 403)

    def test_unauthed_forged_duplicate_and_oversized_cookie(self):
        self.assertEqual(self.request('GET', '/api/me')[0], 401)
        self.assertEqual(self.request('GET', '/api/me', extra={'HTTP_COOKIE':'__session=forged'})[0], 401)
        self.assertEqual(self.request('GET', '/api/me', extra={'HTTP_COOKIE':'__session=a; __session=b'})[0], 400)
        self.assertEqual(self.request('GET', '/api/me', extra={'HTTP_COOKIE':'x='+'a'*8200})[0], 431)

    def test_tenant_employee_and_branch_scope_on_wsgi(self):
        h, me = self.signup('owner')
        self.request('POST', '/api/demo', {}, h)
        _, _, state = self.request('GET', '/api/me', extra=h)
        a, b = state['branches'][:2]
        self.request('POST', '/api/members', dict(name='Synthetic Manager', email='manager@fixture.test',
                password='fictional-only-123', role='branch_manager', branches=[a['id']]), h)
        status, cookie, manager = self.request('POST', '/api/signin', dict(email='manager@fixture.test', password='fictional-only-123'))
        self.assertEqual(status, 200)
        mh = dict(HTTP_COOKIE=cookie['Set-Cookie'].split(';')[0], HTTP_X_CSRF_TOKEN=manager['user']['csrf'])
        self.assertEqual(self.request('GET', f"/api/schedule?branch={b['id']}&week=2026-10-12", extra=mh)[0], 403)
        self.assertEqual(self.request('POST', '/api/schedule', dict(branch=b['id'],week='2026-10-12',revision=0,shifts=[],org='victim',role='owner'), mh)[0], 403)
        other, _ = self.signup('other')
        self.assertEqual(self.request('GET', f"/api/schedule?branch={a['id']}&week=2026-10-12", extra=other)[0], 403)
        employee = next(e for e in state['employees'] if e['branch'] == a['id'])
        self.request('POST', '/api/members', dict(name='Synthetic Employee', email='employee@fixture.test',
                password='fictional-only-123',role='employee',branches=[a['id']],employee=employee['id']), h)
        _, cookie, e = self.request('POST', '/api/signin', dict(email='employee@fixture.test',password='fictional-only-123'))
        eh = dict(HTTP_COOKIE=cookie['Set-Cookie'].split(';')[0], HTTP_X_CSRF_TOKEN=e['user']['csrf'])
        self.assertEqual(self.request('GET', f"/api/schedule?branch={a['id']}&week=2026-10-12", extra=eh)[0], 403)
        self.assertEqual(self.request('GET', '/api/my-schedule?week=2026-10-12', extra=eh)[0], 200)

    def test_body_method_query_and_response_bounds(self):
        h, _ = self.signup('bounds')
        cases = [({'CONTENT_TYPE':'text/plain'},415), ({'CONTENT_LENGTH':'2000001'},413),
                 ({'CONTENT_LENGTH':'-1'},411), ({'CONTENT_LENGTH':'3'},400),
                 ({'HTTP_TRANSFER_ENCODING':'chunked'},400)]
        for extra, status in cases:
            with self.subTest(extra=extra): self.assertEqual(self.request('POST','/api/demo',{},h | extra)[0],status)
        self.assertEqual(self.request('POST','/api/demo',[],h)[0],422)
        self.assertEqual(self.request('DELETE','/api/me',extra=h)[0],405)
        self.assertEqual(self.request('GET','/api/me?week=a&week=b',extra=h)[0],422)
        self.assertEqual(self.request('GET','/api/me?'+'&'.join(f'x{i}=a' for i in range(21)),extra=h)[0],422)
        with patch.object(self.service,'dispatch',return_value={'huge':'x'*4_000_000}):
            self.assertEqual(self.request('GET','/api/me',extra=h)[0],413)

    def test_dependency_failure_does_not_expose_secrets(self):
        with patch.object(self.service,'admit_request',side_effect=RuntimeError('sensitive-provider-token')):
            status,h,body=self.request('GET','/api/me')
            self.assertEqual(status,503); self.assertIn('Retry-After',h)
            self.assertNotIn('sensitive',json.dumps(body))

    def test_capabilities_reflect_implemented_recovery_and_delivery_readiness(self):
        status, _, body = self.request('GET', '/api/capabilities')
        self.assertEqual(status, 200)
        self.assertFalse(body['recovery'], 'SQLite has no recovery provider')
        with patch.object(self.service, 'request_recovery', create=True, return_value={}), \
             patch.object(self.service, 'guard', create=True, new=SimpleNamespace(delivery=False)):
            self.assertFalse(self.request('GET', '/api/capabilities')[2]['recovery'])
            self.service.guard.delivery = True
            self.assertTrue(self.request('GET', '/api/capabilities')[2]['recovery'])

    def test_ambiguous_nonfinite_or_non_utf8_json_rejected_before_admission(self):
        bodies = [b'{"branch":"a","branch":"b"}',
                  b'{"nested":{"role":"owner","role":"employee"}}',
                  b'{"branch":"a","br\\u0061nch":"b"}',
                  b'{"x":NaN}', b'{"x":Infinity}', b'{"x":-Infinity}',
                  b'{"x":1e9999}', b'{"x":"\xff"}', b'{}\x00',
                  '{"name":"test"}'.encode('utf-16'),
                  b'{"x":' + b'[' * 1100 + b'0' + b']' * 1100 + b'}']
        with patch.object(self.service, 'admit_request') as admit, \
             patch.object(self.service, 'signup') as signup:
            for raw in bodies:
                with self.subTest(body_length=len(raw)):
                    status, headers, body = self.request('POST', '/api/signup', {},
                        {'CONTENT_LENGTH': str(len(raw)), 'wsgi.input': io.BytesIO(raw)})
                    self.assertEqual(status, 422)
                    self.assertNotIn('Set-Cookie', headers)
                    self.assertEqual(body, {'error': 'Invalid request. Check the fields and try again.'})
            admit.assert_not_called()
            signup.assert_not_called()


if __name__ == '__main__': unittest.main(verbosity=2)
