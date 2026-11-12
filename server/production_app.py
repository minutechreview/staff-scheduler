"""Bounded WSGI API. Disabled startup performs no credential or network access."""
import json
import os
import threading
from contextlib import nullcontext
from http import HTTPStatus
from http.cookies import SimpleCookie
from urllib.parse import parse_qs
from core import Problem, require
from identity_lifecycle import recovery_available, email_actions_available, action_fields
from acceptance_invite import check as check_acceptance
from request_payload import parse_request_object

MAX_BODY = 2_000_000
MAX_RESPONSE = 4_000_000


def json_response(start_response, status, data, cookie=None):
    body = json.dumps(data, allow_nan=False, separators=(',', ':')).encode()
    if len(body) > MAX_RESPONSE:
        status, body = 413, b'{"error":"Response exceeds the staging limit. Narrow the requested scope."}'
        cookie = None
    headers = [('Content-Type', 'application/json'), ('Content-Length', str(len(body))),
               ('Cache-Control', 'private, no-store, max-age=0'), ('Vary', 'Cookie, Origin'),
               ('X-Content-Type-Options', 'nosniff'), ('Referrer-Policy', 'no-referrer'),
               ('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"),
               ('Strict-Transport-Security', 'max-age=31536000')]
    if status in (429, 503):
        headers.append(('Retry-After', '60'))
    if cookie is not None:
        headers.append(('Set-Cookie', f'__session={cookie}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age={43200 if cookie else 0}'))
    start_response(f'{status} {HTTPStatus(status).phrase}', headers)
    return [body]


def create_application(service, config):
    """Dependency injection supports local tests without activating live transport."""
    slots = threading.BoundedSemaphore(4)

    def application(environ, start_response):
        try:
            require(environ.get('HTTP_HOST', '') in config.hosts, 'Invalid request host.', 403)
            require(environ.get('wsgi.url_scheme') == 'https', 'HTTPS is required.', 403)
            path = environ.get('PATH_INFO', '')
            require(len(path) <= 2048 and len(environ.get('QUERY_STRING', '')) <= 4096, 'Request target is too large.', 414)
            method = environ.get('REQUEST_METHOD', '')
            if path == '/healthz' and method == 'GET':
                return json_response(start_response, 200, dict(status='ready', scope='synthetic-staging' if config.synthetic_only else 'customer'))
            if path == '/api/billing/webhook' and method == 'POST':
                # Only a deliberately injected emulator fixture can enable this
                # route. No browser cookie, Origin or parsed JSON is trusted.
                billing = getattr(service, 'billing_fixture', None) or getattr(service, 'billing_live', None)
                require(billing is not None, 'Endpoint not found.', 404)
                require(not environ.get('HTTP_TRANSFER_ENCODING'), 'Chunked requests are unsupported.', 400)
                size = environ.get('CONTENT_LENGTH', '')
                require(size.isascii() and size.isdigit() and 0 < int(size) <= 262144, 'Invalid webhook size.', 413)
                raw = environ['wsgi.input'].read(int(size))
                require(len(raw)==int(size), 'Incomplete webhook.', 400)
                require(slots.acquire(blocking=False), 'The service is busy. Please retry.', 503)
                try:
                    with service.request_context() if hasattr(service, 'request_context') else nullcontext():
                        return json_response(start_response, 200, billing.webhook(raw, environ.get('HTTP_X_SIGNATURE', '')))
                finally:
                    slots.release()
            require(method in ('GET', 'POST'), 'Method not allowed.', 405)
            require(path.startswith('/api/'), 'Endpoint not found.', 404)
            if getattr(config,'requires_invite',False):
                # Public capability discovery is static. All other acceptance
                # requests are gated before body parsing, counters or storage.
                if path=='/api/capabilities' and method=='GET':
                    return json_response(start_response,200,dict(recovery=recovery_available(service),email_actions=email_actions_available(service),synthetic_only=config.synthetic_only,signup_invite_required=True))
                check_acceptance(config,dict(enrollment_code=environ.get('HTTP_X_RELAY_ACCEPTANCE','')))
            require(environ.get('HTTP_SEC_FETCH_SITE') not in ('cross-site', 'none') or method == 'GET',
                    'Cross-site requests are forbidden.', 403)
            data = {}
            if method == 'POST':
                require(environ.get('HTTP_ORIGIN') == config.origin, 'Use the approved application origin.', 403)
                require(environ.get('CONTENT_TYPE', '').split(';')[0].strip() == 'application/json',
                        'Send application/json.', 415)
                require(not environ.get('HTTP_TRANSFER_ENCODING'), 'Chunked requests are unsupported.', 400)
                size_text = environ.get('CONTENT_LENGTH', '')
                require(size_text.isascii() and size_text.isdigit(), 'A valid Content-Length is required.', 411)
                size = int(size_text)
                require(0 < size <= MAX_BODY, 'Request body exceeds the staging limit.', 413)
                raw = environ['wsgi.input'].read(size)
                require(len(raw) == size, 'Incomplete request body.', 400)
                data = parse_request_object(raw)
                # Reject malformed codes before admission counters, storage,
                # or provider access. Provider-specific validity is checked later.
                if path in ('/api/auth/action/check','/api/auth/action/complete'):
                    action_fields(data)
                elif path == '/api/recovery/complete':
                    action_fields(dict(mode='resetPassword',code=data.get('code')))
            cookie_header = environ.get('HTTP_COOKIE', '')
            require(len(cookie_header) <= 8192, 'Cookie header is too large.', 431)
            require(sum(part.strip().split('=', 1)[0] == '__session' for part in cookie_header.split(';')) <= 1,
                    'Ambiguous session cookie.', 400)
            cookies = SimpleCookie(cookie_header)
            token = cookies['__session'].value if '__session' in cookies else None
            require(token is None or len(token) <= 200, 'Invalid session.', 401)
            require(slots.acquire(blocking=False), 'The staging service is busy. Please retry.', 503)
            context = service.request_context() if hasattr(service, 'request_context') else nullcontext()
            try:
                context.__enter__()
                if hasattr(service, 'set_request_actor'):
                    service.set_request_actor(path, data, token)
                service.admit_request(path, token)
                if path == '/api/capabilities' and method == 'GET':
                    return json_response(start_response, 200, dict(recovery=recovery_available(service), email_actions=email_actions_available(service), synthetic_only=config.synthetic_only, signup_invite_required=getattr(config,'requires_invite',False)))
                if path in ('/api/auth/action/check', '/api/auth/action/complete') and method == 'POST':
                    require(email_actions_available(service), 'Email actions are unavailable for this adapter.', 503)
                    result = service.check_email_action(data) if path.endswith('/check') else service.complete_email_action(data)
                    clear_cookie = path.endswith('/complete') and result.get('signed_out') is True
                    return json_response(start_response, 200, result, '' if clear_cookie else None)
                if path in ('/api/signup', '/api/signin') and method == 'POST':
                    result = service.signup(data) if path.endswith('signup') else service.signin(data, 'staging-global')
                    if isinstance(result, dict) and result.get('verification_required'):
                        return json_response(start_response, 202, result)
                    bootstrap = service.dispatch(result, 'GET', '/api/me', {}, {})
                    return json_response(start_response, 201 if path.endswith('signup') else 200, bootstrap, result)
                if path == '/api/recovery/request' and method == 'POST':
                    return json_response(start_response, 202, service.request_recovery(data))
                if path == '/api/recovery/complete' and method == 'POST':
                    return json_response(start_response, 200, service.complete_recovery(data), '')
                # No production factory currently attaches this coordinator.
                # It checks owner/CSRF and makes provider calls outside the
                # retried Firestore transaction.
                # The no-card customer trial must never fall through to a provider checkout.
                billing_live = None if getattr(service, 'workspace_trial', None) is not None else getattr(service, 'billing_live', None)
                if billing_live is not None and method == 'GET' and path == '/api/billing':
                    return json_response(start_response, 200, billing_live.status(token))
                if billing_live is not None and method == 'POST':
                    if path == '/api/billing/checkout':
                        return json_response(start_response, 200, billing_live.checkout(token,environ.get('HTTP_X_CSRF_TOKEN'),data.get('plan')))
                    if path == '/api/billing/portal':
                        return json_response(start_response, 200, billing_live.portal(token,environ.get('HTTP_X_CSRF_TOKEN')))
                parsed = parse_qs(environ.get('QUERY_STRING', ''), keep_blank_values=True, max_num_fields=20)
                require(all(len(v) == 1 for v in parsed.values()), 'Duplicate query parameters are forbidden.')
                query = {k: v[0] for k, v in parsed.items()}
                result = service.dispatch(token, method, path, data, query, environ.get('HTTP_X_CSRF_TOKEN'))
                return json_response(start_response, 200, result, '' if path in ('/api/password', '/api/signout') else None)
            finally:
                context.__exit__(None, None, None)
                slots.release()
        except Problem as error:
            return json_response(start_response, error.status, dict(error=str(error)))
        except (ValueError, TypeError, KeyError):
            return json_response(start_response, 422, dict(error='Invalid request. Check the fields and try again.'))
        except Exception:
            # No provider exception, request, email, token or configuration is logged.
            return json_response(start_response, 503, dict(error='Request unavailable. Refresh saved state before retrying.'))
    return application


def load_application():
    if os.environ.get('RELAY_LIVE_ENABLED') != 'approved':
        def disabled(environ, start_response):
            return json_response(start_response, 503, dict(error='Staging activation is disabled.'))
        return disabled
    from firebase_live import create_staging_service
    service = create_staging_service()
    return create_application(service, service.guard)
