"""Local RSA/certificate and provider recovery fixtures, never live-mode enablement."""
import json
import time
import unittest
from datetime import datetime,timedelta,timezone
from unittest.mock import patch
from firebase_contract import Fixture
from firebase_admin import auth,_auth_utils,_token_gen
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
import jwt

def certificate(key):
    name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Synthetic SDK fixture')])
    return x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(datetime.now(timezone.utc)-timedelta(days=1)).not_valid_after(datetime.now(timezone.utc)+timedelta(days=1)).sign(key,hashes.SHA256()).public_bytes(serialization.Encoding.PEM).decode()

class SignedSDKFixtures(Fixture):
    def setUp(self):
        super().setUp();self.rsa=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        self.certs={'fixture-kid':certificate(self.rsa)};self.cert_urls=[]
        self.user=self.get('/api/me')['user']['id']
    def token(self,changes=None,key=None,headers=None):
        now=int(time.time())
        payload=dict(sub=self.user,aud=self.s.guard.project,iss='https://securetoken.google.com/'+self.s.guard.project,iat=now,exp=now+3600,auth_time=now,email_verified=True)
        payload.update(changes or {})
        return jwt.encode(payload,key or self.rsa,algorithm='RS256',headers=headers or {'kid':'fixture-kid'})
    def certificate_request(self,url,**kwargs):
        self.assertEqual(url,_token_gen.ID_TOKEN_CERT_URI);self.cert_urls.append(url)
        class Response:status=200;data=json.dumps(self.certs).encode()
        return Response()
    def verify(self,token):
        # Only this fixture enters the SDK's signature-verifying branch. The app
        # guard remains emulator-only; certificate requests are in-memory data.
        verifier=auth._get_client(self.s.identity.app)._token_verifier
        with patch.object(_auth_utils,'is_emulated',return_value=False),patch.object(verifier,'request',self.certificate_request):
            return self.s.identity.verify(token)
    def test_valid_rs256_uses_pinned_sdk_signature_branch_and_local_certificate(self):
        user,claims=self.verify(self.token());self.assertEqual(user.uid,self.user);self.assertEqual(claims['uid'],self.user)
        self.assertEqual(self.cert_urls,[_token_gen.ID_TOKEN_CERT_URI])
    def test_forged_signature_payload_unknown_key_and_wrong_project_fail(self):
        other=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        for token in [self.token(key=other),self.token(dict(aud='demo-wrong-project')),self.token(dict(iss='https://evil.test')),self.token(headers={'kid':'unknown'})]:
            with self.subTest(token_type=token[:12]):self.assert_problem(lambda:self.verify(token),401)
    def test_unsigned_hs256_expired_future_issued_and_bad_subject_fail(self):
        payload=jwt.decode(self.token(),options={'verify_signature':False})
        invalid=[jwt.encode(payload,'',algorithm='none'),jwt.encode(payload,'synthetic-hmac-fixture-secret-123456789',algorithm='HS256',headers={'kid':'fixture-kid'}),self.token(dict(exp=int(time.time())-5)),self.token(dict(iat=int(time.time())+3600)),self.token(dict(sub=''))]
        for token in invalid:self.assert_problem(lambda:self.verify(token),401)
    def test_key_rotation_rejects_retired_key_and_accepts_new_key(self):
        old=self.token();new=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        self.certs={'rotated-kid':certificate(new)}
        self.assert_problem(lambda:self.verify(old),401)
        self.assertEqual(self.verify(self.token(key=new,headers={'kid':'rotated-kid'}))[0].uid,self.user)
    def test_valid_signature_does_not_bypass_disabled_or_revoked_provider_state(self):
        token=self.token();auth.update_user(self.user,disabled=True,app=self.s.identity.app)
        self.assert_problem(lambda:self.verify(token),401)
        auth.update_user(self.user,disabled=False,app=self.s.identity.app)
        auth.revoke_refresh_tokens(self.user,app=self.s.identity.app)
        # This pinned Admin SDK compares iat with tokens_valid_after_timestamp.
        # Recent auth_time and same-second credential epochs remain live gates.
        self.assert_problem(lambda:self.verify(self.token(dict(iat=int(time.time())-3600,auth_time=int(time.time())-3600))),401)
    def test_certificate_transport_failure_fails_closed_without_network(self):
        verifier=auth._get_client(self.s.identity.app)._token_verifier
        import google.auth.exceptions
        with patch.object(_auth_utils,'is_emulated',return_value=False),patch.object(verifier,'request',side_effect=google.auth.exceptions.TransportError('Synthetic offline certificate fixture')):
            with self.assertRaises(_token_gen.CertificateFetchError):self.s.identity.verify(self.token())

class RecoveryProviderFixtures(Fixture):
    def reset_code(self,email):
        self.s.identity.rest('sendOobCode',dict(requestType='PASSWORD_RESET',email=email))
        url=f'http://{self.s.guard.auth_host}/emulator/v1/projects/{self.s.guard.project}/oobCodes'
        self.s.guard.assert_auth_url(url)
        result=self.s.identity.http.get(url,timeout=15,allow_redirects=False).json()
        return [r for r in result['oobCodes'] if r['email']==email and r['requestType']=='PASSWORD_RESET'][-1]['oobCode']
    def test_reset_invalidates_old_password_and_session_after_provider_timestamp_boundary(self):
        state=self.get('/api/me');email=state['user']['email'];org=state['organization']['id']
        time.sleep(1.05)
        code=self.reset_code(email);self.s.identity.rest('resetPassword',dict(oobCode=code,newPassword='synthetic-recovered-456'))
        self.assert_problem(lambda:self.get('/api/me'),401)
        self.assert_problem(lambda:self.s.signin(dict(email=email,password='fictional-only-123')),401)
        token=self.s.signin(dict(email=email,password='synthetic-recovered-456'))
        self.assertEqual(self.get('/api/me',token=token)['organization']['id'],org)
    def test_reset_code_is_one_use_and_invalid_code_changes_nothing(self):
        email=self.get('/api/me')['user']['email'];code=self.reset_code(email)
        self.assert_problem(lambda:self.s.identity.rest('resetPassword',dict(oobCode='synthetic-invalid-code',newPassword='synthetic-recovered-456')),401)
        self.s.identity.rest('resetPassword',dict(oobCode=code,newPassword='synthetic-recovered-456'))
        self.assert_problem(lambda:self.s.identity.rest('resetPassword',dict(oobCode=code,newPassword='synthetic-forged-789')),401)
        self.assertIsInstance(self.s.signin(dict(email=email,password='synthetic-recovered-456')),str)
    def test_recovery_never_reenables_disabled_membership(self):
        manager=self.account('branch_manager',[self.a['id']]);user=self.get('/api/me',token=manager)['user']
        self.call('/members/update',dict(id=user['id'],enabled=False))
        code=self.reset_code(user['email']);self.s.identity.rest('resetPassword',dict(oobCode=code,newPassword='synthetic-recovered-456'))
        self.assert_problem(lambda:self.s.signin(dict(email=user['email'],password='synthetic-recovered-456')),401)

if __name__=='__main__':unittest.main(verbosity=2)
