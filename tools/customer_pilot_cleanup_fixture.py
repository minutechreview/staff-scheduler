"""Synthetic-only cleanup rehearsal; contains no cloud adapter or credentials."""
from copy import deepcopy

PROJECT='relay-cust-746234651365'
NAMES={'service':'relay-api-customer','site':'relay-cust-746234651365',
       'repository':'relay-customer-images','database':'relay-customers'}

class CleanupError(RuntimeError):pass

class FixtureBackend:
    def __init__(self,run_id,resources,fail_at=None):
        self.run_id=run_id;self.resources=deepcopy(resources);self.fail_at=fail_at
        self.access_enabled=True;self.published=True;self.billing_linked=True;self.calls=[]
    def invoke(self,step):
        self.calls.append(step)
        if step==self.fail_at:raise CleanupError('SYNTHETIC_FAILURE')
        if step=='disable_access':self.access_enabled=False
        elif step=='unpublish':self.published=False
        elif step.startswith('delete_'):self.resources.pop(step[7:],None)
        elif step=='unlink_billing':self.billing_linked=False
        else:raise CleanupError('INVALID_STEP')

def cleanup(backend,plan):
    if type(backend) is not FixtureBackend or not isinstance(plan,dict) or plan.get('synthetic_fixture') is not True:
        raise CleanupError('FIXTURE_ONLY')
    if plan.get('project')!=PROJECT or plan.get('run_id')!=backend.run_id or not backend.run_id:
        raise CleanupError('SCOPE_MISMATCH')
    expected=plan.get('resources',{})
    if set(expected)!=set(NAMES):raise CleanupError('INCOMPLETE_SCOPE')
    # Verify all ownership and exact captured UIDs before the first mutation.
    for kind,name in NAMES.items():
        ref=expected.get(kind,{});actual=backend.resources.get(kind,{})
        if (ref.get('name')!=name or not ref.get('uid') or actual.get('name')!=name or
            actual.get('uid')!=ref['uid'] or actual.get('run_id')!=backend.run_id):
            raise CleanupError('IDENTITY_MISMATCH')
    try:
        for step in ('disable_access','unpublish','delete_service','delete_repository','delete_database','unlink_billing'):
            backend.invoke(step)
    except CleanupError:
        return {'status':'cleanup_unverified','steps':list(backend.calls),'cloud_calls':0}
    verified=(not backend.access_enabled and not backend.published and not backend.billing_linked and
              all(kind not in backend.resources for kind in ('service','repository','database')))
    # This rehearsal deliberately retains the site and does not model the
    # project, IAM, identities, or provider settings. It is not full cleanup.
    return {'status':'fixture_scope_clean' if verified else 'cleanup_unverified','steps':list(backend.calls),'cloud_calls':0}
