"""Verify signed IAP ES256 assertions; never trust unsigned identity headers."""
import json
import math
import threading
import time
import jwt
import requests
from core import Problem, require
from email_preview_config import AUDIENCE, OWNER

CERT_URL = 'https://www.gstatic.com/iap/verify/public_key'


class IapVerifier:
    def __init__(self, session=None):
        self.http = session or requests.Session()
        self.http.trust_env = False
        self.keys, self.fetched, self.until = {}, 0, 0
        self.lock = threading.Lock()

    def __call__(self, environ):
        token = environ.get('HTTP_X_GOOG_IAP_JWT_ASSERTION', '')
        require(isinstance(token, str) and 0 < len(token) <= 12000, 'Owner IAP sign-in is required.', 403)
        try:
            header = jwt.get_unverified_header(token)
            require(header.get('alg') == 'ES256' and isinstance(header.get('kid'), str) and
                    0 < len(header['kid']) <= 200, 'Invalid IAP assertion.', 403)
            with self.lock:
                now = time.monotonic()
                if now >= self.until or (header['kid'] not in self.keys and now - self.fetched >= 60):
                    response = self.http.get(CERT_URL, timeout=5, allow_redirects=False, verify=True)
                    require(response.status_code == 200 and len(response.content) <= 100000, 'IAP verification unavailable.', 503)
                    keys = json.loads(response.content)
                    require(isinstance(keys, dict) and keys and all(isinstance(k, str) and isinstance(v, str) for k, v in keys.items()),
                            'IAP verification unavailable.', 503)
                    self.keys, self.fetched, self.until = keys, now, now + 300
                key = self.keys.get(header['kid'])
            require(key is not None, 'Invalid IAP signing key.', 403)
            claims = jwt.decode(token, key, algorithms=['ES256'], audience=AUDIENCE,
                issuer='https://cloud.google.com/iap', leeway=30,
                options={'require': ['exp', 'iat', 'iss', 'aud', 'sub', 'email']})
            require(all(type(claims[k]) in (int, float) and math.isfinite(claims[k]) for k in ['exp', 'iat']) and
                    isinstance(claims['aud'], str) and claims['aud'] == AUDIENCE and
                    0 < claims['exp'] - claims['iat'] <= 660 and isinstance(claims['sub'], str) and claims['sub'] and
                    claims['email'] == OWNER, 'Only the approved owner may use this preview.', 403)
            return claims
        except Problem: raise
        except (jwt.PyJWTError, ValueError, TypeError, KeyError):
            raise Problem('Invalid IAP assertion.', 403) from None
        except requests.RequestException:
            raise Problem('IAP verification unavailable.', 503) from None
