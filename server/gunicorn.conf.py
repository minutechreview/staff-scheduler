"""One bounded staging process. No preload/credentials before worker startup."""
import os
bind = '0.0.0.0:' + str(int(os.environ.get('PORT', '8080')))
workers = 1
worker_class = 'gthread'
threads = 4
timeout = 55
graceful_timeout = 20
keepalive = 5
max_requests = 2000
max_requests_jitter = 100
limit_request_line = 4096
limit_request_fields = 40
limit_request_field_size = 8192
preload_app = False
accesslog = None
errorlog = '-'
loglevel = 'warning'
# No mutable control plane/socket is needed in the bounded container worker.
control_socket_disable = True
# Cloud Run's TLS edge is the sole trusted proxy in the reviewed deployment.
# Arbitrary forwarded Host/client-IP headers are never used by the application.
forwarded_allow_ips = '*'
secure_scheme_headers = {'X-FORWARDED-PROTO': 'https'}
