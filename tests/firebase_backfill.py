"""One-time reservation-index backfill for the synthetic benchmark tenant only.

Preserves all groups, schedules and history. This is not a production migration.
"""
import json
from collections import defaultdict
from pathlib import Path
from firebase_contract import FirebaseService
from firebase_repository import key

def main():
    target=json.loads(Path('.local/firebase-benchmark-target.json').read_text())
    s=FirebaseService();org=target['org']
    ref=s.client.collection('organizations').document(key(org))
    assert ref.get().to_dict()['name']=='Synthetic Native Benchmark'
    assert target['email'].startswith('benchmark-') and target['email'].endswith('@example.test')
    groups=defaultdict(list)
    for snap in ref.collection('reservations').stream():groups[snap.to_dict()['employee']].append(snap.reference)
    employees=sorted(groups)
    for offset in range(0,len(employees),150):
        chunk=employees[offset:offset+150]
        def update(c):
            c.bind_org(org)
            manifest_refs=[c._collection(org,'reservation_manifests').document(key(e)) for e in chunk]
            current=c.get_many(manifest_refs)
            c.fence(org,set(chunk))
            for employee,manifest,mref in zip(chunk,current,manifest_refs):
                if manifest is not None:continue
                rows=c.get_many(groups[employee])
                assert all(rows)
                c.stage(mref,dict(employee=employee,groups=[dict(id=key(r['branch'],r['week'],employee),start=r['start'],end=r['end']) for r in rows]))
        s.run(update)
        print(f'indexed {min(offset+150,len(employees))}/{len(employees)} synthetic employees',flush=True)

if __name__=='__main__':main()
