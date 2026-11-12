"""Ordinary customer API entry point. Disabled until separately authorized."""
import os
from production_app import create_application,json_response

def load_application():
    if os.environ.get('RELAY_ORDINARY_LIVE_ENABLED')!='approved':
        def disabled(environ,start_response):return json_response(start_response,503,dict(error='Customer service is disabled.'))
        return disabled
    from production_customer_live import create_production_customer_service
    service=create_production_customer_service()
    return create_application(service,service.guard)
