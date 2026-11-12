"""Separate protected preview. Import/disabled startup never loads provider SDKs."""
import hashlib
import mimetypes
import os
import threading
import time
from pathlib import Path
from core import Problem, require
from email_preview_config import EmailPreviewConfig, CALLBACK, PROFILE, OWNER, HOST
from production_app import create_application, json_response

API_ROUTES = {
    ('GET', '/api/capabilities'), ('GET', '/api/me'),
    ('POST', '/api/signup'), ('POST', '/api/signin'), ('POST', '/api/signout'),
    ('POST', '/api/recovery/request'), ('POST', '/api/auth/action/check'), ('POST', '/api/auth/action/complete'),
}


def create_preview_service(guard):
    # Called only after signed IAP, window and path/method validation.
    from firebase_live import WorkloadCredentials, LiveFirebaseIdentity
    from google.cloud import firestore
    from email_preview_policy import make_preview_service
    guard.assert_open()
    credential = WorkloadCredentials()
    identity = LiveFirebaseIdentity(guard, credential)
    client = firestore.Client(project=guard.project, database=guard.database, credentials=credential.get_credential())
    require(client._database == guard.database and client.project == guard.project and
            client._firestore_api.transport._host in ('firestore.googleapis.com', 'firestore.googleapis.com:443'),
            'Invalid preview database transport.', 503)
    service = make_preview_service(guard, identity, client)
    identity.request_deadline = lambda: getattr(service.local, 'deadline', None)
    return service


def create_preview_application(guard, verifier, factory=create_preview_service, static_dir=None):
    root = Path(static_dir or Path(__file__).resolve().parents[1] / 'dist-email-preview').resolve()
    application = None
    lock = threading.Lock()

    def preview(environ, start_response):
        nonlocal application
        try:
            path, method = environ.get('PATH_INFO', ''), environ.get('REQUEST_METHOD', '')
            if path == '/healthz' and method == 'GET':
                return json_response(start_response, 200, dict(status='preview-shell-only'))
            # Health is the only unauthenticated exception. It reads no data/SDK.
            require(environ.get('HTTP_HOST') == guard.api_host and environ.get('wsgi.url_scheme') == 'https',
                    'Use the exact HTTPS preview origin.', 403)
            verifier(environ)
            require(not environ.get('QUERY_STRING'), 'Paste the email link into the protected form; URL actions are forbidden here.', 422)
            # Revalidate config even for static/metadata requests without requiring
            # an open test window or instantiating an identity adapter.
            require(guard == type(guard).from_environment(), 'Preview configuration changed.', 503)
            if path == '/api/preview' and method == 'GET':
                return json_response(start_response, 200, dict(display_name=PROFILE, recipient=OWNER,
                    starts_at=guard.starts_at, expires_at=guard.expires_at, active=guard.starts_at <= time.time() < guard.expires_at,
                    provider_callback=CALLBACK, api_key_sha256=hashlib.sha256(guard.api_key.encode()).hexdigest(),
                    maximum_messages=dict(verification=1, reset=1)))
            if path.startswith('/api/'):
                require((method, path) in API_ROUTES, 'Outside the email acceptance scope.', 403)
                guard.assert_open()
                if application is None:
                    with lock:
                        if application is None: application = create_application(factory(guard), guard)
                return application(environ, start_response)
            require(method in ['GET', 'HEAD'], 'Method not allowed.', 405)
            require(path in ['/', '/account/action', '/third-party-notices.html'] or
                    (path.startswith('/assets/') and '/' not in path[len('/assets/'):]), 'Page not found.', 404)
            relative = 'preview.html' if path in ['/', '/account/action'] else path.lstrip('/')
            file = (root / relative).resolve()
            require(file.is_relative_to(root) and file.is_file(), 'Page not found.', 404)
            body = file.read_bytes()
            headers = [('Content-Type', mimetypes.guess_type(file.name)[0] or 'application/octet-stream'),
                       ('Content-Length', str(len(body))), ('Cache-Control', 'private, no-store'),
                       ('Referrer-Policy', 'no-referrer'), ('X-Content-Type-Options', 'nosniff'),
                       ('Strict-Transport-Security', 'max-age=31536000'),
                       ('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")]
            start_response('200 OK', headers)
            return [body if method == 'GET' else b'']
        except Problem as error:
            return json_response(start_response, error.status, dict(error=str(error)))
        except Exception:
            return json_response(start_response, 503, dict(error='Protected preview unavailable. No automatic retry.'))
    return preview


def load_application():
    if os.environ.get('RELAY_EMAIL_PREVIEW_EXECUTION') != 'approved':
        return lambda environ, start_response: json_response(start_response, 503, dict(error='Email preview execution is not approved.'))
    try:
        guard = EmailPreviewConfig.from_environment()
        from email_preview_iap import IapVerifier
        return create_preview_application(guard, IapVerifier())
    except Exception:
        return lambda environ, start_response: json_response(start_response, 503, dict(error='Exact protected preview configuration is required.'))
