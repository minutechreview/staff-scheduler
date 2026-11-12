"""Explicit emulator-only Firebase identity provider. Never consults ADC."""
import requests
import firebase_admin
from firebase_admin import auth, credentials
from google.auth.credentials import AnonymousCredentials
from core import Problem, require


class AnonymousAdminCredentials(credentials.Base):
    def get_credential(self): return AnonymousCredentials()


class FirebaseIdentity:
    def __init__(self, guard):
        guard.assert_current()
        self.guard=guard
        self.app=firebase_admin.initialize_app(AnonymousAdminCredentials(),{'projectId':guard.project},name='relay-emulator-'+__import__('secrets').token_hex(8))
        # Pin the Admin SDK's HTTP transport to the configured emulator. SDK internals
        # are version pinned and covered by the outbound transport contract test.
        client=auth._get_client(self.app)
        session=client._user_manager.http_client.session
        session.trust_env=False
        original=session.request
        def local_request(method,url,**kwargs):
            guard.assert_auth_url(url)
            kwargs['allow_redirects']=False
            return original(method,url,**kwargs)
        session.request=local_request
        self.http=requests.Session();self.http.trust_env=False

    def rest(self,action,data):
        url=f'http://{self.guard.auth_host}/identitytoolkit.googleapis.com/v1/accounts:{action}?key=emulator-only'
        self.guard.assert_auth_url(url)
        response=self.http.post(url,json=data,timeout=15,allow_redirects=False)
        if response.status_code>=400:
            code=response.json().get('error',{}).get('message','')
            if 'EMAIL_EXISTS' in code:raise Problem('This email is already registered.',409)
            raise Problem('Invalid credentials or identity request.',401)
        return response.json()

    def create(self,email,password,name,uid=None):
        self.guard.assert_current()
        try:return auth.create_user(email=email,password=password,display_name=name,email_verified=False,app=self.app,**({'uid':uid} if uid else {}))
        except auth.EmailAlreadyExistsError:raise Problem('This email is already registered.',409) from None

    def delete(self,uid):
        self.guard.assert_current();auth.delete_user(uid,app=self.app)
    def user(self,uid):
        self.guard.assert_current()
        try:return auth.get_user(uid,app=self.app)
        except (auth.UserNotFoundError,ValueError):raise Problem('Sign in to continue.',401) from None
    def user_by_email(self,email):
        self.guard.assert_current()
        try:return auth.get_user_by_email(email,app=self.app)
        except (auth.UserNotFoundError,ValueError):raise Problem('Recovery cannot be completed.',401) from None
    def revoke(self,uid):
        self.guard.assert_current();auth.revoke_refresh_tokens(uid,app=self.app)
    def verify(self,token):
        self.guard.assert_current()
        try:
            claims=auth.verify_id_token(token,app=self.app,check_revoked=True)
            user=self.user(claims['uid'])
            require(not user.disabled,'Sign in to continue.',401)
            return user,claims
        except (auth.InvalidIdTokenError,auth.RevokedIdTokenError,auth.UserDisabledError,ValueError):
            raise Problem('Sign in to continue.',401) from None
    def verification(self,id_token,email):
        self.rest('sendOobCode',dict(requestType='VERIFY_EMAIL',idToken=id_token))
        url=f'http://{self.guard.auth_host}/emulator/v1/projects/{self.guard.project}/oobCodes'
        self.guard.assert_auth_url(url)
        response=self.http.get(url,timeout=15,allow_redirects=False);response.raise_for_status()
        codes=[r for r in response.json().get('oobCodes',[]) if r.get('email')==email and r.get('requestType')=='VERIFY_EMAIL']
        require(codes,'Local verification code unavailable.',503)
        return dict(verification_required=True,local_verification_url=codes[-1]['oobLink'],email=email,
                    message='Local emulator verification only. No email was sent.')
    def change_password(self,uid,password):
        self.guard.assert_current()
        auth.update_user(uid,password=password,app=self.app)
        auth.revoke_refresh_tokens(uid,app=self.app)
