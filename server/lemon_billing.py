"""Disabled-by-default Lemon Squeezy billing foundation for synthetic tests.

This module is not registered as a public webhook or a production entitlement
gate. SQLite below is a local test adapter, not a distributed billing store.
"""
import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timezone
from urllib.parse import urlparse


class BillingError(ValueError):
    pass


def parse_time(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError):
        raise BillingError('Invalid provider timestamp') from None


def require_owner(actor):
    if not actor or actor.get('role') != 'owner' or not actor.get('org'):
        raise BillingError('Organization owner required')


def public_plans(plans):
    """Return only explicitly configured plans; absent prices stay absent."""
    return [dict(id=p['id'], name=p['name'], amount_minor=p['amount_minor'],
                 currency=p['currency'], interval=p['interval']) for p in plans]


def schema(c):
    c.executescript('''
    CREATE TABLE IF NOT EXISTS billing_checkout_refs (
      ref TEXT PRIMARY KEY, org TEXT NOT NULL, variant TEXT NOT NULL,
      subscription TEXT UNIQUE, created REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      subscription TEXT PRIMARY KEY, org TEXT NOT NULL, variant TEXT NOT NULL,
      status TEXT NOT NULL, ends_at TEXT, updated_at TEXT NOT NULL,
      payload_hash TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS billing_one_per_org ON billing_subscriptions(org);
    CREATE TABLE IF NOT EXISTS billing_events (payload_hash TEXT PRIMARY KEY);
    ''')


def checkout(c, actor, plan_id, plans, store_id, transport, now):
    """Create a test checkout through an explicitly injected transport only."""
    require_owner(actor)
    choices = [p for p in plans if p.get('id') == plan_id]
    if len(choices) != 1 or not store_id or not choices[0].get('variant_id'):
        raise BillingError('Plan unavailable')
    if not getattr(transport, 'synthetic_only', False):
        raise BillingError('Live checkout is disabled')
    ref = secrets.token_urlsafe(32)
    variant = str(choices[0]['variant_id'])
    c.execute('INSERT INTO billing_checkout_refs(ref,org,variant,created) VALUES(?,?,?,?)',
              (ref, actor['org'], variant, now.timestamp()))
    payload = {'data': {'type': 'checkouts', 'attributes': {'checkout_data': {'custom': {'relay_ref': ref}}},
                        'relationships': {'store': {'data': {'type': 'stores', 'id': str(store_id)}},
                                          'variant': {'data': {'type': 'variants', 'id': variant}}}}}
    response = transport.create_checkout(payload)
    url = response.get('url', '')
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith('.lemonsqueezy.com') or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise BillingError('Invalid checkout URL')
    return {'url': url}


def management_portal(c, actor, transport):
    """Owner-only, freshly obtained provider portal URL; never persist it."""
    require_owner(actor)
    if not getattr(transport, 'synthetic_only', False):
        raise BillingError('Live billing management is disabled')
    row = c.execute('SELECT subscription FROM billing_subscriptions WHERE org=?', (actor['org'],)).fetchone()
    if not row:
        raise BillingError('No subscription found')
    url = transport.subscription_portal(row[0])
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith('.lemonsqueezy.com') or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise BillingError('Invalid portal URL')
    return {'url': url}


EVENTS = {'subscription_created', 'subscription_updated', 'subscription_cancelled',
          'subscription_resumed', 'subscription_expired', 'subscription_paused', 'subscription_unpaused'}
STATUSES = {'on_trial', 'active', 'paused', 'past_due', 'unpaid', 'cancelled', 'expired'}


def handle_webhook(c, raw, signature, signing_secret, store_id, expected_test_mode=True):
    """Authenticate raw bytes then atomically bind and apply a subscription snapshot."""
    if not isinstance(raw, bytes) or len(raw) > 262144 or not signing_secret:
        raise BillingError('Invalid webhook')
    if not isinstance(signature, str) or not re.fullmatch(r'[0-9a-f]{64}', signature):
        raise BillingError('Invalid signature')
    expected = hmac.new(signing_secret, raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise BillingError('Invalid signature')
    try:
        obj = json.loads(raw)
        meta, data = obj['meta'], obj['data']
        attrs = data['attributes']
        event, ref = meta['event_name'], meta['custom_data']['relay_ref']
        sub, variant = str(data['id']), str(attrs['variant_id'])
        status, updated = attrs['status'], attrs['updated_at']
        parsed_updated = parse_time(updated)
        if event not in EVENTS or data['type'] != 'subscriptions' or status not in STATUSES:
            raise BillingError('Unsupported webhook')
        if str(attrs['store_id']) != str(store_id) or attrs['test_mode'] is not expected_test_mode:
            raise BillingError('Wrong store or mode')
        if not isinstance(ref, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', ref) or not sub.isdigit():
            raise BillingError('Invalid binding')
        ends = attrs.get('ends_at')
        if ends is not None:
            parse_time(ends)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        raise BillingError('Invalid webhook payload') from None
    digest = hashlib.sha256(raw).hexdigest()
    c.execute('BEGIN IMMEDIATE')
    try:
        if c.execute('SELECT 1 FROM billing_events WHERE payload_hash=?', (digest,)).fetchone():
            c.commit(); return 'duplicate'
        binding = c.execute('SELECT org,variant,subscription FROM billing_checkout_refs WHERE ref=?', (ref,)).fetchone()
        if not binding or (not binding[2] and binding[1] != variant) or (binding[2] and binding[2] != sub):
            raise BillingError('Unknown or mismatched checkout')
        previous = c.execute('SELECT org,variant,updated_at,status FROM billing_subscriptions WHERE subscription=?', (sub,)).fetchone()
        if previous and previous[0] != binding[0]:
            raise BillingError('Subscription binding mismatch')
        if previous and parsed_updated <= parse_time(previous[2]):
            if parsed_updated == parse_time(previous[2]):
                raise BillingError('Conflicting snapshot; reconcile with provider')
            c.execute('INSERT INTO billing_events VALUES(?)', (digest,)); c.commit(); return 'stale'
        c.execute('UPDATE billing_checkout_refs SET subscription=? WHERE ref=?', (sub, ref))
        if variant != binding[1] or (previous and previous[3] == 'reconciliation_required'):
            status = 'reconciliation_required'
        c.execute('''INSERT INTO billing_subscriptions VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(subscription) DO UPDATE SET status=excluded.status,ends_at=excluded.ends_at,
              updated_at=excluded.updated_at,payload_hash=excluded.payload_hash''',
                  (sub, binding[0], variant, status, ends, updated, digest))
        c.execute('INSERT INTO billing_events VALUES(?)', (digest,)); c.commit(); return 'applied'
    except Exception:
        c.rollback(); raise


def entitled(c, org, now):
    """Fail closed; cancelled subscriptions retain access only until ends_at."""
    row = c.execute('SELECT status,ends_at FROM billing_subscriptions WHERE org=?', (org,)).fetchone()
    if not row:
        return False
    if row[0] in ('active', 'on_trial'):
        return True
    return row[0] == 'cancelled' and bool(row[1]) and now < parse_time(row[1])


def require_entitlement(c, actor, now):
    if not actor or not actor.get('org') or not entitled(c, actor['org'], now):
        raise BillingError('Subscription required')
