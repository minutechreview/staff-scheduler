"""Native emulator-only customer-flow simulation with reserved fictional addresses."""
import contextlib
import concurrent.futures
import hashlib
import http.client
import io
import json
import logging
import sys
import time
import threading
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent))
import native_email_actions as base
from customer_simulation import CustomerSimulationService


class NativeCustomerActions(base.NativeEmailActions):
    def setUp(self):
        provider_patch=patch.object(base,'FirebaseService',CustomerSimulationService)
        provider_patch.start();self.addCleanup(provider_patch.stop)
        self.s=CustomerSimulationService()
        self.context=self.s.request_context();self.context.__enter__()
        self.addCleanup(self.context.__exit__,None,None,None)
        suffix=hashlib.sha256(self._testMethodName.encode()).hexdigest()[:16]
        self.email='native-'+suffix+'@review.example'
        result=self.s.signup(dict(email=self.email,password=base.PASSWORD,
                                  name='Synthetic Customer Owner',organization='Synthetic Customer Workspace'))
        self.assertTrue(result['verification_required'])
        self.verify_code=self.code('VERIFY_EMAIL')

    def test_09_nonfictional_customer_email_is_rejected(self):
        self.rejected(lambda:self.s.signup(dict(email='someone@actual-business.com',password=base.PASSWORD,
                                                name='Forbidden',organization='Forbidden')),422)

    def test_10_http_signin_session_and_signout(self):
        from app import create_server
        self.verified()
        server=create_server('/unused',4333,backend='customer-simulation')
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(),server.server_close(),thread.join()))
        connection=http.client.HTTPConnection('127.0.0.1',4333,timeout=15)
        self.addCleanup(connection.close)
        connection.request('POST','/api/signin',json.dumps(dict(email=self.email,password=base.PASSWORD)),{'Content-Type':'application/json'})
        response=connection.getresponse(); body=json.loads(response.read())
        self.assertEqual(response.status,200)
        cookie=response.getheader('Set-Cookie').split(';',1)[0]
        base.SECRETS.append(cookie)
        csrf=body['user']['csrf']
        connection.request('GET','/api/me',headers={'Cookie':cookie})
        response=connection.getresponse(); response.read(); self.assertEqual(response.status,200)
        connection.request('POST','/api/signout','{}',{'Content-Type':'application/json','Cookie':cookie,'X-CSRF-Token':csrf})
        response=connection.getresponse(); response.read(); self.assertEqual(response.status,200)
        connection.request('GET','/api/me',headers={'Cookie':cookie})
        response=connection.getresponse(); response.read(); self.assertEqual(response.status,401)

    def test_11_customer_adapter_with_emulated_provider(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService()
        self.email='customer-native@example.com'  # RFC-reserved example domain; never delivered.
        result=self.s.signup(dict(email=self.email,password=base.PASSWORD,
                                  name='Fictional Owner',organization='Fictional Company'))
        self.assertTrue(result['verification_required'])
        self.verify_code=self.code('VERIFY_EMAIL')
        old, before=self.verified()
        from production_app import create_application
        self.s.run(lambda c:c.control_put('pilot_controls','global',dict(enabled=True)))
        config=SimpleNamespace(origin='https://fixture.invalid',hosts={'fixture.invalid'},synthetic_only=False)
        application=create_application(self.s,config)
        payload=json.dumps(dict(email=self.email,password=base.PASSWORD)).encode()
        request=dict(REQUEST_METHOD='POST',PATH_INFO='/api/signin',QUERY_STRING='',HTTP_HOST='fixture.invalid',
                     HTTP_ORIGIN=config.origin,CONTENT_TYPE='application/json',CONTENT_LENGTH=str(len(payload)))
        request.update({'wsgi.url_scheme':'https','wsgi.input':io.BytesIO(payload)})
        result=[]
        body=json.loads(b''.join(application(request,lambda status,headers:result.append((status,dict(headers))))))
        self.assertTrue(result[0][0].startswith('200')); self.assertTrue(body['user']['csrf'])
        self.assertIn('Secure',result[0][1]['Set-Cookie']); base.SECRETS.append(result[0][1]['Set-Cookie'])
        code=self.reset_code(); self.reset(code)
        self.rejected(lambda:self.s.dispatch(old,'GET','/api/me',{},{}),401)
        fresh=self.signin(base.NEW_PASSWORD)
        self.assertEqual(self.s.dispatch(fresh,'GET','/api/me',{}, {})['user']['org'],before['user']['org'])
        self.assertFalse(self.s.identity_email_allowed('owner@fictional.test'))

    def test_12_verified_owner_can_reset_before_first_signin(self):
        self.s.complete_email_action(dict(mode='verifyEmail',code=self.verify_code))
        code=self.reset_code()
        self.assertTrue(self.reset(code)['signed_out'])
        token=self.signin(base.NEW_PASSWORD)
        self.assertEqual(self.s.dispatch(token,'GET','/api/me',{}, {})['user']['role'],'owner')

    def test_13_reset_before_first_signin_requires_matching_reservation(self):
        self.s.complete_email_action(dict(mode='verifyEmail',code=self.verify_code))
        user=self.s.identity.user_by_email(self.email)
        self.s.run(lambda c:c.intent_delete(user.uid))
        code=self.reset_code()
        self.rejected(lambda:self.reset(code),401)

    def test_14_customer_acceptance_rejects_non_owner_before_provider(self):
        from customer_live import CustomerFirebaseService
        from firebase_service import FirebaseService
        service=object.__new__(CustomerFirebaseService)
        service.guard=SimpleNamespace(assert_current=lambda:None,allowed_email='owner@example.invalid')
        self.assertTrue(service.identity_email_allowed('owner@example.invalid'))
        self.assertFalse(service.identity_email_allowed('other@example.com'))
        with patch.object(FirebaseService,'signin') as provider_signin:
            self.rejected(lambda:service.signin(dict(email='other@example.com',password=base.PASSWORD)),401)
            provider_signin.assert_not_called()

    def test_15_unverified_signups_do_not_exhaust_customer_capacity(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService()
        original=self.s.guard
        class CustomerGuard:
            reserve_on_verified_login=True
            per_actor_limits=True
            max_tenants=3
            def __getattr__(self,name): return getattr(original,name)
        self.s.guard=CustomerGuard()
        pending=[]
        for index in range(4):
            self.email=f'capacity-{index}@example.com'
            self.s.set_request_actor('/api/signup',dict(email=self.email),None)
            self.s.signup(dict(email=self.email,password=base.PASSWORD,name='Fixture',organization='Fixture'))
            pending.append((self.email,self.code('VERIFY_EMAIL')))
        self.assertIsNone(self.s.run(lambda c:c.control_get('pilot_capacity','global')))
        for email,code in pending[:3]:
            self.email=email
            self.s.set_request_actor('/api/auth/action/complete',dict(code=code),None)
            self.s.complete_email_action(dict(mode='verifyEmail',code=code))
            self.s.set_request_actor('/api/signin',dict(email=email),None);self.signin()
        self.assertEqual(self.s.run(lambda c:c.control_get('pilot_capacity','global'))['reserved'],3)
        self.email,code=pending[3];self.s.set_request_actor('/api/auth/action/complete',dict(code=code),None)
        self.s.complete_email_action(dict(mode='verifyEmail',code=code))
        self.s.set_request_actor('/api/signin',dict(email=self.email),None)
        self.rejected(lambda:self.signin(),409)

    def test_16_customer_anonymous_limits_are_separate_per_account_and_code(self):
        from customer_live import CustomerFirebaseService
        from firebase_service import FirebaseService
        service=object.__new__(CustomerFirebaseService)
        service.guard=SimpleNamespace(per_actor_limits=True)
        service.local=threading.local()
        with patch.object(FirebaseService,'consume_limits') as limits:
            service.set_request_actor('/api/signin',dict(email='first@example.com'),None)
            service.consume_limits([('client/staging-global',30,300)])
            first=limits.call_args.args[0][0][0]
            service.set_request_actor('/api/signin',dict(email='second@example.com'),None)
            service.consume_limits([('client/staging-global',30,300)])
            self.assertNotEqual(first,limits.call_args.args[0][0][0])
            service.set_request_actor('/api/auth/action/check',dict(code='fictional-one'),None)
            service.consume_limits([('email/action/check',30,600)])
            first=limits.call_args.args[0][0][0]
            service.set_request_actor('/api/auth/action/check',dict(code='fictional-one'),'forged-cookie')
            service.consume_limits([('email/action/check',30,600)])
            self.assertEqual(first,limits.call_args.args[0][0][0])
            service.set_request_actor('/api/auth/action/check',dict(code='fictional-two'),None)
            service.consume_limits([('email/action/check',30,600)])
            self.assertNotEqual(first,limits.call_args.args[0][0][0])

    def test_17_customer_signup_conflict_returns_same_generic_result(self):
        from customer_live import CustomerFirebaseService
        from firebase_service import FirebaseService
        service=object.__new__(CustomerFirebaseService);service.guard=SimpleNamespace(per_actor_limits=True)
        with patch.object(FirebaseService,'signup',return_value=dict(verification_required=True)):
            new=service.signup({})
        with patch.object(FirebaseService,'signup',side_effect=base.Problem('existing',409)):
            self.assertEqual(new,service.signup({}))

    def test_18_concurrent_first_signins_enforce_capacity_and_do_not_double_count(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService();original=self.s.guard
        class CustomerGuard:
            reserve_on_verified_login=True
            per_actor_limits=True
            max_tenants=3
            def __getattr__(self,name):return getattr(original,name)
        self.s.guard=CustomerGuard()
        self.s.run(lambda c:c.control_put('pilot_capacity','global',dict(reserved=0)))
        emails=[]
        for index in range(4):
            self.email=f'parallel-capacity-{index}@example.com';emails.append(self.email)
            self.s.set_request_actor('/api/signup',dict(email=self.email),None)
            self.s.signup(dict(email=self.email,password=base.PASSWORD,name='Fixture',organization='Fixture'))
            code=self.code('VERIFY_EMAIL')
            self.s.set_request_actor('/api/auth/action/complete',dict(code=code),None)
            self.s.complete_email_action(dict(mode='verifyEmail',code=code))
        def signin(email):
            try:
                with self.s.request_context():
                    self.s.set_request_actor('/api/signin',dict(email=email),None)
                    token=self.s.signin(dict(email=email,password=base.PASSWORD),'fixture-parallel')
                    base.SECRETS.append(token)
                    return 200
            except base.Problem as error:return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(signin,[emails[0],emails[0]]))
        self.assertTrue(all(result in (200,503) for result in results))
        self.assertLessEqual((self.s.run(lambda c:c.control_get('pilot_capacity','global')) or {}).get('reserved',0),1)
        results=[signin(emails[0]) if result==503 else result for result in results]
        self.assertEqual(results,[200,200])
        self.assertEqual(self.s.run(lambda c:c.control_get('pilot_capacity','global'))['reserved'],1)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results=list(pool.map(signin,emails[1:]))
        self.assertTrue(all(result in (200,409,503) for result in results))
        results=[signin(email) if result==503 else result for email,result in zip(emails[1:],results)]
        self.assertEqual(sorted(results),[200,200,409])
        self.assertEqual(self.s.run(lambda c:c.control_get('pilot_capacity','global'))['reserved'],3)

    def test_19_enrollment_code_is_claimed_by_only_one_concurrent_signup(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService();original=self.s.guard;token='a'*64
        class CustomerGuard:
            reserve_on_verified_login=True
            per_actor_limits=True
            requires_invite=True
            max_tenants=3
            invite_hash=hashlib.sha256(token.encode()).hexdigest()
            invite_expires=time.time()+1800
            def __getattr__(self,name):return getattr(original,name)
        self.s.guard=CustomerGuard()
        def signup(email):
            try:
                with self.s.request_context():
                    self.s.set_request_actor('/api/signup',dict(email=email),None)
                    result=self.s.signup(dict(email=email,password=base.PASSWORD,name='Fixture',
                                              organization='Fixture',enrollment_code=token))
                    return 202 if result.get('verification_required') else 500
            except base.Problem as error:return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            emails=['invite-one@example.com','invite-two@example.com']
            result=list(pool.map(signup,emails))
        self.assertTrue(all(value in (202,403,503) for value in result))
        result=[signup(email) if value==503 else value for email,value in zip(emails,result)]
        self.assertEqual(sorted(result),[202,403])

    def test_20_acceptance_delivery_has_one_provider_submission_per_purpose(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService();original=self.s.guard
        class CustomerGuard:
            requires_invite=True
            invite_hash=hashlib.sha256(b'delivery-fixture').hexdigest()
            invite_expires=time.time()+1800
            def __getattr__(self,name):return getattr(original,name)
        self.s.guard=CustomerGuard(); calls=[]
        self.s.identity.verification=lambda token,email:calls.append('verify')
        self.s.identity.reset_delivery=lambda email:calls.append('reset')
        self.s.bind_acceptance_delivery_limits()
        def verify(_):
            try:self.s.identity.verification('fictional','budget@example.com');return 200
            except base.Problem as error:return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(verify,range(2))),[200,429])
        self.s.identity.reset_delivery('budget@example.com')
        self.rejected(lambda:self.s.identity.reset_delivery('budget@example.com'),429)
        self.assertEqual(calls.count('verify'),1);self.assertEqual(calls.count('reset'),1)

    def test_21_expired_intent_can_be_recreated_by_matching_signup(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService();original=self.s.guard
        class CustomerGuard:
            reserve_on_verified_login=True
            per_actor_limits=True
            max_tenants=3
            def __getattr__(self,name):return getattr(original,name)
        self.s.guard=CustomerGuard();self.email='expired-intent@example.com'
        payload=dict(email=self.email,password=base.PASSWORD,name='Fixture',organization='Fixture')
        self.s.set_request_actor('/api/signup',payload,None);self.s.signup(payload)
        user=self.s.identity.user_by_email(self.email)
        first=self.s.run(lambda c:c.intent_get(user.uid))
        self.assertIsNotNone(first.get('expires_at'))
        self.s.run(lambda c:c.intent_delete(user.uid))
        self.s.signup(payload)
        restored=self.s.run(lambda c:c.intent_get(user.uid))
        self.assertEqual(restored['email'],self.email);self.assertIsNotNone(restored.get('expires_at'))

    def test_22_signin_requires_code_before_provider_or_counters(self):
        from customer_live import CustomerFirebaseService
        from firebase_service import FirebaseService
        service=object.__new__(CustomerFirebaseService)
        service.guard=SimpleNamespace(requires_invite=True,allowed_email='owner@example.invalid',
            invite_hash=hashlib.sha256(b'fixture').hexdigest(),invite_expires=time.time()+1800,assert_current=lambda:None)
        with patch.object(FirebaseService,'signin') as provider:
            self.rejected(lambda:service.signin(dict(email='owner@example.invalid',password=base.PASSWORD)),403)
            provider.assert_not_called()

    def test_23_expired_acceptance_blocks_sessions_and_public_actions(self):
        from customer_live import CustomerFirebaseService
        service=object.__new__(CustomerFirebaseService)
        service.guard=SimpleNamespace(per_actor_limits=True,requires_invite=True,invite_expires=time.time()-1)
        self.rejected(lambda:service.preflight('fictional-session'),401)
        self.rejected(lambda:service.admit_request('/api/auth/action/complete',None),503)

    def test_24_member_provisioning_commits_guarded_job(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService();original=self.s.guard
        class CustomerGuard:
            safe_member_jobs=True
            max_members=5
            def __getattr__(self,name):return getattr(original,name)
        self.s.guard=CustomerGuard();self.email='member-owner@example.com'
        self.s.signup(dict(email=self.email,password=base.PASSWORD,name='Owner',organization='Fixture'))
        self.verify_code=self.code('VERIFY_EMAIL');token,me=self.verified()
        member=dict(email='member-new@example.com',password=base.PASSWORD,name='Member',role='admin',branches=[],areas=[])
        result=self.s.dispatch(token,'POST','/api/members',member,{},me['user']['csrf'])
        self.assertEqual(result['email'],member['email'])
        job=self.s.run(lambda c:c.control_get('provisioning_jobs',member['email']))
        self.assertEqual(job['state'],'committed')

    def test_25_ordinary_wsgi_signup_recovery_and_cross_tenant_denial(self):
        from customer_live import CustomerFirebaseService
        from production_app import create_application
        self.s=CustomerFirebaseService();original=self.s.guard
        class OrdinaryGuard:
            per_actor_limits=True
            reserve_on_verified_login=True
            safe_member_jobs=True
            require_mailbox_password_setup=True
            requires_invite=False
            allowed_email=None
            delivery=True
            max_tenants=20
            max_members=150
            def __getattr__(self,name):return getattr(original,name)
        self.s.guard=OrdinaryGuard()
        self.s.run(lambda c:c.control_put('pilot_controls','global',dict(enabled=True)))
        cfg=SimpleNamespace(origin='https://fixture.invalid',hosts={'fixture.invalid'},synthetic_only=False,requires_invite=False)
        app=create_application(self.s,cfg)
        def call(method,path,data=None,cookie=None,csrf=None):
            raw=json.dumps(data).encode() if data is not None else b''
            target,_,query=path.partition('?')
            env=dict(REQUEST_METHOD=method,PATH_INFO=target,QUERY_STRING=query,HTTP_HOST='fixture.invalid',
                     HTTP_ORIGIN=cfg.origin,CONTENT_TYPE='application/json',CONTENT_LENGTH=str(len(raw)),
                     HTTP_COOKIE=cookie or '',HTTP_X_CSRF_TOKEN=csrf or '')
            env.update({'wsgi.url_scheme':'https','wsgi.input':io.BytesIO(raw)})
            result=[];body=json.loads(b''.join(app(env,lambda status,headers:result.append((int(status.split()[0]),dict(headers))))))
            return result[0][0],result[0][1],body
        status,_,caps=call('GET','/api/capabilities')
        self.assertEqual(status,200);self.assertFalse(caps['signup_invite_required'])
        accounts=[]
        for index in range(2):
            self.email=f'ordinary-{index}@example.com'
            status,_,body=call('POST','/api/signup',dict(email=self.email,password=base.PASSWORD,name='Owner',organization=f'Tenant {index}'))
            self.assertEqual(status,202);self.assertTrue(body['verification_required'])
            code=self.code('VERIFY_EMAIL')
            self.assertEqual(call('POST','/api/auth/action/check',dict(mode='verifyEmail',code=code))[0],200)
            status,_,verification=call('POST','/api/auth/action/complete',dict(mode='verifyEmail',code=code))
            self.assertEqual(status,200);self.assertTrue(verification['password_setup_required'])
            self.assertEqual(call('POST','/api/signin',dict(email=self.email,password=base.PASSWORD))[0],403)
            setup_code=self.code('PASSWORD_RESET')
            self.assertEqual(call('POST','/api/auth/action/complete',dict(mode='resetPassword',code=setup_code,password=base.NEW_PASSWORD))[0],200)
            status,headers,me=call('POST','/api/signin',dict(email=self.email,password=base.NEW_PASSWORD))
            self.assertEqual(status,200);cookie=headers['Set-Cookie'].split(';',1)[0];base.SECRETS.append(cookie)
            accounts.append((self.email,cookie,me['user']['csrf'],me['user']['org']))
        self.assertNotEqual(accounts[0][3],accounts[1][3])
        owner,other=accounts
        branch_data=dict(name='Private branch',country='Testland',market='Metro',area='East',timezone='Europe/London')
        status,_,branch=call('POST','/api/branches',branch_data,owner[1],owner[2]);self.assertEqual(status,200)
        status,_,second=call('POST','/api/branches',branch_data|dict(name='Second branch'),owner[1],owner[2]);self.assertEqual(status,200)
        path='/api/schedule?'+__import__('urllib.parse',fromlist=['urlencode']).urlencode(dict(branch=branch['id'],week='2026-11-02'))
        self.assertIn(call('GET',path,cookie=other[1])[0],(403,404))
        self.assertIn(call('POST','/api/branches',branch|dict(name='Intrusion'),other[1],other[2])[0],(403,404))
        status,_,owner_me=call('GET','/api/me',cookie=owner[1]);self.assertEqual(status,200)
        self.assertEqual(next(x['name'] for x in owner_me['branches'] if x['id']==branch['id']),'Private branch')
        self.email='ordinary-manager@example.com'
        manager=dict(email=self.email,password=base.PASSWORD,name='Manager',role='branch_manager',branches=[branch['id']],areas=[])
        self.assertEqual(call('POST','/api/members',manager,owner[1],owner[2])[0],200)
        self.assertEqual(call('POST','/api/signin',dict(email=self.email,password=base.PASSWORD))[0],202)
        code=self.code('VERIFY_EMAIL')
        self.assertEqual(call('POST','/api/auth/action/complete',dict(mode='verifyEmail',code=code))[0],200)
        self.assertEqual(call('POST','/api/signin',dict(email=self.email,password=base.PASSWORD))[0],403)
        code=self.code('PASSWORD_RESET')
        self.assertEqual(call('POST','/api/auth/action/complete',dict(mode='resetPassword',code=code,password=base.NEW_PASSWORD))[0],200)
        status,headers,_=call('POST','/api/signin',dict(email=self.email,password=base.NEW_PASSWORD));self.assertEqual(status,200)
        manager_cookie=headers['Set-Cookie'].split(';',1)[0];base.SECRETS.append(manager_cookie)
        manager_path='/api/schedule?'+__import__('urllib.parse',fromlist=['urlencode']).urlencode(dict(branch=second['id'],week='2026-11-02'))
        self.assertIn(call('GET',manager_path,cookie=manager_cookie)[0],(403,404))
        self.email=owner[0]
        self.assertEqual(call('POST','/api/recovery/request',dict(email=self.email))[0],202)
        code=self.code('PASSWORD_RESET')
        self.assertEqual(call('POST','/api/auth/action/complete',dict(mode='resetPassword',code=code,password=base.FRESH_PASSWORD))[0],200)
        self.assertEqual(call('GET','/api/me',cookie=owner[1])[0],401)
        self.assertEqual(call('POST','/api/signin',dict(email=self.email,password=base.FRESH_PASSWORD))[0],200)

    def test_26_mailbox_holder_reclaims_unverified_preregistration(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService();original=self.s.guard
        class OrdinaryGuard:
            per_actor_limits=True
            reserve_on_verified_login=True
            require_mailbox_password_setup=True
            delivery=True
            max_tenants=20
            def __getattr__(self,name):return getattr(original,name)
        self.s.guard=OrdinaryGuard();self.email='reclaim-owner@example.com'
        attacker=dict(email=self.email,password=base.PASSWORD,name='Untrusted',organization='Untrusted')
        self.s.set_request_actor('/api/signup',attacker,None);self.s.signup(attacker)
        legitimate=dict(email=self.email,password=base.NEW_PASSWORD,name='Mailbox owner',organization='My team')
        self.assertTrue(self.s.signup(legitimate)['verification_required'])
        code=self.code('PASSWORD_RESET')
        self.s.set_request_actor('/api/auth/action/complete',dict(code=code),None)
        self.assertTrue(self.s.check_email_action(dict(mode='resetPassword',code=code))['workspace_details_required'])
        self.rejected(lambda:self.s.complete_recovery(dict(code=code,password=base.FRESH_PASSWORD)),422)
        result=self.s.complete_recovery(dict(code=code,password=base.FRESH_PASSWORD,name='Mailbox owner',organization='My team'))
        if result.get('verification_required'):
            verify=self.code('VERIFY_EMAIL');self.s.set_request_actor('/api/auth/action/complete',dict(code=verify),None)
            self.assertTrue(self.s.complete_email_action(dict(mode='verifyEmail',code=verify))['verified'])
        self.s.set_request_actor('/api/signin',dict(email=self.email),None)
        self.rejected(lambda:self.s.signin(dict(email=self.email,password=base.PASSWORD)),401)
        token=self.s.signin(dict(email=self.email,password=base.FRESH_PASSWORD));base.SECRETS.append(token)
        me=self.s.dispatch(token,'GET','/api/me',{}, {})
        self.assertEqual(me['user']['role'],'owner');self.assertEqual(me['organization']['name'],'My team')

    def test_27_second_reset_before_first_signin_remains_recoverable(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService();original=self.s.guard
        class Guard:
            per_actor_limits=True;reserve_on_verified_login=True;require_mailbox_password_setup=True;delivery=True;max_tenants=30
            def __getattr__(self,name):return getattr(original,name)
        self.s.guard=Guard();self.email='repeat-reset@example.com'
        payload=dict(email=self.email,password=base.PASSWORD,name='Owner',organization='Team')
        self.s.set_request_actor('/api/signup',payload,None);self.s.signup(payload)
        for password in (base.NEW_PASSWORD,base.FRESH_PASSWORD):
            self.s.set_request_actor('/api/recovery/request',dict(email=self.email),None)
            self.s.request_recovery(dict(email=self.email));code=self.code('PASSWORD_RESET')
            self.s.set_request_actor('/api/auth/action/complete',dict(code=code),None)
            self.assertTrue(self.s.complete_recovery(dict(code=code,password=password))['signed_out'])
        user=self.s.identity.user_by_email(self.email)
        if not user.email_verified:
            verify=self.code('VERIFY_EMAIL');self.s.set_request_actor('/api/auth/action/complete',dict(code=verify),None)
            self.s.complete_email_action(dict(mode='verifyEmail',code=verify))
        self.s.set_request_actor('/api/signin',dict(email=self.email),None)
        token=self.s.signin(dict(email=self.email,password=base.FRESH_PASSWORD));base.SECRETS.append(token)
        self.assertEqual(self.s.dispatch(token,'GET','/api/me',{}, {})['user']['role'],'owner')

    def test_28_verified_race_after_reclaim_does_not_strand_signup(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService();original=self.s.guard
        class Guard:
            per_actor_limits=True;reserve_on_verified_login=True;require_mailbox_password_setup=True;delivery=True;max_tenants=30
            def __getattr__(self,name):return getattr(original,name)
        self.s.guard=Guard();self.email='race-verified@example.com'
        payload=dict(email=self.email,password=base.PASSWORD,name='Owner',organization='Team')
        self.s.set_request_actor('/api/signup',payload,None);self.s.signup(payload)
        stale=self.s.identity.user_by_email(self.email)
        self.s.set_request_actor('/api/recovery/request',dict(email=self.email),None);self.s.request_recovery(dict(email=self.email))
        reset=self.code('PASSWORD_RESET');verify=self.code('VERIFY_EMAIL')
        self.s.set_request_actor('/api/auth/action/complete',dict(code=verify),None)
        self.s.complete_email_action(dict(mode='verifyEmail',code=verify))
        self.s.set_request_actor('/api/auth/action/complete',dict(code=reset),None)
        with patch.object(self.s.identity,'user_by_email',return_value=stale):
            self.s.complete_recovery(dict(code=reset,password=base.NEW_PASSWORD))
        self.s.set_request_actor('/api/signin',dict(email=self.email),None)
        token=self.s.signin(dict(email=self.email,password=base.NEW_PASSWORD));base.SECRETS.append(token)
        self.assertEqual(self.s.dispatch(token,'GET','/api/me',{}, {})['user']['role'],'owner')

    def test_29_reclaim_change_before_transition_stops_before_password_update(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService();original_guard=self.s.guard
        class Guard:
            per_actor_limits=True;reserve_on_verified_login=True;require_mailbox_password_setup=True;delivery=True;max_tenants=30
            def __getattr__(self,name):return getattr(original_guard,name)
        self.s.guard=Guard();self.email='race-reclaim@example.com'
        payload=dict(email=self.email,password=base.PASSWORD,name='Owner',organization='Team')
        self.s.set_request_actor('/api/signup',payload,None);self.s.signup(payload)
        code=self.code('VERIFY_EMAIL');self.s.set_request_actor('/api/auth/action/complete',dict(code=code),None)
        self.s.complete_email_action(dict(mode='verifyEmail',code=code))
        reset=self.code('PASSWORD_RESET');self.s.set_request_actor('/api/auth/action/complete',dict(code=reset),None)
        original=self.s.begin_transition
        def interleave(*args,**kwargs):
            def mark(c):
                job=c.control_get('provisioning_jobs',self.email)
                c.control_put('provisioning_jobs',self.email,job|dict(reclaim_requested=True))
            self.s.run(mark)
            return original(*args,**kwargs)
        with patch.object(self.s,'begin_transition',side_effect=interleave):
            self.rejected(lambda:self.s.complete_recovery(dict(code=reset,password=base.NEW_PASSWORD)),409)
        token=self.s.identity.rest('signInWithPassword',dict(email=self.email,password=base.PASSWORD,returnSecureToken=True))['idToken']
        base.SECRETS.append(token)

    def test_30_intent_expiry_during_reset_restores_verified_snapshot(self):
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService();original_guard=self.s.guard
        class Guard:
            per_actor_limits=True;reserve_on_verified_login=True;require_mailbox_password_setup=True;delivery=True;max_tenants=30
            def __getattr__(self,name):return getattr(original_guard,name)
        self.s.guard=Guard();self.email='ttl-race@example.com'
        payload=dict(email=self.email,password=base.PASSWORD,name='Owner',organization='My original team')
        self.s.set_request_actor('/api/signup',payload,None);self.s.signup(payload)
        code=self.code('VERIFY_EMAIL');self.s.set_request_actor('/api/auth/action/complete',dict(code=code),None)
        self.s.complete_email_action(dict(mode='verifyEmail',code=code))
        reset=self.code('PASSWORD_RESET');self.s.set_request_actor('/api/auth/action/complete',dict(code=reset),None)
        revoke=self.s.identity.revoke
        def expire_intent(uid):
            revoke(uid);self.s.run(lambda c:c.intent_delete(uid))
        with patch.object(self.s.identity,'revoke',side_effect=expire_intent):
            self.assertTrue(self.s.complete_recovery(dict(code=reset,password=base.NEW_PASSWORD))['signed_out'])
        self.s.set_request_actor('/api/signin',dict(email=self.email),None)
        token=self.s.signin(dict(email=self.email,password=base.NEW_PASSWORD));base.SECRETS.append(token)
        self.assertEqual(self.s.dispatch(token,'GET','/api/me',{}, {})['organization']['name'],'My original team')

    def test_31_reset_refreshes_existing_expired_intent_ttl(self):
        from datetime import datetime,timedelta,timezone
        from customer_live import CustomerFirebaseService
        self.s=CustomerFirebaseService();original_guard=self.s.guard
        class Guard:
            per_actor_limits=True;reserve_on_verified_login=True;require_mailbox_password_setup=True;delivery=True;max_tenants=30
            def __getattr__(self,name):return getattr(original_guard,name)
        self.s.guard=Guard();self.email='ttl-refresh@example.com'
        payload=dict(email=self.email,password=base.PASSWORD,name='Owner',organization='Team')
        self.s.set_request_actor('/api/signup',payload,None);self.s.signup(payload)
        user=self.s.identity.user_by_email(self.email)
        def expire(c):
            intent=c.intent_get(user.uid);c.intent_replace(user.uid,intent|dict(expires_at=datetime.now(timezone.utc)-timedelta(days=1)))
        self.s.run(expire)
        verify=self.code('VERIFY_EMAIL');self.s.set_request_actor('/api/auth/action/complete',dict(code=verify),None)
        self.s.complete_email_action(dict(mode='verifyEmail',code=verify))
        reset=self.code('PASSWORD_RESET');self.s.set_request_actor('/api/auth/action/complete',dict(code=reset),None)
        self.s.complete_recovery(dict(code=reset,password=base.NEW_PASSWORD))
        self.assertGreater(self.s.run(lambda c:c.intent_get(user.uid))['expires_at'],datetime.now(timezone.utc)+timedelta(days=1))


if __name__=='__main__':
    logging.disable(logging.CRITICAL)
    stream=io.StringIO();started=time.perf_counter()
    with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
        result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(NativeCustomerActions))
    details=stream.getvalue()
    for secret in sorted(set(base.SECRETS),key=len,reverse=True):details=details.replace(secret,'[REDACTED_SYNTHETIC_SECRET]')
    Path('/evidence/native-email-actions-tests.txt').write_text(details)
    report=dict(project=base.PROJECT,suite='customer-auth-simulation',native_emulators=True,real_email=False,
                tests_run=result.testsRun,failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped),
                success=result.wasSuccessful(),seconds=round(time.perf_counter()-started,3),expiry_verified=False,
                expiry_reason='Auth emulator does not enforce action-code expiry',
                scope='Reserved review.example and example.com identities; emulator-issued codes and local Firestore transactions only')
    Path('/evidence/native-email-actions-result.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report));raise SystemExit(0 if result.wasSuccessful() else 1)
