import json
import unittest
from datetime import date
import test_core
from core import Service,Problem


class ExtensionTests(unittest.TestCase):
    setUp=test_core.CoreTests.setUp
    tearDown=test_core.CoreTests.tearDown
    get=test_core.CoreTests.get
    call=test_core.CoreTests.call
    account=test_core.CoreTests.account
    shift=test_core.CoreTests.shift
    save=test_core.CoreTests.save
    assert_problem=test_core.CoreTests.assert_problem

    def leave(self,start='2026-10-19',end='2026-10-19'):
        return self.call('/leave',dict(employee=self.e['id'],start=start,end=end,reason='Fictional time off'))

    def test_hierarchy_canonical_parentage_names_and_tenant_denial(self):
        tree=self.get('/api/hierarchy')
        self.assertEqual([len(tree[k]) for k in ('countries','markets','areas')],[1,1,1])
        area=tree['areas'][0]
        self.call('/hierarchy',area|dict(kind='area',name='Renamed East'))
        self.assertEqual(self.get('/api/me')['branches'][0]['area'],'Renamed East')
        self.assert_problem(lambda:self.call('/hierarchy',dict(kind='area',parent=area['parent'],name='RENAMED EAST')),409)
        other=self.s.signup(dict(name='Other',organization='Other',email='hierarchy-other@example.test',password='fictional-only-123'))
        self.assert_problem(lambda:self.call('/branches',dict(name='Wrong',area_id=area['id']),other),404)
        self.assert_problem(lambda:self.call('/hierarchy',dict(kind='market',parent=tree['countries'][0]['id'],name='Wrong'),other),404)

    def test_area_scope_includes_new_branches_but_not_other_area(self):
        area=self.a['area_id']
        user=self.call('/members',dict(name='Area',email='dynamic-area@example.test',password='fictional-only-123',role='area_manager',areas=[area],branches=[]))
        token=self.s.signin(dict(email=user['email'],password='fictional-only-123'))
        third=self.call('/branches',dict(name='New East',area_id=area))
        outside=self.call('/branches',dict(name='West',country='Testland',market='Metro',area='West'))
        self.assertEqual(len(self.get('/api/hierarchy',token=token)['areas']),1)
        self.save([],branch=third['id'],token=token)
        self.assert_problem(lambda:self.save([],branch=outside['id'],token=token),403)
        self.assert_problem(lambda:self.call('/hierarchy',dict(kind='country',name='Unauthorised'),token),403)
        self.assert_problem(lambda:self.call('/leave/adjust',dict(employee=self.e['id'],days=1,effective=self.week,reason='No',idempotency_key='bad'),token),403)

    def test_every_scoped_role_cannot_manage_global_hierarchy_policy_or_ledger(self):
        for role,branches,employee in [('area_manager',[self.a['id']],None),('branch_manager',[self.a['id']],None),('employee',[self.a['id']],self.e['id'])]:
            token=self.account(role,branches,employee)
            for path,data in [('/hierarchy',dict(kind='country',name='Denied')),('/settings',dict(max_day_hours=24)),('/leave/adjust',dict(employee=self.e['id'],days=1,effective=self.week,reason='Denied',idempotency_key=role))]:
                self.assert_problem(lambda path=path,data=data:self.call(path,data,token),403)
        admin=self.account('admin',[self.a['id']])
        self.assertEqual(self.call('/hierarchy',dict(kind='country',name='Allowed'),admin)['name'],'Allowed')
        self.assert_problem(lambda:self.call('/members',dict(role='admin'),admin),403)

    def test_effective_week_transition_preserves_history_and_partial_period(self):
        self.save([self.shift()],action='publish')
        self.call('/settings',dict(effective='2026-10-23',week_start=4))
        self.assertEqual(self.get('/api/schedule',dict(branch=self.a['id'],week=self.week))['period_days'],7)
        partial=self.get('/api/schedule',dict(branch=self.a['id'],week='2026-10-19'))
        self.assertEqual((partial['period_days'],partial['period_end'],partial['next_week']),(4,'2026-10-22','2026-10-23'))
        self.call('/schedule',dict(branch=self.a['id'],week='2026-10-19',revision=0,shifts=[self.shift('2026-10-22T09:00','2026-10-22T17:00')]))
        self.assert_problem(lambda:self.call('/schedule',dict(branch=self.a['id'],week='2026-10-19',revision=1,shifts=[self.shift('2026-10-23T09:00','2026-10-23T17:00')])),contains='branch-local week')
        self.assertEqual(self.get('/api/calendar',dict(day='2026-10-23'))['planning']['start'],'2026-10-23')

    def test_policy_rejects_invalidating_commitments_and_duplicate_date(self):
        self.save([self.shift()],action='publish')
        self.assert_problem(lambda:self.call('/settings',dict(effective='2026-10-12',max_day_hours=4)),409)
        self.assertEqual(self.get('/api/calendar',dict(day=self.week))['policy']['policy']['max_day_hours'],10)
        self.call('/settings',dict(effective='2026-11-02',max_day_hours=9))
        self.assert_problem(lambda:self.call('/settings',dict(effective='2026-11-02',max_day_hours=8)),409)
        self.assert_problem(lambda:self.call('/settings',dict(effective='2026-01-01',max_day_hours=9)),contains='backdated')

    def test_workdays_pay_period_and_fiscal_date(self):
        self.call('/settings',dict(workdays=[0,1,2,3,4],pay_cycle='fortnightly',pay_anchor='2026-10-05',fiscal_start_month=4,fiscal_start_day=15))
        view=self.get('/api/calendar',dict(day='2026-10-17'))
        self.assertEqual(view['pay']['start'],'2026-10-05')
        self.assertEqual(view['pay']['end'],'2026-10-18')
        self.assertEqual(view['fiscal']['start'],'2026-04-15')
        self.assert_problem(lambda:self.save([self.shift('2026-10-17T09:00','2026-10-17T17:00')]),contains='working weekdays')
        self.call('/settings',dict(effective='2027-01-01',pay_cycle='semimonthly',pay_split_day=16))
        self.assertEqual(self.get('/api/calendar',dict(day='2028-02-29'))['pay']['end'],'2028-02-29')

    def test_monthly_accrual_and_projected_reservation(self):
        self.call('/employees',self.e|dict(start_date='2026-01-01'))
        self.call('/settings',dict(leave_accrual='monthly',annual_leave_days=24))
        leave=self.leave()
        self.call('/leave/decide',dict(id=leave['id'],status='approved'))
        ledger=self.get('/api/leave/ledger',dict(employee=self.e['id'],on='2026-10-03'))
        self.assertEqual((ledger['balance']['earned'],ledger['balance']['reserved'],ledger['balance']['remaining']),(20,1,19))
        future=self.get('/api/leave/ledger',dict(employee=self.e['id'],on='2026-12-31'))
        self.assertEqual(future['balance']['earned'],24)
        self.assertTrue(future['unposted_earned'])
        self.assertEqual(sum(e['kind']=='reserve' for e in ledger['entries']),1)

    def test_daily_leap_year_accrual_exact_total_and_join_proration(self):
        self.call('/employees',self.e|dict(start_date='2028-01-01'))
        self.call('/settings',dict(leave_accrual='daily',annual_leave_days=25))
        ledger=self.get('/api/leave/ledger',dict(employee=self.e['id'],on='2028-12-31'))
        self.assertEqual(ledger['balance']['earned'],25)
        self.call('/settings',dict(effective='2027-01-01',leave_accrual='annual_upfront',leave_prorate_joiners=True))
        self.call('/employees',self.e|dict(start_date='2028-07-02'))
        self.assertAlmostEqual(self.get('/api/leave/ledger',dict(employee=self.e['id'],on='2028-12-31'))['balance']['earned'],12.5,places=4)

    def test_adjustment_idempotency_reason_and_negative_rollback(self):
        body=dict(employee=self.e['id'],days=2,effective='2026-10-03',reason='Opening balance correction',idempotency_key='once')
        first=self.call('/leave/adjust',body)
        self.assertEqual(first['id'],self.call('/leave/adjust',body)['id'])
        self.assert_problem(lambda:self.call('/leave/adjust',body|dict(days=3)),409)
        self.assert_problem(lambda:self.call('/leave/adjust',body|dict(reason='Different reason')),409)
        self.assert_problem(lambda:self.call('/leave/adjust',body|dict(days=-50,idempotency_key='negative')),409)
        entries=self.get('/api/leave/ledger',dict(employee=self.e['id']))['entries']
        self.assertEqual(sum(e['kind']=='adjustment' for e in entries),1)
        self.assertEqual(self.get('/api/me')['balances'][0]['adjusted'],2)

    def test_cancellation_requires_approval_and_releases_reservation_once(self):
        employee=self.account('employee',[self.a['id']],self.e['id'])
        leave=self.leave()
        self.call('/leave/decide',dict(id=leave['id'],status='approved'))
        requested=self.call('/leave/cancel',dict(id=leave['id']),employee)
        self.assertEqual(requested['status'],'cancel_requested')
        self.assert_problem(lambda:self.call('/schedule',dict(branch=self.a['id'],week='2026-10-19',revision=0,shifts=[self.shift('2026-10-19T09:00','2026-10-19T17:00')])),contains='approved leave')
        self.assertEqual(self.call('/leave/cancel',dict(id=leave['id']))['status'],'cancelled')
        self.assert_problem(lambda:self.call('/leave/cancel',dict(id=leave['id'])),409)
        ledger=self.get('/api/leave/ledger',dict(employee=self.e['id']))
        self.assertEqual((ledger['balance']['reserved'],ledger['balance']['remaining']),(0,25))
        self.assertEqual(sum(e['kind']=='release' for e in ledger['entries']),1)
        self.call('/schedule',dict(branch=self.a['id'],week='2026-10-19',revision=0,shifts=[self.shift('2026-10-19T09:00','2026-10-19T17:00')]))

    def test_carryover_caps_and_employee_ledger_scope(self):
        self.call('/settings',dict(max_carryover_days=5))
        employee=self.account('employee',[self.a['id']],self.e['id'])
        view=self.get('/api/leave/ledger',dict(employee=self.e['id'],on='2027-01-01'),employee)
        self.assertEqual(view['balance']['carryover'],5)
        other=self.call('/employees',dict(name='Other Fictional',branch=self.a['id']))
        self.assert_problem(lambda:self.get('/api/leave/ledger',dict(employee=other['id']),employee),403)
        manager=self.account('branch_manager',[self.b['id']])
        self.assert_problem(lambda:self.get('/api/leave/ledger',dict(employee=self.e['id']),manager),403)
        reloaded=Service(self.db)
        self.assertEqual(reloaded.dispatch(employee,'GET','/api/leave/ledger',{},dict(employee=self.e['id'],on='2027-01-01'))['balance']['carryover'],5)

    def test_hashed_sessions_idle_expiry_own_revoke_and_password_change(self):
        second=self.s.signin(dict(email='owner@example.test',password='fictional-only-123'))
        with self.s.connect() as c:
            self.assertNotIn(second,[r['token'] for r in c.execute('SELECT token FROM sessions')])
        listed=self.get('/api/sessions')
        foreign=self.account('employee',[self.a['id']],self.e['id'])
        self.assert_problem(lambda:self.call('/sessions/revoke',dict(id=listed[0]['id']),foreign),403)
        self.call('/sessions/revoke',dict(all_others=True))
        self.assert_problem(lambda:self.get('/api/me',token=second),401)
        self.call('/password',dict(current_password='fictional-only-123',password='new-fictional-pass-456'))
        self.assert_problem(lambda:self.get('/api/me'),401)
        self.assert_problem(lambda:self.s.signin(dict(email='owner@example.test',password='fictional-only-123')),401)
        token=self.s.signin(dict(email='owner@example.test',password='new-fictional-pass-456'))
        with self.s.connect() as c:
            import time
            c.execute('UPDATE sessions SET last_seen=?',(time.time()-1900,))
        self.assert_problem(lambda:self.get('/api/me',token=token),401)

    def test_persistent_failed_login_throttle(self):
        for _ in range(8):
            self.assert_problem(lambda:self.s.signin(dict(email='not-found@example.test',password='wrong')),401)
        restarted=Service(self.db)
        self.assert_problem(lambda:restarted.signin(dict(email='not-found@example.test',password='wrong')),429)

    def test_disable_and_rescope_revoke_sessions_without_cross_tenant_grants(self):
        token=self.account('branch_manager',[self.a['id']])
        member=next(m for m in self.get('/api/me')['members'] if m['role']=='branch_manager')
        self.call('/members/update',dict(id=member['id'],enabled=False))
        self.assert_problem(lambda:self.get('/api/me',token=token),401)
        self.assert_problem(lambda:self.s.signin(dict(email=member['email'],password='fictional-only-123')),401)
        self.call('/members/update',dict(id=member['id'],enabled=True,branches=[self.b['id']]))
        token=self.s.signin(dict(email=member['email'],password='fictional-only-123'))
        self.assert_problem(lambda:self.save([],token=token),403)
        self.save([],branch=self.b['id'],token=token)
        owner=next(m for m in self.get('/api/me')['members'] if m['role']=='owner')
        self.assert_problem(lambda:self.call('/members/update',dict(id=owner['id'],enabled=False)),403)

    def test_ledger_immutable_and_failed_policy_reduction_rolls_back(self):
        leave=self.leave('2027-01-04','2027-01-08')
        self.call('/leave/decide',dict(id=leave['id'],status='approved'))
        self.assert_problem(lambda:self.call('/settings',dict(effective='2027-01-01',annual_leave_days=1)),409)
        with self.s.connect() as c:
            import sqlite3
            with self.assertRaises(sqlite3.IntegrityError):
                c.execute('UPDATE leave_ledger SET days=999')
        self.assertEqual(self.get('/api/leave/ledger',dict(employee=self.e['id'],on='2027-01-01'))['balance']['projected_remaining'],20)

    def test_pay_policy_transition_clips_periods_without_rewriting_history(self):
        self.save([self.shift()],action='publish')
        self.call('/settings',dict(effective='2026-10-19',pay_cycle='fortnightly',pay_anchor='2026-10-19'))
        old=self.get('/api/calendar',dict(day='2026-10-12'))
        new=self.get('/api/calendar',dict(day='2026-10-19'))
        self.assertEqual((old['pay']['start'],old['pay']['end']),('2026-10-01','2026-10-18'))
        self.assertEqual((new['pay']['start'],new['pay']['end']),('2026-10-19','2026-11-01'))

    def test_partial_cancellation_preserves_consumption_and_reject_keeps_reservation(self):
        from datetime import datetime,timezone
        self.s.now=lambda:datetime(2026,10,5,12,tzinfo=timezone.utc)
        self.call('/employees',self.e|dict(start_date='2026-10-01'))
        leave=self.leave('2026-10-05','2026-10-09')
        self.call('/leave/decide',dict(id=leave['id'],status='approved'))
        employee=self.account('employee',[self.a['id']],self.e['id'])
        self.s.now=lambda:datetime(2026,10,7,12,tzinfo=timezone.utc)
        self.call('/leave/cancel',dict(id=leave['id']),employee)
        self.call('/leave/cancel',dict(id=leave['id'],decision='reject'))
        self.assertEqual(self.get('/api/leave/ledger',dict(employee=self.e['id']))['balance']['reserved'],2)
        self.call('/leave/cancel',dict(id=leave['id']),employee)
        self.assert_problem(lambda:self.call('/leave/cancel',dict(id=leave['id'],cancel_from='2026-10-07')),contains='unconsumed')
        result=self.call('/leave/cancel',dict(id=leave['id']))
        self.assertEqual((result['status'],result['end'],result['days']),('partially_cancelled','2026-10-07',3))
        balance=self.get('/api/leave/ledger',dict(employee=self.e['id']))['balance']
        self.assertEqual((balance['consumed'],balance['reserved'],balance['remaining']),(3,0,22))
        self.assert_problem(lambda:self.call('/leave/cancel',dict(id=leave['id'],cancel_from='2026-10-05')),contains='unconsumed')
        self.assert_problem(lambda:self.call('/schedule',dict(branch=self.a['id'],week='2026-10-05',revision=0,shifts=[self.shift('2026-10-06T09:00','2026-10-06T17:00')])),contains='approved leave')

    def test_leave_clock_uses_home_branch_date_across_timezone_boundary(self):
        from datetime import datetime,timezone
        self.s.now=lambda:datetime(2026,10,5,12,tzinfo=timezone.utc)
        self.call('/employees',self.e|dict(start_date='2026-10-01'))
        self.call('/branches',self.a|dict(timezone='America/Los_Angeles'))
        leave=self.leave('2026-10-06','2026-10-06')
        self.call('/leave/decide',dict(id=leave['id'],status='approved'))
        self.s.now=lambda:datetime(2026,10,6,1,tzinfo=timezone.utc)
        balance=self.get('/api/leave/ledger',dict(employee=self.e['id']))['balance']
        self.assertEqual((balance['on'],balance['consumed']),('2026-10-05',0))
        self.call('/leave/cancel',dict(id=leave['id'],cancel_from='2026-10-06'))
        self.assertEqual(self.get('/api/leave/ledger',dict(employee=self.e['id']))['balance']['used'],0)

    def test_partial_week_analytics_uses_period_and_active_cancellation_leave(self):
        self.call('/settings',dict(workdays=[0,1,2,3,4]))
        self.call('/employees',self.e|dict(availability={str(i):[dict(start='09:00',end='17:00')] for i in range(7)}))
        self.save([],action='publish')
        self.call('/settings',dict(effective='2026-10-23',week_start=4))
        leave=self.leave('2026-10-19','2026-10-19')
        self.call('/leave/decide',dict(id=leave['id'],status='approved'))
        employee=self.account('employee',[self.a['id']],self.e['id'])
        self.call('/leave/cancel',dict(id=leave['id']),employee)
        report=self.get('/api/analytics',dict(week='2026-10-19',branch=self.a['id']))
        self.assertEqual({r['date'] for r in report['coverage']},{'2026-10-19','2026-10-20','2026-10-21','2026-10-22'})
        self.assertEqual(report['distribution'][0]['available_hours'],24)
        self.assertEqual(report['leave_outlook'][0]['status'],'cancel_requested')

    def test_policy_checks_rest_across_effective_boundary(self):
        self.save([self.shift('2026-10-12T09:00','2026-10-12T17:00'),self.shift('2026-10-13T09:00','2026-10-13T17:00')],action='publish')
        self.assert_problem(lambda:self.call('/settings',dict(effective='2026-10-13',min_rest_hours=20)),409)

    def test_concurrent_leave_approval_reserves_once(self):
        from concurrent.futures import ThreadPoolExecutor
        leave=self.leave()
        def approve(_):
            try:
                return self.call('/leave/decide',dict(id=leave['id'],status='approved'))['status']
            except Problem as error:
                return error.status
        with ThreadPoolExecutor(max_workers=2) as executor:
            results=list(executor.map(approve,range(2)))
        self.assertEqual(sorted(map(str,results)),['409','approved'])
        self.assertEqual(sum(r['kind']=='reserve' for r in self.get('/api/leave/ledger',dict(employee=self.e['id']))['entries']),1)

    def test_cancellation_approval_after_elapsed_days_releases_only_future(self):
        from datetime import datetime,timezone
        self.s.now=lambda:datetime(2026,10,5,12,tzinfo=timezone.utc)
        self.call('/employees',self.e|dict(start_date='2026-10-01'))
        leave=self.leave('2026-10-05','2026-10-09')
        self.call('/leave/decide',dict(id=leave['id'],status='approved'))
        employee=self.account('employee',[self.a['id']],self.e['id'])
        self.call('/leave/cancel',dict(id=leave['id']),employee)
        self.s.now=lambda:datetime(2026,10,7,12,tzinfo=timezone.utc)
        result=self.call('/leave/cancel',dict(id=leave['id']))
        self.assertEqual((result['end'],result['days'],result['cancelled_days']),('2026-10-07',3,2))
        self.assertEqual(self.get('/api/leave/ledger',dict(employee=self.e['id']))['balance']['consumed'],3)

    def test_available_capacity_unions_overnight_windows_and_clips_period(self):
        self.call('/settings',dict(max_week_hours=168))
        self.call('/employees',self.e|dict(contract_hours=168,availability={'0':[dict(start='22:00',end='06:00')],'1':[dict(start='00:00',end='08:00')],'6':[dict(start='22:00',end='06:00')]}))
        report=self.get('/api/analytics',dict(week=self.week,branch=self.a['id']))
        self.assertEqual(report['distribution'][0]['available_hours'],18)
