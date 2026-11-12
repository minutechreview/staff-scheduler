"""Real signed SDK verification through live transport code, with zero network."""
import json
import os
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import jwt
import requests
import firebase_admin
from firebase_admin import auth,_token_gen
from google.cloud import firestore
from google.auth.credentials import AnonymousCredentials
from cryptography.hazmat.primitives.asymmetric import rsa
from firebase_assurance import certificate
from firebase_auth import AnonymousAdminCredentials
from firebase_live import LiveFirebaseIdentity,create_staging_service,WorkloadCredentials
from production_config import ProductionConfig
from test_production import SAFE
from core import Problem


class LiveSDKOfflineTests(unittest.TestCase):
    def setUp(self):
        self.env=patch.dict(os.environ,SAFE,clear=True);self.env.start()
        self.guard=ProductionConfig.from_environment()
        self.identity=LiveFirebaseIdentity(self.guard,AnonymousAdminCredentials())
        self.rsa=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        self.certs={'fixture-kid':certificate(self.rsa)};self.requests=[]
        self.user=SimpleNamespace(uid='synthetic-user',disabled=False,email_verified=True,tokens_valid_after_timestamp=0)
        self.client=auth._get_client(self.identity.app)
        self.users=patch.object(self.client,'get_user',return_value=self.user);self.users.start()
        def send(request,**kwargs):
            self.requests.append((request.url,kwargs))
            self.assertEqual(request.url,_token_gen.ID_TOKEN_CERT_URI)
            self.assertTrue(kwargs['verify']);self.assertFalse(kwargs['allow_redirects']);self.assertLessEqual(kwargs['timeout'],15)
            result=requests.Response();result.status_code=200;result._content=json.dumps(self.certs).encode();result.headers['Content-Type']='application/json'
            return result
        self.send=patch.object(self.identity.certificate_http,'send',side_effect=send);self.send.start()
    def tearDown(self):
        self.send.stop();self.users.stop();firebase_admin.delete_app(self.identity.app);self.env.stop()
    def token(self,changes=None,key=None,kid='fixture-kid'):
        now=int(time.time());claims=dict(sub=self.user.uid,aud=self.guard.project,iss='https://securetoken.google.com/'+self.guard.project,
                                       iat=now,exp=now+3600,auth_time=now,email_verified=True)
        claims.update(changes or {})
        return jwt.encode(claims,key or self.rsa,algorithm='RS256',headers={'kid':kid})
    def rejected(self,token):
        with self.assertRaises(Problem) as context:self.identity.verify(token)
        self.assertEqual(context.exception.status,401)
    def test_valid_live_signature_uses_guarded_tls_certificate_transport(self):
        user,claims=self.identity.verify(self.token());self.assertEqual(user.uid,self.user.uid);self.assertEqual(claims['aud'],self.guard.project)
        self.assertEqual(len(self.requests),1);self.assertFalse(self.identity.certificate_http.trust_env)
    def test_forgery_wrong_project_issuer_algorithm_expiry_and_unknown_key(self):
        other=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        for token in (self.token(key=other),self.token(dict(aud='wrong-project')),self.token(dict(iss='https://evil.test')),
                      self.token(dict(exp=int(time.time())-1)),self.token(kid='unknown')):
            self.rejected(token)
        claims=jwt.decode(self.token(),options={'verify_signature':False})
        self.rejected(jwt.encode(claims,'',algorithm='none'))
        self.rejected(jwt.encode(claims,'synthetic-hmac-fixture-secret-123456789',algorithm='HS256',headers={'kid':'fixture-kid'}))
    def test_rotation_disabled_and_revoked_state_remain_enforced(self):
        old=self.token();new=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        self.certs={'new-kid':certificate(new)};self.rejected(old)
        self.assertEqual(self.identity.verify(self.token(key=new,kid='new-kid'))[0].uid,self.user.uid)
        self.user.disabled=True;self.rejected(self.token(key=new,kid='new-kid'))
        self.user.disabled=False;self.user.tokens_valid_after_timestamp=(int(time.time())+5)*1000
        self.rejected(self.token(key=new,kid='new-kid'))
    def test_certificate_failure_and_environment_mutation_fail_closed(self):
        with patch.object(self.identity.certificate_http,'send',side_effect=requests.ConnectionError('Synthetic offline failure')):
            with self.assertRaises(_token_gen.CertificateFetchError):self.identity.verify(self.token())
        os.environ['FIREBASE_AUTH_EMULATOR_HOST']='127.0.0.1:9099'
        with self.assertRaises(ValueError):self.identity.verify(self.token())
    def test_delivery_disabled_before_any_send_or_body_exposure(self):
        with patch.object(self.identity.http,'post',side_effect=AssertionError('Network forbidden')):
            with self.assertRaises(Problem) as context:self.identity.reset_delivery('synthetic@fixture.test')
            self.assertEqual(context.exception.status,503)

    def test_verification_transport_accepts_only_oob_code_without_delivery_or_admin_override(self):
        result=SimpleNamespace(status_code=200,json=lambda:{'email':'owner@example.test'})
        with patch.object(self.identity.http,'post',return_value=result) as request:
            self.identity.rest('update',{'oobCode':'synthetic-oob-fixture'})
            self.assertEqual(request.call_args.kwargs['json'],{'oobCode':'synthetic-oob-fixture'})
            self.assertTrue(request.call_args.kwargs['verify'])
            self.assertFalse(request.call_args.kwargs['allow_redirects'])
        with patch.object(self.identity.http,'post',side_effect=AssertionError('No arbitrary account update')) as request:
            for payload in [{'emailVerified':True},{'oobCode':'fixture','emailVerified':True},
                            {'oobCode':'fixture','localId':'other'},{'oobCode':'fixture','password':'forbidden'},
                            {'oobCode':''},{'oobCode':123}]:
                with self.subTest(fields=list(payload)),self.assertRaises(Problem):self.identity.rest('update',payload)
            request.assert_not_called()
    def test_rest_rejects_redirect_and_enforces_tls_and_request_deadline(self):
        result=SimpleNamespace(status_code=302)
        with patch.object(self.identity.http,'post',return_value=result) as request:
            with self.assertRaises(Problem):self.identity.rest('signInWithPassword',dict(email='synthetic@fixture.test',password='synthetic-only'))
            kwargs=request.call_args.kwargs;self.assertTrue(kwargs['verify']);self.assertFalse(kwargs['allow_redirects'])
        self.identity.request_deadline=lambda:time.monotonic()-1
        with patch.object(self.identity.http,'post',side_effect=AssertionError('Expired request must not send')):
            with self.assertRaises(Problem) as context:self.identity.rest('signInWithPassword',{})
            self.assertEqual(context.exception.status,503)
    def test_factory_pins_named_database_and_never_calls_adc(self):
        credential=AnonymousAdminCredentials()
        api=SimpleNamespace(transport=SimpleNamespace(_host='firestore.googleapis.com'),begin_transaction=lambda:None,commit=lambda:None,rollback=lambda:None)
        client=SimpleNamespace(project=self.guard.project,_database=self.guard.database,_firestore_api=api)
        with patch('firebase_live.WorkloadCredentials',return_value=credential),patch('firebase_live.LiveFirebaseIdentity',return_value=SimpleNamespace()) as identity,patch('firebase_live.firestore.Client',return_value=client) as factory,patch('google.auth.default',side_effect=AssertionError('ADC discovery forbidden')):
            service=create_staging_service()
            self.assertEqual(factory.call_args.kwargs['database'],'relay-saas-staging')
            self.assertEqual(factory.call_args.kwargs['project'],self.guard.project)
            self.assertIs(service.client,client);self.assertTrue(callable(service.identity.request_deadline))
        client._database='(default)'
        with patch('firebase_live.WorkloadCredentials',return_value=credential),patch('firebase_live.LiveFirebaseIdentity',return_value=SimpleNamespace()),patch('firebase_live.firestore.Client',return_value=client):
            with self.assertRaises(Problem):create_staging_service()

    def test_factory_accepts_only_official_host_with_implicit_or_default_tls_port(self):
        for host in ('firestore.googleapis.com', 'firestore.googleapis.com:443'):
            with self.subTest(host=host):
                api=SimpleNamespace(transport=SimpleNamespace(_host=host),begin_transaction=lambda:None,commit=lambda:None,rollback=lambda:None)
                client=SimpleNamespace(project=self.guard.project,_database=self.guard.database,_firestore_api=api)
                with patch('firebase_live.WorkloadCredentials',return_value=AnonymousAdminCredentials()),patch('firebase_live.LiveFirebaseIdentity',return_value=SimpleNamespace()),patch('firebase_live.firestore.Client',return_value=client),patch('google.auth.default',side_effect=AssertionError('ADC discovery forbidden')):
                    self.assertIs(create_staging_service().client,client)

    def test_factory_rejects_other_authorities_without_starting_domain_service(self):
        hosts=(None, '', '127.0.0.1:8080', '[::1]:443', 'localhost:443',
               'http://firestore.googleapis.com', 'https://firestore.googleapis.com:443',
               'firestore.googleapis.com.evil.test:443', 'evil-firestore.googleapis.com:443',
               'firestore.googleapis.com:80', 'firestore.googleapis.com:444',
               'firestore.googleapis.com:0443', 'firestore.googleapis.com:443:443',
               'user@firestore.googleapis.com:443', 'firestore.googleapis.com:443@evil.test',
               'firestore.googleapis.com:443/path', 'firestore.googleapis.com:443?x=1',
               'firestore.googleapis.com:443#fragment', 'firestore.googleapis.com.:443',
               'FIRESTORE.GOOGLEAPIS.COM:443', ' firestore.googleapis.com:443',
               'firestore.googleapis.com:443\n', 'firestore.googleapis.com:443\x00',
               'firestore.googleapis.com\\:443', 'firestore.googleap\u0456s.com:443')
        for host in hosts:
            with self.subTest(host=host):
                client=SimpleNamespace(project=self.guard.project,_database=self.guard.database,
                                       _firestore_api=SimpleNamespace(transport=SimpleNamespace(_host=host)))
                with patch('firebase_live.WorkloadCredentials',return_value=AnonymousAdminCredentials()),patch('firebase_live.LiveFirebaseIdentity',return_value=SimpleNamespace()),patch('firebase_live.firestore.Client',return_value=client),patch('firebase_live.FirebaseService',side_effect=AssertionError('Rejected transport must not construct domain service')) as factory:
                    with self.assertRaises(Problem) as context:create_staging_service()
                    self.assertEqual(context.exception.status,503)
                    factory.assert_not_called()

    def test_factory_uses_real_pinned_sdk_transport_without_rpc_or_adc(self):
        client=firestore.Client(project=self.guard.project,database=self.guard.database,
                               credentials=AnonymousCredentials())
        self.assertEqual(client._firestore_api.transport._host,'firestore.googleapis.com:443')
        with patch('firebase_live.WorkloadCredentials',return_value=AnonymousAdminCredentials()),patch('firebase_live.LiveFirebaseIdentity',return_value=SimpleNamespace()),patch('firebase_live.firestore.Client',return_value=client),patch('google.auth.default',side_effect=AssertionError('ADC discovery forbidden')):
            forbidden=AssertionError('Offline factory must not issue an RPC')
            with patch.object(client._firestore_api,'begin_transaction',side_effect=forbidden),patch.object(client._firestore_api,'commit',side_effect=forbidden),patch.object(client._firestore_api,'rollback',side_effect=forbidden):
                service=create_staging_service()
                self.assertIs(service.client,client)


if __name__=='__main__':unittest.main(verbosity=2)
