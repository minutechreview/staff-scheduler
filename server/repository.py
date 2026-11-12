"""Domain storage seam. SQLite remains the unchanged local persistence baseline."""
import json


def repo(connection):
    return connection if hasattr(connection,'entity_rows') else SQLiteRepository(connection)


class SQLiteRepository:
    def __init__(self,c): self.c=c
    def begin(self): self.c.execute('BEGIN IMMEDIATE')
    def bind_org(self,org): pass
    def fence(self,org,employees): pass  # SQLite BEGIN IMMEDIATE serializes writers.
    def fence_policy(self,org): pass
    def preload_ledger(self,org,employees,all_tenant=False): pass
    def org_get(self,org):
        r=self.c.execute('SELECT * FROM organizations WHERE id=?',(org,)).fetchone()
        return dict(r) if r else None
    def entity_rows(self,org,kind):
        return [json.loads(r[0]) for r in self.c.execute('SELECT data FROM entities WHERE org=? AND kind=?',(org,kind))]
    def entity_get(self,org,kind,ident):
        r=self.c.execute('SELECT data FROM entities WHERE org=? AND kind=? AND id=?',(org,kind,ident)).fetchone()
        return json.loads(r[0]) if r else None
    def entity_put(self,org,kind,data):
        self.c.execute('INSERT INTO entities VALUES(?,?,?,?) ON CONFLICT(org,kind,id) DO UPDATE SET data=excluded.data',(org,kind,data['id'],json.dumps(data)))
    def audit_add(self,actor,action,entity,created):
        self.c.execute('INSERT INTO audit(org,actor,action,entity,created) VALUES(?,?,?,?,?)',(actor['org'],actor['id'],action,entity,created))
    def schedule_exists(self,org,branch=None):
        return bool(self.c.execute('SELECT 1 FROM schedules WHERE org=?'+(' AND branch=?' if branch else '')+' LIMIT 1',(org,branch) if branch else (org,)).fetchone())
    def schedule_get(self,org,branch,week):
        r=self.c.execute('SELECT * FROM schedules WHERE org=? AND branch=? AND week=?',(org,branch,week)).fetchone()
        return dict(r) if r else None
    def schedule_rows(self,org): return [dict(r) for r in self.c.execute('SELECT * FROM schedules WHERE org=?',(org,))]
    def schedule_put(self,row):
        self.c.execute('INSERT INTO schedules VALUES(:org,:branch,:week,:revision,:state,:shifts,:published) ON CONFLICT(org,branch,week) DO UPDATE SET revision=excluded.revision,state=excluded.state,shifts=excluded.shifts,published=excluded.published',row)
    def versions_add(self,row):
        self.c.execute('INSERT INTO versions VALUES(:org,:branch,:week,:revision,:actor,:action,:created,:shifts)',row)
    def versions_rows(self,org,branch,week):
        return [dict(r) for r in self.c.execute('SELECT revision,action,created,actor,shifts FROM versions WHERE org=? AND branch=? AND week=? ORDER BY revision DESC',(org,branch,week))]
    def reservations_replace(self,org,branch,week,draft,published):
        self.c.execute('DELETE FROM reservations WHERE org=? AND branch=? AND week=?',(org,branch,week))
        self.c.executemany('INSERT OR IGNORE INTO reservations VALUES(?,?,?,?,?,?,?,?)',[(org,branch,week,s['employee'],s['start'],s['end'],s['role'],json.dumps(s)) for s in draft+published])
    def reservations_rows(self,org,exclude=None,employees=None,windows=None):
        sql,params='SELECT data FROM reservations WHERE org=?',[org]
        if exclude: sql+=' AND (branch<>? OR week<>?)';params+=list(exclude)
        if employees is not None:
            if not employees:return []
            sql+=' AND employee IN ('+','.join('?' for _ in employees)+')';params+=list(employees)
        values=[json.loads(r[0]) for r in self.c.execute(sql,params)]
        if windows is not None:
            from core import stamp
            values=[s for s in values if s['employee'] in windows and stamp(s['start'])<stamp(windows[s['employee']]['end']) and stamp(s['end'])>stamp(windows[s['employee']]['start'])]
        return values
    def policy_rows(self,org):
        return [dict(r) for r in self.c.execute('SELECT effective,revision,policy,actor,created FROM policy_versions WHERE org=? ORDER BY effective',(org,))]
    def policy_delete_baseline(self,org): self.c.execute('DELETE FROM policy_versions WHERE org=? AND revision=0',(org,))
    def policy_add(self,row): self.c.execute('INSERT INTO policy_versions VALUES(:org,:effective,:revision,:policy,:actor,:created)',row)
    def ledger_rows(self,org,employee,start=None,end=None,non_credit=False):
        sql,params='SELECT * FROM leave_ledger WHERE org=? AND employee=?',[org,employee]
        if start is not None:sql+=' AND effective>=? AND effective<?';params += [str(start),str(end)]
        if non_credit:sql+=" AND kind NOT IN ('accrual','carryover')"
        return [dict(r) for r in self.c.execute(sql+' ORDER BY effective,created,id',params)]
    def ledger_source(self,org,employee,source):
        r=self.c.execute('SELECT * FROM leave_ledger WHERE org=? AND employee=? AND source=?',(org,employee,source)).fetchone()
        return dict(r) if r else None
    def ledger_add(self,row): self.c.execute('INSERT INTO leave_ledger VALUES(:id,:org,:employee,:effective,:kind,:days,:source,:policy_revision,:leave_id,:actor,:reason,:created)',row)
    def ledger_exists(self,org,employee=None):
        return bool(self.c.execute('SELECT 1 FROM leave_ledger WHERE org=?'+(' AND employee=?' if employee else '')+' LIMIT 1',(org,employee) if employee else (org,)).fetchone())
    def ledger_employees(self,org): return [r[0] for r in self.c.execute('SELECT DISTINCT employee FROM leave_ledger WHERE org=?',(org,))]
    def member_get(self,org,user):
        r=self.c.execute('SELECT * FROM members WHERE org=? AND user=?',(org,user)).fetchone()
        return dict(r) if r else None
    def member_rows(self,org):
        return [dict(r) for r in self.c.execute('SELECT u.id,u.name,u.email,m.role,m.branches,m.areas,m.employee,m.enabled FROM members m JOIN users u ON u.id=m.user WHERE m.org=?',(org,))]
    def member_employee_exists(self,org,employee,exclude=None):
        return bool(self.c.execute('SELECT 1 FROM members WHERE org=? AND employee=?'+(' AND user<>?' if exclude else ''),(org,employee,exclude) if exclude else (org,employee)).fetchone())
    def member_add(self,org,user,role,branches,areas,employee):
        self.c.execute('INSERT INTO members(org,user,role,branches,areas,employee) VALUES(?,?,?,?,?,?)',(org,user,role,json.dumps(branches),json.dumps(areas),employee))
    def member_update(self,row):
        self.c.execute('UPDATE members SET role=:role,branches=:branches,areas=:areas,employee=:employee,enabled=:enabled WHERE org=:org AND user=:user',row)
    def sessions_rows(self,user,now):
        return [dict(r) for r in self.c.execute('SELECT * FROM sessions WHERE user=? AND expires>? ORDER BY created DESC',(user,now))]
    def session_id(self,ident):
        r=self.c.execute('SELECT * FROM sessions WHERE id=?',(ident,)).fetchone();return dict(r) if r else None
    def session_delete_id(self,ident): self.c.execute('DELETE FROM sessions WHERE id=?',(ident,))
    def session_delete_user(self,user,except_id=None):
        self.c.execute('DELETE FROM sessions WHERE user=?'+(' AND id<>?' if except_id else ''),(user,except_id) if except_id else (user,))
    def session_delete_token(self,token): self.c.execute('DELETE FROM sessions WHERE token=?',(token,))
