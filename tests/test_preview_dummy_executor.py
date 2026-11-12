"""Synthetic executor integration tests; all sockets are mocked."""
import hashlib,hmac,json,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
import preview_dummy_executor as executor
from preview_supervision_local import SupervisionError

class FakeSocket:
    def __init__(self, key, wrong=False, dead=False): self.key=key;self.wrong=wrong;self.dead=dead
    def settimeout(self,_): pass
    def connect(self,_):
        if self.dead: raise OSError('dummy guard unavailable')
    def sendall(self,payload):self.request=json.loads(payload)
    def recv(self,_):
        run='0123456789abcdef';pid=1234;c=self.request['challenge']
        key=b'y'*32 if self.wrong else self.key
        payload=run.encode()+b'\0'+str(pid).encode()+b'\0'+bytes.fromhex(c)
        return json.dumps({'run':run,'pid':pid,'challenge':c,'mac':hmac.digest(key,payload,hashlib.sha256).hex()}).encode()
    def close(self): pass

class DummyExecutorTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.folder=Path(self.tmp.name)
        self.run='0123456789abcdef';self.key=b'x'*32
        (self.folder/'dummy-key').write_bytes(self.key)
        (self.folder/'checkpoint.json').write_text(json.dumps({'run':self.run,'pid':1234,'deadline_unix':time.time()+120}))
        self.path=patch.object(executor,'identity',return_value=self.folder);self.path.start();self.addCleanup(self.path.stop)
    def test_guarded_synthetic_actions_and_handoff(self):
        with patch('socket.socket',side_effect=lambda *a:FakeSocket(self.key)):
            self.assertTrue(executor.execute(self.run,'simulate')['resource_active'])
            self.assertTrue(executor.execute(self.run,'handoff')['guard_verified'])
        state=json.loads((self.folder/'dummy-executor.json').read_text());self.assertEqual(state['actions'],['simulate','handoff'])
    def test_dead_or_reused_guard_denies_action_and_cleans_synthetic_resource(self):
        for wrong,dead in [(False,True),(True,False)]:
            (self.folder/'dummy-executor.json').write_text(json.dumps({'run':self.run,'resource_active':True,'cleanup_verified':False,'actions':[]}))
            with patch('socket.socket',side_effect=lambda *a:FakeSocket(self.key,wrong,dead)):
                with self.assertRaises(SupervisionError):executor.execute(self.run,'simulate')
            state=json.loads((self.folder/'dummy-executor.json').read_text());self.assertFalse(state['resource_active']);self.assertTrue(state['cleanup_verified'])
    def test_deadline_denies_actions_and_cleanup_failure_is_not_success(self):
        (self.folder/'checkpoint.json').write_text(json.dumps({'run':self.run,'pid':1234,'deadline_unix':time.time()+10}))
        with self.assertRaises(SupervisionError):executor.execute(self.run,'simulate')
        self.assertTrue(json.loads((self.folder/'dummy-executor.json').read_text())['cleanup_verified'])
        (self.folder/'dummy-executor.json').unlink()
        with patch.object(executor,'write',side_effect=OSError('dummy cleanup failed')):
            with self.assertRaises(SupervisionError):executor.execute(self.run,'simulate')
        self.assertFalse((self.folder/'dummy-executor.json').exists())
    def test_closed_run_cannot_restart(self):
        (self.folder/'dummy-executor.json').write_text(json.dumps({'run':self.run,'cleanup_verified':True,'resource_active':False,'actions':[]}))
        with self.assertRaisesRegex(SupervisionError,'DUMMY_RUN_CLOSED'):executor.execute(self.run,'simulate')

if __name__=='__main__':unittest.main()
