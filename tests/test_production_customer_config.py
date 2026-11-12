"""Offline fail-closed guard for normal customer mode; no provider access."""
import os,sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from production_customer_app import load_application
from production_customer_config import ProductionCustomerConfig,PROJECT,DATABASE,ORIGIN
from production_config import ProductionConfig
from customer_config import CustomerConfig
SAFE=dict(RELAY_ORDINARY_LIVE_ENABLED='approved',RELAY_FIREBASE_MODE='customer',RELAY_CUSTOMER_ACCESS_MODE='ordinary',
 RELAY_FIREBASE_PROJECT=PROJECT,RELAY_FIRESTORE_DATABASE=DATABASE,RELAY_ACTIVATION_SCOPE=PROJECT+'/'+DATABASE,
 K_SERVICE='relay-api-customer',K_REVISION='relay-api-customer-00001',RELAY_PUBLIC_ORIGIN=ORIGIN,RELAY_SYNTHETIC_ONLY='false',
 RELAY_RELEASE_REVIEW='approved',RELAY_API_HOST='relay-api-customer-123456789012.us-central1.run.app',
 RELAY_AUTH_API_KEY='synthetic-public-fixture-key-12345')
class Tests(unittest.TestCase):
 def test_disabled_startup_does_not_import_provider(self):
  with patch.dict(os.environ,{},clear=True):
   before=set(sys.modules);app=load_application();status=[];app({},lambda s,h:status.append(s))
   self.assertTrue(status[0].startswith('503'));self.assertNotIn('production_customer_live',set(sys.modules)-before)
 def test_ordinary_scope_has_no_invitation_or_email_allowlist(self):
  with patch.dict(os.environ,SAFE,clear=True):
   guard=ProductionCustomerConfig.from_environment();self.assertFalse(guard.requires_invite);self.assertIsNone(guard.allowed_email);self.assertTrue(guard.require_mailbox_password_setup)
   self.assertFalse(guard.delivery);self.assertNotIn(SAFE['RELAY_AUTH_API_KEY'],repr(guard))
   with self.assertRaises(ValueError):CustomerConfig.from_environment()
   with self.assertRaises(ValueError):ProductionConfig.from_environment()
 def test_cross_environment_and_invalid_activation_fail_closed(self):
  bad={'RELAY_ORDINARY_LIVE_ENABLED':'disabled','RELAY_CUSTOMER_ACCESS_MODE':'acceptance','RELAY_FIREBASE_PROJECT':'relay-saas-stg-746234651365',
   'RELAY_FIRESTORE_DATABASE':'(default)','RELAY_ACTIVATION_SCOPE':'other/db','K_SERVICE':'relay-api-staging','K_REVISION':'',
   'RELAY_PUBLIC_ORIGIN':'https://relay-stg-746234651365.web.app','RELAY_RELEASE_REVIEW':'','RELAY_SYNTHETIC_ONLY':'true',
   'RELAY_CUSTOMER_INVITE_HASH':'a'*64,'GOOGLE_APPLICATION_CREDENTIALS':'some-file','FIRESTORE_EMULATOR_HOST':'localhost:8080',
   'HTTPS_PROXY':'http://invalid','RELAY_API_HOST':'evil.example','RELAY_AUTH_DELIVERY':'yes'}
  for k,v in bad.items():
   with self.subTest(key=k),patch.dict(os.environ,SAFE|{k:v},clear=True),self.assertRaises(ValueError):ProductionCustomerConfig.from_environment()
 def test_guard_detects_drift_and_validates_official_endpoint(self):
  with patch.dict(os.environ,SAFE,clear=True):
   guard=ProductionCustomerConfig.from_environment();guard.assert_auth_url('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword')
   with self.assertRaises(ValueError):guard.assert_auth_url('https://identitytoolkit.googleapis.com.evil.test/x')
   os.environ['RELAY_AUTH_DELIVERY']='approved'
   with self.assertRaises(ValueError):guard.assert_current()
