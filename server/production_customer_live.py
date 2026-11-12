"""Ordinary customer provider factory; never imported by disabled startup."""
from production_customer_config import ProductionCustomerConfig
from customer_live import create_guarded_customer_service

def create_production_customer_service():
    return create_guarded_customer_service(ProductionCustomerConfig.from_environment())
