"""Disabled-by-default, dependency-injected orphan reconciliation.

The caller must provide authorized repository and provider adapters, and a
specific approval to disable the exact provider identity. No credentials are
discovered, no network is called at import, and identities are never deleted.
"""
import secrets
import time
from core import Problem, require


def reconcile(service, provider, email, expected_uid, *, enabled=False):
    require(enabled is True, 'Reconciliation is disabled.', 503)
    require(getattr(service.guard,'safe_member_jobs',False), 'Unsupported reconciliation scope.',403)
    require(isinstance(email,str) and email==email.strip().lower() and isinstance(expected_uid,str) and expected_uid,
            'Exact identity is required.',422)
    marker=secrets.token_hex(24)
    def claim(c):
        job=c.control_get('provisioning_jobs',email)
        require(job and job.get('uid')==expected_uid and job.get('kind')=='member',
                'Provisioning job does not match.',409)
        require(job.get('state') in ('needs_reconciliation','provider_started','reconciliation_claimed','disable_submitted'),
                'Job is not eligible for reconciliation.',409)
        require(c.identity_get(expected_uid) is None,'A committed profile must not be disabled.',409)
        if job.get('state') in ('reconciliation_claimed','disable_submitted'):return job
        job=job|dict(state='reconciliation_claimed',reconciliation=marker,review_at=time.time())
        c.control_put('provisioning_jobs',email,job)
        return job
    job=service.run(claim)
    try:
        user=provider.user(expected_uid)
    except Problem as error:
        if error.status==401:
            # The provider operation may still be in flight; absence is not a
            # safe proof that the reservation can be released.
            return dict(status='provider_absent_unresolved',released=False)
        raise
    require(user.uid==expected_uid and user.email==email,'Provider identity does not match.',409)
    if not user.disabled:
        def reserve_disable(c):
            current=c.control_get('provisioning_jobs',email)
            require(current and current.get('uid')==expected_uid and current.get('state') in ('reconciliation_claimed','disable_submitted')
                    and current.get('reconciliation')==job.get('reconciliation') and c.identity_get(expected_uid) is None,
                    'Job changed during reconciliation.',409)
            if current['state']=='disable_submitted':return False
            c.control_put('provisioning_jobs',email,current|dict(state='disable_submitted',disable_submitted_at=time.time()))
            return True
        if not service.run(reserve_disable):
            # A prior call may still be in flight. Re-read on a later run; do
            # not issue a duplicate security operation or release capacity.
            return dict(status='disable_outcome_unresolved',released=False)
        provider.disable_user(expected_uid)
        user=provider.user(expected_uid)
    require(user.uid==expected_uid and user.email==email and user.disabled,
            'Provider disable is unconfirmed.',503)
    def finish(c):
        current=c.control_get('provisioning_jobs',email)
        require(current and current.get('uid')==expected_uid and current.get('state') in ('reconciliation_claimed','disable_submitted')
                and current.get('reconciliation')==job.get('reconciliation'), 'Job changed during reconciliation.',409)
        require(c.identity_get(expected_uid) is None,'A committed profile must not be disabled.',409)
        capacity=c.control_get('pilot_member_capacity',current['org'])
        require(capacity and capacity.get('reserved',0)>=2,'Member capacity requires reconciliation.',409)
        c.control_put('pilot_member_capacity',current['org'],dict(reserved=capacity['reserved']-1))
        c.control_put('provisioning_jobs',email,current|dict(state='reconciled_disabled',completed=time.time()))
    service.run(finish)
    return dict(status='reconciled_disabled',released=True)
