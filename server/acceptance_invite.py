"""Short-lived acceptance enrollment gate. Never store the bearer secret."""
import hashlib
import hmac
import re
import time
from core import require

def check(guard,data):
    if not getattr(guard,'requires_invite',False):return
    token=data.get('enrollment_code','')
    valid=isinstance(token,str) and re.fullmatch(r'[0-9a-f]{64}',token) is not None
    value=hashlib.sha256(token.encode()).hexdigest() if valid else '0'*64
    require(valid and hmac.compare_digest(value,guard.invite_hash) and time.time()<guard.invite_expires,
            'Enrollment is unavailable or the code is invalid.',403)

def claim(store,guard,job,fingerprint):
    if not getattr(guard,'requires_invite',False):return
    require(time.time()<guard.invite_expires,'Enrollment is unavailable or the code is invalid.',403)
    current=store.control_get('acceptance_invites',guard.invite_hash)
    if current:
        require(current.get('uid')==job['uid'] and current.get('fingerprint')==fingerprint,
                'Enrollment is unavailable or the code is invalid.',403)
    else:
        store.control_put('acceptance_invites',guard.invite_hash,dict(uid=job['uid'],fingerprint=fingerprint,used_at=time.time()))
