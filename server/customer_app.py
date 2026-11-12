"""Optional acceptance WSGI entry point; not ordinary customer sign-in."""
import os
from production_app import create_application, json_response

def load_application():
    if os.environ.get('RELAY_CUSTOMER_LIVE_ENABLED')!='approved':
        def disabled(environ,start_response):
            return json_response(start_response,503,dict(error='Customer deployment is disabled.'))
        return disabled
    from customer_live import create_customer_service
    service=create_customer_service()
    return create_application(service,service.guard)
