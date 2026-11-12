"""Acceptance-only gate rejects callers before storage; ordinary API unchanged."""
import hashlib,io,json,sys,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from production_app import create_application

class Tests(unittest.TestCase):
    def setUp(self):
        self.code='a'*64
        self.cfg=SimpleNamespace(origin='https://fixture.invalid',hosts={'fixture.invalid'},synthetic_only=False,
            requires_invite=True,invite_hash=hashlib.sha256(self.code.encode()).hexdigest(),invite_expires=time.time()+60)
        self.service=SimpleNamespace(admit_request=Mock(),check_email_action=Mock(return_value={'valid':True}),
            complete_email_action=Mock(),request_recovery=Mock(),guard=SimpleNamespace(delivery=True))
        self.app=create_application(self.service,self.cfg)
    def call(self,method,path,body=None,token=None):
        raw=json.dumps(body).encode() if body is not None else b'';out=[]
        env=dict(REQUEST_METHOD=method,PATH_INFO=path,QUERY_STRING='',HTTP_HOST='fixture.invalid',HTTP_ORIGIN=self.cfg.origin,
                 CONTENT_TYPE='application/json',CONTENT_LENGTH=str(len(raw)),HTTP_X_RELAY_ACCEPTANCE=token or '')
        env.update({'wsgi.url_scheme':'https','wsgi.input':io.BytesIO(raw)})
        response=self.app(env,lambda status,headers:out.append(status));return int(out[0].split()[0]),json.loads(b''.join(response))
    def test_public_capabilities_are_static_without_admission(self):
        status,data=self.call('GET','/api/capabilities');self.assertEqual(status,200);self.assertTrue(data['signup_invite_required'])
        self.service.admit_request.assert_not_called()
    def test_missing_or_wrong_code_rejected_before_storage(self):
        for token in (None,'b'*64):self.assertEqual(self.call('POST','/api/auth/action/check',{'mode':'verifyEmail','code':'fixture'},token)[0],403)
        self.service.admit_request.assert_not_called();self.service.check_email_action.assert_not_called()
    def test_valid_code_reaches_action_and_expired_code_is_rejected(self):
        self.assertEqual(self.call('POST','/api/auth/action/check',{'mode':'verifyEmail','code':'fixture'},self.code)[0],200)
        self.service.check_email_action.assert_called_once();self.service.admit_request.reset_mock();self.cfg.invite_expires=time.time()-1
        self.assertEqual(self.call('POST','/api/auth/action/check',{'mode':'verifyEmail','code':'fixture'},self.code)[0],403)
        self.service.admit_request.assert_not_called()
