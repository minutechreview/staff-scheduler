"""Actual local Auth/Firestore codes and transactions; no cloud/live factory."""
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
from firebase_service import FirebaseService
from identity_lifecycle import digest

PROJECT = 'demo-relay-email-actions'
if os.environ.get('RELAY_FIREBASE_PROJECT') != PROJECT or os.environ.get('RELAY_FIREBASE_MODE') != 'emulator':
    raise SystemExit('Native action tests require the isolated demo emulator project')
SECRETS = []
PASSWORD = 'synthetic-native-old-password-123'
NEW_PASSWORD = 'synthetic-native-new-password-456'
FRESH_PASSWORD = 'synthetic-native-fresh-password-789'
SECRETS.extend([PASSWORD, NEW_PASSWORD, FRESH_PASSWORD])


class NativeEmailActions(unittest.TestCase):
    def setUp(self):
        self.s = FirebaseService()
        self.context = self.s.request_context()
        self.context.__enter__()
        self.addCleanup(self.context.__exit__, None, None, None)
        self.email = 'native-' + self._testMethodName.replace('_', '-') + '@example.test'
        result = self.s.signup(dict(email=self.email, password=PASSWORD, name='Synthetic Native Owner',
                                    organization='Synthetic Native Actions'))
        self.assertTrue(result['verification_required'])
        self.verify_code = self.code('VERIFY_EMAIL')

    def code(self, kind):
        url = f'http://{self.s.guard.auth_host}/emulator/v1/projects/{PROJECT}/oobCodes'
        self.s.guard.assert_auth_url(url)
        response = self.s.identity.http.get(url, timeout=15, allow_redirects=False)
        response.raise_for_status()
        values = [row for row in response.json()['oobCodes'] if row['email'] == self.email and row['requestType'] == kind]
        self.assertTrue(values, 'Expected an emulator-only action code')
        value = values[-1]['oobCode']; SECRETS.append(value)
        return value

    def signin(self, password=PASSWORD, service=None):
        token = (service or self.s).signin(dict(email=self.email, password=password), self._testMethodName)
        self.assertIsInstance(token, str)
        SECRETS.append(token)
        return token

    def verified(self):
        self.s.complete_email_action(dict(mode='verifyEmail', code=self.verify_code))
        token = self.signin()
        me = self.s.dispatch(token, 'GET', '/api/me', {}, {})
        return token, me

    def reset_code(self):
        self.s.request_recovery(dict(email=self.email))
        return self.code('PASSWORD_RESET')

    def reset(self, code, password=NEW_PASSWORD):
        return self.s.complete_email_action(dict(mode='resetPassword', code=code, password=password))

    def rejected(self, operation, status):
        with self.assertRaises(Problem) as result: operation()
        self.assertEqual(result.exception.status, status)

    def test_01_real_verification_code_and_first_signin_create_exact_membership(self):
        user = self.s.identity.user_by_email(self.email)
        self.assertFalse(user.email_verified)
        self.assertIsNone(self.s.run(lambda c: c.identity_get(user.uid)))
        checked = self.s.check_email_action(dict(mode='verifyEmail', code=self.verify_code))
        self.assertTrue(checked['valid']); self.assertFalse(checked['submitted_before'])
        token, me = self.verified()
        self.assertEqual(me['user']['id'], user.uid)
        self.assertEqual(me['user']['role'], 'owner')
        self.assertTrue(self.s.identity.user(user.uid).email_verified)
        marker = self.s.run(lambda c: c.control_get('email_action_attempts', digest('verifyEmail/' + self.verify_code)))
        self.assertEqual(marker['state'], 'completed')
        restarted = FirebaseService()
        self.assertEqual(restarted.dispatch(token, 'GET', '/api/me', {}, {})['user']['org'], me['user']['org'])
        self.rejected(lambda: self.s.check_email_action(dict(mode='verifyEmail', code=self.verify_code)), 401)

    def test_02_wrong_purpose_and_invalid_real_provider_responses_do_not_poison_epoch(self):
        _, me = self.verified(); user = me['user']['id']; code = self.reset_code()
        self.rejected(lambda: self.s.check_email_action(dict(mode='verifyEmail', code=code)), 401)
        self.rejected(lambda: self.s.complete_recovery(dict(code='synthetic-invalid-native-code', password=NEW_PASSWORD)), 401)
        self.assertEqual(self.s.run(lambda c: c.security(user))['epoch'], 0)
        self.assertIsNone(self.s.run(lambda c: c.control_get('email_action_attempts', digest('verifyEmail/' + code))))
        self.assertTrue(self.s.check_email_action(dict(mode='resetPassword', code=code))['valid'])

    def test_03_real_reset_preserves_org_rejects_old_session_and_password(self):
        old, before = self.verified(); code = self.reset_code()
        self.assertTrue(self.reset(code)['signed_out'])
        self.rejected(lambda: self.s.dispatch(old, 'GET', '/api/me', {}, {}), 401)
        self.rejected(lambda: self.s.signin(dict(email=self.email, password=PASSWORD), self._testMethodName), 401)
        fresh = self.signin(NEW_PASSWORD)
        after = self.s.dispatch(fresh, 'GET', '/api/me', {}, {})
        self.assertEqual(after['user']['org'], before['user']['org'])
        self.assertEqual(after['user']['id'], before['user']['id'])
        marker = self.s.run(lambda c: c.control_get('email_action_attempts', digest('resetPassword/' + code)))
        self.assertEqual(marker['state'], 'completed')
        self.rejected(lambda: self.reset(code, FRESH_PASSWORD), 401)
        self.assertFalse(self.s.run(lambda c: c.security(before['user']['id']))['blocked'])

    def test_04_native_concurrent_claim_has_one_provider_submission(self):
        _, me = self.verified(); code = self.reset_code()
        original = self.s.identity.rest; barrier = threading.Barrier(2); submissions = []
        def intercept(action, data):
            result = original(action, data)
            if action == 'resetPassword' and data.get('oobCode') == code:
                if 'newPassword' in data: submissions.append(True)
                else: barrier.wait(timeout=15)
            return result
        def attempt(_):
            with self.s.request_context():
                try: self.reset(code); return 200
                except Problem as error: return error.status
        with patch.object(self.s.identity, 'rest', side_effect=intercept), concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = sorted(pool.map(attempt, range(2)))
        self.assertEqual(results, [200, 409])
        self.assertEqual(len(submissions), 1)
        epoch = self.s.run(lambda c: c.security(me['user']['id']))
        self.assertEqual(epoch['epoch'], 1); self.assertFalse(epoch['blocked'])
        self.signin(NEW_PASSWORD)

    def test_05_lost_reset_ack_and_fresh_code_recovery_use_native_epoch_fence(self):
        old, me = self.verified(); code = self.reset_code(); original = self.s.identity.rest
        def lost(action, data):
            result = original(action, data)
            if action == 'resetPassword' and 'newPassword' in data: raise RuntimeError('Synthetic acknowledgement loss')
            return result
        with patch.object(self.s.identity, 'rest', side_effect=lost), self.assertRaises(RuntimeError): self.reset(code)
        user = me['user']['id']; epoch = self.s.run(lambda c: c.security(user))
        self.assertTrue(epoch['blocked'])
        restarted = FirebaseService()
        marker = restarted.run(lambda c: c.control_get('email_action_attempts', digest('resetPassword/' + code)))
        self.assertEqual(marker['state'], 'submitted')
        self.rejected(lambda: restarted.dispatch(old, 'GET', '/api/me', {}, {}), 401)
        self.rejected(lambda: restarted.signin(dict(email=self.email, password=NEW_PASSWORD), self._testMethodName), 401)
        fresh = self.reset_code()
        self.rejected(lambda: self.reset(fresh, FRESH_PASSWORD), 409)
        self.assertIsNone(self.s.run(lambda c: c.control_get('email_action_attempts', digest('resetPassword/' + fresh))))
        # Advance only this synthetic user's emulator fixture timestamp, not
        # an application policy or a provider/security configuration setting.
        self.s.run(lambda c: c.security_put(user, epoch | dict(started=time.time()-121)))
        self.reset(fresh, FRESH_PASSWORD)
        self.assertFalse(self.s.run(lambda c: c.security(user))['blocked'])
        self.signin(FRESH_PASSWORD)
        self.rejected(lambda: self.s.finish_transition(user, epoch['operation'], epoch['epoch']), 409)

    def test_06_lost_verification_ack_can_signin_without_replaying(self):
        original = self.s.identity.rest; submitted = []
        def lost(action, data):
            result = original(action, data)
            if action == 'update': submitted.append(True); raise RuntimeError('Synthetic lost verify acknowledgement')
            return result
        with patch.object(self.s.identity, 'rest', side_effect=lost), self.assertRaises(RuntimeError):
            self.s.complete_email_action(dict(mode='verifyEmail', code=self.verify_code))
        self.assertEqual(len(submitted), 1)
        self.rejected(lambda: self.s.check_email_action(dict(mode='verifyEmail', code=self.verify_code)), 401)
        token = self.signin()
        self.assertEqual(self.s.dispatch(token, 'GET', '/api/me', {}, {})['user']['role'], 'owner')
        self.assertEqual(self.s.run(lambda c: c.control_get('email_action_attempts', digest('verifyEmail/' + self.verify_code)))['state'], 'submitted')

    def test_07_interrupted_before_apply_is_fenced_and_replacement_link_works(self):
        original = self.s.identity.rest
        def unavailable(action, data):
            if action == 'update': raise RuntimeError('Synthetic interruption before provider apply')
            return original(action, data)
        with patch.object(self.s.identity, 'rest', side_effect=unavailable), self.assertRaises(RuntimeError):
            self.s.complete_email_action(dict(mode='verifyEmail', code=self.verify_code))
        self.assertTrue(self.s.check_email_action(dict(mode='verifyEmail', code=self.verify_code))['submitted_before'])
        self.rejected(lambda: self.s.complete_email_action(dict(mode='verifyEmail', code=self.verify_code)), 409)
        result = self.s.signin(dict(email=self.email, password=PASSWORD), self._testMethodName)
        self.assertTrue(result['verification_required'])
        replacement = self.code('VERIFY_EMAIL')
        self.s.complete_email_action(dict(mode='verifyEmail', code=replacement))
        self.signin()

    def test_08_journal_completion_ack_loss_does_not_revoke_a_successful_reset_twice(self):
        old, me = self.verified(); code = self.reset_code()
        with patch.object(self.s, 'finish_email_action', side_effect=RuntimeError('Synthetic journal response loss')), self.assertRaises(RuntimeError):
            self.reset(code)
        epoch = self.s.run(lambda c: c.security(me['user']['id']))
        self.assertEqual(epoch['epoch'], 1); self.assertFalse(epoch['blocked'])
        self.signin(NEW_PASSWORD)
        self.rejected(lambda: self.s.dispatch(old, 'GET', '/api/me', {}, {}), 401)
        self.rejected(lambda: self.reset(code, FRESH_PASSWORD), 401)
        self.assertEqual(self.s.run(lambda c: c.security(me['user']['id']))['epoch'], 1)


if __name__ == '__main__':
    logging.disable(logging.CRITICAL)
    stream = io.StringIO(); started = time.perf_counter()
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(NativeEmailActions))
    details = stream.getvalue()
    for secret in sorted(set(SECRETS), key=len, reverse=True): details = details.replace(secret, '[REDACTED_TEST_SECRET]')
    Path('/evidence/native-email-actions-tests.txt').write_text(details)
    report = dict(project=PROJECT, native_emulators=True, real_email=False, tests_run=result.testsRun,
                  failures=len(result.failures), errors=len(result.errors), skipped=len(result.skipped),
                  success=result.wasSuccessful(), seconds=round(time.perf_counter()-started, 3),
                  expiry_verified=False, expiry_reason='Installed Auth emulator has no OOB expiration enforcement',
                  scope='Actual emulator OOB codes, pinned SDK, native Firestore transactions; synthetic .test accounts only')
    Path('/evidence/native-email-actions-result.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report))
    raise SystemExit(0 if result.wasSuccessful() else 1)
