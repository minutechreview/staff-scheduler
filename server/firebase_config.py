"""Fail-closed emulator configuration. This adapter never enables live services."""
import os
import re
from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class EmulatorConfig:
    project: str
    auth_host: str
    firestore_host: str

    @classmethod
    def from_environment(cls):
        if os.environ.get('RELAY_FIREBASE_MODE') != 'emulator':
            raise ValueError('Firebase adapter requires explicit RELAY_FIREBASE_MODE=emulator; live services are disabled.')
        project=os.environ.get('RELAY_FIREBASE_PROJECT','')
        if not re.fullmatch(r'demo-[a-z0-9-]{3,48}',project):
            raise ValueError('Use a synthetic demo- project. Real Firebase projects are forbidden in this adapter.')
        for name in ('GOOGLE_APPLICATION_CREDENTIALS','FIREBASE_CONFIG'):
            if os.environ.get(name): raise ValueError(f'{name} must be absent; emulator tests never load production credentials.')
        for name in ('grpc_proxy','GRPC_PROXY','http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY','all_proxy','ALL_PROXY'):
            if os.environ.get(name): raise ValueError('Proxy endpoints are forbidden for the loopback-only adapter.')
        for name in ('GCLOUD_PROJECT','GOOGLE_CLOUD_PROJECT'):
            if os.environ.get(name) not in (None,'',project): raise ValueError('Mixed project identifiers are forbidden.')
        hosts=[]
        for name in ('FIREBASE_AUTH_EMULATOR_HOST','FIRESTORE_EMULATOR_HOST'):
            value=os.environ.get(name,'')
            if not re.fullmatch(r'127\.0\.0\.1:[0-9]{2,5}',value) or not 1<=int(value.rsplit(':',1)[1])<=65535:
                raise ValueError(f'{name} must be an explicit 127.0.0.1:port endpoint, without a scheme.')
            hosts.append(value)
        if hosts[0]==hosts[1]: raise ValueError('Auth and Firestore must use separate emulator ports.')
        return cls(project,*hosts)

    def assert_current(self):
        if self != type(self).from_environment(): raise ValueError('Emulator configuration changed after initialization; refuse mixed services.')

    def assert_auth_url(self,url):
        self.assert_current()
        p=urlparse(url)
        if p.scheme!='http' or p.netloc!=self.auth_host or p.username or p.password:
            raise ValueError('An attempted Auth request left the configured loopback emulator.')
