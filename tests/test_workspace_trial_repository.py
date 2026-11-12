"""Real repository/lifecycle methods with an in-memory SDK transport, no network."""
import sys
import threading
import time
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from core import Problem, settings
from workspace_trial import WorkspaceTrial
try:
    from firebase_repository import FirestoreRepository
    from firebase_service import FirebaseService
except ImportError:
    FirestoreRepository = FirebaseService = None

NOW = datetime(2026, 11, 10, 12, tzinfo=timezone.utc)

class Ref:
    def __init__(self, client, path): self.client, self.path = client, path
    def document(self, name): return Ref(self.client, self.path + '/' + name)
    def collection(self, name): return Ref(self.client, self.path + '/' + name)
    def get(self, **kwargs):
        value = deepcopy(self.client.rows.get(self.path))
        return SimpleNamespace(exists=value is not None, to_dict=lambda: value)

class Client:
    def __init__(self): self.rows = {}
    def collection(self, name): return Ref(self, name)

class Transaction:
    def __init__(self, client): self.client = client; self.writes = []
    def create(self, ref, row): self.writes.append(('create', ref.path, deepcopy(row)))
    def set(self, ref, row): self.writes.append(('set', ref.path, deepcopy(row)))
    def delete(self, ref): self.writes.append(('delete', ref.path, None))
    def commit(self):
        rows = deepcopy(self.client.rows)
        for op, path, row in self.writes:
            if op == 'create' and path in rows: raise Problem('Already exists', 409)
            if op == 'delete': rows.pop(path, None)
            else: rows[path] = row
        self.client.rows = rows

@unittest.skipIf(FirestoreRepository is None, 'Firestore SDK unavailable; use .local/firebase-venv/bin/python')
class TrialRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.guard = SimpleNamespace(workspace_trial_required=True, assert_current=lambda: None)
    def unit(self): return FirestoreRepository(self.client, Transaction(self.client), self.guard)
    def transact(self, operation):
        c = self.unit()
        result = operation(c)
        c.flush(); c.transaction.commit()
        return result
    def create(self, org='org-a', now=NOW):
        with patch('firebase_repository.datetime') as clock:
            clock.now.return_value = now
            self.transact(lambda c: c.org_add(org, 'Workspace', settings({'started_at':'2099-01-01', 'trial_days':99})))
    def row(self, org='org-a'):
        def read(c): c.bind_org(org); return c.trial_get(org)
        return self.transact(read)
    def test_atomic_server_timestamp_and_immutable_record(self):
        self.create()
        row = self.row()
        self.assertEqual(row['started_at'], NOW.isoformat())
        self.assertEqual(row['ends_at'], (NOW+timedelta(days=7)).isoformat())
        with self.assertRaises(Problem): self.create(now=NOW+timedelta(days=1))
        self.assertEqual(self.row(), row)
        def fence(c): c.bind_org('org-a'); c.fence_policy('org-a')
        self.transact(fence)
        self.assertEqual(self.row(), row)
    def test_rollback_and_retry_create_no_partial_or_extended_trial(self):
        c = self.unit()
        c.org_add('rolled-back', 'Rolled back', settings({}))
        c.flush()  # Transport commit deliberately omitted: simulated transaction abort.
        self.assertFalse(self.client.rows)
        self.create('rolled-back')
        original = self.row('rolled-back')
        with self.assertRaises(Problem): self.create('rolled-back', NOW+timedelta(days=3))
        self.assertEqual(self.row('rolled-back'), original)
    def test_cross_org_and_missing_record_are_denied(self):
        self.create(); self.create('org-b', NOW-timedelta(days=8))
        c = self.unit(); c.bind_org('org-a')
        with self.assertRaises(Problem): c.trial_get('org-b')
        trial = WorkspaceTrial(SimpleNamespace(now=lambda:NOW))
        c = self.unit(); c.bind_org('org-b')
        self.assertFalse(trial.access(c, {'org':'org-b'}))
        self.guard.workspace_trial_required = False
        self.create('legacy')
        c = self.unit(); c.bind_org('legacy')
        self.assertFalse(trial.access(c, {'org':'legacy'}))
    def test_first_verified_signin_creates_trial_once_and_retries_do_not_reset(self):
        service = FirebaseService.__new__(FirebaseService)
        service.guard = self.guard
        service.local = threading.local()
        service.run = self.transact
        service.consume_limits = lambda *args, **kwargs: None
        service.counter_check = lambda *args, **kwargs: None
        user = SimpleNamespace(uid='uid-owner', email='owner@example.test', email_verified=True, tokens_valid_after_timestamp=0)
        service.identity = SimpleNamespace(rest=lambda *args: {'idToken':'synthetic'},
                verify=lambda token:(user, {'auth_time':time.time()}), verification=lambda *args: {'verification_required':True})
        self.transact(lambda c:c.intent_add(user.uid, dict(email=user.email, name='Owner', organization='Workspace', settings=settings({}))))
        user.email_verified = False
        self.assertTrue(service.signin({'email':user.email, 'password':'synthetic'})['verification_required'])
        self.assertFalse(any('/entitlements/' in path for path in self.client.rows))
        user.email_verified = True
        with patch('firebase_repository.datetime') as clock:
            clock.now.return_value = NOW
            first = service.signin({'email':user.email, 'password':'synthetic', 'started_at':'2099-01-01'})
        profile = self.transact(lambda c:c.identity_get(user.uid)); org = profile['org']
        original = self.row(org)
        with patch('firebase_repository.datetime') as clock:
            clock.now.return_value = NOW+timedelta(days=10)
            second = service.signin({'email':user.email, 'password':'synthetic', 'trial_days':100})
            clock.now.assert_not_called()
        self.assertNotEqual(first, second)
        self.assertEqual(self.row(org), original)
        self.assertEqual(original['started_at'], NOW.isoformat())
    def test_service_initialization_wires_trial_only_when_required(self):
        # The actual constructor can be tested with guarded, no-network SDK stubs.
        api = SimpleNamespace(begin_transaction=lambda:None, commit=lambda:None, rollback=lambda:None)
        client = SimpleNamespace(_firestore_api=api)
        service = FirebaseService(guard=self.guard, identity=object(), client=client)
        self.assertIsInstance(service.workspace_trial, WorkspaceTrial)
        self.guard.workspace_trial_required = False
        service = FirebaseService(guard=self.guard, identity=object(), client=client)
        self.assertFalse(hasattr(service, 'workspace_trial'))
