import importlib.util,unittest
from pathlib import Path
path=Path(__file__).resolve().parents[1]/'tools/customer_operations_plan.py'
spec=importlib.util.spec_from_file_location('customer_operations_plan',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class Tests(unittest.TestCase):
    def test_only_synthetic_data_and_no_mutations(self):
        with self.assertRaises(ValueError):module.plan({'jobs':[]})
        result=module.plan(dict(synthetic_fixture=True,jobs=[dict(state='needs_reconciliation'),dict(state='committed')],expired_documents=[dict(collection='auth_counters',expired=True),dict(collection='credential_epochs',expired=True),dict(collection='recovery_delivery',expired=True,legal_hold=True)]))
        self.assertEqual(result['changes'],0);self.assertEqual(result['provider_calls'],0)
        self.assertEqual(result['counts']['provider_reconciliation_required'],1)
        self.assertEqual(result['counts']['ttl_eligible'],1);self.assertEqual(result['counts']['ttl_excluded'],2)
    def test_bounded_inputs(self):
        with self.assertRaises(ValueError):module.plan(dict(synthetic_fixture=True,jobs=[{}]*1001))
