"""Loopback-only local HTTP adapter. No Firebase fallback or cloud writes."""
import argparse
import json
import os
import sqlite3
import time
from collections import defaultdict
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from core import Problem, Service, require
from identity_lifecycle import recovery_available, email_actions_available
from request_payload import parse_request_object


def create_server(db, port=4317, backend='sqlite', static_dir=None):
    if backend=='firebase-emulator':
        from firebase_service import FirebaseService
        service=FirebaseService()
    elif backend=='customer-simulation':
        from customer_simulation import CustomerSimulationService
        service=CustomerSimulationService()
    else:
        require(backend=='sqlite','Unknown storage adapter.')
        service = Service(db)
    cookie_name=getattr(service,'cookie_name','relay_session')
    attempts = defaultdict(list)
    root = Path(static_dir).resolve() if static_dir else Path(__file__).resolve().parent.parent / 'dist'
    if static_dir and not ((root / 'index.html').is_file() and (root / 'assets').is_dir()):
        raise ValueError('Static directory must contain a built index.html and assets directory')

    class Handler(BaseHTTPRequestHandler):
        server_version = 'RelayLocal/1'

        def log_message(self, format, *args):
            # Never log credentials, cookies, request bodies, or private query strings.
            pass

        def respond(self, status, data, cookie=None):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.headers_common()
            if cookie is not None:
                self.send_header('Set-Cookie', f'{cookie_name}={cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age={43200 if cookie else 0}')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def headers_common(self):
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")

        def do_GET(self):
            self.handle_request('GET')

        def do_POST(self):
            self.handle_request('POST')

        def handle_request(self, method):
            parsed = urlparse(self.path)
            try:
                host = self.headers.get('Host', '')
                require(host in (f'localhost:{self.server.server_port}', f'127.0.0.1:{self.server.server_port}'), 'Invalid local host.', 403)
                if not parsed.path.startswith('/api/'):
                    require(method == 'GET', 'Method not allowed.', 405)
                    requested = (root / parsed.path.lstrip('/')).resolve()
                    require(requested.is_relative_to(root.resolve()), 'Invalid path.', 404)
                    if not requested.is_file():
                        require(not Path(parsed.path).suffix, 'Asset not found.', 404)
                        requested = root / 'index.html'
                    require(requested.is_file(), 'Run npm run build before opening the local preview.', 503)
                    content = requested.read_bytes()
                    kinds = {'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg'}
                    self.send_response(200)
                    self.send_header('Content-Type', kinds.get(requested.suffix, 'application/octet-stream'))
                    self.headers_common()
                    self.send_header('Content-Length', str(len(content)))
                    self.end_headers()
                    self.wfile.write(content)
                    return
                data = {}
                if method == 'POST':
                    origin = self.headers.get('Origin')
                    require(origin is None or origin in (f'http://localhost:{self.server.server_port}', f'http://127.0.0.1:{self.server.server_port}'), 'Cross-origin requests are forbidden.', 403)
                    require(self.headers.get('Content-Type', '').split(';')[0] == 'application/json', 'Send application/json.', 415)
                    size = int(self.headers.get('Content-Length', 0))
                    require(0 < size <= 2_000_000, 'Request body must be 1–2,000,000 bytes.', 413)
                    data = parse_request_object(self.rfile.read(size))
                cookies = SimpleCookie(self.headers.get('Cookie', ''))
                token = cookies[cookie_name].value if cookie_name in cookies else None
                if parsed.path=='/api/capabilities' and method=='GET':
                    self.respond(200,dict(recovery=recovery_available(service),email_actions=email_actions_available(service),synthetic_only=True))
                    return
                if parsed.path in ('/api/auth/action/check','/api/auth/action/complete') and method=='POST':
                    require(email_actions_available(service),'Email actions are unavailable for this adapter.',503)
                    result=service.check_email_action(data) if parsed.path.endswith('/check') else service.complete_email_action(data)
                    self.respond(200,result,'' if parsed.path.endswith('/complete') and result.get('signed_out') is True else None)
                    return
                if parsed.path in ('/api/recovery/request','/api/recovery/complete') and method=='POST':
                    require(hasattr(service,'request_recovery'),'Recovery is unavailable for this adapter.',404)
                    result=service.request_recovery(data) if parsed.path.endswith('request') else service.complete_recovery(data)
                    self.respond(202 if parsed.path.endswith('request') else 200,result,'' if parsed.path.endswith('complete') else None)
                    return
                if parsed.path in ('/api/signup', '/api/signin') and method == 'POST':
                    key = self.client_address[0]
                    attempts[key] = [t for t in attempts[key] if t > time.time() - 300]
                    require(len(attempts[key]) < 30, 'Too many sign-in attempts. Try again in five minutes.', 429)
                    attempts[key].append(time.time())
                    token = service.signup(data) if parsed.path.endswith('signup') else service.signin(data,self.client_address[0])
                    if isinstance(token,dict) and token.get('verification_required'):
                        self.respond(202,token)
                        return
                    result = service.dispatch(token, 'GET', '/api/me', {}, {})
                    self.respond(201 if parsed.path.endswith('signup') else 200, result, token)
                    return
                query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
                result = service.dispatch(token, method, parsed.path, data, query, self.headers.get('X-CSRF-Token'))
                self.respond(200, result, '' if parsed.path in ('/api/signout','/api/password') else None)
            except (BrokenPipeError,ConnectionResetError):
                pass  # A disconnected browser cannot receive a second response.
            except Problem as error:
                self.respond(error.status, dict(error=str(error)))
            except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                self.respond(422, dict(error='Invalid request. Check the fields and try again.'))
            except sqlite3.OperationalError:
                self.respond(503, dict(error='Storage is busy or unavailable. Please retry.'))
            except Exception:
                self.respond(500, dict(error='Request could not be completed. Refresh to check saved state before retrying.'))

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.service = service
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', default=str(Path(__file__).resolve().parent.parent / '.local/relay.sqlite3'))
    parser.add_argument('--port', type=int, default=4317)
    parser.add_argument('--backend', choices=['sqlite','firebase-emulator','customer-simulation'], default='sqlite')
    parser.add_argument('--static-dir', help='Optional local directory containing the built frontend')
    args = parser.parse_args()
    os.umask(0o077)
    server = create_server(args.db, args.port,args.backend,args.static_dir)
    if args.backend=='sqlite':os.chmod(args.db, 0o600)
    print(f'Relay local preview: http://127.0.0.1:{server.server_port}', flush=True)
    server.serve_forever()
