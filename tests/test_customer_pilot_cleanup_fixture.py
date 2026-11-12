import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from customer_pilot_cleanup_fixture import FixtureBackend,CleanupError,PROJECT,NAMES,cleanup
class Tests(unittest.TestCase):
 def setUp(self):
  self.run='fictional-run-1';self.refs={k:{'name':v,'uid':'uid-'+k} for k,v in NAMES.items()}
  self.resources={k:v|{'run_id':self.run} for k,v in self.refs.items()}
  self.plan=dict(synthetic_fixture=True,project=PROJECT,run_id=self.run,resources=self.refs)
 def test_success_only_deletes_exact_fixture_resources(self):
  backend=FixtureBackend(self.run,self.resources);result=cleanup(backend,self.plan)
  self.assertEqual(result['status'],'fixture_scope_clean');self.assertEqual(result['cloud_calls'],0)
  self.assertEqual(backend.resources,{'site':self.resources['site']})
 def test_mismatch_stops_before_any_mutation(self):
  for kind in NAMES:
   backend=FixtureBackend(self.run,self.resources);backend.resources[kind]['uid']='different'
   with self.assertRaises(CleanupError):cleanup(backend,self.plan)
   self.assertEqual(backend.calls,[])
 def test_partial_failure_is_not_claimed_clean(self):
  backend=FixtureBackend(self.run,self.resources,fail_at='delete_repository');result=cleanup(backend,self.plan)
  self.assertEqual(result['status'],'cleanup_unverified');self.assertTrue(backend.billing_linked)
 def test_nonfixture_and_wrong_project_rejected(self):
  with self.assertRaises(CleanupError):cleanup(object(),self.plan)
  with self.assertRaises(CleanupError):cleanup(FixtureBackend(self.run,self.resources),self.plan|{'project':'relay-saas-stg-746234651365'})
