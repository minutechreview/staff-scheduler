"""Disabled operational planning for synthetic fixtures; never accesses cloud.

This tool intentionally cannot mutate records or act on live snapshots. The
provider and datastore require separate, authorized action-time procedures.
"""
import argparse
import json
from pathlib import Path

TTL_COLLECTIONS={'signup_intents','recovery_delivery','auth_counters'}

def plan(fixture):
    if not isinstance(fixture,dict) or fixture.get('synthetic_fixture') is not True:
        raise ValueError('Only an explicitly synthetic local fixture is supported.')
    jobs=fixture.get('jobs',[]);docs=fixture.get('expired_documents',[])
    if not isinstance(jobs,list) or not isinstance(docs,list) or len(jobs)>1000 or len(docs)>1000:
        raise ValueError('Fixture exceeds the bounded planning limit.')
    counts={'committed_preserve':0,'cancelled_no_provider':0,'provider_reconciliation_required':0,
            'unknown_preserve':0,'ttl_eligible':0,'ttl_excluded':0}
    for job in jobs:
        if not isinstance(job,dict):raise ValueError('Invalid fixture job.')
        state=job.get('state')
        if state=='committed':counts['committed_preserve']+=1
        elif state=='cancelled_before_provider':counts['cancelled_no_provider']+=1
        elif state in ('provider_started','needs_reconciliation','checking'):counts['provider_reconciliation_required']+=1
        else:counts['unknown_preserve']+=1
    for doc in docs:
        if not isinstance(doc,dict):raise ValueError('Invalid fixture document.')
        if doc.get('collection') in TTL_COLLECTIONS and doc.get('expired') is True and not doc.get('legal_hold',False):counts['ttl_eligible']+=1
        else:counts['ttl_excluded']+=1
    return dict(mode='synthetic-plan-only',changes=0,provider_calls=0,counts=counts,
        warning='No automatic deletion or capacity release is performed; verify authorization and provider state before any live operation.')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--synthetic-fixture',type=Path,required=True)
    args=parser.parse_args()
    raw=args.synthetic_fixture.read_bytes()
    if len(raw)>250_000:raise SystemExit('Fixture exceeds size limit.')
    print(json.dumps(plan(json.loads(raw)),sort_keys=True))
if __name__=='__main__':main()
