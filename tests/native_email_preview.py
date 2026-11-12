"""Actual emulator preview scope/transactions. No real project or mail delivery."""
import concurrent.futures
import contextlib
import io
import json
import logging
import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from core import Problem
from firebase_auth import FirebaseIdentity
from firebase_config import EmulatorConfig
from email_preview_policy import make_preview_service
from email_preview_config import PROFILE, ORGANIZATION
from firebase_repository import key
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore

PROJECT = 'demo-relay-email-actions'
if os.environ.get('RELAY_FIREBASE_PROJECT') != PROJECT or os.environ.get('RELAY_FIREBASE_MODE') != 'emulator':
    raise SystemExit('Preview native validation requires the isolated demo emulator project')
SECRETS = []
PASSWORD = 'synthetic-preview-old-password-123'
NEW_PASSWORD = 'synthetic-preview-new-password-456'
SECRETS.extend([PASSWORD, NEW_PASSWORD])
TOTAL = dict(document_reads=0, query_documents=0, empty_queries=0, writes=0, transaction_attempts=0)


class NativeGuard:
    delivery = True
    max_staff = 0
    max_branches = 0
    max_tenants = 1
    max_members = 1
    max_calls = 100
    max_reads = 1000
    max_query_documents = 200
    def __init__(self, base, email, run):
        self.base, self.owner_email, self.run_id = base, email, run
        self.project, self.database = PROJECT, '(default)'
        self.expires_at = time.time() + 600
        self.closed = False
    def assert_current(self):
        self.base.assert_current()
        if self.closed or time.time() >= self.expires_at: raise Problem('Synthetic preview window closed', 503)
    def assert_open(self): self.assert_current()


class NativeEmailPreview(unittest.TestCase):
    def setUp(self):
        self.base = EmulatorConfig.from_environment()
        self.email = 'preview-' + self._testMethodName.replace('_', '-') + '@example.test'
        self.guard = NativeGuard(self.base, self.email, 'synthetic-' + self._testMethodName)
        self.client = firestore.Client(project=PROJECT, credentials=AnonymousCredentials())
        self.raw = FirebaseIdentity(self.base)
        self.s = self.service()
        self.s.admit_request('/api/signup', None)

    def service(self):
        service = make_preview_service(self.guard, self.raw, self.client)
        original = service.run
        def tracked(operation):
            previous = getattr(service.local, 'metrics', None)
            try: return original(operation)
            finally:
                values = getattr(service.local, 'metrics', {})
                if values is not previous:
                    for name in TOTAL: TOTAL[name] += values.get(name, 0)
        service.run = tracked
        return service

    def signup(self, service=None):
        return (service or self.s).signup(dict(email=self.email, password=PASSWORD, name=PROFILE, organization=ORGANIZATION))

    def code(self, purpose):
        url = f'http://{self.base.auth_host}/emulator/v1/projects/{PROJECT}/oobCodes'
        self.base.assert_auth_url(url)
        response = self.raw.http.get(url, timeout=10, allow_redirects=False); response.raise_for_status()
        rows = [r for r in response.json()['oobCodes'] if r['email'] == self.email and r['requestType'] == purpose]
        self.assertTrue(rows)
        SECRETS.extend(r['oobCode'] for r in rows)
        return rows[-1]['oobCode'], len(rows)

    def login(self, password=PASSWORD, service=None):
        token = (service or self.s).signin(dict(email=self.email, password=password), 'synthetic-preview')
        self.assertIsInstance(token, str); SECRETS.append(token)
        return token

    def verified(self):
        self.signup(); code, count = self.code('VERIFY_EMAIL'); self.assertEqual(count, 1)
        self.s.complete_email_action(dict(mode='verifyEmail', code=code))
        token = self.login(); return token, self.s.dispatch(token, 'GET', '/api/me', {}, {})

    def rejected(self, operation, status):
        with self.assertRaises(Problem) as result: operation()
        self.assertEqual(result.exception.status, status)

    def test_01_actual_signup_verify_signin_reset_and_session_rejection(self):
        old, before = self.verified()
        self.s.request_recovery(dict(email=self.email)); code, count = self.code('PASSWORD_RESET'); self.assertEqual(count, 1)
        self.s.complete_email_action(dict(mode='resetPassword', code=code, password=NEW_PASSWORD))
        self.rejected(lambda: self.s.dispatch(old, 'GET', '/api/me', {}, {}), 401)
        self.rejected(lambda: self.s.signin(dict(email=self.email, password=PASSWORD)), 401)
        token = self.login(NEW_PASSWORD)
        after = self.s.dispatch(token, 'GET', '/api/me', {}, {})
        self.assertEqual(before['user']['id'], after['user']['id']); self.assertEqual(before['user']['org'], after['user']['org'])
        self.assertEqual(self.s.run(lambda c: c.control_get('preview_send_attempts', 'VERIFY_EMAIL'))['state'], 'reserved')

    def test_02_native_concurrent_send_reservation_has_exactly_one_emulator_oob(self):
        # Stop the signup fixture immediately before its initial send. The race
        # then reserves the first message, without deleting a durable claim.
        with patch.object(self.s.identity, 'verification', return_value=dict(verification_required=True)):
            self.signup()
        user = self.raw.user_by_email(self.email)
        signed = self.raw.rest('signInWithPassword', dict(email=self.email, password=PASSWORD, returnSecureToken=True))
        SECRETS.append(signed['idToken'])
        barrier = threading.Barrier(2)
        def attempt(_):
            barrier.wait(timeout=10)
            try: self.s.identity.verification(signed['idToken'], self.email); return 200
            except Problem as error: return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: values = sorted(pool.map(attempt, range(2)))
        # Firestore can exhaust its bounded contention retries instead of
        # observing the winner. Both 409 and 503 fail closed without a send.
        self.assertEqual(values[0], 200); self.assertIn(values[1], [409, 503])
        self.assertEqual(self.code('VERIFY_EMAIL')[1], 1)
        self.assertEqual(self.raw.user(user.uid).email, self.email)

    def test_03_lost_send_ack_and_fresh_service_are_fenced_without_resend(self):
        self.verified(); original = self.raw.rest; sends = []
        def lost(action, data):
            result = original(action, data)
            if action == 'sendOobCode': sends.append(True); raise RuntimeError('Synthetic lost send acknowledgement')
            return result
        with patch.object(self.raw, 'rest', side_effect=lost): self.s.request_recovery(dict(email=self.email))
        restarted = self.service()
        restarted.request_recovery(dict(email=self.email))
        self.assertEqual(len(sends), 1); self.assertEqual(self.code('PASSWORD_RESET')[1], 1)
        self.assertIsNotNone(restarted.run(lambda c: c.control_get('preview_send_attempts', 'PASSWORD_RESET')))

    def test_04_inbox_uid_admin_and_route_negatives(self):
        self.signup()
        self.rejected(lambda: self.s.signin(dict(email='other@example.test', password=PASSWORD)), 403)
        self.rejected(lambda: self.s.identity.user('other-uid'), 403)
        self.rejected(lambda: self.s.identity.rest('update', dict(localId='other-uid', emailVerified=True)), 403)
        self.rejected(lambda: self.s.identity.rest('sendOobCode', dict(requestType='EMAIL_SIGNIN', email=self.email)), 403)
        self.rejected(lambda: self.s.dispatch(None, 'POST', '/api/people', {}, {}), 403)
        self.rejected(lambda: self.s.request_recovery(dict(email=self.email)), 403)

    def test_05_namespace_does_not_touch_root_identity_org_or_paused_global_control(self):
        global_ref = self.client.collection('pilot_controls').document(key('global'))
        global_ref.set(dict(enabled=False, synthetic_marker='preserve-global'))
        token, me = self.verified(); uid = me['user']['id']
        self.assertFalse(self.client.collection('identities').document(key(uid)).get().exists)
        self.assertFalse(self.client.collection('organizations').document(key(me['user']['org'])).get().exists)
        self.assertEqual(global_ref.get().to_dict(), dict(enabled=False, synthetic_marker='preserve-global'))
        restarted = self.service(); self.assertEqual(restarted.dispatch(token, 'GET', '/api/me', {}, {})['user']['id'], uid)

    def test_06_expiry_after_identity_reservation_blocks_sdk_send_and_closed_gate(self):
        self.signup(); signed = self.raw.rest('signInWithPassword', dict(email=self.email, password=PASSWORD, returnSecureToken=True))
        SECRETS.append(signed['idToken']); self.guard.closed = True
        self.rejected(lambda: self.s.identity.verification(signed['idToken'], self.email), 503)
        self.rejected(lambda: self.s.admit_request('/api/signup', None), 503)
        self.guard.closed = False
        self.assertEqual(self.code('VERIFY_EMAIL')[1], 1)
        self.s.run(lambda c: c.control_put('preview_controls', 'run', c.control_get('preview_controls', 'run') | dict(enabled=False)))
        self.rejected(lambda: self.s.identity.verification(signed['idToken'], self.email), 503)

    def test_07_existing_auth_identity_is_never_adopted_or_reset(self):
        existing = self.raw.create(self.email, PASSWORD, 'Synthetic pre-existing identity')
        self.rejected(self.signup, 409)
        self.assertEqual(self.raw.user_by_email(self.email).uid, existing.uid)
        self.assertIsNone(self.s.run(lambda c: c.control_get('preview_send_attempts', 'VERIFY_EMAIL')))

    def test_08_unverified_signin_and_signup_retry_cannot_issue_another_message(self):
        self.signup()
        self.rejected(lambda: self.s.signin(dict(email=self.email, password=PASSWORD)), 409)
        self.rejected(self.signup, 409)
        self.assertEqual(self.code('VERIFY_EMAIL')[1], 1)


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    stream = io.StringIO(); started = time.perf_counter()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(NativeEmailPreview))
    details = stream.getvalue()
    for secret in sorted(set(SECRETS), key=len, reverse=True): details = details.replace(secret, '[REDACTED_SYNTHETIC_SECRET]')
    Path('/evidence/native-email-actions-tests.txt').write_text(details)
    report = dict(project=PROJECT, suite='protected-email-preview', native_emulators=True, real_email=False,
        tests_run=result.testsRun, failures=len(result.failures), errors=len(result.errors), skipped=len(result.skipped),
        success=result.wasSuccessful(), seconds=round(time.perf_counter() - started, 3),
        aggregate_repository_metrics=TOTAL, expiry_verified=False,
        expiry_reason='Auth emulator does not enforce OOB expiry; preview absolute expiry tested separately',
        scope='Actual emulator-issued codes, SDK, Firestore transactions, isolated preview namespace; .test fixtures only')
    Path('/evidence/native-email-actions-result.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report)); raise SystemExit(0 if result.wasSuccessful() else 1)
