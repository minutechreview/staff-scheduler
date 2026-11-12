"""Guard for ordinary email/password customer deployment; disabled by default.

This proposal is isolated from staging and the temporary acceptance harness.
The explicit flags are deployment gates, not evidence that the provider or
edge security configuration has been independently verified.
"""
import os
import re
from dataclasses import dataclass,field
from urllib.parse import urlparse
from customer_config import PROJECT,DATABASE,ORIGIN,SERVICE

@dataclass(frozen=True)
class ProductionCustomerConfig:
    project:str
    database:str
    origin:str
    api_host:str
    api_key:str=field(repr=False)
    delivery:bool=False
    synthetic_only:bool=False
    requires_invite:bool=False
    allowed_email:None=None
    reserve_on_verified_login:bool=True
    per_actor_limits:bool=True
    safe_member_jobs:bool=True
    require_mailbox_password_setup:bool=True
    max_staff:int=50
    max_branches:int=3
    count_active_staff:bool=True
    workspace_trial_required:bool=True
    max_tenants:int=3
    max_members:int=150
    max_reads:int=12000
    max_query_documents:int=5000

    @property
    def hosts(self):return {urlparse(self.origin).netloc,self.api_host}
    @classmethod
    def from_environment(cls):
        e=os.environ
        required={'RELAY_ORDINARY_LIVE_ENABLED':'approved','RELAY_FIREBASE_MODE':'customer',
                  'RELAY_CUSTOMER_ACCESS_MODE':'ordinary','RELAY_FIREBASE_PROJECT':PROJECT,
                  'RELAY_FIRESTORE_DATABASE':DATABASE,'RELAY_ACTIVATION_SCOPE':PROJECT+'/'+DATABASE,
                  'K_SERVICE':SERVICE,'RELAY_PUBLIC_ORIGIN':ORIGIN,'RELAY_SYNTHETIC_ONLY':'false',
                  'RELAY_RELEASE_REVIEW':'approved'}
        if any(e.get(k)!=v for k,v in required.items()) or not e.get('K_REVISION'):
            raise ValueError('The dedicated ordinary customer deployment is not activated.')
        forbidden=('FIREBASE_AUTH_EMULATOR_HOST','FIRESTORE_EMULATOR_HOST','GOOGLE_APPLICATION_CREDENTIALS',
                   'FIREBASE_CONFIG','GCE_METADATA_HOST','GCE_METADATA_IP','GCE_METADATA_ROOT',
                   'grpc_proxy','GRPC_PROXY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy',
                   'RELAY_CUSTOMER_INVITE_HASH','RELAY_CUSTOMER_INVITE_EXPIRES','RELAY_CUSTOMER_ACCEPTANCE_EMAIL')
        if any(e.get(k) for k in forbidden) or any(e.get(k) not in (None,'',PROJECT) for k in ('GCLOUD_PROJECT','GOOGLE_CLOUD_PROJECT')):
            raise ValueError('Mixed project, acceptance, emulator, credential file or proxy configuration is forbidden.')
        host=e.get('RELAY_API_HOST','');label=r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
        if (len(host)>253 or not host.startswith(SERVICE+'-') or not host.endswith('.run.app') or len(host.split('.'))<3
                or any(not re.fullmatch(label,x) for x in host.split('.'))):raise ValueError('Exact customer Cloud Run host required.')
        key=e.get('RELAY_AUTH_API_KEY','')
        if not re.fullmatch(r'[A-Za-z0-9_-]{20,200}',key):raise ValueError('Customer Auth public API configuration required.')
        delivery=e.get('RELAY_AUTH_DELIVERY','disabled')
        if delivery not in ('disabled','approved'):raise ValueError('Invalid email delivery setting.')
        return cls(PROJECT,DATABASE,ORIGIN,host,key,delivery=='approved')
    def assert_current(self):
        if self!=type(self).from_environment():raise ValueError('Customer configuration changed after startup.')
    def assert_auth_url(self,url):
        self.assert_current();p=urlparse(url)
        if p.scheme!='https' or p.hostname!='identitytoolkit.googleapis.com' or p.netloc!=p.hostname:
            raise ValueError('Auth transport must use the official HTTPS endpoint.')
