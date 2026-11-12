"""Separate, opt-in preview scope; never relaxes the original staging guard."""
import math
import os
import re
import time
from dataclasses import dataclass
from production_config import ProductionConfig

PROJECT = 'relay-saas-stg-746234651365'
NUMBER = '931481612691'
SERVICE = 'relay-email-preview'
OWNER = 'owner@example.invalid'
HOST = f'{SERVICE}-{NUMBER}.us-central1.run.app'
ORIGIN = 'https://' + HOST
AUDIENCE = f'/projects/{NUMBER}/locations/us-central1/services/{SERVICE}'
CALLBACK = f'https://{PROJECT}.firebaseapp.com/__/auth/action'
PROFILE = 'Relay staging test'
ORGANIZATION = 'Relay email acceptance'


@dataclass(frozen=True)
class EmailPreviewConfig(ProductionConfig):
    owner_email: str = OWNER
    run_id: str = ''
    starts_at: float = 0
    expires_at: float = 0
    max_calls: int = 100
    max_staff: int = 0
    max_branches: int = 0
    max_tenants: int = 1
    max_members: int = 1
    max_reads: int = 1000
    max_query_documents: int = 200

    @classmethod
    def from_environment(cls):
        e = os.environ
        if (e.get('K_SERVICE') != SERVICE or not e.get('K_REVISION') or
                e.get('RELAY_EMAIL_PREVIEW_EXECUTION') != 'approved' or
                e.get('RELAY_LIVE_ENABLED') != 'approved' or e.get('RELAY_FIREBASE_MODE') != 'staging' or
                e.get('RELAY_FIREBASE_PROJECT') != PROJECT or e.get('RELAY_FIRESTORE_DATABASE') != '(default)' or
                e.get('RELAY_ACTIVATION_SCOPE') != PROJECT + '/(default)' or
                e.get('RELAY_PUBLIC_ORIGIN') != ORIGIN or e.get('RELAY_API_HOST') != HOST or
                e.get('RELAY_EMAIL_PREVIEW_RECIPIENT') != OWNER or e.get('RELAY_AUTH_DELIVERY') != 'approved' or
                e.get('RELAY_SYNTHETIC_ONLY') != 'true'):
            raise ValueError('Exact separately approved email-preview configuration is required.')
        forbidden = ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS',
                     'FIREBASE_CONFIG', 'GCE_METADATA_HOST', 'GCE_METADATA_IP', 'GCE_METADATA_ROOT',
                     'grpc_proxy', 'GRPC_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
                     'http_proxy', 'https_proxy', 'all_proxy']
        if any(e.get(k) for k in forbidden) or any(e.get(k) not in (None, '', PROJECT) for k in ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']):
            raise ValueError('Credential files, emulators, proxies or mixed projects are forbidden.')
        run_id = e.get('RELAY_EMAIL_PREVIEW_RUN_ID', '')
        if not re.fullmatch(r'email-[0-9]{8}t[0-9]{6}z-[a-f0-9]{8}', run_id):
            raise ValueError('One exact bounded preview run ID is required.')
        starts, expires = float(e.get('RELAY_EMAIL_PREVIEW_STARTS_AT', 'nan')), float(e.get('RELAY_EMAIL_PREVIEW_EXPIRES_AT', 'nan'))
        if not all(math.isfinite(v) for v in [starts, expires]) or not 0 < expires - starts <= 1800:
            raise ValueError('A finite window of at most 30 minutes is required.')
        key = e.get('RELAY_AUTH_API_KEY', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{20,200}', key): raise ValueError('Existing pinned public Auth configuration is required.')
        return cls(PROJECT, '(default)', ORIGIN, HOST, key, True, True,
                   owner_email=OWNER, run_id=run_id, starts_at=starts, expires_at=expires)

    def assert_open(self):
        self.assert_current()

    def assert_current(self):
        super().assert_current()
        if not self.starts_at <= time.time() < self.expires_at:
            from core import Problem
            raise Problem('The approved preview window is closed. No action was submitted.', 503)
