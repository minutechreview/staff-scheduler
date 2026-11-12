"""Synthetic invite tokens only; no real account, secrets or provider calls."""
import hashlib,sys,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from acceptance_invite import check,claim
from core import Problem
class Store:
    def __init__(self):self.rows={}
    def control_get(self,c,k):return self.rows.get((c,k))
    def control_put(self,c,k,v):self.rows[(c,k)]=v
class InviteTests(unittest.TestCase):
    def setUp(self):
        self.token='1'*64;self.hash=hashlib.sha256(self.token.encode()).hexdigest()
        self.guard=SimpleNamespace(requires_invite=True,invite_hash=self.hash,invite_expires=time.time()+1800)
    def test_correct_short_lived_secret_required(self):
        check(self.guard,dict(enrollment_code=self.token))
        for value in ('2'*64,'',self.token.upper()+'x'):
            with self.subTest(value=value),self.assertRaises(Problem):check(self.guard,dict(enrollment_code=value))
        with patch('acceptance_invite.time.time',return_value=self.guard.invite_expires+1),self.assertRaises(Problem):
            check(self.guard,dict(enrollment_code=self.token))
    def test_claim_is_bound_to_one_reserved_job_and_never_stores_token(self):
        store=Store(); job=dict(uid='fictional-user')
        claim(store,self.guard,job,'fingerprint');claim(store,self.guard,job,'fingerprint')
        with self.assertRaises(Problem):claim(store,self.guard,dict(uid='other'),'fingerprint')
        with self.assertRaises(Problem):claim(store,self.guard,job,'different')
        self.assertNotIn(self.token,str(store.rows))
