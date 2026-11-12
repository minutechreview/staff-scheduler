"""Explicit staging activation; importing this module never discovers credentials."""
import os
import re
from dataclasses import dataclass, field
from urllib.parse import urlparse


@dataclass(frozen=True)
class ProductionConfig:
    project: str
    database: str
    origin: str
    api_host: str
    api_key: str = field(repr=False)
    delivery: bool = False
    synthetic_only: bool = True
    max_staff: int = 100
    max_branches: int = 3
    max_tenants: int = 3
    max_members: int = 150
    max_reads: int = 12000
    max_query_documents: int = 5000

    @property
    def hosts(self):
        return {urlparse(self.origin).netloc, self.api_host}

    @classmethod
    def from_environment(cls):
        e = os.environ
        if e.get('RELAY_FIREBASE_MODE') != 'staging' or e.get('RELAY_LIVE_ENABLED') != 'approved':
            raise ValueError('Live initialization is disabled; an approved staging configuration is required.')
        project = e.get('RELAY_FIREBASE_PROJECT', '')
        database = e.get('RELAY_FIRESTORE_DATABASE', '')
        if not re.fullmatch(r'[a-z][a-z0-9-]{4,61}[a-z0-9]', project) or project.startswith('demo-'):
            raise ValueError('Configure one explicit live project.')
        # Default is safe only in this separately reviewed, new isolated project.
        # Never generalize this to the original project's default database.
        permitted_database = (database == 'relay-saas-staging' or
                              (project == 'relay-saas-stg-746234651365' and database == '(default)'))
        if not permitted_database or e.get('RELAY_ACTIVATION_SCOPE') != f'{project}/{database}':
            raise ValueError('Only the explicitly scoped staging database can be activated.')
        if e.get('K_SERVICE') != 'relay-api-staging' or not e.get('K_REVISION'):
            raise ValueError('Live initialization requires the dedicated Cloud Run staging workload.')
        forbidden = ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS',
                     'FIREBASE_CONFIG', 'GCE_METADATA_HOST', 'GCE_METADATA_IP', 'GCE_METADATA_ROOT',
                     'grpc_proxy', 'GRPC_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
                     'http_proxy', 'https_proxy', 'all_proxy']
        if any(e.get(k) for k in forbidden):
            raise ValueError('Mixed emulator, file credentials, metadata overrides or proxy configuration are forbidden.')
        if any(e.get(k) not in (None, '', project) for k in ('GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT')):
            raise ValueError('Mixed project identifiers are forbidden.')
        origin = e.get('RELAY_PUBLIC_ORIGIN', '')
        p = urlparse(origin)
        if p.scheme != 'https' or not re.fullmatch(r'[a-z0-9][a-z0-9.-]+[a-z0-9]', p.netloc) or p.path or p.query or p.fragment:
            raise ValueError('Configure a canonical HTTPS staging origin without path, port or user information.')
        if p.hostname in (f'{project}.web.app', f'{project}.firebaseapp.com'):
            raise ValueError('The original Hosting site cannot be reused by this staging adapter.')
        api_host = e.get('RELAY_API_HOST', '')
        # Regional and opaque Google service identifiers can contain dots.
        # Request hosts must still equal this configured host, never a suffix.
        labels = api_host.split('.')
        valid_label = r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
        if (len(api_host) > 253 or len(labels) < 3 or not api_host.endswith('.run.app')
                or any(not re.fullmatch(valid_label, label) for label in labels)):
            raise ValueError('Configure the exact staging Cloud Run hostname.')
        api_key = e.get('RELAY_AUTH_API_KEY', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{20,200}', api_key):
            raise ValueError('Approved project public Auth API configuration is required; no key is discovered automatically.')
        if e.get('RELAY_SYNTHETIC_ONLY', 'true') != 'true':
            raise ValueError('This release permits synthetic staging identities only.')
        delivery = e.get('RELAY_AUTH_DELIVERY', 'disabled')
        if delivery not in ('disabled', 'approved'):
            raise ValueError('Auth delivery must be disabled or separately approved.')
        return cls(project, database, origin, api_host, api_key, delivery == 'approved')

    def assert_current(self):
        if self != type(self).from_environment():
            raise ValueError('Staging configuration changed after initialization.')

    def assert_auth_url(self, url):
        self.assert_current()
        p = urlparse(url)
        if p.scheme != 'https' or p.hostname != 'identitytoolkit.googleapis.com' or p.netloc != p.hostname:
            raise ValueError('Auth transport must remain on the official HTTPS endpoint.')
