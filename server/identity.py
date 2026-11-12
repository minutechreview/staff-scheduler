from repository import repo
"""Provider-neutral local account/session controls; no email or external grants."""
import hashlib
import hmac
import json
import secrets
import time
from core import Problem,require,ROLES


def session_key(token):
    return hashlib.sha256((token or '').encode()).hexdigest()


def sessions(c,actor,token):
    return [dict(id=r['id'],created=r['created'],last_seen=r['last_seen'],expires=r['expires'],current=r['token']==session_key(token)) for r in repo(c).sessions_rows(actor['id'],time.time())]


def revoke(service,c,actor,data):
    if data.get('all_others') is True:
        repo(c).session_delete_user(actor['id'],actor['session_id'])
    else:
        row=repo(c).session_id(data.get('id'))
        require(row is not None and row['user']==actor['id'],'This session is outside your account.',403)
        repo(c).session_delete_id(data['id'])
    service.audit(c,actor,'sessions.revoke',actor['id'])
    return dict(revoked=True)


def password_change(service,token,data,csrf):
    # Failed verification must commit its security counter, then return an error.
    # Keep this transaction separate from domain mutations; no failed business write commits.
    failure=None
    with service.connect() as c:
        c.execute('BEGIN IMMEDIATE')
        actor=service.actor(c,token)
        require(isinstance(csrf,str) and hmac.compare_digest(csrf,actor['csrf']),'Refresh your session before making changes.',403)
        now=time.time()
        key=session_key('password-change/'+actor['id'])
        c.execute('DELETE FROM login_attempts WHERE created<?',(now-600,))
        require(c.execute('SELECT COUNT(*) FROM login_attempts WHERE key=?',(key,)).fetchone()[0]<8,'Too many attempts. Try again in ten minutes.',429)
        row=c.execute('SELECT * FROM users WHERE id=?',(actor['id'],)).fetchone()
        current=data.get('current_password','')
        if not (isinstance(current,str) and len(current)<=128 and hmac.compare_digest(service.password(current,row['salt']),row['password'])):
            c.execute('INSERT INTO login_attempts VALUES(?,?)',(key,now))
            failure=Problem('Current password is incorrect.',401)
        else:
            password=data.get('password','')
            require(isinstance(password,str) and 12<=len(password)<=128,'Use a password of 12–128 characters.')
            require(password!=current,'Choose a different password.')
            salt=secrets.token_hex(16)
            c.execute('UPDATE users SET salt=?,password=? WHERE id=?',(salt,service.password(password,salt),actor['id']))
            c.execute('DELETE FROM sessions WHERE user=?',(actor['id'],))
            c.execute('DELETE FROM login_attempts WHERE key=?',(key,))
            service.audit(c,actor,'password.change',actor['id'])
    if failure:
        raise failure
    return dict(changed=True,signed_out=True)


def member_update(service,c,actor,data):
    service.admin(actor)
    row=repo(c).member_get(actor['org'],data.get('id'))
    require(row is not None,'Member not found.',404)
    require(row['role']!='owner','Owner membership cannot be disabled or demoted.',403)
    role=data.get('role',row['role'])
    require(role in ROLES-{'owner'},'Choose a valid role.')
    require(actor['role']=='owner' or (row['role']!='admin' and role!='admin'),'Only the owner can manage administrators.',403)
    branches=data.get('branches',json.loads(row['branches']))
    areas=data.get('areas',json.loads(row['areas']))
    require(isinstance(branches,list) and isinstance(areas,list),'Specify branch/area assignments.')
    require(set(branches)<=service.scope(c,actor),'Branches must belong to this organization.',403)
    require(role=='area_manager' or not areas,'Only area managers may have area assignments.')
    for area in areas:
        service.entity(c,actor['org'],'area',area)
    require(role not in ('branch_manager','employee') or len(set(branches))==1,'This role requires exactly one branch.')
    require(role!='area_manager' or branches or areas,'Assign at least one area or branch.')
    employee=data.get('employee',row['employee']) if role=='employee' else None
    if employee:
        e=service.entity(c,actor['org'],'employee',employee)
        require(e['branch'] in branches,'Employee must belong to the assigned branch.')
        require(not repo(c).member_employee_exists(actor['org'],employee,row['user']),'Employee already has an account.',409)
    require(role!='employee' or employee,'Employee membership needs an employee record.')
    enabled=data.get('enabled',bool(row['enabled']))
    require(type(enabled) is bool,'Enabled must be true or false.')
    repo(c).fence(actor['org'],{employee} if employee else set())
    repo(c).member_update(dict(role=role,branches=json.dumps(sorted(set(branches))),areas=json.dumps(sorted(set(areas))),employee=employee,enabled=int(enabled),org=actor['org'],user=row['user']))
    repo(c).session_delete_user(row['user'])
    service.audit(c,actor,'member.update',row['user'])
    return dict(id=row['user'],role=role,branches=branches,areas=areas,employee=employee,enabled=enabled,sessions_revoked=True)
