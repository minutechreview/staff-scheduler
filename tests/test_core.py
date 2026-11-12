import concurrent.futures
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from core import Problem, Service, hours, local_instant, week_start

def domain_read(service,org,callback):
    if hasattr(service,'run'):
        def read(c):c.bind_org(org);return callback(c)
        return service.run(read)
    with service.connect() as c:return callback(c)


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / 'test.sqlite3'
        self.s = Service(self.db)
        # Fixed scheduling fixtures must not depend on the machine's current date.
        self.s.now = lambda: datetime(2026, 10, 10, 12, tzinfo=timezone.utc)
        self.owner = self.s.signup(dict(name='Fictional Owner', email='owner@example.test', password='fictional-only-123', organization='Synthetic Co'))
        self.week = '2026-10-12'
        self.a = self.call('/branches', dict(name='Alpha', country='Testland', market='Metro', area='East', timezone='Europe/London', coverage=[dict(start='09:00', end='17:00', role='associate', required=1)]))
        self.b = self.call('/branches', dict(name='Beta', country='Testland', market='Metro', area='East', timezone='Europe/London'))
        self.e = self.call('/employees', dict(name='Fictional Alex', branch=self.a['id'], skills=['associate'], contract_hours=40))

    def tearDown(self):
        self.temp.cleanup()

    def get(self, path, query=None, token=None):
        return self.s.dispatch(token or self.owner, 'GET', path, {}, query or {})

    def call(self, path, body, token=None):
        token = token or self.owner
        if path == '/employees' and 'start_date' not in body and 'id' not in body:
            body = dict(body, start_date='2026-01-01')
        csrf = self.get('/api/me', token=token)['user']['csrf']
        return self.s.dispatch(token, 'POST', f'/api{path}', body, {}, csrf)

    def account(self, role, branches, employee=None):
        email = f'{role}-{len(branches)}-{employee or branches[0]}@example.test'
        self.call('/members', dict(name=f'Fictional {role}', email=email, password='fictional-only-123', role=role, branches=branches, employee=employee))
        return self.s.signin(dict(email=email, password='fictional-only-123'))

    def shift(self, start='2026-10-12T09:00', end='2026-10-12T17:00', employee=None, role='associate'):
        return dict(employee=employee or self.e['id'], start=start, end=end, role=role)

    def save(self, shifts, revision=0, branch=None, action='save', token=None, acknowledge=True):
        return self.call('/schedule', dict(branch=branch or self.a['id'], week=self.week, revision=revision, shifts=shifts, action=action, acknowledge_gaps=acknowledge), token)

    def assert_problem(self, fn, status=None, contains=None):
        with self.assertRaises(Problem) as result:
            fn()
        if status:
            self.assertEqual(result.exception.status, status)
        if contains:
            self.assertIn(contains, str(result.exception))

    def test_signup_signin_signout_persistence(self):
        self.assert_problem(lambda: self.s.signin(dict(email='owner@example.test', password='wrong')), 401)
        reloaded = Service(self.db)
        self.assertEqual(reloaded.dispatch(self.owner, 'GET', '/api/me', {}, {})['employees'][0]['name'], 'Fictional Alex')
        self.call('/signout', {})
        self.assert_problem(lambda: self.get('/api/me'), 401)

    def test_password_hash_not_plaintext_and_csrf(self):
        with self.s.connect() as c:
            row = c.execute('SELECT password,salt FROM users').fetchone()
            self.assertNotIn('fictional-only', row['password'])
            self.assertEqual(len(row['salt']), 32)
        self.assert_problem(lambda: self.s.dispatch(self.owner, 'POST', '/api/demo', {}, {}, 'forged'), 403)

    def test_tenant_negative_read_write_aggregate_assistant(self):
        other = self.s.signup(dict(name='Other Owner', email='other@example.test', password='fictional-only-123', organization='Other tenant'))
        self.assertEqual(self.get('/api/me', token=other)['employees'], [])
        for path in ('/api/schedule', '/api/versions', '/api/analytics', '/api/demand'):
            self.assert_problem(lambda path=path: self.get(path, dict(branch=self.a['id'], week=self.week), other), 403)
        self.assert_problem(lambda: self.save([self.shift()], token=other), 403)
        self.assert_problem(lambda: self.call('/employees', self.e | dict(name='Hijacked'), other), 403)
        answer = self.call('/assistant', dict(question='How many active employees?', start=self.week, end=self.week), other)
        self.assertIn('0 active', answer['answer'])

    def test_branch_manager_cannot_cross_branch_or_promote(self):
        manager = self.account('branch_manager', [self.a['id']])
        self.assertEqual(len(self.get('/api/me', token=manager)['branches']), 1)
        self.assert_problem(lambda: self.save([], branch=self.b['id'], token=manager), 403)
        self.assert_problem(lambda: self.call('/members', dict(role='admin'), manager), 403)
        self.assert_problem(lambda: self.call('/settings', dict(max_week_hours=100), manager), 403)
        self.assert_problem(lambda: self.call('/branches', self.b, manager), 403)
        self.assertEqual(len(self.get('/api/analytics', dict(week=self.week), manager)['coverage']), 7)

    def test_area_manager_exact_assignments(self):
        third = self.call('/branches', dict(name='Gamma', country='Testland', market='Metro', area='West'))
        area = self.account('area_manager', [self.a['id'], self.b['id']])
        self.assertEqual(len(self.get('/api/me', token=area)['branches']), 2)
        self.save([], branch=self.b['id'], token=area)
        self.assert_problem(lambda: self.save([], branch=third['id'], token=area), 403)
        self.assert_problem(lambda: self.get('/api/analytics', dict(branch=third['id'], week=self.week), area), 403)

    def test_employee_published_only_own_visibility(self):
        employee = self.account('employee', [self.a['id']], self.e['id'])
        self.save([self.shift()])
        q = dict(branch=self.a['id'], week=self.week)
        self.assertEqual(self.get('/api/my-schedule', q, employee)['shifts'], [])
        self.save([self.shift()], 1, action='publish')
        self.assertEqual(len(self.get('/api/my-schedule', q, employee)['shifts']), 1)
        self.save([], 2)
        self.assertEqual(len(self.get('/api/my-schedule', q, employee)['shifts']), 1)
        self.assert_problem(lambda: self.save([], 3, token=employee), 403)
        self.assert_problem(lambda: self.get('/api/analytics', q, employee), 403)
        self.assert_problem(lambda: self.get('/api/versions', q, employee), 403)
        self.assertEqual(len(self.get('/api/me', token=employee)['employees']), 1)

    def test_concurrent_revision_compare_and_swap(self):
        def edit():
            try:
                return self.save([self.shift()])['revision']
            except Problem as e:
                return e.status
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: edit(), range(2)))
        self.assertEqual(sorted(results), [1, 409])
        self.assertEqual(len(self.get('/api/versions', dict(branch=self.a['id'], week=self.week))), 1)

    def test_publish_gap_acknowledgement_and_versions(self):
        self.assert_problem(lambda: self.save([self.shift()], action='publish', acknowledge=False), contains='Coverage gaps')
        self.save([self.shift()], action='publish')
        self.save([], 1)
        versions = self.get('/api/versions', dict(branch=self.a['id'], week=self.week))
        self.assertEqual(len(versions), 2)
        self.assertEqual(len(versions[1]['shifts']), 1)
        self.assertEqual(len(self.get('/api/schedule', dict(branch=self.a['id'], week=self.week))['published']), 1)

    def test_schedule_and_generation_respect_employment_start(self):
        self.call('/employees', self.e | dict(start_date='2026-10-13'))
        self.assert_problem(lambda: self.save([self.shift()]), contains='before employment begins')
        proposal = self.call('/generate', dict(branch=self.a['id'], week=self.week, revision=0))
        self.assertFalse(any(s['employee'] == self.e['id'] and s['start'].startswith('2026-10-12') for s in proposal['shifts']))
        self.assertTrue(any(x['date'] == '2026-10-12' for x in proposal['unfilled']))

    def test_overlapping_shift_and_skill_negative(self):
        self.assert_problem(lambda: self.save([self.shift(), self.shift('2026-10-12T16:00', '2026-10-12T18:00')]), contains='already assigned')
        self.assert_problem(lambda: self.save([self.shift(role='lead')]), contains='Missing required skill')

    def test_rest_daily_weekly_constraints(self):
        self.assert_problem(lambda: self.save([self.shift('2026-10-13T01:00', '2026-10-13T08:00')]), contains='availability')
        self.call('/employees', self.e | dict(availability={str(i): [dict(start='00:00', end='00:00')] for i in range(7)}))
        self.assert_problem(lambda: self.save([self.shift(), self.shift('2026-10-13T01:00', '2026-10-13T08:00')]), contains='rest')
        self.assert_problem(lambda: self.save([self.shift('2026-10-12T08:00', '2026-10-12T20:00')]), contains='daily hours')
        shifts = [self.shift(f'2026-10-{12+i}T09:00', f'2026-10-{12+i}T17:00') for i in range(6)]
        self.assert_problem(lambda: self.save(shifts), contains='weekly hours')

    def test_availability_conflicts_rollback(self):
        employee = self.account('employee', [self.a['id']], self.e['id'])
        self.save([self.shift()])
        self.assert_problem(lambda: self.call('/availability', dict(id=self.e['id'], availability={}), employee), 409)
        self.assertTrue(self.get('/api/me')['employees'][0]['availability'])
        other = self.call('/employees', dict(name='Other Person', branch=self.a['id'], skills=['associate']))
        self.assert_problem(lambda: self.call('/availability', dict(id=other['id'], availability={}), employee), 403)

    def test_leave_conflict_approval_and_balance(self):
        l = self.call('/leave', dict(employee=self.e['id'], start=self.week, end=self.week, reason='Private detail'))
        self.save([self.shift()], action='publish')
        self.assert_problem(lambda: self.call('/leave/decide', dict(id=l['id'], status='approved')), 409)
        self.save([], 1)
        self.assert_problem(lambda: self.call('/leave/decide', dict(id=l['id'], status='approved')), 409)
        self.save([], 2, action='publish')
        self.call('/leave/decide', dict(id=l['id'], status='approved'))
        self.assert_problem(lambda: self.save([self.shift()], 3), contains='approved leave')
        self.assertEqual(self.get('/api/me')['balances'][0]['remaining'], 24)
        self.assert_problem(lambda: self.call('/leave', dict(employee=self.e['id'], start=self.week, end=self.week)), 409)

    def test_leave_fiscal_boundary_and_allowance(self):
        self.call('/settings', dict(annual_leave_days=1, fiscal_start_month=4))
        l = self.call('/leave', dict(employee=self.e['id'], start='2027-03-31', end='2027-04-01'))
        self.call('/leave/decide', dict(id=l['id'], status='approved'))
        with self.s.connect() as c:
            self.assertEqual(self.s.leave_balance(c, self.get('/api/me')['user']['org'], self.e['id'], date(2027, 3, 31))['remaining'], 0)
            self.assertEqual(self.s.leave_balance(c, self.get('/api/me')['user']['org'], self.e['id'], date(2027, 4, 1))['remaining'], 0)

    def test_support_home_approval_and_scope(self):
        home = self.account('branch_manager', [self.a['id']])
        dest = self.account('branch_manager', [self.b['id']])
        r = self.call('/support', self.shift() | dict(from_branch=self.a['id'], to_branch=self.b['id']), dest)
        self.assert_problem(lambda: self.call('/support/decide', dict(id=r['id'], status='approved'), dest), 403)
        self.assert_problem(lambda: self.save([self.shift()], branch=self.b['id'], token=dest), contains='approved support')
        self.call('/support/decide', dict(id=r['id'], status='approved'), home)
        self.save([self.shift()], branch=self.b['id'], token=dest)
        self.assert_problem(lambda: self.save([self.shift()], token=home), contains='already assigned')
        candidates = self.get('/api/support-candidates', dict(to_branch=self.b['id']), dest)
        self.assertNotIn('hourly_rate', candidates[0])
        self.assertNotIn('availability', candidates[0])

    def test_support_double_booking_requests(self):
        r = self.call('/support', self.shift() | dict(from_branch=self.a['id'], to_branch=self.b['id']))
        self.call('/support/decide', dict(id=r['id'], status='approved'))
        again = self.call('/support', self.shift() | dict(from_branch=self.a['id'], to_branch=self.b['id']))
        self.assert_problem(lambda: self.call('/support/decide', dict(id=again['id'], status='approved')), 409)

    def test_employee_cross_branch_feed_is_published_and_personal(self):
        employee = self.account('employee', [self.a['id']], self.e['id'])
        r = self.call('/support', self.shift() | dict(from_branch=self.a['id'], to_branch=self.b['id']))
        self.call('/support/decide', dict(id=r['id'], status='approved'))
        self.save([self.shift()], branch=self.b['id'])
        self.assertEqual(self.get('/api/my-schedule', dict(week=self.week), employee)['shifts'], [])
        self.save([self.shift()], revision=1, branch=self.b['id'], action='publish')
        feed = self.get('/api/my-schedule', dict(week=self.week), employee)
        self.assertEqual(len(feed['shifts']), 1)
        self.assertEqual(feed['shifts'][0]['branch_name'], 'Beta')
        self.assertEqual(feed['shifts'][0]['employee'], self.e['id'])
        self.assert_problem(lambda: self.get('/api/schedule', dict(branch=self.b['id'], week=self.week), employee), 403)

    def test_coverage_weekdays_and_fixed_zero_demand_minima(self):
        self.call('/branches', self.a | dict(coverage=[dict(start='09:00', end='17:00', role='associate', required=1, days=[0,1,2,3,4])]))
        self.call('/labor-policy', dict(branch=self.a['id'], transactions_per_hour=20, denominator='scheduled_paid_hours', role='associate'))
        self.call('/demand/import', dict(branch=self.a['id'], csv=self.demand_csv(tx=0), confirm=True))
        report = self.get('/api/analytics', dict(branch=self.a['id'], week=self.week))
        self.assertEqual(report['required_hours'], 40)
        self.assertTrue(all(g['required'] == 1 for g in report['coverage']))

    def test_assistant_comparable_actuals_only_and_coarse_labels(self):
        csv = self.demand_csv(kind='actual', tx=20) + '\n2026-10-12T10:00,2026-10-12T11:00,40,actual,interval,associate,transactions'
        self.call('/demand/import', dict(branch=self.a['id'], csv=csv, confirm=True))
        result = self.call('/assistant', dict(question='When are quieter periods?', start=self.week, end=self.week))
        self.assertEqual(len(result['records']), 1)
        self.assertEqual(result['records'][0]['transactions'], 20)
        self.assertIn('actual imported counts', result['answer'])

    def test_generation_respects_leave_skills_and_hours(self):
        for i in range(3):
            self.call('/employees', dict(name=f'Fictional Person {i}', branch=self.a['id'], skills=['associate'], contract_hours=40))
        l = self.call('/leave', dict(employee=self.e['id'], start=self.week, end=self.week))
        self.call('/leave/decide', dict(id=l['id'], status='approved'))
        p = self.call('/generate', dict(branch=self.a['id'], week=self.week, revision=0))
        self.assertFalse(p['saved'])
        self.assertFalse(any(s['employee'] == self.e['id'] and s['start'].startswith(self.week) for s in p['shifts']))
        self.assertEqual(len(p['shifts']), 7)
        self.save(p['shifts'])
        self.assertEqual(self.get('/api/analytics', dict(branch=self.a['id'], week=self.week))['gap_hours'], 0)

    def test_custom_week_start_rejects_wrong_boundary(self):
        self.call('/settings', dict(week_start=4))
        self.assertEqual(week_start(date(2026, 10, 15), 4), date(2026, 10, 9))
        self.assert_problem(lambda: self.save([]), contains='first day')
        self.week = '2026-10-09'
        self.save([])
        # The implicit effective date must be a non-Monday for this rejection.
        # Otherwise the test legitimately passes the transition on real Mondays.
        with patch.object(self.s, 'local_today', return_value=date(2026, 10, 10)):
            self.assert_problem(lambda: self.call('/settings', dict(week_start=0)), contains='first weekday')

    def test_dst_nonexistent_ambiguous_offsets_and_elapsed_hours(self):
        self.assert_problem(lambda: local_instant('2026-03-08T02:30', 'America/New_York'), contains='does not exist')
        self.assert_problem(lambda: local_instant('2026-11-01T01:30', 'America/New_York'), contains='occurs twice')
        first = local_instant('2026-11-01T01:30', 'America/New_York', 0)
        second = local_instant('2026-11-01T01:30', 'America/New_York', 1)
        self.assertEqual((second - first).total_seconds(), 3600)
        a = local_instant('2026-03-08T00:00', 'America/New_York')
        b = local_instant('2026-03-08T08:00', 'America/New_York')
        self.assertEqual((b - a).total_seconds() / 3600, 7)

    def test_spring_dst_shift_checks_every_touched_home_date(self):
        # A 24 actual-hour interval spans Saturday, Sunday and Monday across
        # spring DST. Checking only the endpoints would omit the closed Sunday.
        self.call('/settings',dict(workdays=[0,1,2,3,4,5],max_day_hours=24,max_week_hours=168,min_rest_hours=0))
        branch=self.call('/branches',dict(name='Synthetic US',country='US',market='NY',area='East',timezone='America/New_York'))
        person=self.call('/employees',dict(name='Synthetic DST',branch=branch['id'],skills=['associate']))
        candidate=dict(id='synthetic-dst-three-days',employee=person['id'],branch=branch['id'],role='associate',start='2026-03-08T04:30:00+00:00',end='2026-03-09T04:30:00+00:00')
        org=self.get('/api/me')['organization']['id']
        errors=domain_read(self.s,org,lambda c:self.s.validate(c,org,[candidate],context=[]))
        self.assertIn('Outside configured working weekdays.',errors[0]['reason'])

    def test_constraint_windows_include_rest_and_complete_custom_periods_across_dst(self):
        from datetime import timedelta
        from core import stamp
        from organization import planning_from
        from zoneinfo import ZoneInfo
        for zone,start,end in [('Europe/London','2026-03-28T23:30:00+00:00','2026-03-29T23:30:00+00:00'),('America/New_York','2026-11-01T05:30:00+00:00','2026-11-01T08:30:00+00:00'),('Pacific/Auckland','2026-04-04T12:30:00+00:00','2026-04-04T16:30:00+00:00')]:
            for week_first in (0,4,6):
                with self.subTest(zone=zone,first=week_first):
                    org=self.get('/api/me')['organization']['id']
                    snapshot=domain_read(self.s,org,lambda c:self.s.validation_snapshot(c,org))
                    from copy import deepcopy
                    snapshot=deepcopy(snapshot)
                    for entry in snapshot['policies']:entry['policy'].update(week_start=week_first,min_rest_hours=48)
                    snapshot['branches'][self.a['id']]['timezone']=zone
                    candidate=dict(id='synthetic-window',employee=self.e['id'],branch=self.a['id'],role='associate',start=start,end=end)
                    window=self.s.constraint_windows([candidate],snapshot)[self.e['id']]
                    self.assertLessEqual(stamp(window['start']),stamp(start)-timedelta(hours=48))
                    self.assertGreaterEqual(stamp(window['end']),stamp(end)+timedelta(hours=48))
                    cursor=stamp(start)
                    while cursor<stamp(end):
                        day=cursor.astimezone(ZoneInfo(zone)).date();period=planning_from(snapshot['policies'],day)
                        self.assertLessEqual(stamp(window['start']),local_instant(period['start']+'T00:00',zone))
                        self.assertGreaterEqual(stamp(window['end']),local_instant(period['next']+'T00:00',zone))
                        cursor=min(stamp(end),local_instant(f'{day+timedelta(days=1)}T00:00',zone))

    def test_overnight_cross_timezone_and_week_split(self):
        self.call('/employees', self.e | dict(availability={str(i): [dict(start='20:00', end='08:00')] for i in range(7)}))
        s = self.save([self.shift('2026-10-18T22:00', '2026-10-19T06:00')])
        self.assertEqual(hours(s['shifts'][0]), 8)
        new_york = self.call('/branches', dict(name='US', country='US', market='New York', area='East', timezone='America/New_York'))
        r = self.call('/support', self.shift('2026-10-13T17:00', '2026-10-14T01:00') | dict(from_branch=self.a['id'], to_branch=new_york['id']))
        self.assertEqual(r['start'], '2026-10-13T21:00:00+00:00')

    def test_coverage_partial_interval_not_shift_label(self):
        self.save([self.shift('2026-10-12T09:00', '2026-10-12T13:00')])
        r = self.get('/api/analytics', dict(branch=self.a['id'], week=self.week))
        monday = [g for g in r['coverage'] if g['date'] == self.week]
        self.assertEqual([g['scheduled'] for g in monday], [1, 0])
        self.assertEqual(r['gap_hours'], 52)
        self.assertIsNone(r['cost'])

    def test_rates_require_data_and_role_permission(self):
        self.call('/employees', self.e | dict(hourly_rate=15))
        self.save([self.shift()])
        q = dict(branch=self.a['id'], week=self.week)
        self.assertEqual(self.get('/api/analytics', q)['cost'], 120)
        manager = self.account('branch_manager', [self.a['id']])
        self.assertIsNone(self.get('/api/analytics', q, manager)['cost'])

    def demand_csv(self, granularity='interval', kind='forecast', start=None, end=None, tx=40):
        return f'start,end,transactions,kind,granularity,role,units\n{start or self.week+"T09:00"},{end or self.week+"T10:00"},{tx},{kind},{granularity},associate,transactions'

    def test_demand_preview_confirm_duplicates_and_units(self):
        payload = dict(branch=self.a['id'], csv=self.demand_csv())
        self.assertTrue(self.call('/demand/preview', payload)['valid'])
        self.assertEqual(self.get('/api/demand', dict(branch=self.a['id'], week=self.week))['records'], [])
        self.assert_problem(lambda: self.call('/demand/import', payload), contains='confirm')
        self.call('/demand/import', payload | dict(confirm=True))
        self.assertFalse(self.call('/demand/preview', payload)['valid'])
        self.assertFalse(self.call('/demand/preview', payload | dict(csv=self.demand_csv(tx='people')))['valid'])
        self.assertFalse(self.call('/demand/preview', payload | dict(csv=self.demand_csv().replace('transactions\n', 'people\n')))['valid'])

    def test_demand_area_policy_bounded_branch_override(self):
        manager = self.account('branch_manager', [self.a['id']])
        policy = dict(branch=self.a['id'], transactions_per_hour=20, denominator='scheduled_paid_hours', productive_factor=1, allowed_override_percent=10, role='associate')
        self.assert_problem(lambda: self.call('/labor-policy', policy, manager), 403)
        area = self.account('area_manager', [self.a['id']])
        self.call('/labor-policy', policy, area)
        self.call('/labor-policy', policy | dict(transactions_per_hour=22), manager)
        self.assert_problem(lambda: self.call('/labor-policy', policy | dict(transactions_per_hour=25), manager), 403)
        self.assert_problem(lambda: self.call('/labor-policy', policy | dict(denominator='scheduled_productive_hours', productive_factor=.8), manager), 403)

    def test_demand_interval_increases_targets_coarse_does_not(self):
        self.call('/labor-policy', dict(branch=self.a['id'], transactions_per_hour=20, denominator='scheduled_paid_hours', role='associate'))
        self.call('/demand/import', dict(branch=self.a['id'], csv=self.demand_csv(tx=80), confirm=True))
        report = self.get('/api/analytics', dict(branch=self.a['id'], week=self.week))
        self.assertEqual(report['coverage'][0]['required'], 4)
        self.assertEqual(report['required_hours'], 59)
        csv = self.demand_csv('week', start=self.week+'T00:00', end='2026-10-19T00:00', tx=10000)
        self.call('/demand/import', dict(branch=self.a['id'], csv=csv, confirm=True))
        self.assertEqual(self.get('/api/analytics', dict(branch=self.a['id'], week=self.week))['required_hours'], 59)

    def test_assistant_scoped_medical_private_and_no_invented_demand(self):
        l = self.call('/leave', dict(employee=self.e['id'], start=self.week, end=self.week, reason='Secret medical text'))
        self.call('/leave/decide', dict(id=l['id'], status='approved'))
        payload = dict(question='Who is on leave?', start=self.week, end=self.week)
        answer = self.call('/assistant', payload)
        self.assertEqual(len(answer['records']), 1)
        self.assertNotIn('Secret medical', json.dumps(answer))
        self.assertEqual(answer['model_state'], 'unconfigured')
        sick = self.call('/assistant', payload | dict(question='Who is currently sick?'))
        self.assertEqual(sick['records'], [])
        self.assertIn('cannot be determined', sick['answer'])
        quiet = self.call('/assistant', payload | dict(question='When are quieter periods?'))
        self.assertIn('No actual transaction', quiet['answer'])
        mutation = self.call('/assistant', payload | dict(question='Assign a shift'))
        self.assertIn('read-only', mutation['answer'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
