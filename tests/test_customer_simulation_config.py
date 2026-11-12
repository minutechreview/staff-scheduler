"""Customer-flow simulation stays emulator-only and cannot activate real mail."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from customer_simulation_config import CustomerSimulationConfig
from production_config import ProductionConfig

SAFE = {'RELAY_CUSTOMER_AUTH_SIMULATION':'enabled', 'RELAY_FIREBASE_MODE':'emulator',
        'RELAY_FIREBASE_PROJECT':'demo-relay-email-actions',
        'FIREBASE_AUTH_EMULATOR_HOST':'127.0.0.1:9099', 'FIRESTORE_EMULATOR_HOST':'127.0.0.1:8089',
        'RELAY_LIVE_ENABLED':'disabled', 'RELAY_AUTH_DELIVERY':'disabled'}

class CustomerSimulationConfigTests(unittest.TestCase):
    def test_explicit_local_config_allows_reserved_fictional_customer_only(self):
        with patch.dict(os.environ,SAFE,clear=True):
            cfg=CustomerSimulationConfig.from_environment()
            self.assertTrue(cfg.email_allowed('owner@review.example'))
            for invalid in ['owner@example.com','owner@review.example.evil','owner@another.example',
                            ' owner@review.example','@review.example','owner@@review.example']:
                self.assertFalse(cfg.email_allowed(invalid))
            self.assertEqual(cfg.action_path,'/account/action')
            self.assertFalse(cfg.real_delivery)
    def test_missing_or_live_mixed_configuration_fails_closed(self):
        variants=[{'RELAY_CUSTOMER_AUTH_SIMULATION':''},{'RELAY_LIVE_ENABLED':'approved'},
                  {'RELAY_AUTH_DELIVERY':'approved'},{'RELAY_FIREBASE_MODE':'staging'},
                  {'RELAY_FIREBASE_PROJECT':'real-project'},
                  {'FIREBASE_AUTH_EMULATOR_HOST':'example.com:9099'},
                  {'GOOGLE_APPLICATION_CREDENTIALS':'private-file'},
                  {'HTTPS_PROXY':'http://example.invalid'}]
        with patch.dict(os.environ,SAFE,clear=True):
            for values in variants:
                with self.subTest(values=values),patch.dict(os.environ,values),self.assertRaises(ValueError):
                    CustomerSimulationConfig.from_environment()
    def test_environment_drift_invalidates_active_config(self):
        with patch.dict(os.environ,SAFE,clear=True):
            cfg=CustomerSimulationConfig.from_environment()
            with patch.dict(os.environ,{'RELAY_CUSTOMER_AUTH_SIMULATION':'disabled'}),self.assertRaises(ValueError):cfg.assert_current()
    def test_customer_simulation_cannot_enable_staging_factory(self):
        with patch.dict(os.environ,SAFE,clear=True),self.assertRaises(ValueError):ProductionConfig.from_environment()

if __name__=='__main__':unittest.main()
