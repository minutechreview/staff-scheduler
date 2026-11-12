import concurrent.futures,copy,sys,threading,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from core import Problem
from member_reconciliation import reconcile
class Store:
    def __init__(self):self.rows={('provisioning_jobs','member@example.test'):dict(uid='uid',kind='member',state='needs_reconciliation',org='org'),('pilot_member_capacity','org'):dict(reserved=2)};self.profile=None
    def control_get(self,c,k):return copy.deepcopy(self.rows.get((c,k)))
    def control_put(self,c,k,v):self.rows[(c,k)]=copy.deepcopy(v)
    def identity_get(self,u):return self.profile
class Provider:
    def __init__(self):self.record=SimpleNamespace(uid='uid',email='member@example.test',disabled=False);self.calls=0
    def user(self,uid):
        if self.record is None:raise Problem('missing',401)
        return self.record
    def disable_user(self,uid):self.calls+=1;self.record.disabled=True
class Tests(unittest.TestCase):
    def setUp(self):
        self.store=Store();self.provider=Provider();self.service=SimpleNamespace(guard=SimpleNamespace(safe_member_jobs=True))
        lock=threading.RLock()
        def run(fn):
            with lock:
                before=copy.deepcopy(self.store.rows)
                try:return fn(self.store)
                except Exception:self.store.rows=before;raise
        self.service.run=run
    def call(self,**kwargs):return reconcile(self.service,self.provider,'member@example.test','uid',**kwargs)
    def test_disabled_by_default(self):
        with self.assertRaises(Problem):self.call()
        self.assertEqual(self.provider.calls,0);self.assertEqual(self.store.rows[('pilot_member_capacity','org')]['reserved'],2)
    def test_matching_orphan_is_disabled_confirmed_and_released_once(self):
        self.assertTrue(self.call(enabled=True)['released']);self.assertEqual(self.provider.calls,1)
        self.assertEqual(self.store.rows[('pilot_member_capacity','org')]['reserved'],1)
        self.assertEqual(self.store.rows[('provisioning_jobs','member@example.test')]['state'],'reconciled_disabled')
        with self.assertRaises(Problem):self.call(enabled=True)
        self.assertEqual(self.store.rows[('pilot_member_capacity','org')]['reserved'],1)
    def test_absence_does_not_release_or_delete(self):
        self.provider.record=None
        self.assertEqual(self.call(enabled=True)['status'],'provider_absent_unresolved')
        self.assertEqual(self.store.rows[('pilot_member_capacity','org')]['reserved'],2)
    def test_profile_or_mismatch_never_disables(self):
        self.store.profile={'id':'uid'}
        with self.assertRaises(Problem):self.call(enabled=True)
        self.store.profile=None;self.provider.record.email='other@example.test'
        with self.assertRaises(Problem):self.call(enabled=True)
        self.assertEqual(self.provider.calls,0)
    def test_failed_disable_keeps_reservation_and_retry_can_finish(self):
        def fail(_):raise RuntimeError('unknown')
        self.provider.disable_user=fail
        with self.assertRaises(RuntimeError):self.call(enabled=True)
        self.assertEqual(self.store.rows[('pilot_member_capacity','org')]['reserved'],2)
        self.provider.record.disabled=True
        self.assertTrue(self.call(enabled=True)['released'])
    def test_concurrent_disable_submits_only_once_and_preserves_capacity(self):
        started=threading.Event();release=threading.Event()
        def disable(uid):
            self.provider.calls+=1;started.set();self.assertTrue(release.wait(5));self.provider.record.disabled=True
        self.provider.disable_user=disable
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            first=pool.submit(self.call,enabled=True);self.assertTrue(started.wait(5))
            second=pool.submit(self.call,enabled=True).result(timeout=5)
            self.assertEqual(second['status'],'disable_outcome_unresolved')
            self.assertEqual(self.store.rows[('pilot_member_capacity','org')]['reserved'],2)
            release.set();self.assertTrue(first.result(timeout=5)['released'])
        self.assertEqual(self.provider.calls,1)
        self.assertEqual(self.store.rows[('pilot_member_capacity','org')]['reserved'],1)
