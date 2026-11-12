"""Synthetic in-memory provider/transaction boundary; never connects to Firebase."""
import copy
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from core import Problem
from identity_lifecycle import IdentityLifecycle


class FixtureStore:
    def __init__(self):
        self.controls, self.counters, self.epochs = {}, {}, {}
        self.profile = dict(id='fixture-owner', email='owner@example.test', org='fixture-org')
        self.member = dict(enabled=True)

    def control_get(self, collection, ident): return copy.deepcopy(self.controls.get((collection, ident)))
    def control_put(self, collection, ident, value): self.controls[(collection, ident)] = copy.deepcopy(value)
    def counter(self, name): return copy.deepcopy(self.counters.get(name, dict(attempts=[])))
    def counter_put(self, name, value): self.counters[name] = copy.deepcopy(value)
    def security(self, user): return copy.deepcopy(self.epochs.get(user, dict(epoch=0, blocked=False)))
    def security_put(self, user, value): self.epochs[user] = copy.deepcopy(value)
    def identity_get(self, user): return copy.deepcopy(self.profile) if user == self.profile['id'] else None
    def bind_org(self, org):
        if org != self.profile['org']: raise AssertionError('Fixture tenant changed')
    def member_get(self, org, user): return copy.deepcopy(self.member)


class FixtureIdentity:
    def __init__(self):
        self.user = SimpleNamespace(uid='fixture-owner', email='owner@example.test', disabled=False, email_verified=False)
        self.password, self.revocations = 'fixture-old-password-123', 0
        self.codes = {}
        self.calls = []
        self.lock = threading.RLock()
        self.inspection_barrier = None
        self.lose_acknowledgement = False
        self.fail_before_apply = False
        for code, kind in [('fixture-verify', 'VERIFY_EMAIL'), ('fixture-reset', 'PASSWORD_RESET'),
                           ('fixture-fresh', 'PASSWORD_RESET'), ('fixture-recover', 'RECOVER_EMAIL'),
                           ('fixture-expired', 'VERIFY_EMAIL'), ('fixture-used', 'VERIFY_EMAIL')]:
            self.codes[code] = dict(kind=kind, expires=time.time() + 3600, used=False)
        self.codes['fixture-expired']['expires'] = 0
        self.codes['fixture-used']['used'] = True
        for code in ['fixture-verify-double', 'fixture-verify-interrupted', 'fixture-verify-navigation',
                     'fixture-verify-reload', 'fixture-verify-pending', 'fixture-verify-timeout', 'fixture-verify-popstate']:
            self.codes[code] = dict(kind='VERIFY_EMAIL', expires=time.time()+3600, used=False)
        self.codes['fixture-reset-mobile'] = dict(kind='PASSWORD_RESET', expires=time.time()+3600, used=False)

    def rest(self, action, data):
        with self.lock:
            self.calls.append((action, dict(data)))
            if action not in ('resetPassword', 'update'):
                raise AssertionError('A fixture must never send email or call another operation')
            item = self.codes.get(data.get('oobCode'))
            if not item or item['used'] or item['expires'] <= time.time():
                raise Problem('Invalid fixture action', 401)
            inspect = action == 'resetPassword' and 'newPassword' not in data
            if inspect:
                result = dict(email=self.user.email, requestType=item['kind'])
            else:
                if self.fail_before_apply: raise RuntimeError('Synthetic unavailable provider')
                if action == 'update':
                    if set(data) != {'oobCode'} or item['kind'] != 'VERIFY_EMAIL': raise Problem('Wrong fixture purpose', 401)
                    self.user.email_verified = True
                else:
                    if item['kind'] != 'PASSWORD_RESET': raise Problem('Wrong fixture purpose', 401)
                    self.password = data['newPassword']
                item['used'] = True
                if self.lose_acknowledgement: raise RuntimeError('Synthetic acknowledgement loss after apply')
                result = dict(email=self.user.email)
        if inspect and self.inspection_barrier: self.inspection_barrier.wait(timeout=5)
        return result

    def user_by_email(self, email):
        if email != self.user.email: raise Problem('Invalid fixture user', 401)
        return self.user
    def revoke(self, user): self.revocations += 1


class FixtureActionService(IdentityLifecycle):
    def __init__(self):
        self.guard = SimpleNamespace(delivery=False)
        self.identity = FixtureIdentity()
        self.store = FixtureStore()
        self.lock, self.local = threading.RLock(), threading.local()

    def run(self, callback):
        # Atomic rollback makes the claim/epoch race meaningful in local tests.
        with self.lock:
            before = copy.deepcopy(self.store)
            try: return callback(self.store)
            except Exception:
                self.store = before
                raise

    def admit_request(self, path, token): pass
    def dispatch(self, *args): raise Problem('Fixture has no signed-in session', 401)


if __name__ == '__main__':
    import argparse
    from unittest.mock import patch
    from app import create_server
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4331)
    args = parser.parse_args()
    if args.port != 4331: raise SystemExit('Fixture server is restricted to loopback test port 4331')
    fixture = FixtureActionService()
    fixture.claim_email_action('verifyEmail', 'fixture-verify-pending')
    with patch('app.Service', return_value=fixture):
        server = create_server('unused-synthetic-fixture', args.port)
    print('Synthetic email-action fixture: http://127.0.0.1:4331 (no provider or email transport)', flush=True)
    server.serve_forever()
