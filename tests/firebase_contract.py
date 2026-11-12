"""Explicit emulator integration suite. Run with the optional Firebase venv.

This file is deliberately outside default unittest discovery: SQLite remains an
independent regression target. Identity verification helpers below are fixtures,
not application auto-verification.
"""
import concurrent.futures
import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from firebase_service import FirebaseService
from firebase_repository import key
from firebase_admin import auth
from core import Problem,uid
from identity import session_key
import test_core,test_extensions,test_security


class VerifiedFixtureService(FirebaseService):
    """Only tests verify identities through the local Admin emulator."""
    def __init__(self,namespace):
        super().__init__();self.namespace=namespace
    def email(self,value):
        return value if value.startswith(self.namespace+'-') else self.namespace+'-'+value
    def signup(self,data):
        data=data|dict(email=self.email(data['email']))
        super().signup(data)
        return self.signin(dict(email=data['email'],password=data['password']))
    def signin(self,data,client='local'):
        data=data|dict(email=self.email(data.get('email','')))
        # Verification occurs through a fixture-only Admin operation. The browser
        # and dedicated negatives use unmodified FirebaseService methods instead.
        try:
            user=auth.get_user_by_email(data['email'],app=self.identity.app)
            if not user.email_verified:auth.update_user(user.uid,email_verified=True,app=self.identity.app)
        except auth.UserNotFoundError:pass
        return super().signin(data,self.namespace if client=='local' else client)
    def dispatch(self,token,method,path,data,query,csrf=None):
        if method=='POST' and path=='/api/members' and 'email' in data:data=data|dict(email=self.email(data['email']))
        return super().dispatch(token,method,path,data,query,csrf)


class Fixture(unittest.TestCase):
    def setUp(self):
        self.namespace='contract-'+uid()
        self.s=VerifiedFixtureService(self.namespace)
        self.owner=self.s.signup(dict(name='Synthetic Owner',email='owner@example.test',password='fictional-only-123',organization='Synthetic Contract'))
        self.week='2026-10-12'
        self.a=self.call('/branches',dict(name='Alpha',country='Testland',market='Metro',area='East',timezone='Europe/London',coverage=[dict(start='09:00',end='17:00',role='associate',required=1)]))
        self.b=self.call('/branches',dict(name='Beta',country='Testland',market='Metro',area='East',timezone='Europe/London'))
        self.e=self.call('/employees',dict(name='Synthetic Alex',branch=self.a['id'],skills=['associate'],contract_hours=40))
    get=test_core.CoreTests.get
    call=test_core.CoreTests.call
    account=test_core.CoreTests.account
    shift=test_core.CoreTests.shift
    save=test_core.CoreTests.save
    assert_problem=test_core.CoreTests.assert_problem
    leave=test_extensions.ExtensionTests.leave
    demand_csv=test_core.CoreTests.demand_csv


# Reuse actual domain assertions, not copies of implementation. Exclude tests
# that intentionally exercise SQLite SQL/schema/password storage and replace
# those contracts with native tests below. Each included method runs independently.
EXCLUDED={
    'test_signup_signin_signout_persistence','test_password_hash_not_plaintext_and_csrf',
    'test_leave_fiscal_boundary_and_allowance','test_carryover_caps_and_employee_ledger_scope',
    'test_hashed_sessions_idle_expiry_own_revoke_and_password_change','test_persistent_failed_login_throttle',
    'test_ledger_immutable_and_failed_policy_reduction_rolls_back',
    'test_injection_payload_does_not_broaden_tenant_or_execute_sql',
    'test_password_verification_throttle_is_durable_and_csrf_first',
}
for source,name in ((test_core.CoreTests,'NativeCore'),(test_extensions.ExtensionTests,'NativeExtensions'),(test_security.SecurityTests,'NativeSecurity')):
    globals()[name]=type(name,(Fixture,),{n:fn for n,fn in source.__dict__.items() if n.startswith('test_') and n not in EXCLUDED})
del source,name  # Avoid collecting the source SQLite TestCase through this alias.


class NativeIdentityAndStorage(Fixture):
    def test_read_abort_retries_complete_transaction_once(self):
        from google.api_core.exceptions import Aborted
        from firebase_repository import FirestoreRepository
        org=self.get('/api/me')['organization']['id'];calls=[]
        original=FirestoreRepository.entity_put
        def fail_once(c,tenant,kind,data):
            calls.append(kind)
            if len(calls)==1:raise Aborted('Synthetic read-stage abort')
            return original(c,tenant,kind,data)
        with patch.object(FirestoreRepository,'entity_put',fail_once):
            self.call('/employees',dict(name='Synthetic Retried',branch=self.a['id'],skills=['associate'],contract_hours=40))
        self.assertEqual(len(calls),2)
        self.assertEqual(sum(e['name']=='Synthetic Retried' for e in self.get('/api/me')['employees']),1)

    def test_reservation_manifest_retains_published_and_removes_only_released_groups(self):
        self.save([self.shift()],action='publish')
        self.save([],revision=1)
        org=self.get('/api/me')['organization']['id']
        def reserved(c):
            c.bind_org(org);return c.reservations_rows(org,employees={self.e['id']})
        self.assertEqual(len(self.s.run(reserved)),1)
        self.save([],revision=2,action='publish')
        self.assertEqual(self.s.run(reserved),[])
        def missing(c):
            c.bind_org(org)
            c.stage(c._collection(org,'reservation_manifests').document(key(self.e['id'])),dict(employee=self.e['id'],groups=[dict(id='missing',start='2026-10-12',end='2026-10-13')]))
        self.s.run(missing)
        self.assert_problem(lambda:self.s.run(reserved),503)

    def test_client_security_rules_deny_anonymous_and_authenticated_crud(self):
        org=self.get('/api/me')['organization']['id']
        signed=self.s.identity.rest('signInWithPassword',dict(email=self.s.email('owner@example.test'),password='fictional-only-123',returnSecureToken=True))
        root=f'http://{self.s.guard.firestore_host}/v1/projects/{self.s.guard.project}/databases/(default)/documents'
        path=f'/organizations/{key(org)}/entities_employee/{key(self.e["id"])}'
        import requests
        session=requests.Session();session.trust_env=False
        for headers in ({},{'Authorization':'Bearer '+signed['idToken']}):
            for verb,url,payload in [('GET',root+path,None),('PATCH',root+path,{'fields':{'name':{'stringValue':'forged'}}}),('DELETE',root+path,None),('POST',root+f'/organizations/{key(org)}/entities_employee',{'fields':{'id':{'stringValue':'forged'}}})]:
                with self.subTest(authenticated=bool(headers),verb=verb):
                    response=session.request(verb,url,headers=headers,json=payload,timeout=15,allow_redirects=False)
                    self.assertEqual(response.status_code,403,response.text)
        self.assertEqual(self.get('/api/me')['employees'][0]['name'],'Synthetic Alex')

    def test_wrong_project_token_and_forged_role_claims_grant_no_access(self):
        signed=self.s.identity.rest('signInWithPassword',dict(email=self.s.email('owner@example.test'),password='fictional-only-123',returnSecureToken=True))
        import base64
        pieces=signed['idToken'].split('.')
        claims=json.loads(base64.urlsafe_b64decode(pieces[1]+'=='))
        claims['aud']='demo-other-project'
        pieces[1]=base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
        self.assert_problem(lambda:self.s.identity.verify('.'.join(pieces)),401)
        employee=self.account('employee',[self.a['id']],self.e['id'])
        user=self.get('/api/me',token=employee)['user']['id']
        auth.set_custom_user_claims(user,{'role':'owner','org':'forged'},app=self.s.identity.app)
        self.assert_problem(lambda:self.save([],token=employee),403)
        self.assertEqual(self.get('/api/me',token=employee)['user']['role'],'employee')

    def test_unverified_signup_no_membership_then_real_oob_verification(self):
        email=self.namespace+'-unverified@example.test'
        result=FirebaseService.signup(self.s,dict(email=email,password='fictional-only-123',name='Synthetic New',organization='New'))
        self.assertTrue(result['verification_required'])
        user=auth.get_user_by_email(email,app=self.s.identity.app)
        self.assertIsNone(self.s.run(lambda c:c.identity_get(user.uid)))
        result=FirebaseService.signin(self.s,dict(email=email,password='fictional-only-123'))
        self.assertTrue(result['verification_required'])
        from urllib.parse import urlparse,parse_qs
        code=parse_qs(urlparse(result['local_verification_url']).query)['oobCode'][0]
        self.s.identity.rest('update',dict(oobCode=code))
        token=FirebaseService.signin(self.s,dict(email=email,password='fictional-only-123'))
        self.assertEqual(self.get('/api/me',token=token)['user']['role'],'owner')

    def test_disabled_revoked_and_unverified_provider_users_fail_existing_session(self):
        user=self.get('/api/me')['user']['id']
        for change in (dict(disabled=True),dict(email_verified=False)):
            auth.update_user(user,app=self.s.identity.app,**change)
            self.assert_problem(lambda:self.get('/api/me'),401)
            auth.update_user(user,disabled=False,email_verified=True,app=self.s.identity.app)
        # The emulator's revocation timestamp has seconds precision.
        time.sleep(1.05)
        auth.revoke_refresh_tokens(user,app=self.s.identity.app)
        self.assert_problem(lambda:self.get('/api/me'),401)

    def test_restart_persistence_opaque_hashed_sessions_and_no_password_documents(self):
        row=self.s.run(lambda c:c.session_get(session_key(self.owner)))
        self.assertNotEqual(row['token'],self.owner)
        profile=self.s.run(lambda c:c.identity_get(row['user']))
        self.assertFalse({'password','salt','idToken','refreshToken'} & profile.keys())
        restarted=FirebaseService()
        self.assertEqual(restarted.dispatch(self.owner,'GET','/api/me',{}, {})['organization']['name'],'Synthetic Contract')
        self.assert_problem(lambda:restarted.dispatch(self.owner,'POST','/api/demo',{}, {},'forged'),403)
        self.call('/signout',{})
        self.assert_problem(lambda:restarted.dispatch(self.owner,'GET','/api/me',{}, {}),401)

    def test_idle_expiry_and_session_revoke(self):
        other=self.s.signin(dict(email='owner@example.test',password='fictional-only-123'))
        listing=self.get('/api/sessions')
        target=next(r for r in listing if not r['current'])
        self.call('/sessions/revoke',dict(id=target['id']))
        self.assert_problem(lambda:self.get('/api/me',token=other),401)
        def expire(c):
            row=c.session_get(session_key(self.owner))
            c.stage(c.client.collection('sessions').document(row['token']),row|dict(last_seen=time.time()-1801))
        self.s.run(expire)
        self.assert_problem(lambda:self.get('/api/me'),401)

    def test_password_change_provider_and_persistent_throttle(self):
        for _ in range(8):self.assert_problem(lambda:self.call('/password',dict(current_password='wrong',password='new-fictional-pass-456')),401)
        restarted=FirebaseService()
        csrf=self.get('/api/me')['user']['csrf']
        self.assert_problem(lambda:restarted.dispatch(self.owner,'POST','/api/password',dict(current_password='fictional-only-123',password='new-fictional-pass-456'),{},csrf),429)
        self.s.counter_check([('password/'+self.get('/api/me')['user']['id'],8,600)],clear=True)
        self.call('/password',dict(current_password='fictional-only-123',password='new-fictional-pass-456'))
        self.assert_problem(lambda:self.get('/api/me'),401)
        self.assert_problem(lambda:self.s.signin(dict(email='owner@example.test',password='fictional-only-123')),401)
        token=self.s.signin(dict(email='owner@example.test',password='new-fictional-pass-456'))
        self.assertEqual(self.get('/api/me',token=token)['user']['role'],'owner')

    def test_failed_login_counters_persist_across_adapter_restart(self):
        email=self.namespace+'-missing@example.test'
        for _ in range(8):self.assert_problem(lambda:FirebaseService.signin(self.s,dict(email=email,password='wrong')),401)
        restarted=FirebaseService()
        self.assert_problem(lambda:restarted.signin(dict(email=email,password='wrong')),429)

    def test_immutable_chunks_versions_policy_ledger_and_idempotency(self):
        self.save([self.shift()])
        org=self.get('/api/me')['organization']['id']
        def immutable(c):
            c.bind_org(org)
            row=c.query(c._collection(org,'versions'))[0]
            c.stage(c._collection(org,'versions').document(key(row['branch'],row['week'],row['revision'])),row|dict(action='forged'),immutable=True)
        self.assert_problem(lambda:self.s.run(immutable),409)
        args=dict(employee=self.e['id'],days=1,effective=self.week,reason='Synthetic adjustment',idempotency_key='one')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.call('/leave/adjust',args),range(2)))
        self.assertEqual(results[0],results[1])
        def rows(c):
            c.bind_org(org);return c.ledger_rows(org,self.e['id'])
        entries=self.s.run(rows)
        self.assertEqual(sum(r['source']=='adjustment/one' for r in entries),1)
        target=next(r for r in entries if r['source']=='adjustment/one')
        def alter(c):
            c.bind_org(org);c.ledger_add(target|dict(days=5))
        self.assert_problem(lambda:self.s.run(alter),409)

    def test_transport_no_adc_and_only_loopback_urls(self):
        with patch('google.auth.default',side_effect=AssertionError('ADC forbidden')):
            fresh=FirebaseService()
            seen=[]
            old=fresh.identity.guard.assert_auth_url
            def check(url):seen.append(url);old(url)
            with patch.object(type(fresh.guard),'assert_auth_url',lambda _,url:check(url)):
                fresh.dispatch(self.owner,'GET','/api/me',{}, {})
            self.assertTrue(seen)
            self.assertTrue(all(url.startswith('http://127.0.0.1:9099/') for url in seen))
            self.assertEqual(fresh.client._firestore_api.transport._host,'127.0.0.1:8089')

    def test_budget_abort_is_atomic_and_repository_tenant_binding(self):
        org=self.get('/api/me')['organization']['id']
        def oversized(c):
            c.bind_org(org)
            for n in range(401):c.entity_put(org,'bounded-test',dict(id=str(n)))
        self.assert_problem(lambda:self.s.run(oversized),413)
        def count(c):c.bind_org(org);return c.entity_rows(org,'bounded-test')
        self.assertEqual(self.s.run(count),[])
        def cross(c):c.bind_org(org);c.entity_rows('other','employee')
        self.assert_problem(lambda:self.s.run(cross),403)


class NativeHTTP(unittest.TestCase):
    def setUp(self):
        from app import create_server
        import threading,requests
        self.server=create_server(None,0,backend='firebase-emulator')
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.server.server_port}'
        self.http=requests.Session();self.http.trust_env=False
        self.email='http-'+uid()+'@example.test'
        self.password='fictional-only-123'
    def tearDown(self):
        self.http.close();self.server.shutdown();self.server.server_close();self.thread.join()
    def post(self,path,data,**kwargs):return self.http.post(self.base+'/api'+path,json=data,timeout=20,**kwargs)
    def signup(self):return self.post('/signup',dict(email=self.email,password=self.password,name='Synthetic HTTP',organization='Synthetic HTTP'))
    def verified_session(self):
        result=self.signup()
        self.assertEqual(result.status_code,202)
        self.assertNotIn('Set-Cookie',result.headers)
        from urllib.parse import urlparse,parse_qs
        code=parse_qs(urlparse(result.json()['local_verification_url']).query)['oobCode'][0]
        self.server.service.identity.rest('update',dict(oobCode=code))
        result=self.post('/signin',dict(email=self.email,password=self.password))
        self.assertEqual(result.status_code,200,result.text)
        self.assertIn('__session=',result.headers['Set-Cookie'])
        self.assertIn('HttpOnly',result.headers['Set-Cookie'])
        self.assertIn('SameSite=Strict',result.headers['Set-Cookie'])
        return result.json()
    def test_verification_cookie_csrf_signup_signin_signout_wire_contract(self):
        state=self.verified_session()
        branch=dict(name='Synthetic Wire',country='Testland',market='Metro',area='East')
        self.assertEqual(self.post('/branches',branch).status_code,403)
        self.assertEqual(self.post('/branches',branch,headers={'X-CSRF-Token':state['user']['csrf']}).status_code,200)
        self.assertEqual(self.http.get(self.base+'/api/me',timeout=15).status_code,200)
        result=self.post('/signout',{},headers={'X-CSRF-Token':state['user']['csrf']})
        self.assertEqual(result.status_code,200)
        self.assertIn('Max-Age=0',result.headers['Set-Cookie'])
        self.assertEqual(self.http.get(self.base+'/api/me',timeout=15).status_code,401)
    def test_unverified_signin_and_sqlite_cookie_never_grant_authority(self):
        self.assertEqual(self.signup().status_code,202)
        result=self.post('/signin',dict(email=self.email,password=self.password))
        self.assertEqual(result.status_code,202)
        self.assertTrue(result.json()['verification_required'])
        self.assertNotIn('Set-Cookie',result.headers)
        self.http.cookies.set('relay_session','forged-local-cookie')
        self.assertEqual(self.http.get(self.base+'/api/me',timeout=15).status_code,401)
    def test_cross_origin_and_disabled_provider_fail_closed_over_http(self):
        state=self.verified_session()
        self.assertEqual(self.post('/signout',{},headers={'Origin':'https://evil.test','X-CSRF-Token':state['user']['csrf']}).status_code,403)
        self.assertEqual(self.http.get(self.base+'/api/me',timeout=15).status_code,200)
        auth.update_user(state['user']['id'],disabled=True,app=self.server.service.identity.app)
        self.assertEqual(self.http.get(self.base+'/api/me',timeout=15).status_code,401)

if __name__=='__main__':unittest.main(verbosity=2)
