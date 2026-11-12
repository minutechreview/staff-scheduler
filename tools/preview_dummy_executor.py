#!/usr/bin/env python3
"""Synthetic-only executor using local guard; intentionally incapable of cloud execution."""
import argparse
import json
import socket
import time
from pathlib import Path
from preview_dummy_sentinel import identity, write
from preview_supervision_local import GuardIdentity, LocalSupervisor, SupervisionError


def execute(run, action):
    folder=identity(run)
    guard=json.loads((folder/'checkpoint.json').read_text())
    key=(folder/'dummy-key').read_bytes()
    ident=GuardIdentity(run,guard['pid'],key)
    statefile=folder/'dummy-executor.json'
    state=json.loads(statefile.read_text()) if statefile.exists() else {'run':run,'resource_active':False,'cleanup_verified':False,'actions':[]}
    if state['run'] != run or state['cleanup_verified']:
        raise SupervisionError('DUMMY_RUN_CLOSED')
    def probe(run_id,pid,challenge):
        sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);sock.settimeout(2)
        try:
            sock.connect(str(Path('/tmp')/('scheduler-dummy-'+run_id+'.sock')))
            sock.sendall(json.dumps({'challenge':challenge.hex()}).encode())
            response=json.loads(sock.recv(4096))
        finally: sock.close()
        if response.get('run')!=run_id or response.get('pid')!=pid or response.get('challenge')!=challenge.hex():
            raise ValueError('guard identity mismatch')
        return bytes.fromhex(response['mac'])
    def cleanup():
        state.update(resource_active=False,cleanup_verified=True,cleanup_source='dummy_executor')
        write(statefile,state)
        return True
    # The executor will stop new actions 20 seconds before the dummy guard expires.
    supervisor=LocalSupervisor(ident,probe,time.time,cleanup,guard['deadline_unix']-20,guard['deadline_unix'])
    if action=='handoff':
        supervisor.owner_handoff()
    elif action=='simulate':
        supervisor.authorize_action()
        state['resource_active']=True
    else:
        raise ValueError('unsupported dummy action')
    state['actions'].append(action);write(statefile,state)
    return {'dummy_run':run,'action':action,'guard_verified':True,'resource_active':state['resource_active'],'cloud_calls':0}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('run');parser.add_argument('action',choices=['handoff','simulate'])
    args=parser.parse_args()
    try: print(json.dumps(execute(args.run,args.action)))
    except (OSError,ValueError,SupervisionError) as error:
        print(json.dumps({'status':'STOPPED','reason':type(error).__name__,'cloud_calls':0}))
        raise SystemExit(1)
