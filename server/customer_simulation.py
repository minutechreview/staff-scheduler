"""Emulator-only customer account rehearsal; no production activation path."""
from customer_simulation_config import CustomerSimulationConfig
from firebase_service import FirebaseService


class CustomerSimulationService(FirebaseService):
    def __init__(self):
        self.customer_simulation = CustomerSimulationConfig.from_environment()
        super().__init__()
        self.customer_simulation.assert_current()

    def run(self, operation):
        self.customer_simulation.assert_current()
        return super().run(operation)

    def identity_email_allowed(self, email):
        self.customer_simulation.assert_current()
        return self.customer_simulation.email_allowed(email)
