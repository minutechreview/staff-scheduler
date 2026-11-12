"""Threat-driven regression tests; disposable synthetic tenants only."""
import json
import test_core
import unittest
from core import Service, Problem


class SecurityTests(unittest.TestCase):
    def setUp(self):
        test_core.CoreTests.setUp(self)
        # These October leave scenarios need an employee with earned leave.
        # Defaulting their hire date to the real test-run date can leave the
        # fixture unfunded and mask the permission/conflict being exercised.
        self.e = self.call('/employees', self.e | dict(start_date='2026-01-01'))
    tearDown = test_core.CoreTests.tearDown
    get = test_core.CoreTests.get
    call = test_core.CoreTests.call
    account = test_core.CoreTests.account
    shift = test_core.CoreTests.shift
    save = test_core.CoreTests.save
    assert_problem = test_core.CoreTests.assert_problem

    def test_employee_cannot_read_branch_draft_or_coworker_schedule(self):
        coworker=self.call('/employees',dict(name='Private Coworker',branch=self.a['id']))
        self.save([self.shift(employee=coworker['id'])])
        employee=self.account('employee',[self.a['id']],self.e['id'])
        self.assert_problem(lambda:self.get('/api/schedule',dict(branch=self.a['id'],week=self.week),employee),403)
        feed=self.get('/api/my-schedule',dict(branch=self.a['id'],week=self.week),employee)
        self.assertEqual(feed['shifts'],[])

    def test_wages_are_admin_only_in_reads_and_mutations(self):
        self.call('/employees',self.e|dict(hourly_rate=17.25))
        manager=self.account('branch_manager',[self.a['id']])
        employee=self.account('employee',[self.a['id']],self.e['id'])
        for token in (manager,employee):
            self.assertNotIn('hourly_rate',self.get('/api/me',token=token)['employees'][0])
        self.assert_problem(lambda:self.call('/employees',self.e|dict(hourly_rate=99),manager),403)
        result=self.call('/employees',dict(id=self.e['id'],name=self.e['name'],branch=self.a['id'],skills=['associate']),manager)
        self.assertNotIn('hourly_rate',result)
        self.call('/availability',dict(id=self.e['id'],availability=self.e['availability']),employee)
        self.assertEqual(self.get('/api/me')['employees'][0]['hourly_rate'],17.25)

    def test_approved_support_reserves_employee_against_leave_approval(self):
        request=self.call('/support',dict(employee=self.e['id'],from_branch=self.a['id'],to_branch=self.b['id'],start='2026-10-19T09:00',end='2026-10-19T17:00',role='associate'))
        self.call('/support/decide',dict(id=request['id'],status='approved'))
        leave=self.call('/leave',dict(employee=self.e['id'],start='2026-10-19',end='2026-10-19',reason='Synthetic'))
        self.assert_problem(lambda:self.call('/leave/decide',dict(id=leave['id'],status='approved')),409)
        self.assertEqual(self.get('/api/me')['leaves'][0]['status'],'pending')
        self.assertEqual(self.get('/api/leave/ledger',dict(employee=self.e['id']))['balance']['reserved'],0)

    def test_injection_payload_does_not_broaden_tenant_or_execute_sql(self):
        other=self.s.signup(dict(name='Other',organization='Other',email='security-other@example.test',password='fictional-only-123'))
        self.assert_problem(lambda:self.get('/api/schedule',dict(branch=self.a['id']+"' OR 1=1 --",week=self.week),other),403)
        self.call('/employees',dict(name="<script>alert(1)</script>'); DROP TABLE users;--",branch=self.a['id']))
        with self.s.connect() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM users').fetchone()[0],2)
        self.assertEqual(len(self.get('/api/me',token=other)['employees']),0)

    def test_sensitive_leave_notes_do_not_enter_assistant_or_candidate_directory(self):
        self.call('/employees',self.e|dict(hourly_rate=17))
        leave=self.call('/leave',dict(employee=self.e['id'],start='2026-10-19',end='2026-10-19',reason='PRIVATE_SENTINEL_MEDICAL_NOTE'))
        self.call('/leave/decide',dict(id=leave['id'],status='approved'))
        answer=self.call('/assistant',dict(question='Who is on leave?',start='2026-10-01',end='2026-10-31'))
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(answer))
        candidates=self.get('/api/support-candidates',dict(to_branch=self.b['id']))
        self.assertNotIn('hourly_rate',json.dumps(candidates))
        self.assertNotIn('availability',json.dumps(candidates))

    def test_cross_tenant_mutation_ids_are_denied_and_leave_state_unchanged(self):
        other=self.s.signup(dict(name='Other',organization='Other',email='idor-other@example.test',password='fictional-only-123'))
        leave=self.call('/leave',dict(employee=self.e['id'],start='2026-10-19',end='2026-10-19',reason='Synthetic'))
        for path,body in [('/leave/decide',dict(id=leave['id'],status='approved')),('/leave/cancel',dict(id=leave['id'])),('/employees',self.e),('/members/update',dict(id=self.get('/api/me')['user']['id'],enabled=False)),('/hierarchy',dict(kind='area',id=self.a['area_id'],name='Wrong',parent=self.a['market_id']))]:
            self.assert_problem(lambda path=path,body=body:self.call(path,body,other),404 if path!='/employees' else 403)
        self.assertEqual(self.get('/api/me')['leaves'][0]['status'],'pending')

    def test_extreme_forecast_cannot_repeat_impossible_placement_search(self):
        self.call('/labor-policy',dict(branch=self.a['id'],transactions_per_hour=1,denominator='scheduled_paid_hours'))
        self.call('/demand/import',dict(branch=self.a['id'],confirm=True,rows=[dict(start='2026-10-12T09:00',end='2026-10-12T10:00',transactions=1_000_000_000,kind='forecast',granularity='interval',role='associate')]))
        original=self.s.validate
        calls=0
        def bounded(*args,**kwargs):
            nonlocal calls
            calls+=1
            if calls>500:
                raise AssertionError('Unbounded repeated placement search')
            return original(*args,**kwargs)
        self.s.validate=bounded
        result=self.call('/generate',dict(branch=self.a['id'],week=self.week,revision=0))
        self.assertFalse(result['saved'])
        self.assertGreater(max(row['missing'] for row in result['unfilled']),999_999_000)
        self.assertLess(calls,500)

    def test_csv_untrusted_shape_nonfinite_and_numeric_bounds(self):
        for rows in [[None],[dict(role=None)],[dict(transactions='NaN')],[dict(transactions='Infinity')],[dict(transactions=1e300)]]:
            result=self.call('/demand/preview',dict(branch=self.a['id'],rows=rows))
            self.assertFalse(result['valid'])
            self.assertEqual(result['rows'],[])
        self.assert_problem(lambda:self.call('/demand/preview',dict(branch=self.a['id'],csv='x\n'+('a\n'*10002))),contains='10,000')

    def test_approved_leave_denies_subsequent_cross_branch_support(self):
        leave=self.call('/leave',dict(employee=self.e['id'],start='2026-10-19',end='2026-10-19',reason='Synthetic'))
        self.call('/leave/decide',dict(id=leave['id'],status='approved'))
        support=self.call('/support',dict(employee=self.e['id'],from_branch=self.a['id'],to_branch=self.b['id'],start='2026-10-19T09:00',end='2026-10-19T17:00',role='associate'))
        self.assert_problem(lambda:self.call('/support/decide',dict(id=support['id'],status='approved')),contains='approved leave')
        self.assertEqual(self.get('/api/me')['support'][0]['status'],'pending')

    def test_session_fixation_and_disabled_revoked_cookie_cannot_mutate(self):
        employee=self.account('employee',[self.a['id']],self.e['id'])
        one=self.s.signin(dict(email='owner@example.test',password='fictional-only-123'))
        two=self.s.signin(dict(email='owner@example.test',password='fictional-only-123'))
        self.assertNotEqual(one,two)
        one_csrf=self.get('/api/me',token=one)['user']['csrf']
        self.assert_problem(lambda:self.s.dispatch(two,'POST','/api/signout',{}, {},one_csrf),403)
        member=next(m for m in self.get('/api/me')['members'] if m['role']=='employee')
        self.call('/members/update',dict(id=member['id'],enabled=False))
        self.assert_problem(lambda:self.s.dispatch(employee,'POST','/api/availability',dict(id=self.e['id'],availability={}),{},one_csrf),401)

    def test_concurrent_support_and_leave_approvals_cannot_both_commit(self):
        from concurrent.futures import ThreadPoolExecutor
        support=self.call('/support',dict(employee=self.e['id'],from_branch=self.a['id'],to_branch=self.b['id'],start='2026-10-19T09:00',end='2026-10-19T17:00',role='associate'))
        leave=self.call('/leave',dict(employee=self.e['id'],start='2026-10-19',end='2026-10-19',reason='Synthetic'))
        def approve(path,ident):
            try:
                self.call(path,dict(id=ident,status='approved'))
                return 'approved'
            except Problem:
                return 'denied'
        with ThreadPoolExecutor(max_workers=2) as executor:
            results=list(executor.map(lambda args:approve(*args),[('/support/decide',support['id']),('/leave/decide',leave['id'])]))
        self.assertEqual(sorted(results),['approved','denied'])

    def test_password_verification_throttle_is_durable_and_csrf_first(self):
        data=dict(current_password='wrong',password='new-fictional-only-123')
        self.assert_problem(lambda:self.s.dispatch(self.owner,'POST','/api/password',data,{},'forged'),403)
        with self.s.connect() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM login_attempts').fetchone()[0],0)
        for _ in range(8):
            self.assert_problem(lambda:self.call('/password',data),401)
        self.s=Service(self.db)
        self.assert_problem(lambda:self.call('/password',data|dict(current_password='fictional-only-123')),429)
        with self.s.connect() as c:
            self.assertEqual(c.execute('SELECT COUNT(*) FROM login_attempts').fetchone()[0],8)
            c.execute('UPDATE login_attempts SET created=0')
        self.assertTrue(self.call('/password',data|dict(current_password='fictional-only-123'))['signed_out'])
        self.assert_problem(lambda:self.get('/api/me'),401)

    def test_labor_policy_tiny_nonfinite_denominator_rejected(self):
        for target,factor in [(1e-320,1),(1,1e-320),(1,float('nan')),(1,float('inf'))]:
            self.assert_problem(lambda:self.call('/labor-policy',dict(branch=self.a['id'],transactions_per_hour=target,productive_factor=factor,denominator='scheduled_productive_hours')))
