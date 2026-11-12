"""Measure reversible domain writes on the existing synthetic benchmark tenant."""
import argparse
import json
import time
from pathlib import Path
from firebase_service import FirebaseService

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--label',required=True);args=parser.parse_args()
    target=json.loads(Path('.local/firebase-benchmark-target.json').read_text())
    assert target['email'].startswith('benchmark-') and target['email'].endswith('@example.test')
    service=FirebaseService();token=service.signin(dict(email=target['email'],password='fictional-only-123'))
    state=service.dispatch(token,'GET','/api/me',{},{});assert state['organization']['name']=='Synthetic Native Benchmark'
    csrf=state['user']['csrf'];person=next(e for e in state['employees'] if e['branch']==target['branch'])
    query=dict(branch=target['branch'],week='2026-10-05');records=[]
    def call(method,path,body=None,query=None):
        started=time.perf_counter();value=service.dispatch(token,method,path,body or {},query or {},csrf)
        records.append(dict(path=path,method=method,seconds=round(time.perf_counter()-started,3),metrics=dict(service.local.metrics),freshness=value.get('freshness')))
        return value
    before=call('GET','/api/analytics',query=query)
    call('GET','/api/analytics',query=query)
    try:
        call('POST','/api/employees',person|dict(name='Synthetic revision cost probe'))
        changed=call('GET','/api/analytics',query=query)
        assert any(r['employee']==person['id'] and r['name']=='Synthetic revision cost probe' for r in changed['distribution'])
        call('POST','/api/employees',person)
        restored=call('GET','/api/analytics',query=query)
        assert before['distribution']==restored['distribution']
        schedule=call('GET','/api/schedule',query=query)
        # Saving an existing draft exercises the actual schedule/version/audit
        # workflow without changing any shift or published employee feed.
        call('POST','/api/schedule',dict(branch=query['branch'],week=query['week'],revision=schedule['revision'],shifts=schedule['shifts'],action='save',acknowledge_gaps=True))
        call('GET','/api/analytics',query=query)
    finally:
        current=service.dispatch(token,'GET','/api/me',{},{});current_person=next(e for e in current['employees'] if e['id']==person['id'])
        if current_person['name']!=person['name']:service.dispatch(token,'POST','/api/employees',person,{},csrf)
    Path('.local/firebase-analytics-mutations-'+args.label+'.json').write_text(json.dumps(dict(label=args.label,synthetic=True,org=state['organization']['id'],employee_restored=True,published_shifts_unchanged=True,records=records),indent=2)+'\n')
    print(json.dumps(records,indent=2))

if __name__=='__main__':main()
