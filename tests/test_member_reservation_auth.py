"""Member authorization must be current at reservation and provider boundaries."""
import sys,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from core import Problem
from identity_lifecycle import IdentityLifecycle

class MemberReservationTests(unittest.TestCase):
    def setUp(self):
        self.service=IdentityLifecycle()
        self.service.guard=SimpleNamespace(max_members=10)
        self.service.credentials=Mock(return_value=('member@example.test','fictional-password','Member'))
        self.service.ensure_reserved_identity=Mock()
        self.store=SimpleNamespace(control_get=Mock(return_value=None),control_put=Mock())
        self.service.run=lambda callback:callback(self.store)
        self.actor=dict(id='actor',org='tenant',role='admin')
    def test_demoted_before_reservation_never_writes_or_calls_provider(self):
        def deny(_): raise Problem('Forbidden',403)
        with self.assertRaises(Problem): self.service.prepare_member(self.actor,{},deny)
        self.store.control_put.assert_not_called()
        self.service.ensure_reserved_identity.assert_not_called()
    def test_demoted_after_reservation_blocks_provider(self):
        calls=[]
        def authorize(_):
            calls.append(True)
            if len(calls)>1:raise Problem('Forbidden',403)
        with self.assertRaises(Problem): self.service.prepare_member(self.actor,{},authorize)
        self.assertEqual(len(calls),2)
        self.service.ensure_reserved_identity.assert_not_called()
