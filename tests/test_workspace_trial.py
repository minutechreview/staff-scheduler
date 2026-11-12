"""No-network trial policy and production-domain dispatch tests."""
import sys
import unittest
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from core import Service, Problem, settings
from workspace_trial import WorkspaceTrial, new_trial, TRIAL_DURATION

NOW = datetime(2026, 11, 10, 12, tzinfo=timezone.utc)

class Unit:
    def __init__(self):
        self.rows = {'org-a': new_trial('org-a', NOW)}
        self.org = 'org-a'
        self.deleted = []
    def trial_get(self, org):
        if org != self.org: raise Problem('Cross-tenant repository context is forbidden.', 403)
        return deepcopy(self.rows.get(org))
    def begin(self): pass
    def entity_rows(self, *args): return []
    def session_delete_token(self, token): self.deleted.append(token)

class TrialService(Service):
    def __init__(self):
        self.unit = Unit()
        self.now = lambda: NOW
        self.workspace_trial = WorkspaceTrial(self)
        self.bootstrap_calls = 0
    @contextmanager
    def connect(self): yield self.unit
    def actor(self, c, token):
        if token != 'session': raise Problem('Sign in to continue.', 401)
        return dict(org='org-a', role='owner', id='owner', name='Owner', csrf='csrf')
    def bootstrap(self, c, actor):
        self.bootstrap_calls += 1
        return dict(user=actor, branches=['private'])

class WorkspaceTrialTests(unittest.TestCase):
    def setUp(self):
        self.s = TrialService()
        self.actor = self.s.actor(None, 'session')
    def status(self): return self.s.workspace_trial.status(self.s.unit, self.actor)
    def call(self, path, method='GET', data=None, token='session', csrf='csrf'):
        return self.s.dispatch(token, method, path, data or {}, {}, csrf)
    def test_exact_seven_days_and_no_automatic_charge(self):
        self.assertEqual(TRIAL_DURATION, timedelta(hours=168))
        for delta, allowed in [(timedelta(0), True), (TRIAL_DURATION-timedelta(microseconds=1), True), (TRIAL_DURATION, False), (timedelta(days=8), False)]:
            self.s.now = lambda: NOW + delta
            self.assertEqual(self.status()['entitled'], allowed)
        status = self.status()
        for flag in ('card_required', 'automatic_charge', 'checkout_available', 'portal_available'):
            self.assertIs(status[flag], False)
    def test_invalid_missing_future_and_clock_fail_closed(self):
        good = new_trial('org-a', NOW)
        bad = [None, {}, 'invalid', good | {'org':'org-b'}, good | {'version':True},
               good | {'started_at':'not-a-date'}, good | {'started_at':NOW.replace(tzinfo=None).isoformat()},
               good | {'ends_at':(NOW+timedelta(days=14)).isoformat()}, good | {'ends_at':None}]
        for row in bad:
            self.s.unit.rows['org-a'] = row
            self.assertFalse(self.status()['entitled'], row)
        self.s.unit.rows['org-a'] = good
        for now in (NOW-timedelta(microseconds=1), NOW.replace(tzinfo=None), None, 'tomorrow'):
            self.s.now = lambda: now
            self.assertEqual(self.status()['status'], 'trial_unavailable')
    def test_cross_org_and_paid_fields_never_grant_or_extend(self):
        self.actor['org'] = 'org-b'
        with self.assertRaises(Problem): self.status()
        self.actor['org'] = 'org-a'
        self.s.unit.rows['org-a'].update(status='active', checked_at=NOW.isoformat(), paid=True, trial_days=30)
        self.s.now = lambda: NOW + TRIAL_DURATION
        self.assertFalse(self.status()['entitled'])
    def test_dispatch_expiry_blocks_all_workspace_access_but_keeps_status_and_logout(self):
        self.assertIn('branches', self.call('/api/me'))
        self.s.now = lambda: NOW + TRIAL_DURATION
        self.assertTrue(self.call('/api/me')['billing_required'])
        self.assertNotIn('branches', self.call('/api/me'))
        self.assertEqual(self.s.bootstrap_calls, 1)
        self.assertEqual(self.call('/api/billing')['status'], 'trial_expired')
        for path, method in [('/api/hierarchy','GET'), ('/api/calendar','GET'), ('/api/analytics','GET'), ('/api/schedule','GET'), ('/api/settings','POST'), ('/api/members','POST')]:
            with self.subTest(path=path), self.assertRaises(Problem) as error: self.call(path, method)
            self.assertEqual(error.exception.status, 402)
        self.assertTrue(self.call('/api/signout', 'POST')['signed_out'])
        self.assertEqual(len(self.s.unit.deleted), 1)
    def test_auth_csrf_and_checkout_still_fail_closed(self):
        with self.assertRaises(Problem) as error: self.call('/api/billing', token='invalid')
        self.assertEqual(error.exception.status, 401)
        with self.assertRaises(Problem) as error: self.call('/api/signout', 'POST', csrf='bad')
        self.assertEqual(error.exception.status, 403)
        for path in ('/api/billing/checkout','/api/billing/portal','/api/billing/reconcile'):
            with self.assertRaises(Problem) as error: self.call(path, 'POST')
            self.assertEqual(error.exception.status, 503)
    def test_settings_cannot_write_control_fields(self):
        self.assertNotIn('started_at', settings({'started_at':'2099-01-01','ends_at':'2099-02-01','trial_days':100}))
        self.assertEqual(self.status()['started_at'], NOW.isoformat())
    def test_account_session_controls_are_not_trial_blocked(self):
        from unittest.mock import patch
        self.s.now = lambda: NOW + TRIAL_DURATION
        with patch('identity.sessions', return_value={'sessions':[]}) as sessions:
            self.assertEqual(self.call('/api/sessions'), {'sessions':[]})
            sessions.assert_called_once()
        with patch('identity.revoke', return_value={'revoked':True}) as revoke:
            self.assertTrue(self.call('/api/sessions/revoke', 'POST')['revoked'])
            revoke.assert_called_once()
        with patch('identity.password_change', return_value={'changed':True}) as change:
            self.assertTrue(self.call('/api/password', 'POST')['changed'])
            change.assert_called_once()
    def test_wsgi_trial_status_and_disabled_checkout_cannot_reach_provider(self):
        import io
        import json
        from unittest.mock import Mock
        from production_app import create_application
        self.s.admit_request = lambda *args: None
        self.s.billing_live = Mock()
        config = SimpleNamespace(hosts={'fixture.invalid'}, origin='https://fixture.invalid', synthetic_only=True)
        app = create_application(self.s, config)
        for path, method, expected in [('/api/billing','GET',200), ('/api/billing/checkout','POST',503), ('/api/billing/portal','POST',503)]:
            request = {'HTTP_HOST':'fixture.invalid', 'wsgi.url_scheme':'https', 'PATH_INFO':path,
                       'REQUEST_METHOD':method, 'HTTP_COOKIE':'__session=session', 'HTTP_X_CSRF_TOKEN':'csrf',
                       'HTTP_ORIGIN':config.origin, 'CONTENT_TYPE':'application/json', 'CONTENT_LENGTH':'2',
                       'wsgi.input':io.BytesIO(b'{}')}
            response = []
            body = json.loads(b''.join(app(request, lambda status, headers:response.append(status))))
            self.assertTrue(response[0].startswith(str(expected)), body)
            if method == 'GET': self.assertEqual(body['status'], 'trialing')
        self.assertEqual(self.s.billing_live.mock_calls, [])
