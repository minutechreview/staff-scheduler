"""Deterministic transaction-boundary tests; all provider identities are synthetic."""
import copy,sys,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from core import Problem
from member_provisioning import prepare,mark_for_review
class Store:
    def __init__(self):self.rows={}
    def control_get(self,c,k):return copy.deepcopy(self.rows.get((c,k)))
    def control_put(self,c,k,v):self.rows[(c,k)]=copy.deepcopy(v)
    def identity_get(self,uid):return None
class Tests(unittest.TestCase):
    def setUp(self):
        self.store=Store();self.service=SimpleNamespace(guard=SimpleNamespace(max_members=4))
        self.service.credentials=lambda data:('member@fixture.test','fixture-password','Fixture')
        def run(fn):
            before=copy.deepcopy(self.store.rows)
            try:return fn(self.store)
            except Exception:self.store.rows=before;raise
        self.service.run=run;self.service.ensure_reserved_identity=Mock(return_value=SimpleNamespace(uid='fixture'))
        self.actor=dict(id='actor',org='org');self.data=dict(role='admin')
    def test_revocation_before_provider_releases_exclusive_reservation(self):
        calls=[]
        def authorize(_):
            calls.append(1)
            if len(calls)==2:raise Problem('revoked',403)
        with self.assertRaises(Problem):prepare(self.service,self.actor,self.data,authorize)
        self.service.ensure_reserved_identity.assert_not_called()
        self.assertEqual(self.store.rows[('pilot_member_capacity','org')]['reserved'],1)
        self.assertEqual(self.store.rows[('provisioning_jobs','member@fixture.test')]['state'],'cancelled_before_provider')
    def test_uncertain_provider_result_keeps_reservation_and_marks_for_review(self):
        self.service.ensure_reserved_identity.side_effect=RuntimeError('synthetic unknown')
        with self.assertRaises(RuntimeError):prepare(self.service,self.actor,self.data,lambda _:None)
        self.assertEqual(self.store.rows[('pilot_member_capacity','org')]['reserved'],2)
        job=self.store.rows[('provisioning_jobs','member@fixture.test')]
        self.assertEqual(job['state'],'needs_reconciliation')
        with self.assertRaises(Problem):prepare(self.service,self.actor,self.data,lambda _:None)
    def test_lost_response_does_not_overwrite_committed_job(self):
        self.store.rows[('provisioning_jobs','member@fixture.test')]=dict(uid='fixture',kind='member',state='committed')
        mark_for_review(self.service,'member@fixture.test','fixture')
        self.assertEqual(self.store.rows[('provisioning_jobs','member@fixture.test')]['state'],'committed')
