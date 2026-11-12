"""Native Firestore unit of work: tenant documents, staged writes and employee fences.

Only imported by the explicit guarded emulator adapter. No SQLite snapshot bridge.
"""
import hashlib
import json
import time
from datetime import datetime, timezone
from copy import deepcopy
from collections import defaultdict
from google.cloud.firestore_v1.base_query import FieldFilter
from core import Problem,require,stamp


def key(*parts): return hashlib.sha256(json.dumps(parts,separators=(',',':')).encode()).hexdigest()
def collection_path(col): return (col.parent.path+'/' if col.parent else '')+col.id
def json_value(item):
    if isinstance(item,datetime): return item.isoformat()
    raise TypeError('Unsupported document value')


def equal(row,filters):
    return all(row.get(field)==value if op=='==' else row.get(field) in value for field,op,value in filters)


class FirestoreRepository:
    MAX_WRITES=400
    MAX_DOCUMENT_BYTES=900_000
    MAX_STAGED_BYTES=6_000_000
    ANALYTICS_SHARDS=64

    def __init__(self,client,transaction,guard,deadline=None):
        self.client,self.transaction,self.guard=client,transaction,guard
        self.deadline=deadline
        self.org=None
        self.reads={}
        self.queries={}
        self.staged={}
        self.fenced=set()
        self.ledger_preloaded={}
        self.after_commit=[]
        self.metrics=dict(document_reads=0,query_documents=0,empty_queries=0,queries=0,writes=0,query_seconds=0.0,batch_gets=0,analytics_revision_writes=0)

    def begin(self): pass  # The SDK transaction runner begins/retries the complete operation.
    def bind_org(self,org):
        require(self.org in (None,org),'Cross-tenant repository context is forbidden.',403)
        self.org=org
    def _org(self,org):
        require(self.org==org,'Repository access requires a trusted matching tenant.',403)
        return self.client.collection('organizations').document(key(org))
    def _collection(self,org,name): return self._org(org).collection(name)
    def get(self,ref):
        self.guard.assert_current()
        if ref.path in self.staged: return deepcopy(self.staged[ref.path][1])
        if ref.path not in self.reads:
            self.metrics['document_reads']+=1
            self.check_read_budget()
            snap=ref.get(transaction=self.transaction,**self.rpc_options())
            self.reads[ref.path]=snap.to_dict() if snap.exists else None
        value=self.reads[ref.path]
        return deepcopy(value)
    def stage(self,ref,value,immutable=False):
        self.guard.assert_current()
        if value is not None:
            require(len(json.dumps(value,allow_nan=False,separators=(',',':'),default=json_value).encode())<self.MAX_DOCUMENT_BYTES,'Document exceeds the bounded Firestore adapter size. Split this operation.',413)
        previous=self.get(ref)
        if previous==value:return
        require(not immutable or previous is None,'Immutable history cannot be overwritten.',409)
        self.staged[ref.path]=(ref,deepcopy(value),immutable)
    def get_many(self,refs):
        self.guard.assert_current()
        missing={ref.path:ref for ref in refs if ref.path not in self.reads and ref.path not in self.staged}
        values=list(missing.values())
        for offset in range(0,len(values),250):
            self.metrics['batch_gets']+=1
            self.metrics['document_reads']+=len(values[offset:offset+250])
            self.check_read_budget()
            for snap in self.client.get_all(values[offset:offset+250],transaction=self.transaction,**self.rpc_options()):
                self.reads[snap.reference.path]=snap.to_dict() if snap.exists else None
        return [self.get(ref) for ref in refs]
    def query(self,col,filters=()):
        self.guard.assert_current()
        colpath=collection_path(col)
        token=(colpath,json.dumps(filters,sort_keys=True))
        if token not in self.queries:
            broad=self.queries.get((colpath,'[]'))
            if broad is not None:
                docs={p:r for p,r in broad.items() if equal(r,filters)}
            else:
                self.metrics['queries']+=1
                begin=time.perf_counter()
                query=col
                for field,op,value in filters:query=query.where(filter=FieldFilter(field,op,value))
                bound=getattr(self.guard,'max_query_documents',None)
                if bound is not None:
                    # Fetch an overflow sentinel, then abort. Never return a
                    # sampled report or issue an unbounded production query.
                    query=query.limit(max(1,bound-self.metrics['query_documents']+1))
                docs={}
                for snap in query.stream(transaction=self.transaction,**self.rpc_options()):
                    row=snap.to_dict();docs[snap.reference.path]=row;self.reads[snap.reference.path]=row
                    self.metrics['query_documents']+=1
                    self.check_read_budget()
                if not docs:self.metrics['empty_queries']+=1
                self.check_read_budget()
                self.metrics['query_seconds']+=time.perf_counter()-begin
            self.queries[token]=docs
        docs=dict(self.queries[token])
        for path,(ref,value,_) in self.staged.items():
            if collection_path(ref.parent)==colpath:
                if value is not None and equal(value,filters):docs[path]=value
                else:docs.pop(path,None)
        return deepcopy(list(docs.values()))
    def check_read_budget(self):
        self.rpc_options()
        require(self.metrics['document_reads']+self.metrics['query_documents']+self.metrics['empty_queries']<=getattr(self.guard,'max_reads',100000),
                'Operation exceeds the document-read budget. Narrow the scope.',413)
        require(self.metrics['query_documents']<=getattr(self.guard,'max_query_documents',100000),
                'Operation exceeds the query budget. Narrow the scope.',413)
    def rpc_options(self):
        if self.deadline is None:return {}
        remaining=self.deadline-time.monotonic()
        require(remaining>0,'The request deadline was reached. Refresh saved state before retrying.',503)
        return dict(timeout=min(15,remaining),retry=None)
    def flush(self):
        self.guard.assert_current()
        self.rpc_options()
        require(len(self.staged)<=self.MAX_WRITES,'Operation exceeds the bounded Firestore transaction write budget.',413)
        require(sum(len(json.dumps(v,allow_nan=False,default=json_value).encode()) for _,v,_ in self.staged.values() if v is not None)<self.MAX_STAGED_BYTES,'Operation exceeds the Firestore request byte budget.',413)
        self.metrics['writes']=len(self.staged)
        # Crucial: all reads and validation happened before the first SDK write.
        for ref,value,immutable in self.staged.values():
            if value is None:self.transaction.delete(ref)
            elif immutable:self.transaction.create(ref,value)
            else:self.transaction.set(ref,value)

    def org_get(self,org):
        row=self.get(self._org(org))
        return row | dict(settings=json.dumps(row['settings'])) if row else None
    def org_add(self,org,name,settings):
        self.bind_org(org)
        self.stage(self._org(org),dict(id=org,name=name,settings=settings,policy_revision=0,hierarchy_revision=0),immutable=True)
        if getattr(self.guard,'workspace_trial_required',False):
            from workspace_trial import new_trial
            self.stage(self._collection(org,'entitlements').document('trial'),
                       new_trial(org,datetime.now(timezone.utc)),immutable=True)
    def trial_get(self,org):
        return self.get(self._collection(org,'entitlements').document('trial'))
    def _org_fence(self,org,field):
        token=(org,field)
        if token not in self.fenced:
            ref=self._org(org);row=self.get(ref);require(row is not None,'Organization not found.',404)
            self.stage(ref,row | {field:row.get(field,0)+1});self.fenced.add(token)
    def fence_policy(self,org): self._org_fence(org,'policy_revision')
    def analytics_revisions(self,org):
        rows=self.get_many([self._collection(org,'analytics_revisions').document(str(i)) for i in range(self.ANALYTICS_SHARDS)])
        return tuple(row['revision'] if row else 0 for row in rows)
    def touch_analytics(self,org,kind,ident):
        shard=int(key(kind,ident),16)%self.ANALYTICS_SHARDS
        token=(org,'analytics_revision',shard)
        if token in self.fenced:return
        ref=self._collection(org,'analytics_revisions').document(str(shard))
        row=self.get(ref) or dict(revision=0)
        self.stage(ref,dict(revision=row['revision']+1))
        self.fenced.add(token);self.metrics['analytics_revision_writes']+=1
    def fence(self,org,employees):
        for employee in sorted(employees):
            token=(org,'employee',employee)
            if token in self.fenced:continue
            ref=self._collection(org,'employee_fences').document(key(employee))
            row=self.get(ref) or dict(employee=employee,revision=0)
            self.stage(ref,row | dict(revision=row['revision']+1));self.fenced.add(token)
    def entity_rows(self,org,kind): return self.query(self._collection(org,'entities_'+kind))
    def entity_get(self,org,kind,ident):return self.get(self._collection(org,'entities_'+kind).document(key(ident)))
    def entity_put(self,org,kind,data):
        ref=self._collection(org,'entities_'+kind).document(key(data['id']))
        if self.get(ref)==data:return
        self.touch_analytics(org,kind,data['id'])
        if kind in ('country','market','area','branch'):self._org_fence(org,'hierarchy_revision')
        self.stage(ref,data)
    def audit_add(self,actor,action,entity,created):
        self.stage(self._collection(actor['org'],'audit').document(),dict(actor=actor['id'],action=action,entity=entity,created=created),immutable=True)

    def _pack(self,org,shifts):
        chunks=[]
        for offset in range(0,len(shifts),200):
            payload=shifts[offset:offset+200];ident=key(payload);ref=self._collection(org,'snapshots').document(ident)
            self.stage(ref,dict(shifts=payload),immutable=True);chunks.append(ident)
        return chunks
    def _unpack(self,org,chunks):
        result=[]
        for ident in chunks:
            row=self.get(self._collection(org,'snapshots').document(ident))
            require(row is not None,'Published snapshot is unavailable. No partial schedule will be shown.',503)
            result.extend(row['shifts'])
        return result
    def _schedule_dto(self,org,row):
        return {k:v for k,v in row.items() if k not in ('draft_chunks','published_chunks')} | dict(shifts=json.dumps(self._unpack(org,row['draft_chunks'])),published=json.dumps(self._unpack(org,row['published_chunks'])))
    def schedule_get(self,org,branch,week):
        row=self.get(self._collection(org,'schedules').document(key(branch,week)))
        return self._schedule_dto(org,row) if row else None
    def schedule_rows(self,org):return [self._schedule_dto(org,r) for r in self.query(self._collection(org,'schedules'))]
    def schedule_exists(self,org,branch=None):
        return bool(self.query(self._collection(org,'schedules'),(('branch','==',branch),) if branch else ()))
    def schedule_put(self,row):
        org=row['org'];native={k:v for k,v in row.items() if k not in ('shifts','published')}
        native.update(draft_chunks=self._pack(org,json.loads(row['shifts'])),published_chunks=self._pack(org,json.loads(row['published'])))
        self.touch_analytics(org,'schedule',key(row['branch'],row['week']))
        self.stage(self._collection(org,'schedules').document(key(row['branch'],row['week'])),native)
    def versions_add(self,row):
        org=row['org'];native={k:v for k,v in row.items() if k!='shifts'};native['chunks']=self._pack(org,json.loads(row['shifts']))
        self.stage(self._collection(org,'versions').document(key(row['branch'],row['week'],row['revision'])),native,immutable=True)
    def versions_rows(self,org,branch,week):
        rows=self.query(self._collection(org,'versions'),(('branch','==',branch),('week','==',week)))
        return [{k:v for k,v in r.items() if k not in ('chunks','org','branch','week')} | dict(shifts=json.dumps(self._unpack(org,r['chunks']))) for r in sorted(rows,key=lambda r:-r['revision'])]
    def reservations_replace(self,org,branch,week,draft,published):
        col=self._collection(org,'reservations');old=self.query(col,(('branch','==',branch),('week','==',week)));groups=defaultdict(dict)
        for shift in draft+published:groups[shift['employee']][(shift['start'],shift['end'],shift['role'])]=shift
        for row in old:
            if row['employee'] not in groups:self.stage(col.document(key(branch,week,row['employee'])),None)
        for employee,values in groups.items():
            shifts=list(values.values())
            self.stage(col.document(key(branch,week,employee)),dict(branch=branch,week=week,employee=employee,shifts=shifts,start=min(s['start'] for s in shifts),end=max(s['end'] for s in shifts)))
        for employee in sorted(set(groups)|{r['employee'] for r in old}):
            self.fence(org,{employee})
            ref=self._collection(org,'reservation_manifests').document(key(employee))
            manifest=self.get(ref)
            # Backfill only this employee when first touching an older synthetic
            # adapter dataset. No original deployment/data is consulted.
            prior=manifest['groups'] if manifest else [dict(id=key(r['branch'],r['week'],employee),start=r['start'],end=r['end']) for r in self.query(col,(('employee','==',employee),))]
            ident=key(branch,week,employee)
            next_groups=[r for r in prior if r['id']!=ident]
            if employee in groups:
                row=self.get(col.document(ident));next_groups.append(dict(id=ident,start=row['start'],end=row['end']))
            require(len(next_groups)<=10000,'Employee reservation history exceeds the bounded manifest budget.',413)
            self.stage(ref,dict(employee=employee,groups=sorted(next_groups,key=lambda r:r['id'])))
    def reservations_rows(self,org,exclude=None,employees=None,windows=None):
        col=self._collection(org,'reservations')
        if employees is None:rows=self.query(col)
        else:
            values=sorted(employees);rows=[]
            manifests=self.get_many([self._collection(org,'reservation_manifests').document(key(e)) for e in values])
            indexed=[]
            for employee,manifest in zip(values,manifests):
                if manifest is None:continue
                window=(windows or {}).get(employee)
                for group in manifest['groups']:
                    if exclude and group['id']==key(*exclude,employee):continue
                    if windows is not None and (window is None or stamp(group['start'])>=stamp(window['end']) or stamp(group['end'])<=stamp(window['start'])):continue
                    indexed.append(group)
            docs=self.get_many([col.document(g['id']) for g in indexed])
            require(all(r is not None for r in docs),'Reservation index is incomplete. No partial schedule can be validated.',503)
            rows.extend(docs)
            legacy=[e for e,m in zip(values,manifests) if m is None]
            for offset in range(0,len(legacy),30):rows.extend(self.query(col,(('employee','in',legacy[offset:offset+30]),)))
        result=[s for r in rows if not exclude or (r['branch'],r['week'])!=tuple(exclude) for s in r['shifts']]
        if windows is not None:result=[s for s in result if s['employee'] in windows and stamp(s['start'])<stamp(windows[s['employee']]['end']) and stamp(s['end'])>stamp(windows[s['employee']]['start'])]
        return result

    def policy_rows(self,org):
        return [r | dict(policy=json.dumps(r['policy'])) for r in sorted(self.query(self._collection(org,'policies')),key=lambda r:r['effective'])]
    def policy_delete_baseline(self,org):
        for row in self.policy_rows(org):
            if row['revision']==0:self.stage(self._collection(org,'policies').document(key(row['effective'])),None)
    def policy_add(self,row):
        ref=self._collection(row['org'],'policies').document(key(row['effective']))
        original=self.reads.get(ref.path)
        replacing_baseline=(original is not None and original['revision']==0 and ref.path in self.staged and self.staged[ref.path][1] is None)
        # Domain policy initialization may replace only a deliberately deleted
        # revision-zero baseline before commitments exist. A Firestore create
        # precondition cannot implement SQLite's delete/insert on the same key.
        self.stage(ref,row | dict(policy=json.loads(row['policy'])),immutable=not replacing_baseline)
    def ledger_rows(self,org,employee,start=None,end=None,non_credit=False):
        col=self._collection(org,'ledger')
        if employee in self.ledger_preloaded:
            values={key(r['employee'],r['source']):r for r in self.ledger_preloaded[employee]}
            for ref,row,_ in self.staged.values():
                if collection_path(ref.parent)==collection_path(col) and row is not None and row['employee']==employee:values[ref.id]=row
            rows=list(values.values())
        else:rows=self.query(col,(('employee','==',employee),))
        return sorted([r for r in rows if (start is None or str(start)<=r['effective']<str(end)) and (not non_credit or r['kind'] not in ('accrual','carryover'))],key=lambda r:(r['effective'],r['created'],r['id']))
    def preload_ledger(self,org,employees,all_tenant=False):
        col=self._collection(org,'ledger');values=sorted(set(employees));rows=[]
        if all_tenant:rows=self.query(col)
        else:
            for offset in range(0,len(values),30):rows.extend(self.query(col,(('employee','in',values[offset:offset+30]),)))
        for employee in values:self.ledger_preloaded[employee]=[r for r in rows if r['employee']==employee]
    def ledger_source(self,org,employee,source):return self.get(self._collection(org,'ledger').document(key(employee,source)))
    def ledger_add(self,row):self.stage(self._collection(row['org'],'ledger').document(key(row['employee'],row['source'])),row,immutable=True)
    def ledger_exists(self,org,employee=None):return bool(self.query(self._collection(org,'ledger'),(('employee','==',employee),) if employee else ()))
    def ledger_employees(self,org):return sorted({r['employee'] for r in self.query(self._collection(org,'ledger'))})

    def identity_get(self,user):return self.get(self.client.collection('identities').document(key(user)))
    def identity_put(self,row):self.stage(self.client.collection('identities').document(key(row['id'])),row,immutable=True)
    def member_get(self,org,user):
        row=self.get(self._collection(org,'members').document(key(user)))
        return row | dict(branches=json.dumps(row['branches']),areas=json.dumps(row['areas'])) if row else None
    def member_rows(self,org):
        rows=self.query(self._collection(org,'members'));result=[]
        for row in rows:
            profile=self.identity_get(row['user']);require(profile is not None,'Membership profile is missing.',503)
            result.append(dict(id=row['user'],name=profile['name'],email=profile['email'],role=row['role'],branches=json.dumps(row['branches']),areas=json.dumps(row['areas']),employee=row['employee'],enabled=row['enabled']))
        return result
    def member_employee_exists(self,org,employee,exclude=None):
        return any(r['user']!=exclude for r in self.query(self._collection(org,'members'),(('employee','==',employee),)))
    def member_add(self,org,user,role,branches,areas,employee):
        self.stage(self._collection(org,'members').document(key(user)),dict(org=org,user=user,role=role,branches=branches,areas=areas,employee=employee,enabled=1),immutable=True)
    def member_update(self,row):
        native=row | dict(branches=json.loads(row['branches']),areas=json.loads(row['areas']))
        self.stage(self._collection(row['org'],'members').document(key(row['user'])),native)
    def session_get(self,token):return self.get(self.client.collection('sessions').document(token))
    def session_add(self,row):self.stage(self.client.collection('sessions').document(row['token']),row,immutable=True)
    def sessions_rows(self,user,now):return sorted([r for r in self.query(self.client.collection('sessions'),(('user','==',user),)) if r['expires']>now],key=lambda r:-r['created'])
    def session_id(self,ident):
        rows=self.query(self.client.collection('sessions'),(('id','==',ident),));return rows[0] if rows else None
    def session_delete_id(self,ident):
        row=self.session_id(ident)
        if row:self.session_delete_token(row['token'])
    def session_delete_token(self,token):self.stage(self.client.collection('sessions').document(token),None)
    def session_delete_user(self,user,except_id=None):
        for row in self.query(self.client.collection('sessions'),(('user','==',user),)):
            if row['id']!=except_id:self.session_delete_token(row['token'])
    def intent_get(self,user):return self.get(self.client.collection('signup_intents').document(key(user)))
    def intent_add(self,user,row):self.stage(self.client.collection('signup_intents').document(key(user)),row,immutable=True)
    def intent_replace(self,user,row):self.stage(self.client.collection('signup_intents').document(key(user)),row)
    def intent_delete(self,user):self.stage(self.client.collection('signup_intents').document(key(user)),None)
    def counter(self,name):return self.get(self.client.collection('auth_counters').document(key(name))) or dict(attempts=[])
    def counter_put(self,name,row):self.stage(self.client.collection('auth_counters').document(key(name)),row)
    def control_get(self,collection,ident):return self.get(self.client.collection(collection).document(key(ident)))
    def control_put(self,collection,ident,row):self.stage(self.client.collection(collection).document(key(ident)),row)
    def security(self,user):return self.control_get('credential_epochs',user) or dict(epoch=0,blocked=False)
    def security_put(self,user,row):self.control_put('credential_epochs',user,row)
