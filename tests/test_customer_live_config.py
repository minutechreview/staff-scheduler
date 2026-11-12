"""Offline customer activation guard tests, with no SDK or cloud access."""
import json,os,sys,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from customer_config import CustomerConfig,PROJECT,DATABASE,ORIGIN
from customer_app import load_application
from production_config import ProductionConfig
SAFE=dict(RELAY_FIREBASE_MODE='customer',RELAY_CUSTOMER_LIVE_ENABLED='approved',
          RELAY_CUSTOMER_ACCESS_MODE='acceptance',
          RELAY_FIREBASE_PROJECT=PROJECT,RELAY_FIRESTORE_DATABASE=DATABASE,
          RELAY_ACTIVATION_SCOPE=PROJECT+'/'+DATABASE,K_SERVICE='relay-api-customer',K_REVISION='relay-api-customer-00001',
          RELAY_PUBLIC_ORIGIN=ORIGIN,RELAY_SYNTHETIC_ONLY='false',
          RELAY_CUSTOMER_ACCEPTANCE_EMAIL='owner@example.invalid',
          RELAY_CUSTOMER_INVITE_HASH='a'*64,RELAY_CUSTOMER_INVITE_EXPIRES=str(int(time.time())+1800),
          RELAY_API_HOST='relay-api-customer-123456789012.us-central1.run.app',RELAY_AUTH_API_KEY='synthetic-public-fixture-key-12345')
class CustomerGuardTests(unittest.TestCase):
    def test_disabled_deployment_templates_match_pinned_scope(self):
        root=Path(__file__).resolve().parents[1]
        hosting=json.loads((root/'deploy/customer/firebase.template.json').read_text())
        run=json.loads((root/'deploy/customer/cloud-run.disabled.template.json').read_text())
        self.assertEqual(hosting['hosting']['site'],'relay-cust-746234651365')
        self.assertEqual(hosting['hosting']['rewrites'][0]['run']['serviceId'],run['metadata']['name'])
        self.assertEqual(hosting['firestore'][0]['database'],DATABASE)
        env={x['name']:x['value'] for x in run['spec']['template']['spec']['containers'][0]['env']}
        self.assertEqual(env['RELAY_CUSTOMER_LIVE_ENABLED'],'disabled')
        self.assertEqual(env['RELAY_AUTH_DELIVERY'],'disabled')
        self.assertEqual(env['RELAY_FIREBASE_PROJECT'],PROJECT)
        self.assertEqual(env['RELAY_PUBLIC_ORIGIN'],ORIGIN)
        self.assertEqual(env['RELAY_CUSTOMER_ACCEPTANCE_EMAIL'],'owner@example.invalid')
        self.assertEqual(env['RELAY_ACTIVATION_SCOPE'],'UNAPPROVED')
    def test_disabled_startup_does_not_import_live_provider(self):
        with patch.dict(os.environ,{},clear=True):
            before=set(sys.modules); application=load_application(); status=[]
            application({},lambda s,h:status.append(s))
            self.assertTrue(status[0].startswith('503')); self.assertNotIn('customer_live',set(sys.modules)-before)
    def test_explicit_customer_config_and_delivery_off(self):
        with patch.dict(os.environ,SAFE,clear=True):
            config=CustomerConfig.from_environment(); self.assertFalse(config.delivery); self.assertFalse(config.synthetic_only)
            self.assertNotIn(SAFE['RELAY_AUTH_API_KEY'],repr(config))
            config.assert_auth_url('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword')
            with self.assertRaises(ValueError):config.assert_auth_url('https://identitytoolkit.googleapis.com.evil.example/a')
            with self.assertRaises(ValueError):ProductionConfig.from_environment()
    def test_scope_and_mixed_environment_fail_closed(self):
        variants={'RELAY_FIREBASE_PROJECT':'relay-saas-stg-746234651365','RELAY_FIRESTORE_DATABASE':'(default)',
          'RELAY_CUSTOMER_LIVE_ENABLED':'disabled','RELAY_ACTIVATION_SCOPE':'other/relay-customers',
          'RELAY_CUSTOMER_ACCESS_MODE':'production',
          'K_SERVICE':'relay-api-staging','K_REVISION':'','RELAY_SYNTHETIC_ONLY':'true',
          'RELAY_PUBLIC_ORIGIN':'https://relay-stg-746234651365.web.app', 'RELAY_API_HOST':'evil.run.app',
          'RELAY_AUTH_API_KEY':'','RELAY_AUTH_DELIVERY':'yes','HTTPS_PROXY':'http://example.invalid',
          'FIREBASE_AUTH_EMULATOR_HOST':'127.0.0.1:9099','GOOGLE_APPLICATION_CREDENTIALS':'/not-read',
          'GOOGLE_CLOUD_PROJECT':'different'}
        variants['RELAY_CUSTOMER_ACCEPTANCE_EMAIL']='other@example.com'
        variants['RELAY_CUSTOMER_INVITE_HASH']='not-a-verifier'
        variants['RELAY_CUSTOMER_INVITE_EXPIRES']=str(int(time.time())+7200)
        for key,value in variants.items():
            with self.subTest(key=key),patch.dict(os.environ,SAFE|{key:value},clear=True),self.assertRaises(ValueError): CustomerConfig.from_environment()
    def test_configuration_drift_fails_closed(self):
        with patch.dict(os.environ,SAFE,clear=True):
            cfg=CustomerConfig.from_environment(); os.environ['RELAY_AUTH_DELIVERY']='approved'
            with self.assertRaises(ValueError): cfg.assert_current()
if __name__=='__main__':unittest.main()
