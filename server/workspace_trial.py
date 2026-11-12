"""Server-owned, no-card workspace trial. No provider or payment operations.

A trial is created only by the native repository's atomic workspace creation.
Existing workspaces without that record fail closed; login is not a migration.
Paid entitlements are deliberately not inferred from billing status fields.
"""
from datetime import datetime, timedelta, timezone
from core import require

TRIAL_DAYS = 7
TRIAL_DURATION = timedelta(days=TRIAL_DAYS)


def trusted_time(value):
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError('A timezone-aware server timestamp is required.')
    return value.astimezone(timezone.utc)


def new_trial(org, now):
    start = trusted_time(now)
    return dict(org=org, version=1, started_at=start.isoformat(),
                ends_at=(start + TRIAL_DURATION).isoformat())


class WorkspaceTrial:
    def __init__(self, service):
        self.service = service

    def status(self, c, actor):
        # trial_get enforces the transaction's already authenticated org scope.
        row = c.trial_get(actor['org'])
        result = dict(status='trial_unavailable', entitled=False, trial_days=TRIAL_DAYS,
                      card_required=False, automatic_charge=False,
                      checkout_available=False, portal_available=False,
                      started_at=None, ends_at=None, plans=[])
        try:
            if not isinstance(row, dict) or row.get('org') != actor['org'] or type(row.get('version')) is not int or row['version'] != 1:
                return result
            start = trusted_time(datetime.fromisoformat(row['started_at']))
            end = trusted_time(datetime.fromisoformat(row['ends_at']))
            now = trusted_time(self.service.now())
            if end != start + TRIAL_DURATION or now < start:
                return result
        except (KeyError, TypeError, ValueError, OverflowError):
            return result
        active = now < end
        return result | dict(status='trialing' if active else 'trial_expired', entitled=active,
                             started_at=start.isoformat(), ends_at=end.isoformat())

    def access(self, c, actor):
        return self.status(c, actor)['entitled']

    def check(self, c, actor):
        require(self.access(c, actor),
                'Workspace trial has ended or is unavailable. Review billing status.', 402)
