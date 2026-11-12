"""Explicit, isolated customer-flow simulation; never enables a live provider."""
import os
import re
from dataclasses import dataclass
from firebase_config import EmulatorConfig


@dataclass(frozen=True)
class CustomerSimulationConfig:
    emulator: EmulatorConfig
    action_path: str = '/account/action'
    real_delivery: bool = False

    @classmethod
    def from_environment(cls):
        if os.environ.get('RELAY_CUSTOMER_AUTH_SIMULATION') != 'enabled':
            raise ValueError('Customer-flow simulation requires explicit local opt-in.')
        if os.environ.get('RELAY_LIVE_ENABLED', 'disabled') != 'disabled':
            raise ValueError('Customer-flow simulation cannot activate live services.')
        if os.environ.get('RELAY_AUTH_DELIVERY', 'disabled') != 'disabled':
            raise ValueError('Customer-flow simulation cannot enable real delivery.')
        emulator = EmulatorConfig.from_environment()
        if emulator.project != 'demo-relay-email-actions':
            raise ValueError('Customer-flow simulation requires its isolated demo project.')
        return cls(emulator)

    def assert_current(self):
        if self != type(self).from_environment():
            raise ValueError('Customer-flow simulation configuration changed.')

    def email_allowed(self, email):
        # Reserved .example addresses are fictional; no real recipient is permitted.
        return isinstance(email, str) and re.fullmatch(
            r'[a-z0-9][a-z0-9._+\-]{0,63}@review\.example', email, re.ASCII) is not None
