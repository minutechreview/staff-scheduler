"""Emulator-only billing integration; no provider requests or real email."""
import contextlib, hashlib, hmac, io, json, logging, sys, time, unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parent))
import native_email_actions as base
from customer_simulation import CustomerSimulationService
from billing_fixture_service import SyntheticBilling
from core import Problem
from production_app import create_application

PLAN={'id':'fictional','name':'Fixture','amount_minor':1234,'currency':'USD','interval':'month','variant_id':'55'}
PLAN2={'id':'fictional2','name':'Fixture 2','amount_minor':2345,'currency':'USD','interval':'month','variant_id':'56'}

class NativeBilling(unittest.TestCase):
    def setUp(self):
        self.s=CustomerSimulationService();self.context=self.s.request_context();self.context.__enter__()
        self.addCleanup(self.context.__exit__,None,None,None)
        self.email='billing-'+hashlib.sha256(self._testMethodName.encode()).hexdigest()[:12]+'@review.example'
        self.sub=str(int(hashlib.sha256(self._testMethodName.encode()).hexdigest()[:12],16))
        self.s.signup(dict(email=self.email,password=base.PASSWORD,name='Owner',organization='Fictional'))
        # Read only the synthetic emulator out-of-band verification code.
        fixture=object.__new__(base.NativeEmailActions);fixture.s=self.s;fixture.email=self.email
        code=fixture.code('VERIFY_EMAIL');self.s.complete_email_action(dict(mode='verifyEmail',code=code))
        self.token=self.s.signin(dict(email=self.email,password=base.PASSWORD),'billing-fixture');base.SECRETS.append(self.token)
        self.me=self.s.dispatch(self.token,'GET','/api/me',{},{});self.csrf=self.me['user']['csrf']
        self.billing=SyntheticBilling(self.s,b'fixture-secret',[PLAN,PLAN2]);self.s.billing_fixture=self.billing

    def request(self,path,method='GET',data=None,csrf=None):
        return self.s.dispatch(self.token,method,path,data or {},{},csrf)

    def test_team_active_staff_capacity_and_reactivation(self):
        original=self.s.guard
        class TeamGuard:
            max_staff=50;max_branches=3;count_active_staff=True
            def __getattr__(self,name):return getattr(original,name)
        self.s.guard=TeamGuard();org=self.me['user']['org']
        def seed(c):
            c.bind_org(org)
            for n in range(50):c.entity_put(org,'employee',{'id':f'fixture-{n}','active':True})
        self.s.run(seed)
        def put(c,ident,active):
            c.bind_org(org);self.s.put(c,org,'employee',{'id':ident,'active':active})
        self.s.run(lambda c:put(c,'inactive',False))
        with self.assertRaises(Problem):self.s.run(lambda c:put(c,'extra',True))
        with self.assertRaises(Problem):self.s.run(lambda c:put(c,'inactive',True))
        self.s.run(lambda c:put(c,'fixture-0',False))
        self.s.run(lambda c:put(c,'inactive',True))
        with self.assertRaises(Problem):self.s.run(lambda c:put(c,'fixture-0',True))

    def test_team_capacity_concurrent_final_slot(self):
        original=self.s.guard
        class TeamGuard:
            max_staff=50;max_branches=3;count_active_staff=True
            def __getattr__(self,name):return getattr(original,name)
        self.s.guard=TeamGuard();org=self.me['user']['org']
        def seed(c):
            c.bind_org(org)
            for n in range(49):c.entity_put(org,'employee',{'id':f'fixture-{n}','active':True})
        self.s.run(seed)
        def add(n):
            try:
                with self.s.request_context():
                    def create(c):c.bind_org(org);self.s.put(c,org,'employee',{'id':f'contender-{n}','active':True})
                    self.s.run(create)
                return 200
            except Problem as error:return error.status
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(add,range(2)))
        self.assertEqual(results.count(200),1);self.assertTrue(all(code in (200,409,503) for code in results))
        def count(c):c.bind_org(org);return sum(row.get('active',True) for row in c.entity_rows(org,'employee'))
        self.assertEqual(self.s.run(count),50)

    def event(self,ref,status='active',updated='2026-11-01T01:00:00Z',variant=55,sub=None,ends=None):
        sub=sub or self.sub
        return json.dumps({'meta':{'event_name':'subscription_updated','custom_data':{'relay_ref':ref}},
            'data':{'id':sub,'type':'subscriptions','attributes':{'variant_id':variant,'store_id':42,'status':status,
             'updated_at':updated,'ends_at':ends,'test_mode':True}}},separators=(',',':')).encode()

    def webhook(self,raw,signature=None):
        if signature is None:signature=hmac.new(b'fixture-secret',raw,hashlib.sha256).hexdigest()
        app=create_application(self.s,SimpleNamespace(origin='https://fixture.invalid',hosts={'fixture.invalid'},synthetic_only=True))
        env={'REQUEST_METHOD':'POST','PATH_INFO':'/api/billing/webhook','QUERY_STRING':'','HTTP_HOST':'fixture.invalid',
             'CONTENT_LENGTH':str(len(raw)),'HTTP_X_SIGNATURE':signature,'wsgi.url_scheme':'https','wsgi.input':io.BytesIO(raw)}
        result=[];body=b''.join(app(env,lambda status,headers:result.append(status)))
        return int(result[0].split()[0]),json.loads(body)

    def test_complete_guarded_flow_and_reconciliation(self):
        self.assertEqual(self.request('/api/billing')['status'],'none')
        with self.assertRaises(Problem) as error:self.request('/api/hierarchy')
        self.assertEqual(error.exception.status,402)
        with self.assertRaises(Problem) as error:self.request('/api/billing/checkout','POST',{'plan':'fictional'},'bad')
        self.assertEqual(error.exception.status,403)
        url=self.request('/api/billing/checkout','POST',{'plan':'fictional'},self.csrf)['url'];ref=url.rsplit('/',1)[1]
        raw=self.event(ref);self.assertEqual(self.webhook(raw,'0'*64)[0],401)
        self.assertEqual(self.webhook(raw),(200,{'result':'applied'}));self.assertEqual(self.webhook(raw),(200,{'result':'duplicate'}))
        self.assertTrue(self.request('/api/billing')['entitled']);self.request('/api/hierarchy')
        self.assertEqual(self.webhook(self.event(ref,'cancelled','2026-11-01T02:00:00Z',56,ends='2099-01-01T00:00:00Z'))[0],200)
        self.assertTrue(self.request('/api/billing')['entitled'])
        self.assertEqual(self.webhook(self.event(ref,'active','2026-11-01T00:00:00Z'))[1]['result'],'stale')
        self.assertEqual(self.webhook(self.event(ref,'active','2026-11-01T03:00:00Z',999))[0],200)
        self.assertFalse(self.request('/api/billing')['entitled'])
        self.assertEqual(self.webhook(self.event(ref,'active','2026-11-01T03:30:00Z',56))[0],200)
        self.assertFalse(self.request('/api/billing')['entitled'])
        self.assertIn('/'+self.sub+'/',self.request('/api/billing/portal','POST',{},self.csrf)['url'])
        self.billing.transport.snapshots[self.sub]={'subscription':self.sub,'checkout_ref':ref,'variant':'56','status':'active','updated_at':'2026-11-01T04:00:00Z','ends_at':None}
        self.request('/api/billing/reconcile','POST',{},self.csrf);self.assertTrue(self.request('/api/billing')['entitled'])
        old=self.s.now;self.s.now=lambda:old()+timedelta(hours=25)
        self.assertFalse(self.request('/api/billing')['entitled'])
        self.assertEqual(self.request('/api/me')['user']['org'],self.me['user']['org'])
        self.request('/api/signout','POST',{},self.csrf)

    def test_cross_tenant_sub_binding_and_owner_restriction(self):
        actor={'org':self.me['user']['org'],'role':'owner'}
        with self.assertRaises(Problem):self.s.run(lambda c:self.billing.checkout(c,actor|{'role':'admin'},{'plan':'fictional'}))
        first=self.s.run(lambda c:self.billing.checkout(c,actor,{'plan':'fictional'}))['url'].rsplit('/',1)[1]
        second=self.s.run(lambda c:self.billing.checkout(c,{'org':'other-fictional-org','role':'owner'},{'plan':'fictional'}))['url'].rsplit('/',1)[1]
        self.assertEqual(self.webhook(self.event(first))[0],200)
        self.assertEqual(self.webhook(self.event(second,updated='2026-11-01T02:00:00Z'))[0],403)
        self.assertIsNone(self.s.run(lambda c:c.control_get('billing_orgs','other-fictional-org')))

    def test_late_checkout_remains_quarantined_until_reconciled(self):
        ref=self.request('/api/billing/checkout','POST',{'plan':'fictional'},self.csrf)['url'].rsplit('/',1)[1]
        self.s.run(lambda c:c.control_put('billing_refs',ref,c.control_get('billing_refs',ref)|{'expires':'2020-01-01T00:00:00Z'}))
        self.assertEqual(self.webhook(self.event(ref))[0],200)
        self.assertEqual(self.request('/api/billing')['status'],'reconciliation_required')
        self.assertEqual(self.webhook(self.event(ref,updated='2026-11-01T02:00:00Z'))[0],200)
        self.assertFalse(self.request('/api/billing')['entitled'])
        with self.assertRaises(Problem):self.request('/api/billing/checkout','POST',{'plan':'fictional'},self.csrf)
        self.billing.transport.snapshots[self.sub]={'subscription':self.sub,'checkout_ref':ref,'variant':'55','status':'active','updated_at':'2026-11-01T03:00:00Z','ends_at':None}
        self.request('/api/billing/reconcile','POST',{},self.csrf);self.assertTrue(self.request('/api/billing')['entitled'])

    def test_concurrent_checkout_has_only_one_pending_intent(self):
        actor={'org':self.me['user']['org'],'role':'owner'}
        def issue(_):
            try:
                with self.s.request_context():self.s.run(lambda c:self.billing.checkout(c,actor,{'plan':'fictional'}))
                return 'created'
            except Problem as error:return str(error.status)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(issue,range(2)))
        self.assertEqual(results.count('created'),1);self.assertTrue(all(r in ('created','409','503') for r in results))

    def test_abandoned_checkout_requires_confirmed_fixture_outcome(self):
        ref=self.request('/api/billing/checkout','POST',{'plan':'fictional'},self.csrf)['url'].rsplit('/',1)[1]
        with self.assertRaises(Problem):self.request('/api/billing/reconcile-checkout','POST',{},self.csrf)
        self.billing.transport.checkout_outcomes[ref]='confirmed_abandoned'
        with self.assertRaises(Problem):self.request('/api/billing/reconcile-checkout','POST',{},self.csrf)
        self.billing.transport.checkout_outcomes[ref]='confirmed_expired_unpayable_unpaid'
        self.assertEqual(self.request('/api/billing/reconcile-checkout','POST',{},self.csrf)['status'],'closed')
        self.assertNotEqual(self.request('/api/billing/checkout','POST',{'plan':'fictional'},self.csrf)['url'].rsplit('/',1)[1],ref)

    def test_real_session_role_change_and_tenant_body_cannot_override_scope(self):
        org=self.me['user']['org'];user=self.me['user']['id']
        def change_role(c,role):
            c.bind_org(org);row=c.member_get(org,user);c.member_update(row|{'role':role})
        self.s.run(lambda c:change_role(c,'admin'))
        with self.assertRaises(Problem) as error:self.request('/api/billing/checkout','POST',{'plan':'fictional'},self.csrf)
        self.assertEqual(error.exception.status,403)
        self.s.run(lambda c:change_role(c,'owner'))
        second='other-'+hashlib.sha256(self._testMethodName.encode()).hexdigest()[:12]+'@review.example'
        self.s.signup(dict(email=second,password=base.PASSWORD,name='Other',organization='Other'))
        fixture=object.__new__(base.NativeEmailActions);fixture.s=self.s;fixture.email=second
        self.s.complete_email_action(dict(mode='verifyEmail',code=fixture.code('VERIFY_EMAIL')))
        other=self.s.signin(dict(email=second,password=base.PASSWORD),'billing-other');base.SECRETS.append(other)
        me=self.s.dispatch(other,'GET','/api/me',{},{});self.assertNotEqual(me['user']['org'],org)
        url=self.s.dispatch(other,'POST','/api/billing/checkout',{'plan':'fictional','org':org},{},me['user']['csrf'])['url']
        ref=url.rsplit('/',1)[1]
        self.assertEqual(self.s.run(lambda c:c.control_get('billing_refs',ref))['org'],me['user']['org'])

    def test_coordinator_firestore_checkout_webhook_and_quarantine(self):
        from billing_coordinator import BillingCoordinator
        class Provider:
            store_id='42';test_mode=True
            def create_checkout(self,variant,ref,expires,deadline=None):
                return {'id':'synthetic-checkout','url':'https://fixture.lemonsqueezy.com/checkout/'+ref}
            def subscription(self,sub,deadline=None):
                return {'variant_id':55,'status':'active','updated_at':'2026-11-01T01:00:00Z','ends_at':None}
        self.s.billing_fixture=None;self.s.billing_live=BillingCoordinator(self.s,Provider(),[PLAN],b'fixture-secret')
        self.s.run(lambda c:c.control_put('pilot_controls','global',{'enabled':True}))
        app=create_application(self.s,SimpleNamespace(origin='https://fixture.invalid',hosts={'fixture.invalid'},synthetic_only=True))
        body=json.dumps({'plan':'fictional'}).encode();env={'REQUEST_METHOD':'POST','PATH_INFO':'/api/billing/checkout',
            'QUERY_STRING':'','HTTP_HOST':'fixture.invalid','HTTP_ORIGIN':'https://fixture.invalid',
            'HTTP_COOKIE':'__session='+self.token,'HTTP_X_CSRF_TOKEN':self.csrf,'CONTENT_TYPE':'application/json',
            'CONTENT_LENGTH':str(len(body)),'wsgi.url_scheme':'https','wsgi.input':io.BytesIO(body)}
        result=[];value=json.loads(b''.join(app(env,lambda status,headers:result.append(status))))
        self.assertTrue(result[0].startswith('200'),str((result[0],value)));ref=value['url'].rsplit('/',1)[1]
        self.assertEqual(self.webhook(self.event(ref))[0],200)
        with self.assertRaises(Problem) as error:self.request('/api/hierarchy')
        self.assertEqual(error.exception.status,402)
        self.s.billing_live.reconcile_organization(self.me['user']['org'],lambda *_:True)
        self.request('/api/hierarchy')

    def test_replacement_checkout_fenced_and_old_events_do_not_take_over(self):
        from billing_coordinator import BillingCoordinator
        class Provider:
            store_id='42';test_mode=True
            def __init__(self):self.calls=0
            def create_checkout(self,variant,ref,expires,deadline=None):
                self.calls+=1;return {'id':'synthetic-checkout','url':'https://fixture.lemonsqueezy.com/checkout/'+ref}
            def subscription(self,sub,deadline=None):
                return {'variant_id':55,'status':'expired','updated_at':'2026-10-31T00:00:00Z','ends_at':'2026-10-31T00:00:00Z'}
        provider=Provider();self.s.billing_fixture=None
        self.s.billing_live=BillingCoordinator(self.s,provider,[PLAN],b'fixture-secret',lambda *_:True)
        org=self.me['user']['org'];oldref='b'*43
        old={'subscription':self.sub,'checkout_ref':oldref,'status':'expired','provider_status':'expired','variant':'55','updated_at':'2026-10-30T00:00:00Z','ends_at':'2026-10-30T00:00:00Z'}
        def seed(c):
            c.control_put('billing_orgs',org,old);c.control_put('billing_refs',oldref,{'org':org,'subscription':self.sub,'checkout_id':'old','state':'bound','verified':True,'variant':'55'})
            c.control_put('billing_subscriptions',self.sub,{'org':org})
        self.s.run(seed)
        def start(_):
            try:
                with self.s.request_context():return self.s.billing_live.checkout(self.token,self.csrf,'fictional')['url']
            except Problem as error:return 'error:'+str(error.status)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(start,range(2)))
        urls=[r for r in results if r.startswith('https://')];self.assertEqual(len(urls),1);self.assertEqual(provider.calls,1)
        ref=urls[0].rsplit('/',1)[1];newsub=str(int(self.sub)+1)
        self.assertEqual(self.webhook(self.event(ref,sub=newsub))[0],200)
        self.assertEqual(self.webhook(self.event(oldref,'expired','2026-10-29T00:00:00Z'))[1]['result'],'old_subscription')
        row=self.s.run(lambda c:c.control_get('billing_orgs',org));self.assertEqual(row['subscription'],newsub);self.assertEqual(row['status'],'reconciliation_required')

if __name__=='__main__':
    logging.disable(logging.CRITICAL);stream=io.StringIO();started=time.perf_counter()
    with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
        result=unittest.TextTestRunner(stream=stream,verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(NativeBilling))
    details=stream.getvalue()
    for secret in sorted(set(base.SECRETS),key=len,reverse=True):details=details.replace(secret,'[REDACTED]')
    Path('/evidence/native-email-actions-tests.txt').write_text(details)
    report=dict(suite='billing-emulator',native_emulators=True,real_email=False,tests_run=result.testsRun,failures=len(result.failures),errors=len(result.errors),success=result.wasSuccessful(),seconds=round(time.perf_counter()-started,3))
    Path('/evidence/native-email-actions-result.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report));raise SystemExit(0 if result.wasSuccessful() else 1)
