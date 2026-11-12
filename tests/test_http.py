import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from app import create_server


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.db = Path(cls.temp.name) / 'http.sqlite3'
        cls.server = create_server(cls.db, 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, method, path, data=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        h = {'Content-Type': 'application/json'} | (headers or {})
        connection.request(method, path, body=json.dumps(data) if data is not None else None, headers=h)
        response = connection.getresponse()
        status, returned_headers, raw = response.status, dict(response.getheaders()), response.read()
        connection.close()
        parsed = json.loads(raw) if returned_headers.get('Content-Type') == 'application/json' else raw
        return status, returned_headers, parsed

    def signup(self, suffix):
        status, headers, body = self.request('POST', '/api/signup', dict(name='Fictional HTTP Owner', organization='HTTP Tests', email=f'{suffix}@example.test', password='fictional-only-123'))
        self.assertEqual(status, 201)
        cookie = headers['Set-Cookie'].split(';')[0]
        return {'Cookie': cookie, 'X-CSRF-Token': body['user']['csrf']}, body

    def test_real_cookie_session_csrf_signout(self):
        headers, _ = self.signup('session')
        self.assertEqual(self.request('GET', '/api/me', headers=headers)[0], 200)
        self.assertEqual(self.request('POST', '/api/demo', {}, {'Cookie': headers['Cookie']})[0], 403)
        self.assertEqual(self.request('POST', '/api/demo', {}, headers)[0], 200)
        self.assertEqual(self.request('POST', '/api/signout', {}, headers)[0], 200)
        self.assertEqual(self.request('GET', '/api/me', headers=headers)[0], 401)

    def test_cookie_flags_headers_and_no_browser_token(self):
        _, headers, body = self.request('POST', '/api/signup', dict(name='Fictional', organization='Cookies', email='cookies@example.test', password='fictional-only-123'))
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', headers['Set-Cookie'])
        self.assertIn('frame-ancestors', headers['Content-Security-Policy'])
        self.assertNotIn('token', body)
        self.assertNotIn('password', body['user'])

    def test_origin_and_host_rejection(self):
        headers, _ = self.signup('origin')
        self.assertEqual(self.request('POST', '/api/demo', {}, headers | {'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.request('GET', '/api/me', headers=headers | {'Host': 'evil.example'})[0], 403)

    def test_unauthed_and_forged_session(self):
        self.assertEqual(self.request('GET', '/api/me')[0], 401)
        self.assertEqual(self.request('GET', '/api/me', headers={'Cookie': 'relay_session=forged'})[0], 401)

    def test_expired_session(self):
        headers, _ = self.signup('expires')
        from identity import session_key
        token = session_key(headers['Cookie'].split('=', 1)[1])
        with self.server.service.connect() as c:
            c.execute('UPDATE sessions SET expires=0 WHERE token=?', (token,))
        self.assertEqual(self.request('GET', '/api/me', headers=headers)[0], 401)

    def test_body_tenant_and_role_spoof_no_effect(self):
        headers, body = self.signup('spoof')
        status, _, _ = self.request('POST', '/api/demo', dict(org='victim', role='owner'), headers)
        self.assertEqual(status, 200)
        _, _, me = self.request('GET', '/api/me', headers=headers)
        self.assertEqual(me['user']['org'], body['user']['org'])
        self.assertEqual(len(me['branches']), 3)

    def test_unexpected_api_and_content_type(self):
        headers, _ = self.signup('endpoint')
        self.assertEqual(self.request('POST', '/api/profile', dict(role='owner'), headers)[0], 404)
        self.assertEqual(self.request('POST', '/api/demo', {}, headers | {'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('GET', '/api/unknown', headers=headers)[0], 404)

    def test_static_missing_and_traversal_are_not_spa_html(self):
        self.assertEqual(self.request('GET', '/missing-asset.js')[0], 404)
        self.assertEqual(self.request('GET', '/../server/core.py')[0], 404)

    def test_custom_built_static_directory_keeps_traversal_protection(self):
        root = Path(self.temp.name) / 'preview'
        root.mkdir()
        (root / 'assets').mkdir()
        (root / 'index.html').write_text('<title>Synthetic preview</title>')
        (Path(self.temp.name) / 'private.js').write_text('private')
        alternate = create_server(self.db, 0, static_dir=root)
        thread = threading.Thread(target=alternate.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection('127.0.0.1', alternate.server_port)
            for path, expected in [('/', 200), ('/../private.js', 404), ('/missing.js', 404)]:
                connection.request('GET', path)
                response = connection.getresponse()
                self.assertEqual(response.status, expected)
                response.read()
            connection.close()
        finally:
            alternate.shutdown()
            alternate.server_close()
            thread.join()

    def test_custom_static_directory_requires_built_assets(self):
        with self.assertRaisesRegex(ValueError, 'built index.html'):
            create_server(self.db, 0, static_dir=self.temp.name)

    def test_restart_same_database_persists(self):
        headers, _ = self.signup('persist')
        self.request('POST', '/api/demo', {}, headers)
        alternate = create_server(self.db, 0)
        thread = threading.Thread(target=alternate.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection('127.0.0.1', alternate.server_port)
            connection.request('GET', '/api/me', headers={'Cookie': headers['Cookie']})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(len(json.loads(response.read())['employees']), 24)
            connection.close()
        finally:
            alternate.shutdown()
            alternate.server_close()
            thread.join()

    def test_employee_manager_route_denied_over_http(self):
        headers,_=self.signup('http-employee-owner')
        _,_,branch=self.request('POST','/api/branches',dict(name='Synthetic',country='Testland',market='Metro',area='East',timezone='Europe/London'),headers)
        _,_,employee=self.request('POST','/api/employees',dict(name='Synthetic Person',branch=branch['id']),headers)
        self.assertEqual(self.request('POST','/api/members',dict(name='Employee',email='http-employee@example.test',password='fictional-only-123',role='employee',branches=[branch['id']],employee=employee['id']),headers)[0],200)
        status,cookies,me=self.request('POST','/api/signin',dict(email='http-employee@example.test',password='fictional-only-123'))
        self.assertEqual(status,200)
        employee_headers={'Cookie':cookies['Set-Cookie'].split(';')[0],'X-CSRF-Token':me['user']['csrf']}
        self.assertEqual(self.request('GET',f"/api/schedule?branch={branch['id']}&week=2026-10-12",headers=employee_headers)[0],403)
        self.assertEqual(self.request('GET','/api/my-schedule?week=2026-10-12',headers=employee_headers)[0],200)
        self.assertEqual(self.request('POST','/api/schedule',dict(branch=branch['id'],week='2026-10-12',revision=0,shifts=[]),employee_headers)[0],403)

    def test_password_change_clears_cookie_and_revokes_old_session(self):
        headers,_=self.signup('http-password')
        data=dict(current_password='fictional-only-123',password='updated-fictional-only-123')
        self.assertEqual(self.request('POST','/api/password',data,{'Cookie':headers['Cookie']})[0],403)
        status,cookies,result=self.request('POST','/api/password',data,headers)
        self.assertEqual(status,200)
        self.assertTrue(result['signed_out'])
        self.assertIn('Max-Age=0',cookies['Set-Cookie'])
        self.assertEqual(self.request('GET','/api/me',headers=headers)[0],401)
        self.assertEqual(self.request('POST','/api/signin',dict(email='http-password@example.test',password='fictional-only-123'))[0],401)
        self.assertEqual(self.request('POST','/api/signin',dict(email='http-password@example.test',password='updated-fictional-only-123'))[0],200)

    def test_parser_body_bounds_reset_and_no_auth_override(self):
        headers,_=self.signup('http-parser')
        self.assertEqual(self.request('POST','/api/demo',[],headers)[0],422)
        self.assertEqual(self.request('POST','/api/demo',{},headers|{'Content-Length':'2000001'})[0],413)
        self.assertEqual(self.request('POST','/api/password/reset',dict(email='http-parser@example.test',role='owner'),headers)[0],404)
        self.assertEqual(self.request('POST','/api/signin',dict(email='http-parser@example.test',password='fictional-only-123'),{'Origin':'https://evil.example'})[0],403)

    def test_raw_ambiguous_json_rejected_before_signup(self):
        from unittest.mock import patch
        bodies = [b'{"email":"a@example.test","email":"b@example.test"}',
                  b'{"settings":{"max_week_hours":40,"max_week_hours":168}}',
                  b'{"number":NaN}', b'{"number":1e9999}', b'{"name":"\xff"}']
        with patch.object(self.server.service, 'signup') as signup:
            for raw in bodies:
                with self.subTest(length=len(raw)):
                    connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
                    connection.request('POST', '/api/signup', body=raw, headers={'Content-Type': 'application/json'})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 422)
                    self.assertIsNone(response.getheader('Set-Cookie'))
                    self.assertEqual(json.loads(response.read()), {'error': 'Invalid request. Check the fields and try again.'})
                    connection.close()
            signup.assert_not_called()

    def test_failed_signin_rate_limit_over_http(self):
        self.signup('http-throttle')
        data=dict(email='http-throttle@example.test',password='wrong')
        for _ in range(8):
            self.assertEqual(self.request('POST','/api/signin',data)[0],401)
        self.assertEqual(self.request('POST','/api/signin',data)[0],429)


if __name__ == '__main__':
    unittest.main(verbosity=2)
