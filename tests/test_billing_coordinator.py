import hashlib, hmac, json, sys, threading, unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from billing_coordinator import BillingCoordinator, scheduled_reconcile
from core import Problem
from lemon_provider import ProviderError

PLAN={'id':'fixture','name':'Fixture','amount_minor':1234,'currency':'USD','interval':'month','variant_id':'55'}
class Unit:
    def __init__(self):self.rows={}
    def control_get(self,col,key):return self.rows.get((col,key))
    def control_put(self,col,key,row):self.rows[(col,key)]=row
class Service:
    def __init__(self):self.local=threading.local();self.unit=Unit();self.role='owner';self.now=lambda:datetime(2026,11,1,tzinfo=timezone.utc)
    def preflight(self,token):
        if token!='valid':raise Problem('Sign in.',401)
        return object()
    def actor(self,c,token):return {'id':'u','org':'org-a','role':self.role,'csrf':'csrf'}
    def run(self,fn):return fn(self.unit)
class Provider:
    store_id='42';test_mode=True
    def __init__(self,service):self.calls=0;self.service=service;self.fail=False;self.revoke=False;self.snapshots={};self.snapshot={'variant_id':55,'status':'active','updated_at':'2026-11-01T01:00:00Z','ends_at':None}
    def create_checkout(self,variant,ref,expires,deadline=None):
        self.calls+=1
        if self.fail:raise ProviderError('timeout',uncertain=True)
        if self.revoke:self.service.role='admin'
        return {'id':'fixture-id','url':'https://fixture.lemonsqueezy.com/checkout'}
    def portal(self,sub,deadline=None):return 'https://fixture.lemonsqueezy.com/billing'
    def subscription(self,sub,deadline=None):return self.snapshots.get(sub,self.snapshot)
    def checkout(self,ident,deadline=None):return {'expires_at':'2020-01-01T00:00:00Z'}

class CoordinatorTests(unittest.TestCase):
    def setUp(self):self.service=Service();self.provider=Provider(self.service);self.billing=BillingCoordinator(self.service,self.provider,[PLAN])
    def test_owner_reservation_and_duplicate_prevention(self):
        self.assertIn('lemonsqueezy.com',self.billing.checkout('valid','csrf','fixture')['url'])
        with self.assertRaises(Problem):self.billing.checkout('valid','csrf','fixture')
        self.assertEqual(self.provider.calls,1)
    def test_uncertain_provider_and_revoked_owner_never_replay(self):
        self.provider.fail=True
        with self.assertRaises(Problem):self.billing.checkout('valid','csrf','fixture')
        self.provider.fail=False
        with self.assertRaises(Problem):self.billing.checkout('valid','csrf','fixture')
        self.assertEqual(self.provider.calls,1)
        self.setUp();self.provider.revoke=True
        with self.assertRaises(Problem):self.billing.checkout('valid','csrf','fixture')
        pending=self.service.unit.control_get('billing_pending','org-a')
        self.assertEqual(pending['state'],'created')
        self.assertEqual(self.service.unit.control_get('billing_refs',pending['ref'])['checkout_id'],'fixture-id')
    def test_owner_csrf_portal_and_disabled_schedule(self):
        self.service.role='admin'
        with self.assertRaises(Problem):self.billing.checkout('valid','csrf','fixture')
        self.service.role='owner'
        with self.assertRaises(Problem):self.billing.checkout('valid','bad','fixture')
        self.service.unit.control_put('billing_orgs','org-a',{'subscription':'19'})
        self.assertIn('billing',self.billing.portal('valid','csrf')['url'])
        with self.assertRaises(Problem):scheduled_reconcile(self.billing,[])

    def test_signed_webhook_is_quarantined_until_authoritative_reconciliation(self):
        self.billing.webhook_secret=b'fixture-secret';self.billing.checkout('valid','csrf','fixture')
        ref=self.service.unit.control_get('billing_pending','org-a')['ref']
        raw=json.dumps({'meta':{'event_name':'subscription_created','custom_data':{'relay_ref':ref}},'data':{'type':'subscriptions','id':'19','attributes':{'variant_id':55,'store_id':42,'test_mode':True,'status':'active','updated_at':'2026-11-01T01:00:00Z','ends_at':None}}}).encode()
        with self.assertRaises(Problem):self.billing.webhook(raw,'0'*64)
        sig=hmac.new(b'fixture-secret',raw,hashlib.sha256).hexdigest()
        self.assertEqual(self.billing.webhook(raw,sig)['result'],'applied')
        self.assertEqual(self.billing.webhook(raw,sig)['result'],'duplicate')
        self.assertFalse(self.billing.access(self.service.unit,{'org':'org-a'}))
        with self.assertRaises(Problem):self.billing.reconcile_organization('org-a',lambda *_:False)
        self.assertEqual(self.billing.reconcile_organization('org-a',lambda *_:True)['status'],'active')
        self.assertTrue(self.billing.access(self.service.unit,{'org':'org-a'}))
        self.assertIsNone(self.service.unit.control_get('billing_pending','org-a'))

    def test_webhook_before_checkout_finalization_keeps_checkout_identity(self):
        self.billing.webhook_secret=b'fixture-secret'
        def racing_checkout(variant,ref,expires,deadline=None):
            raw=json.dumps({'meta':{'event_name':'subscription_created','custom_data':{'relay_ref':ref}},'data':{'type':'subscriptions','id':'19','attributes':{'variant_id':55,'store_id':42,'test_mode':True,'status':'active','updated_at':'2026-11-01T01:00:00Z','ends_at':None}}}).encode()
            self.billing.webhook(raw,hmac.new(b'fixture-secret',raw,hashlib.sha256).hexdigest())
            with self.assertRaises(Problem):self.billing.reconcile_organization('org-a',lambda *_:True)
            return {'id':'fixture-id','url':'https://fixture.lemonsqueezy.com/checkout'}
        self.provider.create_checkout=racing_checkout
        with self.assertRaises(Problem):self.billing.checkout('valid','csrf','fixture')
        ref=self.service.unit.control_get('billing_pending','org-a')['ref']
        self.assertEqual(self.service.unit.control_get('billing_refs',ref)['checkout_id'],'fixture-id')
        self.assertFalse(self.billing.access(self.service.unit,{'org':'org-a'}))
        self.billing.reconcile_organization('org-a',lambda *_:True)
        self.assertIsNone(self.service.unit.control_get('billing_pending','org-a'))

    def test_pending_is_retained_until_authoritative_unpaid_confirmation(self):
        self.billing.checkout('valid','csrf','fixture')
        with self.assertRaises(Problem):self.billing.reconcile_pending('org-a',lambda *_:False)
        self.assertIsNotNone(self.service.unit.control_get('billing_pending','org-a'))
        self.assertEqual(self.billing.reconcile_pending('org-a',lambda *_:True)['status'],'closed')
        self.assertIsNone(self.service.unit.control_get('billing_pending','org-a'))

    def test_replacement_requires_verified_terminal_provider_status_and_quarantines_payment(self):
        oldref='b'*43;old={'subscription':'19','checkout_ref':oldref,'status':'expired','provider_status':'expired','variant':'55','updated_at':'2026-10-30T01:00:00Z','ends_at':'2026-10-30T01:00:00Z'}
        binding={'org':'org-a','subscription':'19','checkout_id':'old','verified':True,'state':'bound','variant':'55'}
        self.service.unit.control_put('billing_orgs','org-a',old);self.service.unit.control_put('billing_refs',oldref,binding)
        self.service.unit.control_put('billing_subscriptions','19',{'org':'org-a'})
        with self.assertRaises(Problem):self.billing.checkout('valid','csrf','fixture')
        self.billing.binding_verifier=lambda *_:True
        for state in ('cancelled','unpaid','active'):
            self.provider.snapshot={'variant_id':55,'status':state,'updated_at':'2026-10-31T01:00:00Z','ends_at':'2026-10-31T01:00:00Z'}
            with self.assertRaises(Problem):self.billing.checkout('valid','csrf','fixture')
        self.provider.snapshot={'variant_id':55,'status':'expired','updated_at':'2026-10-31T01:00:00Z','ends_at':'2026-10-31T01:00:00Z'}
        self.billing.webhook_secret=b'fixture-secret';self.billing.checkout('valid','csrf','fixture')
        ref=self.service.unit.control_get('billing_pending','org-a')['ref']
        with self.assertRaises(Problem):self.billing.checkout('valid','csrf','fixture')
        def event(ref,sub,status,updated):
            raw=json.dumps({'meta':{'event_name':'subscription_updated','custom_data':{'relay_ref':ref}},'data':{'type':'subscriptions','id':sub,'attributes':{'variant_id':55,'store_id':42,'test_mode':True,'status':status,'updated_at':updated,'ends_at':None}}}).encode()
            return self.billing.webhook(raw,hmac.new(b'fixture-secret',raw,hashlib.sha256).hexdigest())
        self.assertEqual(event(ref,'20','active','2026-11-01T01:00:00Z')['result'],'applied')
        self.assertFalse(self.billing.access(self.service.unit,{'org':'org-a'}))
        self.assertEqual(event(oldref,'19','expired','2026-10-29T01:00:00Z')['result'],'old_subscription')
        self.assertEqual(self.service.unit.control_get('billing_orgs','org-a')['subscription'],'20')
        self.assertEqual(event(oldref,'19','active','2026-11-01T02:00:00Z')['result'],'old_subscription')
        self.assertEqual(self.service.unit.control_get('billing_orgs','org-a')['status'],'reconciliation_required')
        self.assertEqual(event(ref,'20','active','2026-11-01T03:00:00Z')['result'],'applied')
        self.assertFalse(self.billing.access(self.service.unit,{'org':'org-a'}))
        with self.assertRaises(Problem):self.billing.reconcile_organization('org-a',lambda *_:True)
        self.provider.snapshots={'19':{'status':'expired','variant_id':55,'updated_at':'2026-11-01T04:00:00Z','ends_at':'2026-10-31T00:00:00Z'},
            '20':{'status':'active','variant_id':55,'updated_at':'2026-11-01T04:00:00Z','ends_at':None}}
        with self.assertRaises(Problem):self.billing.reconcile_replacement_conflict('org-a',lambda *_:False)
        self.assertEqual(self.billing.reconcile_replacement_conflict('org-a',lambda *_:True)['status'],'active')
        self.assertTrue(self.billing.access(self.service.unit,{'org':'org-a'}))
        self.assertEqual(event(oldref,'19','active','2026-11-01T03:30:00Z')['result'],'old_subscription')
        self.assertTrue(self.billing.access(self.service.unit,{'org':'org-a'}))

    def test_old_change_during_checkout_retains_payment_conflict(self):
        oldref='b'*43;old={'subscription':'19','checkout_ref':oldref,'status':'expired','provider_status':'expired','variant':'55','updated_at':'2026-10-30T01:00:00Z','ends_at':'2026-10-30T01:00:00Z'}
        binding={'org':'org-a','subscription':'19','checkout_id':'old','verified':True,'state':'bound','variant':'55'}
        self.service.unit.control_put('billing_orgs','org-a',old);self.service.unit.control_put('billing_refs',oldref,binding)
        self.billing.binding_verifier=lambda *_:True;self.billing.webhook_secret=b'fixture-secret'
        self.provider.snapshot={'variant_id':55,'status':'expired','updated_at':'2026-10-31T01:00:00Z','ends_at':'2026-10-31T01:00:00Z'}
        def event(ref,sub,status,updated):
            raw=json.dumps({'meta':{'event_name':'subscription_updated','custom_data':{'relay_ref':ref}},'data':{'type':'subscriptions','id':sub,'attributes':{'variant_id':55,'store_id':42,'test_mode':True,'status':status,'updated_at':updated,'ends_at':None}}}).encode()
            return self.billing.webhook(raw,hmac.new(b'fixture-secret',raw,hashlib.sha256).hexdigest())
        def racing(variant,ref,expires,deadline=None):
            event(oldref,'19','active','2026-11-01T01:00:00Z')
            return {'id':'fixture-id','url':'https://fixture.lemonsqueezy.com/checkout'}
        self.provider.create_checkout=racing
        with self.assertRaises(Problem):self.billing.checkout('valid','csrf','fixture')
        ref=self.service.unit.control_get('billing_pending','org-a')['ref']
        self.assertEqual(self.service.unit.control_get('billing_refs',ref)['checkout_id'],'fixture-id')
        self.assertTrue(self.service.unit.control_get('billing_refs',ref)['quarantined'])
        self.assertEqual(event(ref,'20','active','2026-11-01T02:00:00Z')['result'],'applied')
        self.assertIsNotNone(self.service.unit.control_get('billing_conflicts','org-a'))
        self.assertFalse(self.billing.access(self.service.unit,{'org':'org-a'}))

    def verified_fixture(self):
        self.test_signed_webhook_is_quarantined_until_authoritative_reconciliation()
        return self.service.unit.control_get('billing_orgs','org-a')['checkout_ref']

    def signed_event(self,ref,**changes):
        attrs={'variant_id':55,'store_id':42,'test_mode':True,'status':'active',
               'updated_at':'2026-11-01T02:00:00Z','ends_at':None}|changes
        raw=json.dumps({'meta':{'event_name':'subscription_updated','custom_data':{'relay_ref':ref,'workspace_id':'attacker-org'}},
                        'data':{'type':'subscriptions','id':'19','attributes':attrs}}).encode()
        return self.billing.webhook(raw,hmac.new(b'fixture-secret',raw,hashlib.sha256).hexdigest())

    def test_known_variant_change_revokes_until_matching_checkout_evidence(self):
        ref=self.verified_fixture()
        self.billing.plans.append(PLAN|{'id':'other','variant_id':'56'})
        self.signed_event(ref,variant_id=56)
        self.assertFalse(self.billing.access(self.service.unit,{'org':'org-a'}))
        self.assertFalse(self.service.unit.control_get('billing_refs',ref)['verified'])
        self.provider.snapshot={'variant_id':56,'status':'active','updated_at':'2026-11-01T03:00:00Z','ends_at':None}
        with self.assertRaises(Problem):self.billing.reconcile_organization('org-a',lambda *_:True)

    def test_equal_timestamp_conflict_commits_quarantine_and_replay_stays_denied(self):
        ref=self.verified_fixture()
        self.assertEqual(self.signed_event(ref,status='expired',updated_at='2026-11-01T01:00:00Z')['result'],'reconciliation_required')
        self.assertFalse(self.billing.access(self.service.unit,{'org':'org-a'}))
        self.assertEqual(self.signed_event(ref,status='expired',updated_at='2026-11-01T01:00:00Z')['result'],'duplicate')
        self.signed_event(ref,updated_at='2026-11-01T03:00:00Z')
        self.assertFalse(self.billing.access(self.service.unit,{'org':'org-a'}))

    def test_webhook_workspace_claim_is_ignored_and_cancellation_expires(self):
        ref=self.verified_fixture()
        end='2026-11-02T00:00:00Z'
        self.signed_event(ref,status='cancelled',ends_at=end)
        self.assertIsNone(self.service.unit.control_get('billing_orgs','attacker-org'))
        self.assertTrue(self.billing.access(self.service.unit,{'org':'org-a'}))
        self.service.now=lambda:datetime(2026,11,2,tzinfo=timezone.utc)
        self.assertFalse(self.billing.access(self.service.unit,{'org':'org-a'}))

if __name__=='__main__':unittest.main()
