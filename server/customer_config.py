"""Optional, isolated acceptance configuration; not customer production auth."""
import os
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

PROJECT = 'relay-cust-746234651365'  # Proposed; availability and ownership are unverified.
DATABASE = 'relay-customers'
ORIGIN = 'https://relay-cust-746234651365.web.app'
SERVICE = 'relay-api-customer'
OWNER_EMAIL = 'owner@example.invalid'

@dataclass(frozen=True)
class CustomerConfig:
    project: str
    database: str
    origin: str
    api_host: str
    api_key: str = field(repr=False)
    invite_hash: str = field(repr=False)
    invite_expires: int
    delivery: bool = False
    synthetic_only: bool = False
    allowed_email: str = OWNER_EMAIL
    reserve_on_verified_login: bool = True
    per_actor_limits: bool = True
    requires_invite: bool = True
    safe_member_jobs: bool = True
    max_staff: int = 100
    max_branches: int = 3
    max_tenants: int = 3
    max_members: int = 150
    max_reads: int = 12000
    max_query_documents: int = 5000

    @property
    def hosts(self): return {urlparse(self.origin).netloc, self.api_host}

    @classmethod
    def from_environment(cls):
        e=os.environ
        required={'RELAY_FIREBASE_MODE':'customer', 'RELAY_CUSTOMER_LIVE_ENABLED':'approved',
                  'RELAY_CUSTOMER_ACCESS_MODE':'acceptance',
                  'RELAY_FIREBASE_PROJECT':PROJECT, 'RELAY_FIRESTORE_DATABASE':DATABASE,
                  'RELAY_ACTIVATION_SCOPE':PROJECT+'/'+DATABASE, 'K_SERVICE':SERVICE,
                  'RELAY_PUBLIC_ORIGIN':ORIGIN, 'RELAY_SYNTHETIC_ONLY':'false'}
        required['RELAY_CUSTOMER_ACCEPTANCE_EMAIL'] = OWNER_EMAIL
        if any(e.get(k)!=v for k,v in required.items()) or not e.get('K_REVISION'):
            raise ValueError('The dedicated customer deployment scope is not activated.')
        forbidden=('FIREBASE_AUTH_EMULATOR_HOST','FIRESTORE_EMULATOR_HOST','GOOGLE_APPLICATION_CREDENTIALS',
                   'FIREBASE_CONFIG','GCE_METADATA_HOST','GCE_METADATA_IP','GCE_METADATA_ROOT',
                   'grpc_proxy','GRPC_PROXY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')
        if any(e.get(k) for k in forbidden) or any(e.get(k) not in (None,'',PROJECT) for k in ('GCLOUD_PROJECT','GOOGLE_CLOUD_PROJECT')):
            raise ValueError('Mixed project, emulator, credential file or proxy configuration is forbidden.')
        host=e.get('RELAY_API_HOST','')
        label=r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
        if (len(host)>253 or not host.startswith(SERVICE+'-') or not host.endswith('.run.app') or
            len(host.split('.'))<3 or any(not re.fullmatch(label,part) for part in host.split('.'))):
            raise ValueError('The exact customer Cloud Run host is required.')
        key=e.get('RELAY_AUTH_API_KEY','')
        if not re.fullmatch(r'[A-Za-z0-9_-]{20,200}',key): raise ValueError('Customer Auth public API key is required.')
        invite_hash=e.get('RELAY_CUSTOMER_INVITE_HASH','')
        expires=e.get('RELAY_CUSTOMER_INVITE_EXPIRES','')
        if (not re.fullmatch(r'[0-9a-f]{64}',invite_hash) or not re.fullmatch(r'[0-9]{10}',expires)
                or int(expires)>time.time()+3600):
            raise ValueError('A short-lived acceptance enrollment verifier is required.')
        delivery=e.get('RELAY_AUTH_DELIVERY','disabled')
        if delivery not in ('disabled','approved'): raise ValueError('Invalid email delivery setting.')
        return cls(PROJECT,DATABASE,ORIGIN,host,key,invite_hash,int(expires),delivery=='approved')

    def assert_current(self):
        if self != type(self).from_environment(): raise ValueError('Customer configuration changed after startup.')

    def assert_auth_url(self,url):
        self.assert_current(); p=urlparse(url)
        if p.scheme!='https' or p.hostname!='identitytoolkit.googleapis.com' or p.netloc!=p.hostname:
            raise ValueError('Auth transport must use the official HTTPS endpoint.')
