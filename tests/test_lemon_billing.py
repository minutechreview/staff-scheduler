import hashlib
import hmac
import json
import sqlite3
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from lemon_billing import BillingError, checkout, entitled, handle_webhook, management_portal, public_plans, require_entitlement, schema

NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)
PLAN = {'id': 'fixture', 'name': 'Fixture', 'amount_minor': 1234, 'currency': 'USD', 'interval': 'month', 'variant_id': '55'}


class FixtureTransport:
    synthetic_only = True
    def create_checkout(self, payload):
        self.payload = payload
        return {'url': 'https://fixture.lemonsqueezy.com/checkout/custom/fixture'}
    def subscription_portal(self, sub):
        return f'https://fixture.lemonsqueezy.com/subscription/{sub}/fixture'


class LemonBillingTests(unittest.TestCase):
    def setUp(self):
        self.c = sqlite3.connect(':memory:')
        schema(self.c)
        self.transport = FixtureTransport()
        checkout(self.c, {'org': 'org-a', 'role': 'owner'}, 'fixture', [PLAN], '42', self.transport, NOW)
        self.c.commit()
        self.ref = self.transport.payload['data']['attributes']['checkout_data']['custom']['relay_ref']
        self.secret = b'fixture-secret'

    def event(self, status='active', updated='2026-11-01T01:00:00Z', ends=None, **override):
        attrs = {'variant_id': 55, 'store_id': 42, 'status': status, 'updated_at': updated, 'ends_at': ends, 'test_mode': True} | override
        return json.dumps({'meta': {'event_name': 'subscription_updated', 'custom_data': {'relay_ref': self.ref}},
                           'data': {'type': 'subscriptions', 'id': '100', 'attributes': attrs}}, separators=(',', ':')).encode()

    def apply(self, raw):
        return handle_webhook(self.c, raw, hmac.new(self.secret, raw, hashlib.sha256).hexdigest(), self.secret, '42')

    def test_checkout_restricted_and_live_disabled(self):
        self.assertEqual(public_plans([PLAN])[0]['amount_minor'], 1234)
        self.assertNotIn('variant_id', public_plans([PLAN])[0])
        with self.assertRaises(BillingError): checkout(self.c, {'org':'org-a','role':'admin'}, 'fixture', [PLAN], '42', self.transport, NOW)
        with self.assertRaises(BillingError): checkout(self.c, {'org':'org-a','role':'owner'}, 'fixture', [PLAN], '42', object(), NOW)
        with self.assertRaises(BillingError): checkout(self.c, {'org':'org-a','role':'owner'}, 'missing', [], '42', self.transport, NOW)

    def test_signature_store_mode_and_binding(self):
        raw = self.event()
        with self.assertRaises(BillingError): handle_webhook(self.c, raw, '0'*64, self.secret, '42')
        for bad in (self.event(store_id=99), self.event(test_mode=False), self.event(variant_id=99)):
            with self.assertRaises(BillingError): self.apply(bad)
        self.assertFalse(entitled(self.c, 'org-a', NOW))
        self.assertEqual(self.apply(raw), 'applied')
        self.assertEqual(self.apply(raw), 'duplicate')
        self.assertTrue(entitled(self.c, 'org-a', NOW))
        self.assertFalse(entitled(self.c, 'org-b', NOW))
        with self.assertRaises(BillingError): require_entitlement(self.c, {'org':'org-b'}, NOW)

    def test_cancellation_expiry_recovery_and_out_of_order(self):
        self.apply(self.event())
        self.apply(self.event('cancelled', '2026-11-01T02:00:00Z', '2026-11-02T00:00:00Z'))
        self.assertTrue(entitled(self.c, 'org-a', NOW))
        self.assertFalse(entitled(self.c, 'org-a', datetime(2026,11,2,tzinfo=timezone.utc)))
        self.assertEqual(self.apply(self.event('active', '2026-11-01T00:00:00Z')), 'stale')
        self.assertFalse(entitled(self.c, 'org-a', datetime(2026,11,2,tzinfo=timezone.utc)))
        self.apply(self.event('active', '2026-11-01T03:00:00Z'))
        self.assertTrue(entitled(self.c, 'org-a', NOW))
        self.apply(self.event('past_due', '2026-11-01T04:00:00Z'))
        self.assertFalse(entitled(self.c, 'org-a', NOW))
        self.apply(self.event('expired', '2026-11-01T05:00:00Z'))
        self.assertFalse(entitled(self.c, 'org-a', NOW))

    def test_equal_timestamp_conflict_is_not_applied(self):
        self.apply(self.event())
        with self.assertRaises(BillingError): self.apply(self.event('expired'))
        self.assertTrue(entitled(self.c, 'org-a', NOW))

    def test_changed_variant_quarantines_instead_of_retaining_active_access(self):
        self.apply(self.event())
        self.assertEqual(self.apply(self.event(updated='2026-11-01T02:00:00Z',variant_id=77)),'applied')
        self.assertFalse(entitled(self.c,'org-a',NOW))
        self.apply(self.event(updated='2026-11-01T03:00:00Z'))
        self.assertFalse(entitled(self.c,'org-a',NOW))

    def test_portal_is_owner_and_tenant_scoped(self):
        self.apply(self.event())
        self.assertIn('/100/', management_portal(self.c, {'role':'owner','org':'org-a'}, self.transport)['url'])
        for actor in ({'role':'admin','org':'org-a'}, {'role':'owner','org':'org-b'}):
            with self.assertRaises(BillingError): management_portal(self.c, actor, self.transport)

    def test_concurrent_webhook_delivery_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / 'fixture.sqlite')
            dest = sqlite3.connect(db); self.c.backup(dest); dest.close()
            raw = self.event(); sig = hmac.new(self.secret, raw, hashlib.sha256).hexdigest()
            def run(_):
                with sqlite3.connect(db, timeout=5) as conn:
                    return handle_webhook(conn, raw, sig, self.secret, '42')
            with ThreadPoolExecutor(max_workers=2) as pool:
                self.assertCountEqual(list(pool.map(run, range(2))), ['applied', 'duplicate'])


if __name__ == '__main__': unittest.main()
