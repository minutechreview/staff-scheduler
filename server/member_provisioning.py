"""Customer-only provision state machine; provider calls are not transactional.

No deletion of provider identities is automatic. An uncertain call retains its
reservation for a disabled operator reconciliation tool.
"""
import hashlib
import json
import secrets
import time
from core import Problem, require, uid


def prepare(service,actor,data,authorize):
    email,password,name=service.credentials(data)
    payload={key:value for key,value in data.items() if key!='password'}
    fingerprint=hashlib.sha256(json.dumps(dict(actor=actor['id'],org=actor['org'],data=payload),sort_keys=True).encode()).hexdigest()
    lease=secrets.token_hex(24)
    def reserve(c):
        authorize(c)
        previous=c.control_get('provisioning_jobs',email)
        require(previous is None or previous.get('state')=='cancelled_before_provider',
                'Account provisioning requires reconciliation.',409)
        capacity=c.control_get('pilot_member_capacity',actor['org']) or dict(reserved=1)
        require(capacity['reserved']<service.guard.max_members,'Member capacity is full.',409)
        c.control_put('pilot_member_capacity',actor['org'],dict(reserved=capacity['reserved']+1))
        job=dict(uid=uid(),kind='member',fingerprint=fingerprint,state='checking',lease=lease,
                 org=actor['org'],actor=actor['id'],created=time.time())
        c.control_put('provisioning_jobs',email,job)
        return job
    job=service.run(reserve)
    def start(c):
        authorize(c)
        current=c.control_get('provisioning_jobs',email)
        require(current and current.get('lease')==lease and current.get('state')=='checking',
                'Account provisioning requires reconciliation.',409)
        c.control_put('provisioning_jobs',email,current|dict(state='provider_started',provider_started_at=time.time()))
    try:
        service.run(start)
    except Exception:
        # Release only an exclusive claim proven not to have started a provider
        # call. Concurrent workers cannot acquire the same claim.
        def compensate(c):
            current=c.control_get('provisioning_jobs',email)
            if not current or current.get('lease')!=lease or current.get('state')!='checking':return
            capacity=c.control_get('pilot_member_capacity',actor['org'])
            require(capacity and capacity.get('reserved',0)>=2,'Member capacity requires reconciliation.',409)
            require(c.identity_get(job['uid']) is None,'Identity requires reconciliation.',409)
            c.control_put('pilot_member_capacity',actor['org'],dict(reserved=capacity['reserved']-1))
            c.control_put('provisioning_jobs',email,current|dict(state='cancelled_before_provider',cancelled_at=time.time()))
        service.run(compensate)
        raise
    try:
        return service.ensure_reserved_identity(job,email,password,name)
    except Exception:
        mark_for_review(service,email,job['uid'])
        raise


def mark_for_review(service,email,expected_uid):
    def mark(c):
        job=c.control_get('provisioning_jobs',email)
        if not job or job.get('uid')!=expected_uid or job.get('kind')!='member':return
        # A completed membership may have committed despite a lost response.
        if job.get('state')=='committed':return
        if job.get('state')=='provider_started':
            c.control_put('provisioning_jobs',email,job|dict(state='needs_reconciliation',review_at=time.time()))
    service.run(mark)
