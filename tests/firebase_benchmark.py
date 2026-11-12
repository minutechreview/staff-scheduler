"""Native emulator probe: synthetic tenant only; never selects a real project."""
import argparse
import json
import statistics
import time
import hashlib
from datetime import date,timedelta
from firebase_contract import VerifiedFixtureService
from core import uid

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--branches',type=int,default=40)
    parser.add_argument('--staff',type=int,default=50)
    parser.add_argument('--weeks',type=int,default=12)
    parser.add_argument('--label',default='native')
    parser.add_argument('--bootstrap-only',action='store_true')
    parser.add_argument('--reuse-target',action='store_true')
    args=parser.parse_args()
    s=VerifiedFixtureService('benchmark-'+uid())
    if args.reuse_target:
        from pathlib import Path
        target_info=json.loads(Path('.local/firebase-benchmark-target.json').read_text())
        from firebase_service import FirebaseService
        from firebase_repository import key
        s=FirebaseService()
        assert target_info['email'].startswith('benchmark-') and target_info['email'].endswith('@example.test')
        token=s.signin(dict(email=target_info['email'],password='fictional-only-123'))
        state=s.dispatch(token,'GET','/api/me',{}, {})
        assert state['organization']['name']=='Synthetic Native Benchmark'
        org=state['organization']['id'];csrf=state['user']['csrf'];branches=[b['id'] for b in state['branches']]
        result=dict(label=args.label,emulator=True,project=s.guard.project,org=org,branches=len(branches),employees=len(state['employees']),weeks=args.weeks,historical_shifts=len(state['employees'])*5*args.weeks,reused_synthetic_dataset=True,timings={})
        return probes(s,token,csrf,branches,result,args)
    token=s.signup(dict(name='Synthetic Benchmark',email='owner@example.test',password='fictional-only-123',organization='Synthetic Native Benchmark'))
    state=s.dispatch(token,'GET','/api/me',{}, {})
    org=state['organization']['id'];csrf=state['user']['csrf']
    template=s.dispatch(token,'POST','/api/branches',dict(name='Template',country='Testland',market='Metro',area='Synthetic',timezone='Europe/London',coverage=[dict(start='09:00',end='17:00',role='associate',required=10)]),{},csrf)
    branches=[];target='2026-10-12';start=time.perf_counter();total_docs=0
    for bi in range(args.branches):
        branch=template['id'] if bi==0 else 'b-'+str(bi);branches.append(branch)
        def people(c):
            c.bind_org(org)
            c.entity_put(org,'branch',template|dict(id=branch,name=f'Synthetic Branch {bi}'))
            for ei in range(args.staff):
                c.entity_put(org,'employee',dict(id=f'e-{bi}-{ei}',name=f'Synthetic Employee {bi}/{ei}',branch=branch,skills=['associate'],contract_hours=40,active=True,hourly_rate=None,start_date='1970-01-01',availability={str(i):[dict(start='08:00',end='22:00')] for i in range(7)}))
        s.run(people);total_docs+=s.local.metrics['writes']
        for wi in range(args.weeks):
            week=date.fromisoformat(target)-timedelta(weeks=wi+1)
            shifts=[dict(id=f's-{bi}-{wi}-{ei}-{di}',employee=f'e-{bi}-{ei}',branch=branch,role='associate',start=f'{week+timedelta(days=di)}T08:00:00+00:00',end=f'{week+timedelta(days=di)}T16:00:00+00:00') for ei in range(args.staff) for di in range(5)]
            def snapshot(c):
                c.bind_org(org)
                row=dict(org=org,branch=branch,week=str(week),revision=1,state='published',shifts=json.dumps(shifts),published=json.dumps(shifts))
                c.schedule_put(row);c.reservations_replace(org,branch,str(week),shifts,shifts)
                c.versions_add(dict(org=org,branch=branch,week=str(week),revision=1,actor=state['user']['id'],action='publish',created=time.time(),shifts=json.dumps(shifts)))
            s.run(snapshot);total_docs+=s.local.metrics['writes']
        print(f'seeded {bi+1}/{args.branches} synthetic branches',flush=True)
    result=dict(label=args.label,emulator=True,project=s.guard.project,org=org,branches=args.branches,employees=args.branches*args.staff,weeks=args.weeks,historical_shifts=args.branches*args.staff*5*args.weeks,seed_seconds=round(time.perf_counter()-start,3),seed_document_writes=total_docs,timings={})
    probes(s,token,csrf,branches,result,args)

def probes(s,token,csrf,branches,result,args):
    operations={'owner_bootstrap':('GET','/api/me',{},{}),'selected_empty_analytics':('GET','/api/analytics',{},dict(branch=branches[0],week='2026-10-12')), 'selected_populated_analytics':('GET','/api/analytics',{},dict(branch=branches[0],week='2026-10-05')), 'generation':('POST','/api/generate',dict(branch=branches[0],week='2026-10-12',revision=0),{}), 'all_populated_analytics':('GET','/api/analytics',{},dict(week='2026-10-05'))}
    if args.bootstrap_only:operations={'owner_bootstrap':operations['owner_bootstrap']}
    for name,(method,path,data,query) in operations.items():
        samples=[];metrics=[];hashes=[];freshness=[]
        for _ in range(2):
            begin=time.perf_counter();value=s.dispatch(token,method,path,data,query,csrf)
            samples.append(time.perf_counter()-begin);metrics.append(s.local.metrics)
            freshness.append(value.get('freshness'))
            def canonical(item):
                if isinstance(item,dict):return {k:canonical(v) for k,v in sorted(item.items()) if k!='freshness'}
                if isinstance(item,list):return sorted([canonical(v) for v in item],key=lambda v:json.dumps(v,sort_keys=True))
                return item
            hashes.append(hashlib.sha256(json.dumps(canonical(value),sort_keys=True,separators=(',',':')).encode()).hexdigest() if path=='/api/analytics' else None)
        result['timings'][name]=dict(samples_seconds=[round(v,3) for v in samples],mean_seconds=round(statistics.mean(samples),3),operation_rpc_counts=metrics,canonical_analytics_hashes=hashes,freshness=freshness)
        print(name,result['timings'][name],flush=True)
    from pathlib import Path
    Path('.local/firebase-benchmark-'+args.label+'.json').write_text(json.dumps(result,indent=2)+'\n')

if __name__=='__main__':main()
