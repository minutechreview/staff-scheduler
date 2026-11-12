import copy, sqlite3, sys, tempfile, unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from billing_attempt_evidence import EvidenceError, evaluate, fixture_consume, fixture_schema, tag

class AttemptEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.secret=b'synthetic-only-secret-'+b'x'*32
        self.attempt={'ref':'a'*43,'org':'tenant-a','plan':'fixture','variant':'55','price_id':'66','store':'42','test_mode':True,
                      'amount_minor':1200,'currency':'USD','interval':'month','interval_count':1,'issued_at':'2026-11-04T10:00:00Z','expires_at':'2026-11-04T10:30:00Z'}
        self.sub={'id':'100','order_id':200,'order_item_id':300,'customer_id':400,'variant_id':55,'store_id':42,'test_mode':True,'status':'active','first_subscription_item':{'price_id':66,'quantity':1}}
        self.order={'id':'200','customer_id':400,'store_id':42,'test_mode':True,'status':'paid','refunded':False,'discount_total':0,'refunded_amount':0,'total':1200,'currency':'USD','created_at':'2026-11-04T10:25:00Z'}
        self.item={'id':'300','order_id':200,'variant_id':55,'price':1200,'quantity':1}
        self.variant={'id':'55','test_mode':True}
        self.price={'id':'66','variant_id':55,'category':'subscription','scheme':'standard','unit_price':1200,'usage_aggregation':None,'setup_fee_enabled':False,'trial_interval_unit':None,'renewal_interval_unit':'month','renewal_interval_quantity':1}
    def check(self,attempt=None,ref=None,signature=None,sub=None,order=None,item=None,variant=None,price=None):
        a=attempt or self.attempt
        return evaluate(self.secret,a,ref or a['ref'],signature or tag(self.secret,self.attempt),sub or self.sub,order or self.order,item or self.item,variant or self.variant,price or self.price)
    def test_signed_attempt_and_independently_retrieved_facts(self):
        self.assertEqual(self.check()['org'],'tenant-a')
        self.assertEqual(self.check()['evidence_status'],'insufficient_checkout_provenance')
        # A late webhook is not treated as a new checkout. Creation time is
        # checked as chronology only; it does not establish settlement time.
        self.assertEqual(self.check()['order'],'200')
    def test_lkr_test_price_still_requires_independent_checkout_provenance(self):
        # The owner's existing LKR 3,990 test product is a synthetic fixture,
        # not a selected live price or evidence of provider checkout origin.
        attempt=self.attempt|{'amount_minor':399000,'currency':'LKR'}
        order=self.order|{'total':399000,'currency':'LKR'}
        item=self.item|{'price':399000}
        price=self.price|{'unit_price':399000}
        result=self.check(attempt=attempt,signature=tag(self.secret,attempt),order=order,item=item,price=price)
        self.assertEqual(result['evidence_status'],'insufficient_checkout_provenance')
        self.assertEqual(result['org'],'tenant-a')
        for wrong_order in (order|{'currency':'USD'},):
            with self.subTest(order=wrong_order),self.assertRaises(EvidenceError):
                self.check(attempt=attempt,signature=tag(self.secret,attempt),order=wrong_order,item=item,price=price)
        for wrong_item in (item|{'price':1200},item|{'price':3990}):
            with self.subTest(item=wrong_item),self.assertRaises(EvidenceError):
                self.check(attempt=attempt,signature=tag(self.secret,attempt),order=order,item=wrong_item,price=price)

    def test_signed_currency_cannot_be_changed_to_lkr(self):
        with self.assertRaises(EvidenceError):
            self.check(attempt=self.attempt|{'currency':'LKR'})

    def test_different_qualifying_order_exposes_missing_provenance(self):
        # These provider objects are internally consistent but cannot show
        # which checkout produced them. A copied bearer attempt cannot supply
        # the missing relationship; results remain explicitly untrusted.
        other_sub=self.sub|{'id':'101','order_id':201,'order_item_id':301,'customer_id':401}
        other_order=self.order|{'id':'201','customer_id':401}
        other_item=self.item|{'id':'301','order_id':201}
        result=self.check(sub=other_sub,order=other_order,item=other_item)
        self.assertEqual(result['evidence_status'],'insufficient_checkout_provenance')
    def test_tampering_tenant_plan_mode_interval_and_signature(self):
        for field,value in [('org','tenant-b'),('plan','other'),('variant','56'),('price_id','77'),('store','99'),('test_mode',False),('interval','year'),('interval_count',3),('amount_minor',1)]:
            with self.subTest(field=field),self.assertRaises(EvidenceError):self.check(attempt=self.attempt|{field:value})
        with self.assertRaises(EvidenceError):self.check(ref='b'*43)
        with self.assertRaises(EvidenceError):self.check(signature='0'*64)
    def test_payment_binding_prevents_cross_order_and_prepayment_grant(self):
        cases=[('sub',self.sub|{'order_id':999}),('sub',self.sub|{'customer_id':999}),('sub',self.sub|{'test_mode':False}),('sub',self.sub|{'status':'on_trial'}),('sub',self.sub|{'first_subscription_item':{'price_id':77}}),
               ('order',self.order|{'status':'pending'}),('order',self.order|{'refunded':True}),('order',self.order|{'created_at':'2026-11-04T10:31:00Z'}),
               ('order',self.order|{'discount_total':1200,'total':0}),('order',self.order|{'refunded_amount':1}),
               ('item',self.item|{'variant_id':56}),('item',self.item|{'price':10}),('item',self.item|{'quantity':2}),('price',self.price|{'renewal_interval_unit':'year'}),('price',self.price|{'unit_price':999}),('price',self.price|{'scheme':'graduated'})]
        for key,value in cases:
            with self.subTest(key=key,value=value),self.assertRaises(EvidenceError):self.check(**{key:value})
    def test_replay_deduplication_and_conflicting_claims_quarantine_both(self):
        c=sqlite3.connect(':memory:');fixture_schema(c);claim=self.check()
        self.assertEqual(fixture_consume(c,claim),'consumed');self.assertEqual(fixture_consume(c,claim),'duplicate')
        self.assertEqual(fixture_consume(c,claim|{'ref':'b'*43,'org':'tenant-b'}),'review')
        self.assertEqual(fixture_consume(c,claim),'review')
        self.assertEqual(c.execute('SELECT COUNT(*) FROM review').fetchone()[0],2)
    def test_same_attempt_multiple_paid_orders_quarantines(self):
        c=sqlite3.connect(':memory:');fixture_schema(c);claim=self.check()
        self.assertEqual(fixture_consume(c,claim),'consumed')
        self.assertEqual(fixture_consume(c,claim|{'order':'201','subscription':'101'}),'review')
        self.assertEqual(fixture_consume(c,claim),'review')
    def test_combined_identities_quarantine_all_prior_claims(self):
        c=sqlite3.connect(':memory:');fixture_schema(c);claim=self.check()
        other=claim|{'ref':'b'*43,'org':'tenant-b','subscription':'101','order':'201'}
        self.assertEqual(fixture_consume(c,claim),'consumed');self.assertEqual(fixture_consume(c,other),'consumed')
        self.assertEqual(fixture_consume(c,claim|{'ref':'c'*43,'org':'tenant-c','order':'201'}),'review')
        self.assertEqual(c.execute('SELECT COUNT(*) FROM review').fetchone()[0],3)
        self.assertEqual(fixture_consume(c,claim),'review');self.assertEqual(fixture_consume(c,other),'review')
    def test_existing_attempt_reassigned_to_other_payment_quarantines_both(self):
        c=sqlite3.connect(':memory:');fixture_schema(c);claim=self.check()
        other=claim|{'ref':'b'*43,'org':'tenant-b','subscription':'101','order':'201'}
        self.assertEqual(fixture_consume(c,claim),'consumed');self.assertEqual(fixture_consume(c,other),'consumed')
        self.assertEqual(fixture_consume(c,claim|{'subscription':'101','order':'201'}),'review')
        self.assertEqual(fixture_consume(c,other),'review')
        self.assertEqual(c.execute('SELECT COUNT(*) FROM review').fetchone()[0],2)
    def test_reviewed_attempt_with_other_payment_also_quarantines_other(self):
        c=sqlite3.connect(':memory:');fixture_schema(c);claim=self.check()
        other=claim|{'ref':'b'*43,'org':'tenant-b','subscription':'101','order':'201'}
        self.assertEqual(fixture_consume(c,claim),'consumed');self.assertEqual(fixture_consume(c,other),'consumed')
        self.assertEqual(fixture_consume(c,claim|{'subscription':'999','order':'999'}),'review')
        self.assertEqual(fixture_consume(c,claim|{'subscription':'101','order':'201'}),'review')
        self.assertEqual(fixture_consume(c,other),'review')
    def test_simultaneous_duplicate_deliveries_consume_once(self):
        with tempfile.TemporaryDirectory() as temp:
            path=str(Path(temp)/'fixture.sqlite');c=sqlite3.connect(path);fixture_schema(c);c.close();claim=self.check()
            def run(_):
                with sqlite3.connect(path,timeout=5) as conn:return fixture_consume(conn,claim)
            with ThreadPoolExecutor(max_workers=2) as pool:self.assertCountEqual(list(pool.map(run,range(2))),['consumed','duplicate'])

if __name__=='__main__':unittest.main()
