import json, sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from lemon_provider import LemonProvider, ProviderError

class Response:
    def __init__(self,body,status=200):self.body,self.status_code,self.closed=body,status,False
    def iter_content(self,chunk_size):yield json.dumps(self.body).encode()
    def close(self):self.closed=True
class Session:
    def __init__(self,response):self.response=response;self.calls=[]
    def request(self,*args,**kwargs):
        self.calls.append((args,kwargs))
        if isinstance(self.response,Exception):raise self.response
        return self.response

class ProviderTests(unittest.TestCase):
    def client(self,response):
        session=Session(response)
        return LemonProvider(session,'synthetic-key','42','https://relay.example.test/billing',True,'fixture.lemonsqueezy.com'),session
    def test_checkout_contract(self):
        ident='5e8b546c-c561-4a2c-a586-40c18bb2a195'
        result={'data':{'type':'checkouts','id':ident,'attributes':{'store_id':42,'variant_id':55,'test_mode':True,'expires_at':'2026-11-01T16:00:00.000000Z','product_options':{'enabled_variants':[55]},'url':'https://fixture.lemonsqueezy.com/checkout/custom/2'}}}
        client,session=self.client(Response(result));self.assertEqual(client.create_checkout('55','a'*43,'2026-11-01T16:00:00Z')['id'],ident)
        args,kwargs=session.calls[0];self.assertEqual(args,('POST','https://api.lemonsqueezy.com/v1/checkouts'))
        self.assertFalse(kwargs['allow_redirects']);self.assertEqual(kwargs['json']['data']['attributes']['product_options']['enabled_variants'],[55])
        self.assertIs(kwargs['json']['data']['attributes']['test_mode'],True)
        self.assertEqual(kwargs['json']['data']['attributes']['checkout_data']['custom']['relay_ref'],'a'*43)
    def test_checkout_missing_expiry_or_variant_lock_is_uncertain(self):
        attrs={'store_id':42,'variant_id':55,'test_mode':True,'expires_at':'2026-11-01T16:00:00Z','product_options':{'enabled_variants':[55]},'url':'https://fixture.lemonsqueezy.com/checkout'}
        for change in ({'expires_at':None},{'product_options':{'enabled_variants':[]}}):
            data={'data':{'type':'checkouts','id':'5e8b546c-c561-4a2c-a586-40c18bb2a195','attributes':attrs|change}}
            client,_=self.client(Response(data))
            with self.assertRaises(ProviderError) as error:client.create_checkout('55','a'*43,'2026-11-01T16:00:00Z')
            self.assertTrue(error.exception.uncertain)
    def test_uncertain_post_and_mismatch_fail_closed(self):
        client,_=self.client(TimeoutError())
        with self.assertRaises(ProviderError) as error:client.create_checkout('55','a'*43,'2026-11-01T16:00:00Z')
        self.assertTrue(error.exception.uncertain)
        client,_=self.client(Response({'data':{'type':'checkouts','id':'5e8b546c-c561-4a2c-a586-40c18bb2a195','attributes':{'store_id':42,'variant_id':55,'test_mode':False,'url':'https://fixture.lemonsqueezy.com'}}}))
        with self.assertRaises(ProviderError) as error:client.create_checkout('55','a'*43,'2026-11-01T16:00:00Z')
        self.assertTrue(error.exception.uncertain)
    def test_subscription_portal_url_and_redirection_rejected(self):
        data={'data':{'type':'subscriptions','id':'19','attributes':{'store_id':42,'test_mode':True,'urls':{'customer_portal':'https://fixture.lemonsqueezy.com/billing?signature=fixture'}}}}
        client,session=self.client(Response(data));self.assertIn('lemonsqueezy.com',client.portal('19'));self.assertFalse(session.calls[0][1]['allow_redirects'])
        data['data']['attributes']['urls']['customer_portal']='https://fixture.lemonsqueezy.com.evil.test/billing'
        with self.assertRaises(ProviderError):client.portal('19')
        response=Response({},302);client,_=self.client(response)
        with self.assertRaises(ProviderError):client.subscription('19')
        self.assertTrue(response.closed)

if __name__=='__main__':unittest.main()
