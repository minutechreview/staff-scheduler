"""Minimal injected test-mode webhook receiver. No listener is started here.

It records only a fixed event name via an injected callback. It does not process
payments, retain provider payloads, grant access, or accept live-mode events.
An actual tunnel and provider configuration are not authorized by this module.
"""
import hashlib
import hmac
import json
import re
import threading

ALLOWED = frozenset({'subscription_created','subscription_updated','subscription_cancelled',
                     'subscription_expired','subscription_resumed','subscription_paused','subscription_unpaused'})
MAX_BODY=262144


def create_receiver(secret, host, store_id, on_event):
    if not isinstance(secret,bytes) or len(secret)<32 or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{0,251}',host) or not str(store_id).isdigit() or not callable(on_event):
        raise ValueError('Invalid test receiver configuration')
    seen=set();lock=threading.Lock()
    def app(env,start_response):
        status='404 Not Found';body=b'{"error":"Not found"}'
        if (env.get('PATH_INFO')=='/webhook' and not env.get('QUERY_STRING') and
                env.get('REQUEST_METHOD')=='POST' and env.get('HTTP_HOST')==host and
                env.get('CONTENT_TYPE','').split(';')[0].strip().lower()=='application/json' and
                not env.get('HTTP_TRANSFER_ENCODING')):
            try:
                length=env.get('CONTENT_LENGTH','')
                if not length.isascii() or not length.isdigit() or not 0<int(length)<=MAX_BODY:raise ValueError()
                raw=env['wsgi.input'].read(int(length))
                if len(raw)!=int(length):raise ValueError()
                signature=env.get('HTTP_X_SIGNATURE','')
                if not re.fullmatch(r'[0-9a-f]{64}',signature) or not hmac.compare_digest(hmac.new(secret,raw,hashlib.sha256).hexdigest(),signature):
                    status='401 Unauthorized';body=b'{"error":"Invalid signature"}'
                else:
                    obj=json.loads(raw);event=obj['meta']['event_name']
                    if (event not in ALLOWED or obj['data']['type']!='subscriptions' or
                            obj['data']['attributes']['test_mode'] is not True or
                            str(obj['data']['attributes']['store_id'])!=str(store_id)):raise ValueError()
                    digest=hashlib.sha256(raw).digest()
                    with lock:
                        if digest not in seen:
                            if len(seen)>=256:raise RuntimeError('Test receipt limit reached')
                            try:on_event(event)
                            except Exception:raise RuntimeError('Test receipt unavailable') from None
                            seen.add(digest)
                    status='200 OK';body=b'{"received":true}'
            except (ValueError,KeyError,TypeError,UnicodeError):
                status='400 Bad Request';body=b'{"error":"Invalid test event"}'
            except Exception:
                status='503 Service Unavailable';body=b'{"error":"Unavailable"}'
        start_response(status,[('Content-Type','application/json'),('Cache-Control','no-store'),
                               ('Content-Length',str(len(body))),('X-Content-Type-Options','nosniff')])
        return [body]
    return app
