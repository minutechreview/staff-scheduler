"""Lemon Squeezy API transport. No client is created at application startup.

All calls require an explicitly injected session and credentials; activation is
not wired to configuration. Never log provider errors, URLs or response bodies.
"""
import json
import re
import time
from datetime import datetime, timezone
from uuid import UUID
from urllib.parse import urlparse

API = 'https://api.lemonsqueezy.com/v1'
MEDIA = 'application/vnd.api+json'


class ProviderError(RuntimeError):
    def __init__(self, code, uncertain=False):
        super().__init__(code)
        self.uncertain = uncertain


def hardened_session():
    """Create explicitly, only after activation; no proxies, netrc or retries."""
    import requests
    from requests.adapters import HTTPAdapter
    session=requests.Session();session.trust_env=False;session.verify=True
    session.mount('https://',HTTPAdapter(max_retries=0))
    return session


def hosted_url(value, expected_host):
    try:
        p=urlparse(value)
        if (p.scheme!='https' or p.hostname!=expected_host or
                p.username or p.password or p.port not in (None,443) or p.fragment):
            raise ValueError()
    except (TypeError,ValueError):
        raise ProviderError('Invalid hosted provider URL') from None
    return value


def timestamp(value):
    try:
        result=datetime.fromisoformat(value.replace('Z','+00:00'))
        if result.tzinfo is None:raise ValueError()
        return result.astimezone(timezone.utc)
    except (AttributeError,TypeError,ValueError):
        raise ProviderError('Invalid checkout expiry') from None


class LemonProvider:
    def __init__(self, session, api_key, store_id, redirect_url, expected_test_mode, store_host):
        if (not isinstance(api_key,str) or not api_key or not str(store_id).isdigit() or
                not isinstance(expected_test_mode,bool)):
            raise ProviderError('Invalid provider configuration')
        p=urlparse(redirect_url)
        if p.scheme!='https' or not p.hostname or p.username or p.password or p.fragment or p.query:
            raise ProviderError('Invalid redirect')
        if not isinstance(store_host,str) or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.lemonsqueezy\.com',store_host):
            raise ProviderError('Invalid store host')
        session.trust_env=False
        self._session,self._api_key,self.store_id,self.redirect_url,self.test_mode,self.store_host=session,api_key,str(store_id),redirect_url,expected_test_mode,store_host

    def _call(self, method, path, payload=None, deadline=None):
        if not re.fullmatch(r'/(?:checkouts(?:/[0-9a-f-]{36})?|subscriptions(?:/[0-9]+)?)',path):
            raise ProviderError('Invalid API path')
        limit=min(time.monotonic()+20,deadline if deadline is not None else float('inf'))
        remaining=limit-time.monotonic()
        if remaining<=0:raise ProviderError('Provider deadline reached')
        try:
            response=self._session.request(method,API+path,headers={'Accept':MEDIA,'Content-Type':MEDIA,
                'Authorization':'Bearer '+self._api_key},json=payload,timeout=(min(5,remaining),min(5,remaining)),allow_redirects=False,verify=True,stream=True)
        except Exception:
            raise ProviderError('Provider unavailable', uncertain=method=='POST') from None
        try:
            if response.status_code<200 or response.status_code>=300:
                raise ProviderError('Provider request failed', uncertain=method=='POST')
            try:
                chunks=[];size=0
                for chunk in response.iter_content(16384):
                    if time.monotonic()>=limit:raise ValueError()
                    size+=len(chunk)
                    if size>262144:raise ValueError()
                    chunks.append(chunk)
                body=json.loads(b''.join(chunks));data=body['data']
                if not isinstance(data,dict) or not isinstance(data['attributes'],dict):raise ValueError()
                return data
            except Exception:
                raise ProviderError('Invalid provider response', uncertain=method=='POST') from None
        finally:
            response.close()

    def create_checkout(self, variant, ref, expires_at, deadline=None):
        if not str(variant).isdigit() or not re.fullmatch(r'[A-Za-z0-9_-]{43}',ref):
            raise ProviderError('Invalid checkout')
        expected_expiry=timestamp(expires_at)
        payload={'data':{'type':'checkouts','attributes':{'expires_at':expires_at,'test_mode':self.test_mode,
            'product_options':{'enabled_variants':[int(variant)],'redirect_url':self.redirect_url},
            'checkout_data':{'custom':{'relay_ref':ref}}},'relationships':{
                'store':{'data':{'type':'stores','id':self.store_id}},
                'variant':{'data':{'type':'variants','id':str(variant)}}}}}
        data=self._call('POST','/checkouts',payload,deadline);a=data['attributes']
        try: checkout_id=str(UUID(str(data.get('id',''))))
        except ValueError:raise ProviderError('Checkout response mismatch',uncertain=True) from None
        if (data.get('type')!='checkouts' or
                str(a.get('store_id'))!=self.store_id or str(a.get('variant_id'))!=str(variant) or a.get('test_mode') is not self.test_mode):
            raise ProviderError('Checkout response mismatch',uncertain=True)
        try:
            if timestamp(a.get('expires_at'))!=expected_expiry or a.get('product_options',{}).get('enabled_variants')!=[int(variant)]:
                raise ValueError()
        except (ValueError,ProviderError,TypeError,AttributeError):
            # Provider creation may already have succeeded. Preserve the
            # pending intent and never repeat the POST automatically.
            raise ProviderError('Checkout configuration mismatch',uncertain=True) from None
        return {'id':checkout_id,'url':hosted_url(a.get('url'),self.store_host)}

    def subscription(self, sub, deadline=None):
        if not str(sub).isdigit():raise ProviderError('Invalid subscription')
        data=self._call('GET','/subscriptions/'+str(sub),deadline=deadline);a=data['attributes']
        if (data.get('type')!='subscriptions' or str(data.get('id'))!=str(sub) or
                str(a.get('store_id'))!=self.store_id or a.get('test_mode') is not self.test_mode):
            raise ProviderError('Subscription response mismatch')
        return a

    def checkout(self,ident,deadline=None):
        try:ident=str(UUID(str(ident)))
        except ValueError:raise ProviderError('Invalid checkout') from None
        data=self._call('GET','/checkouts/'+ident,deadline=deadline);a=data['attributes']
        if (data.get('type')!='checkouts' or str(data.get('id'))!=ident or
                str(a.get('store_id'))!=self.store_id or a.get('test_mode') is not self.test_mode):
            raise ProviderError('Checkout response mismatch')
        return a

    def portal(self,sub,deadline=None):
        return hosted_url(self.subscription(sub,deadline).get('urls',{}).get('customer_portal'),self.store_host)
