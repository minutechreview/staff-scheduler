"""Customer SDK factory. Imported only after explicit customer activation."""
import re
import time
from google.cloud import firestore
from core import Problem, require
from firebase_live import LiveFirebaseIdentity, WorkloadCredentials
from firebase_service import FirebaseService
from customer_config import CustomerConfig
from identity_lifecycle import digest
from acceptance_invite import check as check_invite

PUBLIC_PATHS={'/api/capabilities','/api/signup','/api/signin','/api/recovery/request',
              '/api/recovery/complete','/api/auth/action/check','/api/auth/action/complete'}

class CustomerFirebaseService(FirebaseService):
    identity_email_error = 'Enter a valid email address.'
    def set_request_actor(self,path,data,token):
        if token and path not in PUBLIC_PATHS:
            actor='session/'+digest(token)
        else:
            value=data.get('email') if path in ('/api/signin','/api/signup','/api/recovery/request') else data.get('code')
            if not isinstance(value,str):value='invalid-input'
            actor=('email/' if path in ('/api/signin','/api/signup','/api/recovery/request') else 'code/')+digest(value.strip().lower() if 'email' in data else value)
        self.local.request_actor=actor

    def admit_request(self,path,token):
        if not getattr(self.guard,'per_actor_limits',False): return super().admit_request(path,token)
        if getattr(self.guard,'requires_invite',False):
            require(time.time()<self.guard.invite_expires,'Service is temporarily unavailable.',503)
        def enabled(c):
            control=c.control_get('pilot_controls','global') or {}
            require(control.get('enabled',False),'Service is temporarily unavailable.',503)
        self.run(enabled)
        if token and path not in PUBLIC_PATHS:
            # Invalid cookies must not allocate durable counter documents.
            self.preflight(token)
            self.consume_limits([('api/session/'+digest(token),90,60)])

    def consume_limits(self,names):
        if getattr(self.guard,'per_actor_limits',False):
            actor=getattr(self.local,'request_actor',None)
            require(actor is not None,'Request context is unavailable.',503)
            shared={'signup/global','recovery/global','recovery/complete','email/action/check','email/action/verify','client/staging-global'}
            names=[(name+'/actor/'+actor if name in shared else name,limit,window) for name,limit,window in names]
        return super().consume_limits(names)

    def signup(self,data):
        check_invite(self.guard,data)
        try:
            result=super().signup(data)
        except Problem as error:
            if not getattr(self.guard,'per_actor_limits',False) or error.status not in (401,409):raise
            if getattr(self.guard,'require_mailbox_password_setup',False):
                # Never disclose whether an address was already reserved. A
                # mailbox holder can reclaim access through the normal reset flow.
                email=data.get('email','')
                if isinstance(email,str):
                    email=email.strip().lower()
                    def mark_reclaim(c):
                        job=c.control_get('provisioning_jobs',email)
                        if (job and job.get('kind')=='signup' and c.identity_get(job['uid']) is None
                                and not c.security(job['uid']).get('blocked',False)):
                            c.control_put('provisioning_jobs',email,job|dict(reclaim_requested=True))
                    try:self.run(mark_reclaim)
                    except Problem:pass
                try:self.request_recovery(dict(email=email))
                except Problem:pass
            result={}
        if getattr(self.guard,'per_actor_limits',False):
            return dict(verification_required=True,message='If eligible, check your email for verification instructions.')
        return result

    def request_recovery(self,data):
        check_invite(self.guard,data)
        return super().request_recovery(data)

    def bind_acceptance_delivery_limits(self):
        """Reserve the one allowed call per purpose before any provider request."""
        if not getattr(self.guard,'requires_invite',False):return
        verification=self.identity.verification
        recovery=self.identity.reset_delivery
        def reserve(kind,email):
            import time
            require(getattr(self.guard,'delivery',True),'Delivery is unavailable.',503)
            require(self.identity_email_allowed(email) and time.time()<self.guard.invite_expires,
                    'Delivery is unavailable.',503)
            def claim(c):
                row=c.control_get('acceptance_delivery',self.guard.invite_hash) or {}
                require(not row.get(kind),'Delivery limit reached.',429)
                c.control_put('acceptance_delivery',self.guard.invite_hash,row|{kind:True})
            self.run(claim)
        def verify_once(id_token,email):
            reserve('verify',email)
            return verification(id_token,email)
        def reset_once(email):
            reserve('reset',email)
            return recovery(email)
        self.identity.verification=verify_once
        self.identity.reset_delivery=reset_once
    def identity_email_allowed(self,email):
        self.guard.assert_current()
        permitted=getattr(self.guard,'allowed_email',None)
        if permitted is not None and email!=permitted: return False
        if not isinstance(email,str) or len(email)>254 or email!=email.lower(): return False
        if not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?",email): return False
        domain=email.rsplit('@',1)[1]
        labels=domain.split('.')
        return (len(labels)>1 and all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',x) for x in labels)
                and labels[-1] not in ('test','example','invalid','localhost') and not any(x=='' for x in labels))

    def signin(self,data,client='local'):
        check_invite(self.guard,data)
        email=data.get('email','')
        require(isinstance(email,str) and self.identity_email_allowed(email.strip().lower()),'Invalid credentials.',401)
        return super().signin(data,client)

    def preflight(self,token):
        if getattr(self.guard,'requires_invite',False):
            require(time.time()<self.guard.invite_expires,'Sign in to continue.',401)
        user=super().preflight(token)
        require(self.identity_email_allowed(user.email),'Sign in to continue.',401)
        return user

def create_guarded_customer_service(guard):
    guard.assert_current()
    credential=WorkloadCredentials()
    identity=LiveFirebaseIdentity(guard,credential)
    client=firestore.Client(project=guard.project,database=guard.database,credentials=credential.get_credential())
    require(client._database==guard.database and client.project==guard.project,'Database identity mismatch.',503)
    require(client._firestore_api.transport._host in ('firestore.googleapis.com','firestore.googleapis.com:443'),
            'Firestore must use its official TLS transport.',503)
    service=CustomerFirebaseService(guard=guard,identity=identity,client=client)
    service.bind_acceptance_delivery_limits()
    identity.request_deadline=lambda:getattr(service.local,'deadline',None)
    return service

def create_customer_service():
    return create_guarded_customer_service(CustomerConfig.from_environment())
