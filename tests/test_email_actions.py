import concurrent.futures
import io
import json
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from email_action_fixtures import FixtureActionService
from core import Problem
from identity_lifecycle import digest
from production_app import create_application, load_application
from test_production import SAFE, ProductionConfig


class EmailActionTests(unittest.TestCase):
    def setUp(self): self.s = FixtureActionService()
    def data(self, mode='verifyEmail', code='fixture-verify', **extra): return dict(mode=mode, code=code, **extra)
    def rejected(self, operation, status):
        with self.assertRaises(Problem) as result: operation()
        self.assertEqual(result.exception.status, status)

    def test_check_is_non_consuming_and_exposes_no_identity_or_code(self):
        data = self.data()
        for _ in range(2):
            self.assertEqual(self.s.check_email_action(data), dict(valid=True, mode='verifyEmail', submitted_before=False))
        self.assertFalse(self.s.identity.codes['fixture-verify']['used'])
        self.assertFalse(self.s.identity.user.email_verified)
        self.assertEqual(self.s.store.controls, {})

    def test_verification_applies_code_once_without_profile_session_or_admin_override(self):
        self.assertEqual(self.s.complete_email_action(self.data()), dict(verified=True, sign_in_required=True))
        self.assertTrue(self.s.identity.user.email_verified)
        updates = [data for action, data in self.s.identity.calls if action == 'update']
        self.assertEqual(updates, [{'oobCode': 'fixture-verify'}])
        self.assertEqual(self.s.store.epochs, {})
        self.rejected(lambda: self.s.complete_email_action(self.data()), 401)
        self.assertEqual(len([a for a, _ in self.s.identity.calls if a == 'update']), 1)

    def test_invalid_expired_reused_and_wrong_purpose_do_not_claim_or_change_epochs(self):
        for code in ['invalid', 'fixture-expired', 'fixture-used', 'fixture-recover', 'fixture-reset']:
            self.rejected(lambda: self.s.complete_email_action(self.data(code=code)), 401)
        self.rejected(lambda: self.s.complete_recovery(self.data(code='fixture-verify', password='fixture-new-password-456')), 401)
        self.assertEqual(self.s.store.controls, {})
        self.assertEqual(self.s.store.epochs, {})
        self.assertFalse(self.s.identity.user.email_verified)

    def test_malformed_fields_and_unsupported_mode_never_call_identity(self):
        for data in [dict(mode='recoverEmail', code='fixture-recover'), dict(mode='verifyEmail', code=''),
                     dict(mode='verifyEmail', code='x' * 1025), dict(mode='verifyEmail', code='bad\ncode')]:
            self.rejected(lambda: self.s.check_email_action(data), 422 if data['mode']=='recoverEmail' else 401)
        self.assertEqual(self.s.identity.calls, [])

    def test_delivery_disabled_blocks_new_messages_but_accepts_existing_links(self):
        self.rejected(lambda: self.s.request_recovery(dict(email='owner@example.test')), 503)
        self.assertEqual(self.s.store.controls, {})
        self.assertTrue(self.s.complete_email_action(self.data())['verified'])

    def test_password_reset_uses_existing_membership_and_epoch_revocation(self):
        result = self.s.complete_email_action(self.data('resetPassword', 'fixture-reset', password='fixture-new-password-456'))
        self.assertTrue(result['signed_out'])
        self.assertEqual(self.s.identity.password, 'fixture-new-password-456')
        self.assertEqual(self.s.identity.revocations, 1)
        self.assertEqual(self.s.store.security('fixture-owner')['epoch'], 1)
        self.assertFalse(self.s.store.security('fixture-owner')['blocked'])
        stored = json.dumps([[list(key), value] for key, value in self.s.store.controls.items()])
        self.assertNotIn('fixture-reset', stored)
        self.assertNotIn('fixture-new-password-456', stored)
        self.rejected(lambda: self.s.complete_email_action(self.data('resetPassword', 'fixture-reset', password='fixture-other-password-789')), 401)

    def test_disabled_membership_or_provider_user_never_changes_password(self):
        self.s.store.member['enabled'] = False
        self.rejected(lambda: self.s.complete_recovery(dict(code='fixture-reset', password='fixture-new-password-456')), 401)
        self.s.store.member['enabled'] = True
        self.s.identity.user.disabled = True
        self.rejected(lambda: self.s.complete_recovery(dict(code='fixture-reset', password='fixture-new-password-456')), 401)
        self.assertEqual(self.s.store.epochs, {})
        self.assertEqual(self.s.store.controls, {})

    def test_uncertain_verification_is_fenced_without_automatic_replay(self):
        self.s.identity.fail_before_apply = True
        with self.assertRaises(RuntimeError): self.s.complete_email_action(self.data())
        self.assertTrue(self.s.check_email_action(self.data())['submitted_before'])
        self.rejected(lambda: self.s.complete_email_action(self.data()), 409)
        self.assertEqual(len([a for a, _ in self.s.identity.calls if a == 'update']), 1)

    def test_lost_reset_ack_blocks_old_epoch_and_fresh_link_can_recover_after_window(self):
        self.s.identity.lose_acknowledgement = True
        with self.assertRaises(RuntimeError):
            self.s.complete_recovery(dict(code='fixture-reset', password='fixture-new-password-456'))
        self.assertTrue(self.s.store.security('fixture-owner')['blocked'])
        self.s.identity.lose_acknowledgement = False
        self.rejected(lambda: self.s.complete_recovery(dict(code='fixture-fresh', password='fixture-fresh-password-789')), 409)
        self.assertIsNone(self.s.store.control_get('email_action_attempts', digest('resetPassword/fixture-fresh')))
        self.s.store.epochs['fixture-owner']['started'] -= 121
        self.s.complete_recovery(dict(code='fixture-fresh', password='fixture-fresh-password-789'))
        self.assertFalse(self.s.store.security('fixture-owner')['blocked'])
        self.assertEqual(self.s.identity.password, 'fixture-fresh-password-789')

    def test_concurrent_reset_has_one_provider_submission_and_does_not_reblock(self):
        self.s.identity.inspection_barrier = threading.Barrier(2)
        def reset(_):
            try:
                self.s.complete_recovery(dict(code='fixture-reset', password='fixture-new-password-456'))
                return 200
            except Problem as error: return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(reset, range(2))), [200, 409])
        writes = [data for action, data in self.s.identity.calls if 'newPassword' in data]
        self.assertEqual(len(writes), 1)
        self.assertEqual(self.s.store.security('fixture-owner')['epoch'], 1)
        self.assertFalse(self.s.store.security('fixture-owner')['blocked'])


class EmailActionTransportTests(unittest.TestCase):
    def setUp(self):
        self.s = FixtureActionService()
        with patch.dict('os.environ', SAFE, clear=True): self.config = ProductionConfig.from_environment()
        self.app = create_application(self.s, self.config)
    def post(self, path, data, **extra):
        raw = json.dumps(data).encode(); response = []
        env = {'REQUEST_METHOD':'POST', 'PATH_INFO':path, 'HTTP_HOST':'relay-fixture.web.app',
               'HTTP_ORIGIN':self.config.origin, 'CONTENT_TYPE':'application/json', 'CONTENT_LENGTH':str(len(raw)),
               'wsgi.url_scheme':'https', 'wsgi.input':io.BytesIO(raw)} | extra
        content = self.app(env, lambda status, headers: response.append((int(status.split()[0]), dict(headers))))
        return *response[0], json.loads(b''.join(content))
    def test_verification_never_mints_cookie_and_reset_explicitly_clears_it(self):
        status, headers, _ = self.post('/api/auth/action/complete', dict(mode='verifyEmail', code='fixture-verify'))
        self.assertEqual(status, 200); self.assertNotIn('Set-Cookie', headers)
        status, headers, _ = self.post('/api/auth/action/complete', dict(mode='resetPassword', code='fixture-reset', password='fixture-new-password-456'))
        self.assertEqual(status, 200); self.assertIn('Max-Age=0', headers['Set-Cookie'])
    def test_origin_and_global_disabled_state_stop_actions(self):
        self.assertEqual(self.post('/api/auth/action/check', dict(mode='verifyEmail', code='fixture-verify'), HTTP_ORIGIN='https://evil.test')[0], 403)
        self.assertEqual(self.s.identity.calls, [])
        with patch.dict('os.environ', {}, clear=True): disabled = load_application()
        result=[]; disabled({},lambda status, headers:result.append(status))
        self.assertTrue(result[0].startswith('503'))

    def test_malformed_codes_rejected_before_admission_or_identity(self):
        with patch.object(self.s,'admit_request') as admission:
            for path,data in [('/api/auth/action/check',dict(mode='verifyEmail',code='')),
                              ('/api/auth/action/complete',dict(mode='resetPassword',code='bad\ncode')),
                              ('/api/recovery/complete',dict(code='x'*1025))]:
                self.assertEqual(self.post(path,data)[0],401)
            admission.assert_not_called()
        self.assertEqual(self.s.identity.calls,[])


if __name__ == '__main__': unittest.main(verbosity=2)
