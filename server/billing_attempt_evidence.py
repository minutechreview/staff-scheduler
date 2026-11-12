"""Synthetic-only evaluation of a signed-attempt payment-binding alternative.

Not connected to checkout, webhook handling or production. An HMAC attempt is a
bearer capability: possession is not proof of payment or checkout provenance.
Provider facts must be retrieved independently by an authenticated server.
"""
import hashlib
import hmac
import json
import re
import sqlite3
from datetime import datetime


class EvidenceError(ValueError): pass


def when(value):
    try:
        result=datetime.fromisoformat(value.replace('Z','+00:00'))
        if result.utcoffset() is None:raise ValueError()
        return result
    except (ValueError,TypeError,AttributeError):raise EvidenceError('Invalid timestamp') from None


def tag(secret, attempt):
    required=('ref','org','plan','variant','price_id','store','test_mode','amount_minor','currency','interval','interval_count','issued_at','expires_at')
    if not isinstance(secret,bytes) or len(secret)<32 or not all(k in attempt for k in required):
        raise EvidenceError('Invalid signing input')
    canonical=json.dumps([attempt[k] for k in required],ensure_ascii=True,separators=(',',':'),allow_nan=False).encode()
    return hmac.new(secret,b'relay-billing-attempt-v1\0'+canonical,hashlib.sha256).hexdigest()


def evaluate(secret,attempt,received_ref,received_tag,subscription,order,item,variant,price):
    """Check an attempt and fresh provider objects; never calls the provider."""
    if received_ref!=attempt.get('ref') or not isinstance(received_tag,str) or not re.fullmatch(r'[0-9a-f]{64}',received_tag):raise EvidenceError('Invalid attempt')
    if not hmac.compare_digest(tag(secret,attempt),received_tag):raise EvidenceError('Invalid attempt')
    if not isinstance(attempt['ref'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',attempt['ref']):raise EvidenceError('Invalid attempt')
    if not isinstance(attempt['org'],str) or not attempt['org'] or not isinstance(attempt['plan'],str) or not attempt['plan']:
        raise EvidenceError('Invalid attempt')
    if type(attempt['test_mode']) is not bool:raise EvidenceError('Invalid attempt')
    try:
        sub_id=str(subscription['id']); order_id=str(order['id']);item_id=str(item['id'])
        if not all(re.fullmatch(r'[0-9]+',x) for x in (sub_id,order_id,item_id)):raise EvidenceError('Invalid provider identity')
        if any(str(x.get('store_id'))!=str(attempt['store']) for x in (subscription,order)):raise EvidenceError('Store mismatch')
        if any(x.get('test_mode') is not attempt['test_mode'] for x in (subscription,order,variant)):raise EvidenceError('Mode mismatch')
        if str(subscription.get('order_id'))!=order_id or str(subscription.get('order_item_id'))!=item_id or str(item.get('order_id'))!=order_id:
            raise EvidenceError('Order mismatch')
        if str(subscription.get('customer_id'))!=str(order.get('customer_id')) or not str(order.get('customer_id','')).isdigit():
            raise EvidenceError('Customer mismatch')
        if (str(subscription.get('variant_id'))!=str(attempt['variant']) or str(item.get('variant_id'))!=str(attempt['variant']) or
                str(variant.get('id'))!=str(attempt['variant']) or str(price.get('variant_id'))!=str(attempt['variant'])):
            raise EvidenceError('Variant mismatch')
        subscription_item=subscription.get('first_subscription_item') or {}
        if (str(price.get('id'))!=str(attempt['price_id']) or str(subscription_item.get('price_id'))!=str(attempt['price_id']) or
                price.get('category')!='subscription' or subscription_item.get('quantity')!=1):
            raise EvidenceError('Price identity mismatch')
        if (type(attempt['amount_minor']) is not int or attempt['amount_minor']<0 or
                item.get('price')!=attempt['amount_minor'] or item.get('quantity')!=1 or
                order.get('currency')!=attempt['currency'] or price.get('renewal_interval_unit')!=attempt['interval'] or
                price.get('renewal_interval_quantity')!=attempt['interval_count'] or
                price.get('scheme')!='standard' or price.get('unit_price')!=attempt['amount_minor'] or
                price.get('usage_aggregation') is not None or price.get('setup_fee_enabled') is not False or
                price.get('trial_interval_unit') is not None):
            raise EvidenceError('Price or interval mismatch')
        if order.get('status')!='paid' or order.get('refunded') is not False:raise EvidenceError('Payment not confirmed')
        # This deliberately narrow test case excludes trials, discounts,
        # refunds and zero-total orders pending an explicit product policy.
        if (order.get('discount_total')!=0 or order.get('refunded_amount')!=0 or
                type(order.get('total')) is not int or order['total']<=0):raise EvidenceError('Payment terms require review')
        if subscription.get('status')!='active':raise EvidenceError('Subscription terms require review')
        if not when(attempt['issued_at'])<=when(order['created_at'])<=when(attempt['expires_at']):
            raise EvidenceError('Payment time requires review')
    except (KeyError,TypeError):raise EvidenceError('Incomplete provider evidence') from None
    # There is no documented checkout ID in these provider facts. Even a
    # correctly signed attempt and matching paid facts are only a candidate;
    # this result must never activate an entitlement.
    return {'ref':attempt['ref'],'org':attempt['org'],'plan':attempt['plan'],'subscription':sub_id,'order':order_id,
            'evidence_status':'insufficient_checkout_provenance'}


def fixture_schema(c):
    c.executescript('''CREATE TABLE IF NOT EXISTS claims(ref TEXT PRIMARY KEY,org TEXT NOT NULL,subscription TEXT UNIQUE NOT NULL,order_id TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS review(ref TEXT PRIMARY KEY,reason TEXT NOT NULL);''')


def fixture_consume(c,claim):
    """Atomically consume a synthetic claim; ambiguity locks it for review."""
    c.execute('BEGIN IMMEDIATE')
    try:
        if c.execute('SELECT 1 FROM review WHERE ref=?',(claim['ref'],)).fetchone():
            related=c.execute('SELECT DISTINCT ref FROM claims WHERE subscription=? OR order_id=?',(claim['subscription'],claim['order'])).fetchall()
            c.executemany("INSERT OR REPLACE INTO review VALUES(?,'identity_reuse')",related)
            c.commit();return 'review'
        existing=c.execute('SELECT org,subscription,order_id FROM claims WHERE ref=?',(claim['ref'],)).fetchone()
        if existing:
            if existing==(claim['org'],claim['subscription'],claim['order']):c.commit();return 'duplicate'
            related=c.execute('SELECT DISTINCT ref FROM claims WHERE subscription=? OR order_id=?',(claim['subscription'],claim['order'])).fetchall()
            c.executemany("INSERT OR REPLACE INTO review VALUES(?,'multiple_payments')",[(claim['ref'],),*related])
            c.commit();return 'review'
        others=c.execute('SELECT DISTINCT ref FROM claims WHERE subscription=? OR order_id=?',(claim['subscription'],claim['order'])).fetchall()
        if others:
            c.executemany("INSERT OR REPLACE INTO review VALUES(?,'identity_reuse')",[(claim['ref'],),*others])
            c.commit();return 'review'
        c.execute('INSERT INTO claims VALUES(?,?,?,?)',(claim['ref'],claim['org'],claim['subscription'],claim['order']))
        c.commit();return 'consumed'
    except (sqlite3.Error,KeyError):
        c.rollback();raise
