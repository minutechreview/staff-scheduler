"""Production SDK transport, instantiated only after explicit staging activation.

No ADC search, local credential file, email delivery or resource provisioning occurs
on import. Tests inject transports; deployment permissions remain separately reviewed.
"""
import secrets
import time
import requests
import firebase_admin
from firebase_admin import auth, credentials, _token_gen
from google.auth.compute_engine import Credentials
from google.cloud import firestore
from requests.adapters import HTTPAdapter
from core import Problem, require
from firebase_auth import FirebaseIdentity
from firebase_service import FirebaseService
from production_config import ProductionConfig


class WorkloadCredentials(credentials.Base):
    def __init__(self):
        self.credential = Credentials(scopes=['https://www.googleapis.com/auth/cloud-platform'])

    def get_credential(self):
        return self.credential


class LiveFirebaseIdentity(FirebaseIdentity):
    def __init__(self, guard, credential):
        guard.assert_current()
        self.guard = guard
        self.app = firebase_admin.initialize_app(credential, {'projectId': guard.project, 'httpTimeout': 15},
                                                name='relay-staging-' + secrets.token_hex(8))
        client = auth._get_client(self.app)
        session = client._user_manager.http_client.session
        session.trust_env = False
        session.mount('https://',HTTPAdapter(max_retries=0))
        original = session.request

        def secure_request(method, url, **kwargs):
            guard.assert_auth_url(url)
            kwargs.update(allow_redirects=False, verify=True)
            kwargs['timeout']=self.timeout()
            return original(method, url, **kwargs)
        session.request = secure_request
        self.http = requests.Session()
        self.http.trust_env = False
        cert_request = client._token_verifier.request
        certs = cert_request.session
        certs.trust_env = False
        original_cert = certs.request

        def certificate_request(method, url, **kwargs):
            guard.assert_current()
            require(method.upper() == 'GET' and url == _token_gen.ID_TOKEN_CERT_URI,
                    'Invalid identity certificate endpoint.', 503)
            kwargs.update(allow_redirects=False, verify=True)
            kwargs['timeout'] = self.timeout()
            return original_cert(method, url, **kwargs)
        certs.request = certificate_request
        self.certificate_http=certs
        # Retain the SDK's CacheControl certificate cache and key-rotation policy.

    def rest(self, action, data):
        require(action in ('signInWithPassword', 'sendOobCode', 'resetPassword', 'update'), 'Invalid identity operation.', 403)
        if action == 'update':
            require(set(data) == {'oobCode'} and isinstance(data['oobCode'], str) and
                    1 <= len(data['oobCode']) <= 1024,
                    'Only email action code application is supported.', 403)
        if action == 'sendOobCode':
            require(self.guard.delivery, 'Identity delivery is disabled pending owner approval.', 503)
        url = f'https://identitytoolkit.googleapis.com/v1/accounts:{action}'
        self.guard.assert_auth_url(url)
        try:
            response = self.http.post(url, params={'key': self.guard.api_key}, json=data,
                                      timeout=self.timeout(), allow_redirects=False, verify=True)
            if response.status_code != 200:
                raise Problem('Invalid credentials or identity request.', 401)
            return response.json()
        except requests.RequestException:
            raise Problem('Identity provider unavailable. Please retry.', 503) from None

    def timeout(self):
        deadline=getattr(self,'request_deadline',lambda:None)()
        remaining=deadline-time.monotonic() if deadline is not None else 15
        require(remaining>0,'The identity request deadline was reached.',503)
        return min(15,remaining)

    def verification(self, id_token, email):
        self.rest('sendOobCode', dict(requestType='VERIFY_EMAIL', idToken=id_token))
        return dict(verification_required=True, message='Verify your address before signing in.')

    def reset_delivery(self, email):
        # Caller always returns a generic response; this never exposes a link/code.
        self.rest('sendOobCode', dict(requestType='PASSWORD_RESET', email=email))


def create_staging_service():
    guard = ProductionConfig.from_environment()
    credential = WorkloadCredentials()
    identity = LiveFirebaseIdentity(guard, credential)
    client = firestore.Client(project=guard.project, database=guard.database,
                              credentials=credential.get_credential())
    require(client._database == guard.database and client.project == guard.project,
            'Database identity mismatch.', 503)
    # The pinned SDK includes the default TLS port in its authority. Accept only
    # these two exact forms; URLs, alternate ports and host suffixes stay denied.
    require(client._firestore_api.transport._host in ('firestore.googleapis.com', 'firestore.googleapis.com:443'),
            'Firestore must use its official TLS transport.', 503)
    service=FirebaseService(guard=guard, identity=identity, client=client)
    identity.request_deadline=lambda:getattr(service.local,'deadline',None)
    return service
