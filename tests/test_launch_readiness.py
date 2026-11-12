"""Offline request/identity boundaries; no SDK, emulator or cloud connection."""
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from core import Problem
from identity_lifecycle import IdentityLifecycle, recovery_available
from request_payload import parse_request_object


class RecoveryReadinessTests(unittest.TestCase):
    def service(self, guard):
        service = IdentityLifecycle()
        service.guard = guard
        service.consume_limits = Mock()
        service.run = Mock(side_effect=lambda action: action(SimpleNamespace(control_put=Mock())))
        service.identity = SimpleNamespace(reset_delivery=Mock())
        return service

    def test_disabled_delivery_never_writes_or_sends_and_is_not_advertised(self):
        service = self.service(SimpleNamespace(delivery=False))
        self.assertFalse(recovery_available(service))
        for address in ['unknown@example.test', 'existing@example.test']:
            with self.assertRaises(Problem) as result:
                service.request_recovery({'email': address})
            self.assertEqual(result.exception.status, 503)
        service.consume_limits.assert_not_called()
        service.run.assert_not_called()
        service.identity.reset_delivery.assert_not_called()

    def test_emulator_or_explicit_approved_delivery_preserves_generic_response(self):
        for guard in [SimpleNamespace(), SimpleNamespace(delivery=True)]:
            with self.subTest(guard=guard):
                service = self.service(guard)
                self.assertTrue(recovery_available(service))
                known = service.request_recovery({'email': 'existing@example.test'})
                service.identity.reset_delivery.side_effect = RuntimeError('sensitive-provider-detail')
                unknown = service.request_recovery({'email': 'unknown@example.test'})
                self.assertEqual(known, unknown)
                self.assertNotIn('sensitive', str(unknown))
                self.assertEqual(service.consume_limits.call_count, 2)
                self.assertEqual(service.run.call_count, 4)
                self.assertEqual(service.identity.reset_delivery.call_count, 2)

    def test_unimplemented_adapter_does_not_advertise_recovery(self):
        self.assertFalse(recovery_available(SimpleNamespace()))

    def test_recovery_status_contains_no_raw_email_and_is_bounded_per_address(self):
        service=self.service(SimpleNamespace(delivery=True))
        store=SimpleNamespace(control_put=Mock())
        service.run=Mock(side_effect=lambda action:action(store))
        service.request_recovery({'email':'person@example.test'})
        service.request_recovery({'email':'person@example.test'})
        entries=[call.args for call in store.control_put.call_args_list]
        self.assertEqual(len({entry[1] for entry in entries}),1)
        self.assertNotIn('person@example.test',str(entries))


class RequestPayloadTests(unittest.TestCase):
    def test_valid_nested_utf8_object_preserves_fields_and_finite_numbers(self):
        self.assertEqual(parse_request_object('{"name":"Jules é","rules":{"hours":37.5},"roles":["lead"]}'.encode()),
                         {'name': 'Jules é', 'rules': {'hours': 37.5}, 'roles': ['lead']})

    def test_nested_duplicate_or_nonfinite_number_cannot_reach_business_logic(self):
        for raw in [b'{"x":{"a":1,"a":2}}', b'{"x":[NaN]}', b'{"x":1e9999}', b'[]', b'null']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse_request_object(raw)

    def test_application_nesting_bound_is_independent_of_python_recursion_limit(self):
        parse_request_object(b'{"x":' + b'[' * 31 + b'0' + b']' * 31 + b'}')
        with self.assertRaises(ValueError):
            parse_request_object(b'{"x":' + b'[' * 32 + b'0' + b']' * 32 + b'}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
