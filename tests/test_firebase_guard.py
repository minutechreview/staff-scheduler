"""Pure standard-library guard tests run without optional Firebase dependencies."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from firebase_config import EmulatorConfig

SAFE=dict(RELAY_FIREBASE_MODE='emulator',RELAY_FIREBASE_PROJECT='demo-relay-scheduler',FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099',FIRESTORE_EMULATOR_HOST='127.0.0.1:8089')

class FirebaseGuardTests(unittest.TestCase):
    def test_explicit_demo_loopback_only(self):
        with patch.dict(os.environ,SAFE,clear=True):
            c=EmulatorConfig.from_environment();c.assert_auth_url('http://127.0.0.1:9099/test')
            for url in ('https://identitytoolkit.googleapis.com/test','http://localhost:9099/test','http://127.0.0.1:8089/test','http://evil.test','http://a:b@127.0.0.1:9099/test'):
                with self.subTest(url=url),self.assertRaises(ValueError):c.assert_auth_url(url)
    def test_unsafe_or_missing_configuration_fails_closed(self):
        bad=[('RELAY_FIREBASE_MODE','production'),('RELAY_FIREBASE_PROJECT','real-project'),('FIREBASE_AUTH_EMULATOR_HOST',''),('FIRESTORE_EMULATOR_HOST','firestore.googleapis.com'),('FIRESTORE_EMULATOR_HOST','127.0.0.1:9099'),('GOOGLE_APPLICATION_CREDENTIALS','/must-not-read.json'),('FIREBASE_CONFIG','{}'),('GCLOUD_PROJECT','other-project'),('FIRESTORE_EMULATOR_HOST','http://127.0.0.1:8089'),('grpc_proxy','http://proxy.test'),('HTTPS_PROXY','http://proxy.test')]
        for name,value in bad:
            with self.subTest(name=name,value=value),patch.dict(os.environ,SAFE|{name:value},clear=True),self.assertRaises(ValueError):EmulatorConfig.from_environment()
    def test_environment_changed_after_initialization_fails_closed(self):
        with patch.dict(os.environ,SAFE,clear=True):
            c=EmulatorConfig.from_environment()
            os.environ.pop('FIRESTORE_EMULATOR_HOST')
            with self.assertRaises(ValueError):c.assert_current()
