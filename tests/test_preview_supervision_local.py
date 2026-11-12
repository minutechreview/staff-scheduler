"""Dummy-only tests; no network, credentials, OS supervisor, or cloud resources."""
import hashlib
import hmac
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from preview_supervision_local import GuardIdentity, LocalSupervisor, SupervisionError

class SupervisionTests(unittest.TestCase):
    def setUp(self):
        self.clock = 1
        self.alive = True
        self.wrong_identity = False
        self.cleanups = []
        self.cleanup_result = True
        self.identity = GuardIdentity('dummy-run', 1234, b'x' * 32)
        def probe(run, pid, challenge):
            if not self.alive: raise OSError('dummy guard died')
            key = b'y' * 32 if self.wrong_identity else self.identity.key
            return hmac.digest(key, run.encode()+b'\0'+str(pid).encode()+b'\0'+challenge, hashlib.sha256)
        def cleanup():
            self.cleanups.append('dummy cleanup')
            return self.cleanup_result
        self.supervisor = LocalSupervisor(self.identity, probe, lambda:self.clock, cleanup, 25, 30)

    def test_owner_handoff_keeps_same_guard_identity(self):
        self.supervisor.owner_handoff()
        self.assertEqual(self.supervisor.phase, 'awaiting_owner')
        self.supervisor.authorize_action()
        self.assertEqual(self.supervisor.phase, 'active')
        self.assertEqual(self.cleanups, [])

    def test_dead_guard_stops_action_and_cleans_once(self):
        self.supervisor.owner_handoff(); self.alive = False
        with self.assertRaisesRegex(SupervisionError, 'GUARD_IDENTITY_UNVERIFIED'):
            self.supervisor.authorize_action()
        self.supervisor.tick(); self.assertEqual(len(self.cleanups), 1)
        self.assertTrue(self.supervisor.cleanup_verified)

    def test_reused_pid_with_wrong_guard_key_rejected(self):
        self.wrong_identity = True
        with self.assertRaisesRegex(SupervisionError, 'GUARD_IDENTITY_UNVERIFIED'):
            self.supervisor.authorize_action()
        self.assertEqual(len(self.cleanups), 1)

    def test_handoff_interruption_is_detected_on_next_tick(self):
        self.supervisor.owner_handoff(); self.alive = False
        self.assertEqual(self.supervisor.tick(), 'closed')
        self.assertEqual(len(self.cleanups), 1)

    def test_cleanup_at_cutoff_and_no_actions_afterward(self):
        self.clock = 25
        with self.assertRaisesRegex(SupervisionError, 'CLEANUP_STARTED'):
            self.supervisor.authorize_action()
        with self.assertRaisesRegex(SupervisionError, 'RUN_CLOSED'):
            self.supervisor.authorize_action()
        self.assertEqual(len(self.cleanups), 1)

    def test_unverified_cleanup_is_not_reported_successful_or_retried(self):
        self.cleanup_result = False; self.clock = 25
        self.assertEqual(self.supervisor.tick(), 'cleanup_unverified')
        self.assertFalse(self.supervisor.cleanup_verified)
        self.supervisor.tick(); self.assertEqual(len(self.cleanups), 1)

    def test_invalid_identity_and_deadline_rejected(self):
        with self.assertRaises(ValueError):
            LocalSupervisor(GuardIdentity('x', 1, b'short'), lambda *_:None, lambda:0, lambda:True, 25, 30)
        with self.assertRaises(ValueError):
            LocalSupervisor(self.identity, lambda *_:None, lambda:0, lambda:True, 30, 30)

if __name__ == '__main__': unittest.main()
