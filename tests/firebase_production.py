"""Production lifecycle against synthetic loopback Auth/Firestore only."""
import concurrent.futures
import io
import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from firebase_contract import Fixture
from firebase_service import FirebaseService
from firebase_repository import FirestoreRepository
from firebase_admin import auth
from core import Problem,uid
from identity import session_key
from production_app import create_application
from production_config import ProductionConfig


class LifecycleTests(Fixture):
    def email(self):return self.s.email('owner@example.test')
    def code(self):
        self.s.request_recovery(dict(email=self.email()))
        url=f'http://{self.s.guard.auth_host}/emulator/v1/projects/{self.s.guard.project}/oobCodes'
        self.s.guard.assert_auth_url(url)
        codes=self.s.identity.http.get(url,timeout=15,allow_redirects=False).json()['oobCodes']
        return [r for r in codes if r['email']==self.email() and r['requestType']=='PASSWORD_RESET'][-1]['oobCode']

    def test_atomic_limit_reservation_under_concurrent_successful_attempts(self):
        name='concurrent/'+self.namespace
        def attempt(_):
            try:self.s.consume_limits([(name,3,600)]);return 200
            except Problem as error:return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:results=list(pool.map(attempt,range(6)))
        self.assertLessEqual(results.count(200),3)
        self.assertTrue(set(results)<= {200,429,503})
        committed=len(self.s.run(lambda c:c.counter(name))['attempts'])
        self.assertEqual(committed,results.count(200))
        # Contention may exhaust the bounded retry budget (503). It must not
        # bypass admission; fill any rolled-back slots and verify the hard limit.
        for _ in range(3-committed):self.s.consume_limits([(name,3,600)])
        self.assert_problem(lambda:self.s.consume_limits([(name,3,600)]),429)
        self.assertEqual(len(self.s.run(lambda c:c.counter(name))['attempts']),3)

    def test_same_second_password_transition_revokes_by_epoch(self):
        user=self.get('/api/me')['user']['id']
        before=self.s.run(lambda c:c.session_get(session_key(self.owner)))
        operation='epoch-fixture';epoch=self.s.begin_transition(user,operation,'password-change')
        self.assert_problem(lambda:self.get('/api/me'),401)
        self.s.finish_transition(user,operation,epoch)
        # Provider valid_after was never changed. Old session still fails by epoch.
        self.assertEqual(before['valid_after'],self.s.identity.user(user).tokens_valid_after_timestamp)
        self.assert_problem(lambda:self.get('/api/me'),401)
        token=FirebaseService.signin(self.s,dict(email=self.email(),password='fictional-only-123'))
        self.assertEqual(self.get('/api/me',token=token)['user']['id'],user)

    def test_provider_password_success_acknowledgement_loss_stays_blocked(self):
        actor=self.get('/api/me')['user'];original=self.s.identity.change_password
        def lost(uid,password):original(uid,password);raise RuntimeError('Synthetic lost provider acknowledgement')
        with patch.object(self.s.identity,'change_password',side_effect=lost),self.assertRaises(RuntimeError):
            self.call('/password',dict(current_password='fictional-only-123',password='synthetic-updated-456'))
        self.assertTrue(self.s.run(lambda c:c.security(actor['id']))['blocked'])
        restarted=FirebaseService()
        self.assert_problem(lambda:restarted.dispatch(self.owner,'GET','/api/me',{},{}),401)
        self.assert_problem(lambda:restarted.signin(dict(email=self.email(),password='synthetic-updated-456')),401)

    def test_invalid_recovery_code_does_not_change_epoch_or_password(self):
        user=self.get('/api/me')['user']['id'];before=self.s.run(lambda c:c.security(user))
        self.assert_problem(lambda:self.s.complete_recovery(dict(code='synthetic-invalid',password='synthetic-reset-456')),401)
        self.assertEqual(self.s.run(lambda c:c.security(user)),before)
        self.assertEqual(self.get('/api/me')['user']['id'],user)

    def test_recovery_is_one_use_preserves_org_and_invalidates_old_session(self):
        state=self.get('/api/me');code=self.code()
        result=self.s.complete_recovery(dict(code=code,password='synthetic-reset-456'))
        self.assertTrue(result['signed_out']);self.assert_problem(lambda:self.get('/api/me'),401)
        self.assert_problem(lambda:self.s.complete_recovery(dict(code=code,password='synthetic-reset-789')),401)
        token=FirebaseService.signin(self.s,dict(email=self.email(),password='synthetic-reset-456'))
        self.assertEqual(self.get('/api/me',token=token)['organization']['id'],state['organization']['id'])

    def test_ambiguous_consumed_reset_recovers_with_fresh_code_and_epoch_fence(self):
        user=self.get('/api/me')['user']['id'];code=self.code();original=self.s.identity.rest
        def lost(action,data):
            result=original(action,data)
            if action=='resetPassword' and 'newPassword' in data:raise RuntimeError('Synthetic response lost')
            return result
        with patch.object(self.s.identity,'rest',side_effect=lost),self.assertRaises(RuntimeError):
            self.s.complete_recovery(dict(code=code,password='synthetic-reset-456'))
        stale=self.s.run(lambda c:c.security(user));self.assertTrue(stale['blocked'])
        fresh=self.code()
        self.assert_problem(lambda:self.s.complete_recovery(dict(code=fresh,password='synthetic-reset-789')),409)
        self.s.run(lambda c:c.security_put(user,stale|dict(started=time.time()-121)))
        self.s.complete_recovery(dict(code=fresh,password='synthetic-reset-789'))
        current=self.s.run(lambda c:c.security(user));self.assertFalse(current['blocked']);self.assertGreater(current['epoch'],stale['epoch'])
        self.assert_problem(lambda:self.s.finish_transition(user,stale['operation'],stale['epoch']),409)
        token=FirebaseService.signin(self.s,dict(email=self.email(),password='synthetic-reset-789'))
        self.assertEqual(self.get('/api/me',token=token)['user']['id'],user)

    def test_disabled_membership_recovery_never_reenables_access(self):
        code=self.code();state=self.get('/api/me');user=state['user']['id'];org=state['organization']['id']
        def disable(c):
            c.bind_org(org);member=c.member_get(org,user);c.member_update(member|dict(enabled=False))
        self.s.run(disable)
        self.assert_problem(lambda:self.s.complete_recovery(dict(code=code,password='synthetic-reset-456')),401)
        self.assert_problem(lambda:FirebaseService.signin(self.s,dict(email=self.email(),password='fictional-only-123')),401)
        self.assertEqual(self.s.run(lambda c:c.security(user))['epoch'],0)

    def test_signup_uid_reserved_before_provider_call_and_survives_lost_response(self):
        email=self.namespace+'-reserved@fixture.test'
        data=dict(email=email,password='synthetic-reserved-456',name='Synthetic',organization='Reserved')
        original=self.s.identity.create;created=[]
        def lost(*args,**kwargs):
            job=self.s.run(lambda c:c.control_get('provisioning_jobs',email))
            self.assertEqual(job['uid'],kwargs['uid']);self.assertNotIn('password',job)
            result=original(*args,**kwargs);created.append(result.uid)
            raise RuntimeError('Synthetic provider acknowledgement lost')
        with patch.object(self.s.identity,'create',side_effect=lost),self.assertRaises(RuntimeError):FirebaseService.signup(self.s,data)
        self.assertEqual(self.s.identity.user(created[0]).email,email)
        with patch.object(self.s.identity,'create',side_effect=AssertionError('Must reuse reserved UID')):
            result=FirebaseService.signup(self.s,data)
        self.assertTrue(result['verification_required'])
        self.assertEqual(self.s.run(lambda c:c.control_get('provisioning_jobs',email))['uid'],created[0])

    def test_existing_provider_email_never_auto_links_and_no_compensation_delete(self):
        email=self.namespace+'-existing@fixture.test'
        existing=self.s.identity.create(email,'synthetic-existing-456','Synthetic Existing')
        with patch.object(self.s.identity,'delete',side_effect=AssertionError('Never delete pre-existing identity')):
            self.assert_problem(lambda:FirebaseService.signup(self.s,dict(email=email,password='synthetic-existing-456',name='Synthetic',organization='Attacker')),409)
        self.assertIsNone(self.s.run(lambda c:c.identity_get(existing.uid)))
        self.assertEqual(self.s.identity.user(existing.uid).email,email)

    def test_member_response_loss_is_resumable_with_authority_rechecked(self):
        email=self.s.email('pending-member@fixture.test')
        data=dict(email=email,password='synthetic-member-456',name='Synthetic Member',role='branch_manager',branches=[self.a['id']])
        original=self.s.identity.create;created=[]
        def lost(*args,**kwargs):
            result=original(*args,**kwargs);created.append(result.uid);raise RuntimeError('Synthetic provider response loss')
        with patch.object(self.s.identity,'create',side_effect=lost),self.assertRaises(RuntimeError):self.call('/members',data)
        restarted=FirebaseService();csrf=self.get('/api/me')['user']['csrf']
        result=restarted.dispatch(self.owner,'POST','/api/members',data,{},csrf)
        self.assertEqual(result['id'],created[0]);self.assertEqual(result['role'],'branch_manager')

    def test_read_budget_rolls_back_without_partial_mutation(self):
        original=FirestoreRepository.check_read_budget
        def bounded(c):
            original(c)
            if c.metrics['query_documents']>1:raise Problem('Synthetic read budget exceeded',413)
        with patch.object(FirestoreRepository,'check_read_budget',bounded):
            self.assert_problem(lambda:self.call('/demo',{}),413)
        self.assertEqual(len(self.get('/api/me')['employees']),1)

    def test_staging_global_disable_and_per_tenant_capacity(self):
        self.s.run(lambda c:c.control_put('pilot_controls','global',dict(enabled=False)))
        self.assert_problem(lambda:self.s.admit_request('/api/me',self.owner),503)
        self.s.run(lambda c:c.control_put('pilot_controls','global',dict(enabled=True)))
        self.s.admit_request('/api/me',self.owner)
        base=self.s.guard
        class BoundedGuard:
            max_branches=2;max_staff=1
            def assert_current(_):base.assert_current()
            def __getattr__(_,name):return getattr(base,name)
        self.s.guard=BoundedGuard()
        self.assert_problem(lambda:self.call('/employees',dict(name='Over capacity',branch=self.a['id'])),409)
        self.assert_problem(lambda:self.call('/branches',dict(name='Over capacity',country='Testland',market='Metro',area='East',timezone='Europe/London')),409)
        self.assertEqual(len(self.get('/api/me')['employees']),1)

    def test_wsgi_real_firebase_sessions_tenant_denial_and_deadline_commit(self):
        self.s.run(lambda c:c.control_put('pilot_controls','global',dict(enabled=True)))
        config=ProductionConfig(self.s.guard.project,'relay-saas-staging','https://fixture.web.app','fixture.run.app','synthetic-key')
        app=create_application(self.s,config)
        csrf=self.get('/api/me')['user']['csrf']
        def request(method,path,data=None,token=None,csrf_token=None,origin=config.origin):
            raw=json.dumps(data).encode() if data is not None else b''
            target,_,query=path.partition('?')
            environ=dict(REQUEST_METHOD=method,PATH_INFO=target,QUERY_STRING=query,HTTP_HOST='fixture.web.app',HTTP_ORIGIN=origin,
                         CONTENT_TYPE='application/json',CONTENT_LENGTH=str(len(raw)),HTTP_COOKIE='__session='+(token or ''),
                         HTTP_X_CSRF_TOKEN=csrf_token or '')
            environ.update({'wsgi.url_scheme':'https','wsgi.input':io.BytesIO(raw)})
            response=[];body=app(environ,lambda s,h:response.append((int(s.split()[0]),dict(h))))
            return response[0][0],response[0][1],json.loads(b''.join(body))
        self.assertEqual(request('GET','/api/me',token=self.owner)[0],200)
        self.assertEqual(request('POST','/api/employees',dict(name='Synthetic HTTPS',branch=self.a['id']),self.owner,csrf)[0],200)
        self.assertEqual(request('POST','/api/employees',dict(name='Forged',branch=self.a['id']),self.owner,'forged')[0],403)
        self.assertEqual(request('POST','/api/employees',dict(name='Forged',branch=self.a['id']),self.owner,csrf,'https://evil.test')[0],403)
        other=self.s.signup(dict(name='Other',email='other@fixture.test',password='fictional-only-123',organization='Other'))
        self.assertEqual(request('GET',f"/api/schedule?branch={self.a['id']}&week={self.week}",token=other)[0],403)
        status,headers,_=request('POST','/api/signout',{},self.owner,csrf)
        self.assertEqual(status,200);self.assertIn('Secure',headers['Set-Cookie']);self.assertIn('Max-Age=0',headers['Set-Cookie'])
        self.assertEqual(request('GET','/api/me',token=self.owner)[0],401)
        self.s.local.deadline=time.monotonic()-1
        try:self.assert_problem(lambda:self.s.run(lambda c:c.counter('expired-fixture')),503)
        finally:self.s.local.deadline=None


if __name__=='__main__':unittest.main(verbosity=2)
