import hashlib, hmac, io, json, sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from billing_test_webhook_receiver import create_receiver

class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.secret=b'synthetic-'+b'x'*32;self.events=[]
        self.app=create_receiver(self.secret,'fixture.example.test','42',self.events.append)
        self.raw=json.dumps({'meta':{'event_name':'subscription_created'},'data':{'type':'subscriptions','attributes':{'test_mode':True,'store_id':42}}}).encode()
    def call(self,raw=None,**changes):
        raw=self.raw if raw is None else raw
        env={'PATH_INFO':'/webhook','QUERY_STRING':'','REQUEST_METHOD':'POST','HTTP_HOST':'fixture.example.test',
             'CONTENT_TYPE':'application/json','CONTENT_LENGTH':str(len(raw)),
             'HTTP_X_SIGNATURE':hmac.new(self.secret,raw,hashlib.sha256).hexdigest(),'wsgi.input':io.BytesIO(raw)}|changes
        response=[];body=b''.join(self.app(env,lambda status,headers:response.append((status,dict(headers)))))
        return response[0],body
    def test_only_fixed_signed_test_subscription_event_is_recorded(self):
        (status,headers),_=self.call();self.assertEqual(status,'200 OK');self.assertEqual(self.events,['subscription_created']);self.assertEqual(headers['Cache-Control'],'no-store')
        self.assertEqual(self.call()[0][0],'200 OK');self.assertEqual(self.events,['subscription_created'])
    def test_wrong_signature_live_mode_and_host_are_rejected(self):
        self.assertTrue(self.call(HTTP_X_SIGNATURE='0'*64)[0][0].startswith('401'))
        live=self.raw.replace(b'true',b'false');self.assertTrue(self.call(live)[0][0].startswith('400'))
        wrong_store=self.raw.replace(b'42',b'43');self.assertTrue(self.call(wrong_store)[0][0].startswith('400'))
        self.assertTrue(self.call(HTTP_HOST='elsewhere.example.test')[0][0].startswith('404'));self.assertEqual(self.events,[])
    def test_no_other_route_method_query_or_oversize(self):
        for changes in ({'PATH_INFO':'/api/me'},{'REQUEST_METHOD':'GET'},{'QUERY_STRING':'q=x'},{'CONTENT_LENGTH':'262145'},{'HTTP_TRANSFER_ENCODING':'chunked'}):
            self.assertNotEqual(self.call(**changes)[0][0],'200 OK')
        self.assertEqual(self.events,[])
    def test_unavailable_sink_does_not_acknowledge_event(self):
        for exception in (RuntimeError(),ValueError(),KeyError(),TypeError()):
            self.app=create_receiver(self.secret,'fixture.example.test','42',lambda event: (_ for _ in ()).throw(exception))
            self.assertTrue(self.call()[0][0].startswith('503'))

if __name__=='__main__':unittest.main()
