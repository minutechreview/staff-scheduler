#!/usr/bin/env python3
"""Local dummy-only handoff experiment. No cloud imports, credentials or real cleanup."""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import time

ROOT = Path(__file__).resolve().parents[1] / '.local' / 'dummy-supervision'


def identity(run):
    if len(run) != 16 or any(c not in '0123456789abcdef' for c in run):
        raise ValueError('invalid dummy run')
    return ROOT / run


def write(path, value):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value) + '\n')
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def server(duration):
    if not 30 <= duration <= 300:
        raise ValueError('duration outside dummy bounds')
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    run = secrets.token_hex(8)
    directory = identity(run)
    directory.mkdir(mode=0o700)
    key = secrets.token_bytes(32)
    keyfile = directory / 'dummy-key'
    keyfile.write_bytes(key); os.chmod(keyfile, 0o600)
    sockpath = Path('/tmp') / ('scheduler-dummy-' + run + '.sock')
    deadline = time.time() + duration
    server_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server_socket.bind(str(sockpath)); os.chmod(sockpath, 0o600)
    server_socket.listen(1); server_socket.settimeout(1.0)
    checkpoint = directory / 'checkpoint.json'
    data = {'run':run, 'pid':os.getpid(), 'status':'armed', 'deadline_unix':deadline,
            'heartbeat_unix':time.time(), 'probes':0, 'dummy_cleanup':False}
    write(checkpoint,data)
    print(json.dumps({'dummy_run':run,'pid':os.getpid(),'deadline_unix':deadline,'cloud_calls':0}),flush=True)
    try:
        while time.time() < deadline:
            data['heartbeat_unix'] = time.time(); write(checkpoint,data)
            try: connection, _ = server_socket.accept()
            except socket.timeout: continue
            with connection:
                connection.settimeout(2)
                request = json.loads(connection.recv(4096))
                challenge = request.get('challenge','')
                if len(challenge) != 64 or any(c not in '0123456789abcdef' for c in challenge):
                    continue
                payload = run.encode() + b'\0' + str(os.getpid()).encode() + b'\0' + bytes.fromhex(challenge)
                response = {'run':run,'pid':os.getpid(),'challenge':challenge,
                            'mac':hmac.new(key,payload,hashlib.sha256).hexdigest()}
                connection.sendall(json.dumps(response).encode())
                data['probes'] += 1
    finally:
        statefile=directory/'dummy-executor.json'
        if statefile.exists():
            state=json.loads(statefile.read_text())
            state.update(resource_active=False,cleanup_verified=True,cleanup_source='dummy_guard_expiry')
            write(statefile,state)
        data.update(status='completed',dummy_cleanup=True,completed_unix=time.time())
        write(checkpoint,data)
        server_socket.close()
        sockpath.unlink(missing_ok=True)
        print(json.dumps({'dummy_run':run,'status':'completed','dummy_cleanup':True,'cloud_calls':0}),flush=True)


def probe(run):
    directory=identity(run)
    data=json.loads((directory/'checkpoint.json').read_text())
    if data['status'] != 'armed' or data['deadline_unix'] <= time.time():
        raise RuntimeError('dummy guard not armed')
    key=(directory/'dummy-key').read_bytes()
    challenge=secrets.token_hex(32)
    sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); sock.settimeout(3)
    try:
        sock.connect(str(Path('/tmp') / ('scheduler-dummy-' + run + '.sock')))
        sock.sendall(json.dumps({'challenge':challenge}).encode())
        response=json.loads(sock.recv(4096))
    finally: sock.close()
    payload=run.encode()+b'\0'+str(data['pid']).encode()+b'\0'+bytes.fromhex(challenge)
    expected=hmac.new(key,payload,hashlib.sha256).hexdigest()
    if response.get('run')!=run or response.get('pid')!=data['pid'] or response.get('challenge')!=challenge or not hmac.compare_digest(response.get('mac',''),expected):
        raise RuntimeError('dummy guard identity mismatch')
    print(json.dumps({'dummy_run':run,'identity_verified':True,'pid':data['pid'],
                      'heartbeat_age_seconds':round(time.time()-data['heartbeat_unix'],2),
                      'deadline_unix':data['deadline_unix'],'cloud_calls':0}))


def status(run):
    data=json.loads((identity(run)/'checkpoint.json').read_text())
    print(json.dumps(data))


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    sub=parser.add_subparsers(dest='mode',required=True)
    start=sub.add_parser('start');start.add_argument('--duration',type=int,default=180)
    for mode in ['probe','status']:
        command=sub.add_parser(mode);command.add_argument('run')
    args=parser.parse_args()
    if args.mode=='start': server(args.duration)
    elif args.mode=='probe': probe(args.run)
    else: status(args.run)
