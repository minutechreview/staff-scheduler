"""Scope, freshness, exactness and concurrent cache contracts on native emulators."""
import concurrent.futures
import threading
import unittest
from unittest.mock import patch
from firebase_contract import Fixture
from firebase_repository import FirestoreRepository
from core import Service

def payload(value):return {k:v for k,v in value.items() if k!='freshness'}

class AnalyticsContracts(Fixture):
    def report(self,token=None,branch=None):return self.get('/api/analytics',dict(week=self.week,branch=branch or self.a['id']),token)
    def test_cache_reuses_exact_result_then_employee_and_schedule_mutations_invalidate(self):
        self.save([self.shift()])
        first=self.report();second=self.report()
        self.assertEqual(payload(first),payload(second));self.assertEqual(second['freshness']['cache'],'version-validated reuse')
        self.call('/employees',self.e|dict(name='Synthetic Updated',hourly_rate=12))
        third=self.report()
        self.assertEqual(third['freshness']['cache'],'computed from transactional inputs')
        self.assertEqual(third['distribution'][0]['name'],'Synthetic Updated');self.assertEqual(third['cost'],96)
        self.save([],revision=1)
        self.assertEqual(self.report()['assigned_hours'],0)
    def test_failed_mutation_rolls_back_input_revisions_and_preserves_cached_correctness(self):
        employee=self.account('employee',[self.a['id']],self.e['id'])
        self.save([self.shift()]);before=self.report()
        self.assert_problem(lambda:self.call('/availability',dict(id=self.e['id'],availability={}),employee),409)
        after=self.report();self.assertEqual(payload(before),payload(after))
        self.assertEqual(after['freshness']['cache'],'version-validated reuse')
    def test_tenant_role_and_rescope_never_reuse_wages_or_other_branches(self):
        self.call('/employees',self.e|dict(hourly_rate=12));self.save([self.shift()]);owner=self.report()
        self.assertEqual(owner['cost'],96)
        manager=self.account('branch_manager',[self.a['id']]);result=self.report(manager)
        self.assertIsNone(result['cost']);self.assertEqual(payload(result),payload(self.report(manager)))
        self.assert_problem(lambda:self.get('/api/analytics',dict(week=self.week,branch=self.b['id']),manager),403)
        other=self.s.signup(dict(name='Other Synthetic',email='other-cache@example.test',password='fictional-only-123',organization='Other'))
        self.assert_problem(lambda:self.report(other),403)
        other_result=self.get('/api/analytics',dict(week=self.week),other)
        self.assertEqual(other_result['distribution'],[]);self.assertEqual(other_result['assigned_hours'],0)
        employee=self.account('employee',[self.a['id']],self.e['id'])
        self.assert_problem(lambda:self.report(employee),403)
        member=self.get('/api/me',token=manager)['user']['id']
        self.call('/members/update',dict(id=member,branches=[self.b['id']]))
        self.assert_problem(lambda:self.report(manager),401)
    def test_policy_and_demand_mutations_invalidate_exact_coverage(self):
        self.report();self.report()
        self.call('/settings',dict(effective=self.week,max_week_hours=32))
        changed=self.report();self.assertEqual(changed['freshness']['cache'],'computed from transactional inputs')
        self.assertEqual(changed['distribution'][0]['available_hours'],32)
        self.report()
        self.call('/demand/import',dict(branch=self.a['id'],csv=self.demand_csv(tx=160),confirm=True))
        changed=self.report();self.assertEqual(changed['freshness']['cache'],'computed from transactional inputs')
        self.assertGreater(changed['required_hours'],0)
    def test_leave_and_support_transitions_invalidate_available_hours_and_status(self):
        self.call('/employees',self.e|dict(availability={str(i):[dict(start='09:00',end='17:00')] for i in range(5)}))
        self.report();self.report()
        leave=self.call('/leave',dict(employee=self.e['id'],start=self.week,end=self.week))
        self.call('/leave/decide',dict(id=leave['id'],status='approved'))
        approved=self.report();self.assertEqual(approved['freshness']['cache'],'computed from transactional inputs')
        self.assertEqual(approved['leave_outlook'][0]['status'],'approved')
        self.assertLess(approved['distribution'][0]['available_hours'],40)
        support=self.call('/support',self.shift('2026-10-13T09:00','2026-10-13T17:00')|dict(from_branch=self.a['id'],to_branch=self.b['id']))
        self.report();self.report()
        self.call('/support/decide',dict(id=support['id'],status='approved'))
        changed=self.report();self.assertEqual(changed['freshness']['cache'],'computed from transactional inputs')
        self.assertEqual(changed['support_requests'][0]['status'],'approved')
    def test_ttl_expiry_recomputes_and_cache_copies_cannot_be_mutated(self):
        before=self.report();before['distribution'][0]['name']='Forged copy'
        again=self.report();self.assertEqual(again['distribution'][0]['name'],'Synthetic Alex')
        with self.s.analytics_cache.lock:
            for entry in self.s.analytics_cache.entries.values():entry['created']-=31
        self.assertEqual(self.report()['freshness']['cache'],'computed from transactional inputs')
    def test_read_abort_does_not_install_uncommitted_cache_entry(self):
        from google.api_core.exceptions import Aborted
        original=FirestoreRepository.flush;attempts=[]
        def abort_once(c):
            if c.after_commit:
                attempts.append(1)
                if len(attempts)==1:raise Aborted('Synthetic read transaction abort')
            return original(c)
        with patch.object(FirestoreRepository,'flush',abort_once),patch.object(self.s.analytics_cache,'put',wraps=self.s.analytics_cache.put) as put:
            result=self.report();self.assertEqual(put.call_count,1)
        self.assertEqual(len(attempts),2);self.assertEqual(result['assigned_hours'],0)
    def test_concurrent_read_and_mutation_return_valid_snapshots_then_current_result(self):
        self.save([self.shift()]);entered=threading.Event();release=threading.Event()
        original=Service.analytics
        def paused(service,*args,**kwargs):
            if threading.current_thread().name.startswith('report-worker'):
                entered.set();self.assertTrue(release.wait(10))
            return original(service,*args,**kwargs)
        with patch.object(Service,'analytics',paused),concurrent.futures.ThreadPoolExecutor(max_workers=1,thread_name_prefix='report-worker') as reader,concurrent.futures.ThreadPoolExecutor(max_workers=1) as writer:
            read=reader.submit(self.report);self.assertTrue(entered.wait(10))
            change=writer.submit(self.call,'/employees',self.e|dict(name='Synthetic Concurrent'))
            release.set();result=read.result(timeout=45);change.result(timeout=45)
        self.assertIn(result['distribution'][0]['name'],('Synthetic Alex','Synthetic Concurrent'))
        self.assertEqual(self.report()['distribution'][0]['name'],'Synthetic Concurrent')
    def test_windowed_report_matches_complete_history_oracle(self):
        self.save([self.shift()]);self.week='2026-10-19';self.save([self.shift('2026-10-19T09:00','2026-10-19T17:00')])
        self.s.cache_enabled=False
        windowed=self.report()
        with patch.object(self.s,'constraint_windows',return_value=None):full=self.report()
        self.assertEqual(payload(windowed),payload(full))
    def test_optional_cache_failure_does_not_fail_committed_read(self):
        with patch.object(self.s.analytics_cache,'put',side_effect=RuntimeError('Synthetic cache failure')):
            self.assertEqual(self.report()['assigned_hours'],0)
        self.assertEqual(self.s.local.metrics['cache_install_failures'],1)
    def test_missing_relevant_index_data_is_never_sampled_or_served_as_complete(self):
        self.save([self.shift()]);org=self.get('/api/me')['organization']['id']
        from firebase_repository import key
        def corrupt(c):
            c.bind_org(org);ref=c._collection(org,'reservation_manifests').document(key(self.e['id']))
            row=c.get(ref);row['groups'].append(dict(id='missing-relevant',start='2026-10-12T08:00:00+00:00',end='2026-10-12T18:00:00+00:00'))
            c.stage(ref,row);c.touch_analytics(org,'synthetic-integrity-test',self.e['id'])
        self.report();self.s.run(corrupt)
        self.assert_problem(self.report,503)

if __name__=='__main__':unittest.main(verbosity=2)
