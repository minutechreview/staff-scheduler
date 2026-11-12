"""Local-only supervision state machine; not wired to cloud or an OS supervisor.

The caller must supply a verified transport, clock and cleanup callback. This module
cannot keep a process alive after its host terminates, and contains no cloud API.
"""
from dataclasses import dataclass
import hashlib
import hmac
import secrets


class SupervisionError(RuntimeError):
    pass


@dataclass(frozen=True)
class GuardIdentity:
    run_id: str
    pid: int
    key: bytes


class LocalSupervisor:
    def __init__(self, identity, probe, now, cleanup, cleanup_start, deadline):
        if not identity.run_id or identity.pid <= 0 or len(identity.key) < 32:
            raise ValueError('invalid guard identity')
        if cleanup_start >= deadline:
            raise ValueError('invalid cleanup window')
        self.identity, self.probe, self.now, self.cleanup = identity, probe, now, cleanup
        self.cleanup_start, self.deadline = cleanup_start, deadline
        self.phase = 'prepared'
        self.cleanup_attempted = False
        self.cleanup_verified = False

    def check_guard(self):
        challenge = secrets.token_bytes(32)
        payload = self.identity.run_id.encode() + b'\0' + str(self.identity.pid).encode() + b'\0' + challenge
        expected = hmac.digest(self.identity.key, payload, hashlib.sha256)
        try:
            response = self.probe(self.identity.run_id, self.identity.pid, challenge)
        except Exception:
            response = None
        return isinstance(response, bytes) and hmac.compare_digest(expected, response)

    def authorize_action(self):
        if self.phase in ('cleaning', 'closed', 'cleanup_unverified'):
            raise SupervisionError('RUN_CLOSED')
        if self.now() >= self.cleanup_start:
            self.finish()
            raise SupervisionError('CLEANUP_STARTED')
        if not self.check_guard():
            self.finish()
            raise SupervisionError('GUARD_IDENTITY_UNVERIFIED')
        self.phase = 'active'

    def owner_handoff(self):
        self.authorize_action()
        self.phase = 'awaiting_owner'

    def tick(self):
        if self.phase in ('closed', 'cleanup_unverified'):
            return self.phase
        if self.now() >= self.cleanup_start or not self.check_guard():
            self.finish()
        return self.phase

    def finish(self):
        if self.cleanup_attempted:
            return
        self.cleanup_attempted = True
        self.phase = 'cleaning'
        try:
            result = self.cleanup()
            self.cleanup_verified = result is True
        except Exception:
            self.cleanup_verified = False
        self.phase = 'closed' if self.cleanup_verified else 'cleanup_unverified'
