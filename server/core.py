"""Relay domain service. SQLite is the local adapter; all authority lives here."""
import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = timezone.utc
ROLES = {'owner', 'admin', 'area_manager', 'branch_manager', 'employee'}
DEFAULTS = dict(timezone='Europe/London', week_start=0, fiscal_start_month=1,
                max_week_hours=40, max_day_hours=10, min_rest_hours=11,
                annual_leave_days=25, leave_workdays=[0, 1, 2, 3, 4], workdays=list(range(7)), fiscal_start_day=1,
                pay_cycle='monthly', pay_anchor='1970-01-01', pay_split_day=16, leave_accrual='annual_upfront',
                max_carryover_days=0, leave_prorate_joiners=False)


class Problem(Exception):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def require(condition, message, status=422):
    if not condition:
        raise Problem(message, status)


def uid():
    return secrets.token_hex(12)


def text(value, label, length=120):
    require(isinstance(value, str) and 0 < len(value.strip()) <= length, f'{label} is required (up to {length} characters).')
    return value.strip()


def local_instant(value, tz, fold=None):
    """Reject imaginary/ambiguous wall times. Explicit offsets disambiguate DST."""
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo:
            return parsed.astimezone(UTC)
        zone = ZoneInfo(tz)
        valid = [parsed.replace(tzinfo=zone, fold=f) for f in (0, 1)
                 if parsed.replace(tzinfo=zone, fold=f).astimezone(UTC).astimezone(zone).replace(tzinfo=None) == parsed]
        require(valid, 'This local time does not exist because the clock changes. Choose another time.')
        ambiguous = len(valid) == 2 and valid[0].utcoffset() != valid[1].utcoffset()
        require(not ambiguous or fold in (0, 1), 'This local time occurs twice. Provide an explicit UTC offset or fold 0/1.')
        return parsed.replace(tzinfo=zone, fold=fold or 0).astimezone(UTC)
    except (ValueError, TypeError, ZoneInfoNotFoundError):
        raise Problem('Use a valid ISO date/time and IANA timezone.') from None


def iso(value):
    return value.astimezone(UTC).isoformat()


def stamp(value):
    return datetime.fromisoformat(value).astimezone(UTC)


def hours(shift):
    return (stamp(shift['end']) - stamp(shift['start'])).total_seconds() / 3600


def overlap(a, b):
    return stamp(a['start']) < stamp(b['end']) and stamp(b['start']) < stamp(a['end'])


def week_start(day, first):
    return day - timedelta(days=(day.weekday() - first) % 7)


def settings(data):
    result = DEFAULTS | data
    try:
        ZoneInfo(result['timezone'])
    except (ZoneInfoNotFoundError, TypeError):
        raise Problem('Choose a valid IANA timezone.') from None
    require(type(result['week_start']) is int and 0 <= result['week_start'] <= 6, 'Week start must be Monday (0) through Sunday (6).')
    require(type(result['fiscal_start_month']) is int and 1 <= result['fiscal_start_month'] <= 12, 'Fiscal month must be 1–12.')
    for key, lo, hi in [('max_week_hours', 1, 168), ('max_day_hours', 1, 24), ('min_rest_hours', 0, 48), ('annual_leave_days', 0, 366)]:
        require(type(result[key]) in (int, float) and lo <= result[key] <= hi, f'Invalid {key.replace("_", " ")}.')
    require(isinstance(result['leave_workdays'], list) and result['leave_workdays'] and all(type(x) is int and 0 <= x <= 6 for x in result['leave_workdays']), 'Leave workdays must be weekday numbers 0–6.')
    require(type(result['fiscal_start_day']) is int and 1 <= result['fiscal_start_day'] <= 28, 'Fiscal start day must be 1–28.')
    require(result['pay_cycle'] in ('weekly','fortnightly','semimonthly','monthly'), 'Choose a supported pay cycle.')
    try:
        anchor = date.fromisoformat(result['pay_anchor'])
        require(anchor.day <= 28, 'Pay anchor day must be 1–28.')
    except (ValueError, TypeError):
        raise Problem('Choose a valid pay anchor date.') from None
    require(type(result['pay_split_day']) is int and 2 <= result['pay_split_day'] <= 28, 'Semimonthly split day must be 2–28.')
    require(result['leave_accrual'] in ('annual_upfront','monthly','daily'), 'Choose annual upfront, monthly or daily accrual.')
    require(type(result['leave_prorate_joiners']) is bool, 'Proration must be true or false.')
    require(type(result['max_carryover_days']) in (int,float) and 0 <= result['max_carryover_days'] <= 366, 'Carryover cap must be 0–366 days.')
    require(isinstance(result['workdays'],list) and result['workdays'] and all(type(x) is int and 0 <= x <= 6 for x in result['workdays']), 'Configure working weekdays 0–6.')
    return {key: result[key] for key in DEFAULTS}


from repository import repo


class Service:
    def __init__(self, path):
        self.path = str(path)
        self.now = lambda: datetime.now(UTC)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            c.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY, name TEXT, settings TEXT);
            CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, salt TEXT, password TEXT);
            CREATE TABLE IF NOT EXISTS members(org TEXT, user TEXT, role TEXT, branches TEXT, employee TEXT, PRIMARY KEY(org,user));
            CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user TEXT, csrf TEXT, expires REAL);
            CREATE TABLE IF NOT EXISTS entities(org TEXT, kind TEXT, id TEXT, data TEXT, PRIMARY KEY(org,kind,id));
            CREATE INDEX IF NOT EXISTS entities_scope ON entities(org,kind);
            CREATE TABLE IF NOT EXISTS schedules(org TEXT, branch TEXT, week TEXT, revision INTEGER, state TEXT, shifts TEXT, published TEXT, PRIMARY KEY(org,branch,week));
            CREATE INDEX IF NOT EXISTS schedules_scope ON schedules(org,week,branch);
            CREATE TABLE IF NOT EXISTS reservations(org TEXT,branch TEXT,week TEXT,employee TEXT,start TEXT,end TEXT,role TEXT,data TEXT,PRIMARY KEY(org,branch,week,employee,start,end,role));
            CREATE INDEX IF NOT EXISTS reservations_employee ON reservations(org,employee,start,end);
            CREATE TABLE IF NOT EXISTS versions(org TEXT, branch TEXT, week TEXT, revision INTEGER, actor TEXT, action TEXT, created REAL, shifts TEXT, PRIMARY KEY(org,branch,week,revision));
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, org TEXT, actor TEXT, action TEXT, entity TEXT, created REAL);
            CREATE TABLE IF NOT EXISTS policy_versions(org TEXT,effective TEXT,revision INTEGER,policy TEXT,actor TEXT,created REAL,PRIMARY KEY(org,effective));
            CREATE TABLE IF NOT EXISTS leave_ledger(id TEXT PRIMARY KEY,org TEXT,employee TEXT,effective TEXT,kind TEXT,days REAL,source TEXT,policy_revision INTEGER,leave_id TEXT,actor TEXT,reason TEXT,created REAL,UNIQUE(org,employee,source));
            CREATE INDEX IF NOT EXISTS leave_ledger_employee ON leave_ledger(org,employee,effective);
            CREATE TABLE IF NOT EXISTS login_attempts(key TEXT,created REAL);
            CREATE INDEX IF NOT EXISTS login_attempts_key ON login_attempts(key,created);
            CREATE TRIGGER IF NOT EXISTS leave_ledger_no_update BEFORE UPDATE ON leave_ledger BEGIN SELECT RAISE(ABORT,'Leave ledger entries are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS leave_ledger_no_delete BEFORE DELETE ON leave_ledger BEGIN SELECT RAISE(ABORT,'Leave ledger entries are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS policy_no_update BEFORE UPDATE ON policy_versions BEGIN SELECT RAISE(ABORT,'Policy versions are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS policy_no_delete BEFORE DELETE ON policy_versions WHEN OLD.revision>0 BEGIN SELECT RAISE(ABORT,'Policy versions are immutable'); END;
            PRAGMA user_version=5;
            ''')
            columns = {row['name'] for row in c.execute('PRAGMA table_info(members)')}
            if 'areas' not in columns:
                c.execute("ALTER TABLE members ADD COLUMN areas TEXT NOT NULL DEFAULT '[]'")
            if 'enabled' not in columns:
                c.execute('ALTER TABLE members ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
            session_columns={row['name'] for row in c.execute('PRAGMA table_info(sessions)')}
            for key,definition in [('id','TEXT'),('created','REAL'),('last_seen','REAL')]:
                if key not in session_columns:
                    c.execute(f'ALTER TABLE sessions ADD COLUMN {key} {definition}')
            from identity import session_key
            for row in c.execute('SELECT * FROM sessions').fetchall():
                key=session_key(row['token']) if len(row['token'])!=64 else row['token']
                created=row['created'] or row['expires']-43200
                c.execute('UPDATE sessions SET token=?,id=?,created=?,last_seen=? WHERE token=?',(key,row['id'] or uid(),created,row['last_seen'] or created,row['token']))
            from organization import refresh_labels
            for org in c.execute('SELECT id,settings FROM organizations').fetchall():
                base = settings(json.loads(org['settings']))
                c.execute('INSERT OR IGNORE INTO policy_versions VALUES(?,?,?,?,?,?)', (org['id'],'0001-01-01',0,json.dumps(base),'local-migration',time.time()))
                refresh_labels(self,c,org['id'])
                from leave_ledger import charges,post
                for employee in self.rows(c,org['id'],'employee'):
                    if 'start_date' not in employee:
                        self.put(c,org['id'],'employee',employee | dict(start_date='1970-01-01'))
                for leave in self.rows(c,org['id'],'leave'):
                    if 'charge_days' not in leave:
                        leave['charge_days']=charges(self,c,org['id'],leave['start'],leave['end'])
                        self.put(c,org['id'],'leave',leave)
                    if leave['status'] in ('approved','cancel_requested','partially_cancelled'):
                        for day in leave['charge_days']:
                            post(c,org['id'],leave['employee'],dict(effective=day,days=-1,kind='reserve',source=f'leave/{leave["id"]}/{day}/reserve'),'local-migration','Preserved existing approved leave',leave['id'])
            if c.execute('SELECT 1 FROM schedules LIMIT 1').fetchone() and not c.execute('SELECT 1 FROM reservations LIMIT 1').fetchone():
                self.rebuild_reservations(c)

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA foreign_keys=ON')
        try:
            with c:
                yield c
        finally:
            c.close()

    def rows(self, c, org, kind):
        return repo(c).entity_rows(org,kind)

    def entity(self, c, org, kind, ident):
        row = repo(c).entity_get(org,kind,ident)
        require(row is not None, f'{kind.title()} not found.', 404)
        return row

    def put(self, c, org, kind, data):
        repo(c).entity_put(org,kind,data)
        return data

    def audit(self, c, actor, action, entity):
        repo(c).audit_add(actor,action,entity,time.time())

    def actor(self, c, token):
        from identity import session_key
        row = c.execute('SELECT u.id,u.email,u.name,m.org,m.role,m.branches,m.areas,m.employee,s.csrf,s.id AS session_id FROM sessions s JOIN users u ON u.id=s.user JOIN members m ON m.user=u.id WHERE s.token=? AND s.expires>? AND s.last_seen>? AND m.enabled=1', (session_key(token), time.time(),time.time()-1800)).fetchone()
        require(row is not None, 'Sign in to continue.', 401)
        c.execute('UPDATE sessions SET last_seen=? WHERE id=?',(time.time(),row['session_id']))
        a = dict(row)
        a['branches'] = json.loads(a['branches'])
        a['areas'] = json.loads(a['areas'])
        return a

    def scope(self, c, a, branch=None, write=False):
        require(not write or a['role'] != 'employee', 'Your role cannot edit schedules.', 403)
        all_branches = self.rows(c, a['org'], 'branch')
        allowed = {b['id'] for b in all_branches} if a['role'] in ('owner', 'admin') else set(a['branches']) | ({b['id'] for b in all_branches if b.get('area_id') in a.get('areas', [])} if a['role'] == 'area_manager' else set())
        if branch:
            require(branch in allowed, 'This branch is outside your assigned scope.', 403)
        return allowed

    def admin(self, a):
        require(a['role'] in ('owner', 'admin'), 'An organization owner or administrator is required.', 403)

    def org_settings(self, c, org, on=None):
        from organization import policy_at
        if on is None:
            baseline = json.loads(repo(c).org_get(org)['settings'])
            on = self.now().astimezone(ZoneInfo(baseline['timezone'])).date()
        return policy_at(self,c,org,on)['policy']

    def local_today(self,c,org,employee=None):
        if employee:
            zone=self.entity(c,org,'branch',employee['branch'])['timezone']
        else:
            zone=self.org_settings(c,org,self.now().date())['timezone']
        return self.now().astimezone(ZoneInfo(zone)).date()

    def password(self, value, salt):
        return hashlib.scrypt(value.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()

    def user(self, c, data):
        email = text(data.get('email'), 'Email', 254).lower()
        require('@' in email and '.' in email.split('@')[-1], 'Enter a valid email address.')
        password = data.get('password', '')
        require(isinstance(password, str) and 12 <= len(password) <= 128, 'Use a password of 12–128 characters.')
        salt = secrets.token_hex(16)
        user = dict(id=uid(), email=email, name=text(data.get('name'), 'Name'), salt=salt, password=self.password(password, salt))
        require(not c.execute('SELECT 1 FROM users WHERE email=?', (email,)).fetchone(), 'This email is already registered.', 409)
        c.execute('INSERT INTO users VALUES(:id,:email,:name,:salt,:password)', user)
        return user

    def new_session(self, c, user):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        c.execute('DELETE FROM sessions WHERE expires<?', (time.time(),))
        from identity import session_key
        now=time.time()
        c.execute('INSERT INTO sessions(token,user,csrf,expires,id,created,last_seen) VALUES(?,?,?,?,?,?,?)', (session_key(token),user,csrf,now+43200,uid(),now,now))
        return token

    def signup(self, data):
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            u = self.user(c, data)
            org = uid()
            s = settings(data.get('settings', {}))
            c.execute('INSERT INTO organizations VALUES(?,?,?)', (org, text(data.get('organization'), 'Organization'), json.dumps(s)))
            c.execute('INSERT INTO members(org,user,role,branches,employee) VALUES(?,?,?,?,?)', (org, u['id'], 'owner', '[]', None))
            c.execute('INSERT INTO policy_versions VALUES(?,?,?,?,?,?)',(org,'0001-01-01',0,json.dumps(s),u['id'],time.time()))
            return self.new_session(c, u['id'])

    def signin(self, data, client='local'):
        from identity import session_key
        email=data.get('email','')
        require(isinstance(email,str),'Invalid credentials.',401)
        email=email.strip().lower()
        require(len(email)<=254,'Invalid credentials.',401)
        password=data.get('password','')
        require(isinstance(password,str) and len(password)<=128,'Invalid credentials.',401)
        key=session_key('signin/'+email)
        remote=session_key('client/'+client)
        failure=None
        token=None
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            now=time.time()
            c.execute('DELETE FROM login_attempts WHERE created<?',(now-600,))
            require(c.execute('SELECT COUNT(*) FROM login_attempts WHERE key=?',(key,)).fetchone()[0]<8,'Too many attempts. Try again in ten minutes.',429)
            require(c.execute('SELECT COUNT(*) FROM login_attempts WHERE key=? AND created>?',(remote,now-300)).fetchone()[0]<30,'Too many attempts. Try again in five minutes.',429)
            row=c.execute('SELECT u.*,m.enabled FROM users u JOIN members m ON m.user=u.id WHERE u.email=?',(email,)).fetchone()
            salt=row['salt'] if row else '00'*16
            hashed=self.password(password,salt)
            if row is None or not row['enabled'] or not hmac.compare_digest(hashed,row['password']):
                c.executemany('INSERT INTO login_attempts VALUES(?,?)',[(key,now),(remote,now)])
                failure=Problem('Invalid credentials.',401)
            else:
                c.execute('DELETE FROM login_attempts WHERE key=?',(key,))
                token=self.new_session(c,row['id'])
        if failure:
            raise failure
        return token

    def branch(self, c, a, data):
        self.admin(a)
        zone = data.get('timezone', self.org_settings(c, a['org'])['timezone'])
        try:
            ZoneInfo(zone)
        except (ZoneInfoNotFoundError, TypeError):
            raise Problem('Choose a valid IANA timezone.') from None
        b = dict(id=data.get('id') or uid(), name=text(data.get('name'), 'Branch name'),
                 timezone=zone,
                 coverage=data.get('coverage', [{'start': '09:00', 'end': '17:00', 'role': 'associate', 'required': 2}]))
        from organization import resolve_labels
        b.update(resolve_labels(self,c,a['org'],data))
        require(isinstance(b['coverage'], list) and len(b['coverage']) <= 20, 'Use up to 20 coverage windows.')
        for r in b['coverage']:
            require(type(r.get('required')) is int and 1 <= r['required'] <= 100, 'Coverage count must be 1–100.')
            text(r.get('role'), 'Coverage role', 40)
            require(isinstance(r.get('days', list(range(7))), list) and all(type(day) is int and 0 <= day <= 6 for day in r.get('days', list(range(7)))), 'Coverage days must be weekday numbers 0–6.')
            for k in ('start', 'end'):
                require(isinstance(r.get(k), str) and len(r[k]) == 5, 'Coverage times must use HH:MM.')
                try:
                    datetime.strptime(r[k], '%H:%M')
                except ValueError:
                    raise Problem('Coverage times must use HH:MM.') from None
        if data.get('id'):
            old = self.entity(c, a['org'], 'branch', data['id'])
            require(old['timezone'] == zone or not repo(c).schedule_exists(a['org'],b['id']), 'A branch timezone cannot change after schedules exist. Create a new branch.')
        self.put(c, a['org'], 'branch', b)
        self.audit(c, a, 'branch.save', b['id'])
        return b

    def public_employee(self, actor, employee):
        return employee if actor['role'] in ('owner','admin') else {k:v for k,v in employee.items() if k != 'hourly_rate'}

    def employee(self, c, a, data):
        self.scope(c, a, data.get('branch'), True)
        self.entity(c, a['org'], 'branch', data['branch'])
        ident = data.get('id') or uid()
        old = self.entity(c, a['org'], 'employee', ident) if data.get('id') else {}
        repo(c).fence(a['org'],{ident})
        if old:
            self.scope(c, a, old['branch'], True)
            require(old['branch'] == data['branch'], 'Branch transfers need a separate migration workflow.')
        skills = data.get('skills', ['associate'])
        require(isinstance(skills, list) and 0 < len(skills) <= 20 and all(isinstance(x, str) and 0 < len(x) <= 40 for x in skills), 'Specify 1–20 skills.')
        contract = data.get('contract_hours', 40)
        require(type(contract) in (int, float) and 0 < contract <= 168, 'Contract hours must be 1–168.')
        availability = data.get('availability', old.get('availability', {str(i): [{'start': '08:00', 'end': '22:00'}] for i in range(7)}))
        require(isinstance(availability, dict) and set(availability).issubset({str(i) for i in range(7)}), 'Availability uses weekday keys 0–6.')
        for windows in availability.values():
            require(isinstance(windows, list) and len(windows) <= 8, 'Use up to eight availability windows per day.')
            for window in windows:
                for key in ('start', 'end'):
                    try:
                        datetime.strptime(window[key], '%H:%M')
                    except (KeyError, ValueError, TypeError):
                        raise Problem('Availability times must use HH:MM.') from None
        rate = data.get('hourly_rate', old.get('hourly_rate'))
        require(a['role'] in ('owner','admin') or rate == old.get('hourly_rate'), 'Only an owner or administrator can configure wage rates.',403)
        require(rate is None or (type(rate) in (int, float) and 0 <= rate < 100000), 'Hourly rate must be a nonnegative number, or unset.')
        e = dict(id=ident, name=text(data.get('name'), 'Employee name'), branch=data['branch'], skills=skills,
                 contract_hours=contract, availability=availability, active=data.get('active', True), hourly_rate=rate)
        from organization import parse_day
        e['start_date']=str(parse_day(data.get('start_date',old.get('start_date',str(date.today())))))
        require(not old or old.get('start_date') == e['start_date'] or not repo(c).ledger_exists(a['org'],ident), 'Employment start cannot change after ledger posting; use a reasoned ledger adjustment.')
        require(type(e['active']) is bool, 'Active status must be true or false.')
        if old and not e['active']:
            require(not any(stamp(x['end']) > datetime.now(UTC) for x in self.all_shifts(c, a['org'], employee_ids={ident})), 'Remove future assignments before deactivating an employee.')
        self.put(c, a['org'], 'employee', e)
        self.audit(c, a, 'employee.save', ident)
        return self.public_employee(a,e)

    def member(self, c, a, data):
        self.admin(a)
        role = data.get('role')
        require(role in ROLES - {'owner'}, 'Choose a valid member role.')
        require(a['role'] == 'owner' or role != 'admin', 'Only the owner can create administrators.', 403)
        branches = data.get('branches', [])
        require(isinstance(branches, list), 'Specify assigned branches.')
        allowed = self.scope(c, a)
        require(set(branches) <= allowed, 'Assigned branches must belong to this organization.', 403)
        require(role not in ('branch_manager', 'employee') or len(branches) == 1, 'This role needs exactly one branch.')
        areas = data.get('areas', [])
        require(isinstance(areas,list) and (role == 'area_manager' or not areas), 'Area assignments are for area managers only.')
        for area in areas:
            self.entity(c,a['org'],'area',area)
        require(role != 'area_manager' or branches or areas, 'Assign branches or areas to the area manager.')
        employee = data.get('employee')
        if role == 'employee':
            e = self.entity(c, a['org'], 'employee', employee)
            require(e['branch'] in branches, 'The employee must belong to the assigned branch.')
            require(not repo(c).member_employee_exists(a['org'],employee), 'This employee already has an account.', 409)
        u = self.user(c, data)
        repo(c).fence(a['org'],{employee} if employee else set())
        repo(c).member_add(a['org'],u['id'],role,branches,areas,employee if role == 'employee' else None)
        self.audit(c, a, 'member.create', u['id'])
        return dict(id=u['id'], name=u['name'], email=u['email'], role=role)

    def sync_reservations(self, c, org, branch, week, draft, published):
        repo(c).reservations_replace(org,branch,week,draft,published)

    def rebuild_reservations(self, c):
        for row in c.execute('SELECT org,branch,week,shifts,published FROM schedules').fetchall():
            self.sync_reservations(c, row['org'], row['branch'], row['week'], json.loads(row['shifts']), json.loads(row['published'] or '[]'))

    def all_shifts(self, c, org, exclude=None, employee_ids=None, windows=None):
        return repo(c).reservations_rows(org,exclude,employee_ids,windows)

    def shift(self, c, a, branch, data):
        b = self.entity(c, a['org'], 'branch', branch)
        start = local_instant(data.get('start', ''), b['timezone'], data.get('start_fold'))
        end = local_instant(data.get('end', ''), b['timezone'], data.get('end_fold'))
        require(0 < (end - start).total_seconds() <= 86400, 'A shift must last between 0 and 24 actual hours.')
        return dict(id=data.get('id') or uid(), branch=branch, employee=text(data.get('employee'), 'Employee ID'),
                    role=text(data.get('role'), 'Shift role', 40), start=iso(start), end=iso(end))

    def availability_ok(self, e, shift, branch):
        zone = ZoneInfo(branch['timezone'])
        # Availability is interpreted in employee home timezone (caller supplies home branch).
        start, end = stamp(shift['start']), stamp(shift['end'])
        local_day = start.astimezone(zone).date()
        # Prior day supports windows crossing midnight.
        for d in (local_day - timedelta(days=1), local_day):
            for w in e['availability'].get(str(d.weekday()), []):
                finish_day = d + timedelta(days=w['end'] <= w['start'])
                try:
                    lo = local_instant(f'{d}T{w["start"]}', branch['timezone'])
                    hi = local_instant(f'{finish_day}T{w["end"]}', branch['timezone'])
                except Problem:
                    continue
                if lo <= start and end <= hi:
                    return True
        return False

    def validation_snapshot(self, c, org):
        from organization import policy_versions
        return dict(policy=self.org_settings(c, org), policies=policy_versions(self,c,org), branches={b['id']: b for b in self.rows(c, org, 'branch')},
                    employees={e['id']: e for e in self.rows(c, org, 'employee')}, leaves=self.rows(c, org, 'leave'), support=self.rows(c, org, 'support'))

    def validate(self, c, org, shifts, exclude=None, context=None, snapshot=None):
        """Indexed per employee, retaining published reservations while a draft changes."""
        if not shifts:
            return []
        snapshot = snapshot or self.validation_snapshot(c, org)
        branches, employees = snapshot['branches'], snapshot['employees']
        from organization import policy_from,planning_from
        policies = snapshot['policies']
        from functools import cache
        @cache
        def policy_on(day):
            return policy_from(policies,day)['policy']
        @cache
        def week_on(day):
            return planning_from(policies,day)['start']
        leaves = defaultdict(list)
        for l in snapshot['leaves']:
            if l['status'] in ('approved','cancel_requested','partially_cancelled'):
                leaves[l['employee']].append(l)
        support = defaultdict(list)
        for r in snapshot['support']:
            if r['status'] == 'approved':
                support[r['employee']].append(r)
        ids = {s['employee'] for s in shifts}
        windows=self.constraint_windows(shifts,snapshot) if context is None else None
        existing = self.all_shifts(c, org, exclude, ids,windows) if context is None else [s for s in context if s['employee'] in ids]
        by_employee = defaultdict(list)
        for x in existing + shifts:
            by_employee[x['employee']].append(x)
        errors = []
        totals = {}
        for s in shifts:
            e = employees.get(s['employee'])
            if not e or not e['active']:
                errors.append(dict(shift=s['id'], reason='Employee is missing or inactive.'))
                continue
            b = branches[e['branch']]
            zone = ZoneInfo(b['timezone'])
            start, end = stamp(s['start']), stamp(s['end'])
            policy = policy_on(start.astimezone(zone).date())
            reason = []
            if start.astimezone(zone).date() < date.fromisoformat(e.get('start_date', '1970-01-01')):
                reason.append('Shift starts before employment begins.')
            if s['role'] not in e['skills']:
                reason.append('Missing required skill/role.')
            if not self.availability_ok(e, s, b):
                reason.append('Outside employee availability.')
            for l in leaves[e['id']]:
                lo = local_instant(f'{l["start"]}T00:00', b['timezone'])
                hi = local_instant(f'{date.fromisoformat(l["end"]) + timedelta(days=1)}T00:00', b['timezone'])
                if start < hi and lo < end:
                    reason.append('Overlaps approved leave.')
            if e['branch'] != s['branch'] and not any(r['from_branch'] == e['branch'] and r['to_branch'] == s['branch'] and stamp(r['start']) <= start and end <= stamp(r['end']) for r in support[e['id']]):
                reason.append('Cross-branch work requires an approved support request.')
            others = [x for x in by_employee[e['id']] if x is not s]
            if any(overlap(s, x) for x in others):
                reason.append('Employee is already assigned during this interval.')
            if any(0 <= min(abs((start - stamp(x['end'])).total_seconds()), abs((stamp(x['start']) - end).total_seconds())) < max(policy['min_rest_hours'],policy_on(stamp(x['start']).astimezone(zone).date())['min_rest_hours']) * 3600 for x in others if not overlap(s, x)):
                reason.append('Insufficient rest between shifts.')
            # Split overnight shifts into home-local dates; actual elapsed hours count across DST.
            if e['id'] not in totals:
                daily, weekly = defaultdict(float), defaultdict(float)
                for x in by_employee[e['id']]:
                    cursor, finish = stamp(x['start']), stamp(x['end'])
                    while cursor < finish:
                        d = cursor.astimezone(zone).date()
                        midnight = local_instant(f'{d + timedelta(days=1)}T00:00', b['timezone'])
                        piece_end = min(midnight, finish)
                        amount = (piece_end - cursor).total_seconds() / 3600
                        daily[d] += amount
                        weekly[week_on(d)] += amount
                        cursor = piece_end
                totals[e['id']] = daily, weekly
            daily, weekly = totals[e['id']]
            touched=set()
            cursor=start
            while cursor<end:
                day=cursor.astimezone(zone).date();touched.add(day)
                cursor=min(end,local_instant(f'{day+timedelta(days=1)}T00:00',b['timezone']))
            if any(d.weekday() not in policy_on(d)['workdays'] for d in touched):
                reason.append('Outside configured working weekdays.')
            if any(daily[d] > policy_on(d)['max_day_hours'] + 0.001 for d in touched):
                reason.append('Exceeds maximum daily hours.')
            if any(weekly[week_on(d)] > policy_on(d)['max_week_hours'] + 0.001 for d in touched):
                reason.append('Exceeds maximum weekly hours.')
            if reason:
                errors.append(dict(shift=s['id'], employee=e['id'], reason=' '.join(dict.fromkeys(reason))))
        return errors

    def constraint_windows(self,shifts,snapshot):
        """Complete UTC read windows for overlap, rest and touched day/week totals.

        Include each home-local planning period touched by the candidate, plus
        the maximum configured rest before/after. No historical fairness inputs
        are truncated: generation requests its complete history separately.
        """
        from organization import planning_from
        rest=timedelta(hours=max(p['policy']['min_rest_hours'] for p in snapshot['policies']))
        windows={}
        for shift in shifts:
            employee=snapshot['employees'].get(shift['employee'])
            if employee is None:continue
            branch=snapshot['branches'][employee['branch']];zone=ZoneInfo(branch['timezone'])
            start,end=stamp(shift['start']),stamp(shift['end'])
            lo,hi=start-rest,end+rest
            cursor=start
            try:
                while cursor<end:
                    day=cursor.astimezone(zone).date()
                    period=planning_from(snapshot['policies'],day)
                    lo=min(lo,local_instant(period['start']+'T00:00',branch['timezone']))
                    hi=max(hi,local_instant(period['next']+'T00:00',branch['timezone']))
                    cursor=min(end,local_instant(f'{day+timedelta(days=1)}T00:00',branch['timezone']))
            except Problem:
                # An ambiguous/imaginary midnight must not narrow facts. The
                # domain's own time validation still returns its precise error.
                lo=min(lo,start-timedelta(days=10));hi=max(hi,end+timedelta(days=10))
            previous=windows.get(employee['id'])
            if previous:lo=min(lo,stamp(previous['start']));hi=max(hi,stamp(previous['end']))
            windows[employee['id']]=dict(start=iso(lo),end=iso(hi))
        return windows

    def schedule(self, c, a, branch, week):
        self.scope(c, a, branch)
        b = self.entity(c, a['org'], 'branch', branch)
        try:
            d = date.fromisoformat(week)
        except (ValueError, TypeError):
            raise Problem('Use an ISO week start date.') from None
        from organization import planning_period,policy_from
        period = planning_period(self,c,a['org'],d)
        require(week == period['start'], 'Date must match the effective organization’s first day of week.')
        row = repo(c).schedule_get(a['org'],branch,week)
        result = dict(period_end=period['end'],period_days=period['days'],next_week=period['next'],previous_week=planning_period(self,c,a['org'],date.fromisoformat(period['previous']))['start'],branch=branch, week=week, timezone=b['timezone'], revision=0, state='draft', shifts=[], published=[])
        if row:
            result.update(dict(row))
            result['shifts'], result['published'] = json.loads(row['shifts']), json.loads(row['published'] or '[]')
        if a['role'] == 'employee':
            result['shifts'] = [s for s in result['published'] if s['employee'] == a['employee']]
            result['published'] = result['shifts']
            result['state'] = 'published' if result['shifts'] else 'unpublished'
        return result

    def save_schedule(self, c, a, data):
        branch, week = data.get('branch'), data.get('week')
        self.scope(c, a, branch, True)
        current = self.schedule(c, a, branch, week)
        require(type(data.get('revision')) is int and data['revision'] == current['revision'], 'Another manager changed this week. Reload before saving.', 409)
        source = data.get('shifts', [])
        require(isinstance(source, list) and len(source) <= 10000, 'Use up to 10,000 shifts per branch/week.')
        shifts = [self.shift(c, a, branch, s) for s in source]
        require(len({s['id'] for s in shifts}) == len(shifts), 'Shift IDs must be unique.')
        b = self.entity(c, a['org'], 'branch', branch)
        for s in shifts:
            d = stamp(s['start']).astimezone(ZoneInfo(b['timezone'])).date()
            from organization import planning_period
            require(planning_period(self,c,a['org'],d)['start'] == week, 'All shifts must start in this branch-local week.')
        repo(c).fence(a['org'],{x['employee'] for x in shifts+current['shifts']+current['published']})
        errors = self.validate(c, a['org'], shifts, (branch, week))
        require(not errors, errors[0]['reason'] if errors else '')
        action = data.get('action', 'save')
        require(action in ('save', 'publish', 'restore'), 'Choose save, publish, or restore.')
        if action == 'publish':
            gaps = [g for g in self.coverage(c, a['org'], branch, week, shifts) if g['gap'] > 0]
            require(not gaps or data.get('acknowledge_gaps') is True, 'Coverage gaps remain. Review and explicitly acknowledge them before publishing.')
        revision = current['revision'] + 1
        published = shifts if action == 'publish' else current['published']
        state = 'published' if action == 'publish' else 'draft'
        repo(c).schedule_put(dict(org=a['org'],branch=branch,week=week,revision=revision,state=state,shifts=json.dumps(shifts),published=json.dumps(published)))
        repo(c).versions_add(dict(org=a['org'],branch=branch,week=week,revision=revision,actor=a['id'],action=action,created=time.time(),shifts=json.dumps(shifts)))
        self.sync_reservations(c, a['org'], branch, week, shifts, published)
        self.audit(c, a, f'schedule.{action}', f'{branch}/{week}/v{revision}')
        return self.schedule(c, a, branch, week)

    def coverage(self, c, org, branch, week, shifts):
        from demand import targets
        b = self.entity(c, org, 'branch', branch)
        result = []
        base = date.fromisoformat(week)
        windows = []
        from organization import planning_period
        for offset in range(planning_period(self,c,org,base)['days']):
            d = base + timedelta(days=offset)
            if d.weekday() not in self.org_settings(c,org,d)['workdays']:
                continue
            for rule in b['coverage']:
                if d.weekday() not in rule.get('days', list(range(7))):
                    continue
                try:
                    lo = local_instant(f'{d}T{rule["start"]}', b['timezone'])
                    end_day = d + timedelta(days=rule['end'] <= rule['start'])
                    hi = local_instant(f'{end_day}T{rule["end"]}', b['timezone'])
                except Problem as error:
                    result.append(dict(branch=branch, date=str(d), role=rule['role'], start='', end='', required=rule['required'], scheduled=0, gap=rule['required'], reason=str(error)))
                    continue
                windows.append(dict(start=iso(lo), end=iso(hi), role=rule['role'], required=rule['required'], source='Minimum role coverage'))
        windows += targets(self, c, org, branch, week)
        for role in {w['role'] for w in windows}:
            role_windows = [w for w in windows if w['role'] == role]
            relevant = [s for s in shifts if s['role'] == role]
            boundaries = sorted({stamp(w[k]) for w in role_windows for k in ('start', 'end')} | {stamp(s[k]) for s in relevant for k in ('start', 'end')})
            for start, end in zip(boundaries, boundaries[1:]):
                active = [w for w in role_windows if stamp(w['start']) <= start and end <= stamp(w['end'])]
                if not active:
                    continue
                required = max(w['required'] for w in active)
                assigned = len({s['employee'] for s in relevant if stamp(s['start']) <= start and end <= stamp(s['end'])})
                result.append(dict(branch=branch, date=str(start.astimezone(ZoneInfo(b['timezone'])).date()), role=role, start=iso(start), end=iso(end), required=required, scheduled=assigned, gap=max(0, required - assigned), source='Forecast + minimum' if any(w['source'] != 'Minimum role coverage' for w in active) else 'Minimum role coverage'))
        return result

    def generate(self, c, a, data):
        from demand import targets
        branch, week = data.get('branch'), data.get('week')
        self.scope(c, a, branch, True)
        current = self.schedule(c, a, branch, week)
        require(data.get('revision') == current['revision'], 'Reload the latest week before generating.', 409)
        b = self.entity(c, a['org'], 'branch', branch)
        employees = [e for e in self.rows(c, a['org'], 'employee') if e['active'] and e['branch'] == branch]
        assigned = list(current['shifts'])
        elsewhere = self.all_shifts(c, a['org'], (branch, week), {e['id'] for e in employees})
        snapshot = self.validation_snapshot(c, a['org'])
        loads = Counter()
        # Fairness uses retained current draft and historical weeks, normalized to contract hours.
        for s in elsewhere + assigned:
            loads[s['employee']] += hours(s)
        unfilled = []
        base = date.fromisoformat(week)
        windows = []
        from organization import planning_period
        for offset in range(planning_period(self,c,a['org'],base)['days']):
            d = base + timedelta(days=offset)
            if d.weekday() not in self.org_settings(c,a['org'],d)['workdays']:
                continue
            for rule in b['coverage']:
                if d.weekday() not in rule.get('days', list(range(7))):
                    continue
                windows.append((d, rule))
        for demand in targets(self, c, a['org'], branch, week):
            local = stamp(demand['start']).astimezone(ZoneInfo(b['timezone']))
            windows.append((local.date(), demand))
        for d, rule in windows:
                target_end = d + timedelta(days=rule['end'] <= rule['start'])
                try:
                    candidate = self.shift(c, a, branch, dict(start=rule['start'] if 'source' in rule else f'{d}T{rule["start"]}', end=rule['end'] if 'source' in rule else f'{target_end}T{rule["end"]}', employee='pending', role=rule['role']))
                except Problem as err:
                    unfilled.append(dict(date=str(d), role=rule['role'], reason=str(err), missing=rule['required']))
                    continue
                present = len({s['employee'] for s in assigned if s['role'] == rule['role'] and stamp(s['start']) <= stamp(candidate['start']) and stamp(candidate['end']) <= stamp(s['end'])})
                missing = max(0,rule['required']-present)
                for placement in range(missing):
                    reasons = Counter()
                    chosen = None
                    for e in sorted(employees, key=lambda e: (loads[e['id']] / e['contract_hours'], e['id'])):
                        s = candidate | dict(id=uid(), employee=e['id'])
                        errors = self.validate(c, a['org'], [s], (branch, week), context=elsewhere + assigned, snapshot=snapshot)
                        if errors:
                            reasons[errors[0]['reason']] += 1
                        else:
                            chosen = s
                            break
                    if chosen:
                        assigned.append(chosen)
                        loads[chosen['employee']] += hours(chosen)
                    else:
                        unfilled.append(dict(date=str(d), role=rule['role'], start=candidate['start'], end=candidate['end'], missing=missing-placement, reason='; '.join(f'{v} candidate(s): {k}' for k, v in reasons.items()) or 'No active employees in this branch.'))
                        # No state changed: repeating the same failed search cannot fill another place.
                        break
        return dict(shifts=assigned, unfilled=unfilled, revision=current['revision'], saved=False,
                    report=self.analytics(c, a, week, branch, override=assigned),
                    explanation='Existing shifts retained. Eligible staff ordered by assigned hours / contract hours; hard constraints checked before every placement. Review, save a draft, then publish.')

    def leave_balance(self,c,org,employee,on=None):
        from leave_ledger import balance
        return balance(self,c,org,employee,on or self.local_today(c,org,self.entity(c,org,'employee',employee)))

    def leave(self, c, a, data):
        e = self.entity(c, a['org'], 'employee', data.get('employee'))
        self.scope(c, a, e['branch'])
        require(a['role'] != 'employee' or e['id'] == a['employee'], 'You can request leave only for yourself.', 403)
        from leave_ledger import charges
        dated_charges=charges(self,c,a['org'],data.get('start'),data.get('end'))
        days=len(dated_charges)
        require(days > 0, 'This request contains no configured leave workdays.')
        for l in self.rows(c, a['org'], 'leave'):
            require(l['employee'] != e['id'] or l['status'] in ('rejected','cancelled') or data['start'] > l['end'] or data['end'] < l['start'], 'This overlaps another pending or approved leave request.', 409)
        request = dict(id=uid(), employee=e['id'], branch=e['branch'], start=data['start'], end=data['end'], days=days, charge_days=dated_charges, reason=text(data.get('reason', 'Time off'), 'Reason', 500), status='pending', requested_by=a['id'])
        self.put(c, a['org'], 'leave', request)
        self.audit(c, a, 'leave.request', request['id'])
        return request

    def leave_decide(self, c, a, data):
        l = self.entity(c, a['org'], 'leave', data.get('id'))
        self.scope(c, a, l['branch'], True)
        require(l['status'] == 'pending', 'This request was already decided.', 409)
        decision = data.get('status')
        require(decision in ('approved', 'rejected'), 'Choose approved or rejected.')
        if decision == 'approved':
            repo(c).fence(a['org'],{l['employee']})
            from leave_ledger import reserve
            reserve(self,c,a,l)
            finish = date.fromisoformat(l['end'])
            e = self.entity(c, a['org'], 'employee', l['employee'])
            b = self.entity(c, a['org'], 'branch', e['branch'])
            span = dict(start=iso(local_instant(f'{l["start"]}T00:00', b['timezone'])), end=iso(local_instant(f'{finish + timedelta(days=1)}T00:00', b['timezone'])))
            require(not any(s['employee'] == e['id'] and overlap(s, span) for s in self.all_shifts(c, a['org'])), 'Leave conflicts with assigned shifts. Edit and publish the schedule first.', 409)
            require(not any(r['employee'] == e['id'] and r['status'] == 'approved' and overlap(r,span) for r in self.rows(c,a['org'],'support')), 'Leave conflicts with approved cross-branch support.',409)
        l.update(status=decision, decided_by=a['id'])
        self.put(c, a['org'], 'leave', l)
        self.audit(c, a, f'leave.{decision}', l['id'])
        return l

    def support(self, c, a, data):
        self.scope(c, a, data.get('to_branch'), True)
        e = self.entity(c, a['org'], 'employee', data.get('employee'))
        require(e['branch'] == data.get('from_branch') and e['branch'] != data['to_branch'], 'Choose a different home and destination branch.')
        require(e['active'], 'Employee is inactive.')
        # Branch directories expose only name/hierarchy, candidate directories are opt-in request endpoint scoped to tenant.
        s = self.shift(c, a, data['to_branch'], data)
        require(s['role'] in e['skills'], 'Employee lacks this role.')
        r = s | dict(id=uid(), employee_name=e['name'], from_branch=e['branch'], to_branch=data['to_branch'], status='pending', requested_by=a['id'], destination_approved_by=a['id'])
        self.put(c, a['org'], 'support', r)
        self.audit(c, a, 'support.request', r['id'])
        return r

    def support_decide(self, c, a, data):
        r = self.entity(c, a['org'], 'support', data.get('id'))
        self.scope(c, a, r['from_branch'], True)
        require(r['status'] == 'pending', 'This support request was already decided.', 409)
        require(data.get('status') in ('approved', 'rejected'), 'Choose approved or rejected.')
        if data['status'] == 'approved':
            repo(c).fence(a['org'],{r['employee']})
            require(not any(s['employee'] == r['employee'] and overlap(s, r) for s in self.all_shifts(c, a['org'])), 'Support overlaps an existing shift.', 409)
            require(not any(x['employee'] == r['employee'] and x['status'] == 'approved' and overlap(x, r) for x in self.rows(c, a['org'], 'support')), 'Employee is already committed to another support request.', 409)
            r['status'] = 'approved'
            self.put(c, a['org'], 'support', r)
            errors = self.validate(c, a['org'], [r])
            require(not errors, errors[0]['reason'] if errors else '')
        r.update(status=data['status'], home_approved_by=a['id'])
        self.put(c, a['org'], 'support', r)
        self.audit(c, a, f'support.{data["status"]}', r['id'])
        return r

    def bootstrap(self, c, a):
        org = repo(c).org_get(a['org'])
        allowed = self.scope(c, a)
        branches = [b for b in self.rows(c, a['org'], 'branch') if b['id'] in allowed]
        employees = [e for e in self.rows(c, a['org'], 'employee') if e['branch'] in allowed and (a['role'] != 'employee' or e['id'] == a['employee'])]
        repo(c).preload_ledger(a['org'],[e['id'] for e in employees],all_tenant=a['role'] in ('owner','admin'))
        balances = [self.leave_balance(c, a['org'], e['id']) for e in employees]
        leaves = [l for l in self.rows(c, a['org'], 'leave') if l['branch'] in allowed and (a['role'] != 'employee' or l['employee'] == a['employee'])]
        support = [] if a['role'] == 'employee' else [r for r in self.rows(c, a['org'], 'support') if r['from_branch'] in allowed or r['to_branch'] in allowed]
        directory = [] if a['role'] == 'employee' else [dict(id=b['id'], name=b['name'], country=b['country'], market=b['market'], area=b['area']) for b in self.rows(c, a['org'], 'branch')]
        members = [dict(r) | {'branches': json.loads(r['branches']), 'areas': json.loads(r['areas'])} for r in repo(c).member_rows(a['org'])] if a['role'] in ('owner', 'admin') else []
        from organization import hierarchy,policy_versions,calendar_view
        return dict(hierarchy=hierarchy(self,c,a),policies=policy_versions(self,c,a['org']),calendar=calendar_view(self,c,a,str(self.local_today(c,a['org']))),user=a, organization=dict(id=org['id'], name=org['name']), settings=self.org_settings(c,a['org']), branches=branches, directory=directory, employees=[self.public_employee(a,e) for e in employees], leaves=leaves, balances=balances, support=support, members=members)

    def analytics(self, c, a, week, branch=None, override=None):
        require(a['role'] != 'employee', 'Manager analytics are outside your role.', 403)
        allowed = self.scope(c, a, branch)
        branch_ids = {branch} if branch else allowed
        coverage, all_shifts, invalid = [], [], []
        snapshot = self.validation_snapshot(c, a['org'])
        for bid in branch_ids:
            schedule = self.schedule(c, a, bid, week)
            shifts = override if override is not None and bid == branch else schedule['shifts']
            all_shifts += shifts
            coverage += self.coverage(c, a['org'], bid, week, shifts)
            invalid += self.validate(c, a['org'], shifts, (bid, week), snapshot=snapshot)
        assignments = Counter()
        for s in all_shifts:
            assignments[s['employee']] += hours(s)
        employees = [e for e in self.rows(c, a['org'], 'employee') if e['branch'] in branch_ids]
        distribution = []
        from organization import planning_period,policy_from
        period = planning_period(self,c,a['org'],date.fromisoformat(week))
        policy = self.org_settings(c, a['org'],date.fromisoformat(week))
        leave_rows = snapshot['leaves']
        for e in employees:
            b = self.entity(c, a['org'], 'branch', e['branch'])
            zone = ZoneInfo(b['timezone'])
            start_day = date.fromisoformat(week)
            end_day = date.fromisoformat(period['end']) + timedelta(days=1)
            bound_start = local_instant(f'{start_day}T00:00', b['timezone'])
            bound_end = local_instant(f'{end_day}T00:00', b['timezone'])
            spans = []
            # Include the prior day's overnight window; clip both ends to the period.
            for offset in range(-1, period['days']):
                d = start_day + timedelta(days=offset)
                for w in e['availability'].get(str(d.weekday()), []):
                    try:
                        lo = max(bound_start,local_instant(f'{d}T{w["start"]}', b['timezone']))
                        hi = min(bound_end,local_instant(f'{d + timedelta(days=w["end"] <= w["start"])}T{w["end"]}', b['timezone']))
                        if lo < hi:
                            spans.append((lo,hi))
                    except Problem:
                        pass
            merged = []
            for lo,hi in sorted(spans):
                if merged and lo <= merged[-1][1]:
                    merged[-1] = (merged[-1][0],max(hi,merged[-1][1]))
                else:
                    merged.append((lo,hi))
            capacity = defaultdict(float)
            for cursor,finish in merged:
                while cursor < finish:
                    d = cursor.astimezone(zone).date()
                    stop = min(finish,local_instant(f'{d+timedelta(days=1)}T00:00',b['timezone']))
                    day_policy = policy_from(snapshot['policies'],d)['policy']
                    approved = any(l['employee']==e['id'] and l['status'] in ('approved','cancel_requested','partially_cancelled') and l['start']<=str(d)<=l['end'] for l in leave_rows)
                    if d.weekday() in day_policy['workdays'] and not approved:
                        capacity[d] += (stop-cursor).total_seconds()/3600
                    cursor = stop
            available = sum(min(value,policy_from(snapshot['policies'],day)['policy']['max_day_hours']) for day,value in capacity.items())
            assigned = assignments[e['id']]
            distribution.append(dict(employee=e['id'], name=e['name'], branch=e['branch'], available_hours=round(min(available, policy['max_week_hours'], e['contract_hours']), 2), assigned_hours=round(assigned, 2), contract_hours=e['contract_hours'], overtime_risk=assigned > e['contract_hours'], ratio=round(assigned / e['contract_hours'], 3)))
        required_hours = sum((stamp(g['end']) - stamp(g['start'])).total_seconds() / 3600 * g['required'] for g in coverage if g['start'])
        gap_hours = sum((stamp(g['end']) - stamp(g['start'])).total_seconds() / 3600 * g['gap'] for g in coverage if g['start'])
        rates = {e['id']: e['hourly_rate'] for e in self.rows(c, a['org'], 'employee')}
        cost = sum(hours(s) * rates[s['employee']] for s in all_shifts) if a['role'] in ('owner', 'admin') and all_shifts and all(rates.get(s['employee']) is not None for s in all_shifts) else None
        end = period['end']
        leaves = [l for l in self.rows(c, a['org'], 'leave') if l['branch'] in branch_ids and l['end'] >= week and l['start'] <= end]
        support = [r for r in self.rows(c, a['org'], 'support') if r['from_branch'] in branch_ids or r['to_branch'] in branch_ids]
        return dict(coverage=coverage, required_hours=round(required_hours, 2), gap_hours=round(gap_hours, 2), assigned_hours=round(sum(assignments.values()), 2), distribution=distribution, overtime_risk=sum(x['overtime_risk'] for x in distribution), fairness_spread=round(max((x['ratio'] for x in distribution), default=0) - min((x['ratio'] for x in distribution), default=0), 3), leave_outlook=leaves, support_requests=support, cost=round(cost, 2) if cost is not None else None, data_quality=dict(invalid_assignments=invalid, missing_rates=sum(e['hourly_rate'] is None for e in employees), inactive_employees=sum(not e['active'] for e in employees)))

    def seed(self, c, a):
        self.admin(a)
        require(not self.rows(c, a['org'], 'branch'), 'Demo setup only works in an empty organization.', 409)
        names = ['Alex Morgan', 'Sam Rivera', 'Jules Park', 'Casey Reed', 'Robin Hayes', 'Taylor Chen', 'Avery Patel', 'Jordan Ellis']
        branches = []
        for name, area in [('Northbank', 'Central'), ('Riverside', 'Central'), ('Westpoint', 'West')]:
            b = self.branch(c, a, dict(name=name, country='United Kingdom', market='London', area=area, coverage=[dict(start='09:00', end='17:00', role='associate', required=2), dict(start='09:00', end='17:00', role='lead', required=1)]))
            branches.append(b)
            for i, employee_name in enumerate(names):
                self.employee(c, a, dict(name=employee_name if len(branches) == 1 else f'{employee_name.split()[0]} {"Lane" if len(branches) == 2 else "Brooks"}', branch=b['id'], skills=['associate', 'lead'] if i < 2 else ['associate'], contract_hours=40, start_date=str(self.local_today(c, a['org']) - timedelta(days=90))))
        return dict(branches=branches, synthetic=True)

    def dispatch(self, token, method, path, data, query, csrf=None):
        from demand import assistant, demand_report, import_rows, normalize, save_policy
        if method == 'POST' and path == '/api/password':
            from identity import password_change
            return password_change(self,token,data,csrf)
        with self.connect() as c:
            if method != 'GET':
                repo(c).begin()
            a = self.actor(c, token)
            if method != 'GET':
                require(hmac.compare_digest(csrf or '', a['csrf']), 'Refresh your session before making changes.', 403)
            trial = getattr(self, 'workspace_trial', None)
            if trial is not None:
                if path == '/api/billing' and method == 'GET':
                    return trial.status(c, a)
                if path.startswith('/api/billing/'):
                    raise Problem('Billing checkout is not enabled. No payment will be taken.', 503)
                if path not in ('/api/me', '/api/signout', '/api/sessions', '/api/sessions/revoke', '/api/password'):
                    trial.check(c, a)
            fixture = getattr(self, 'billing_fixture', None)
            billing = fixture or getattr(self, 'billing_live', None)
            if billing is not None:
                if fixture and path == '/api/billing' and method == 'GET':
                    return billing.status(c, a)
                if fixture and path == '/api/billing/checkout' and method == 'POST':
                    return billing.checkout(c, a, data)
                if fixture and path == '/api/billing/portal' and method == 'POST':
                    return billing.portal(c, a)
                if fixture and path == '/api/billing/reconcile' and method == 'POST':
                    return billing.reconcile(c, a)
                if fixture and path == '/api/billing/reconcile-checkout' and method == 'POST':
                    return billing.reconcile_checkout(c, a)
                # Recovery and account controls stay available after expiry.
                if path not in ('/api/me', '/api/signout', '/api/sessions', '/api/password'):
                    billing.check(c, a)
            if path == '/api/sessions' and method == 'GET':
                from identity import sessions
                return sessions(c,a,token)
            if path == '/api/leave/ledger' and method == 'GET':
                from leave_ledger import ledger
                return ledger(self,c,a,query)
            if path == '/api/hierarchy' and method == 'GET':
                from organization import hierarchy
                return hierarchy(self,c,a)
            if path == '/api/calendar' and method == 'GET':
                from organization import calendar_view
                return calendar_view(self,c,a,query.get('day'))
            if path == '/api/me' and method == 'GET':
                if (trial is not None and not trial.access(c, a)) or (billing is not None and not billing.access(c, a)):
                    # Keep sign-in and billing recovery available without
                    # returning the ordinary roster/leave bootstrap.
                    return dict(user={k:a[k] for k in ('id','name','role','org','csrf')}, billing_required=True)
                return self.bootstrap(c, a)
            from identity import session_key
            if path == '/api/signout' and method == 'POST':
                repo(c).session_delete_token(session_key(token))
                return dict(signed_out=True)
            if path == '/api/schedule' and method == 'GET':
                require(a['role'] != 'employee', 'Branch drafts and rosters are available only to managers. Use your personal published feed.',403)
                return self.schedule(c, a, query.get('branch'), query.get('week'))
            if path == '/api/my-schedule' and method == 'GET':
                require(a['role'] == 'employee', 'Employee schedule feed requires an employee account.', 403)
                home = self.entity(c, a['org'], 'employee', a['employee'])
                home_branch = self.entity(c, a['org'], 'branch', home['branch'])
                week = query.get('week')
                calendar = self.schedule(c, a, home['branch'], week)
                lo = local_instant(f'{week}T00:00', home_branch['timezone'])
                hi = local_instant(f'{date.fromisoformat(calendar["period_end"]) + timedelta(days=1)}T00:00', home_branch['timezone'])
                shifts = []
                for row in repo(c).schedule_rows(a['org']):
                    for s in json.loads(row['published'] or '[]'):
                        if s['employee'] == a['employee'] and stamp(s['start']) < hi and lo < stamp(s['end']):
                            b = self.entity(c, a['org'], 'branch', row['branch'])
                            shifts.append(s | dict(branch_name=b['name'], timezone=b['timezone']))
                return dict(period_end=calendar['period_end'],period_days=calendar['period_days'],next_week=calendar['next_week'],previous_week=calendar['previous_week'],shifts=sorted(shifts, key=lambda x: x['start']), published=shifts, branch=home['branch'], week=week, state='published', revision=None)
            if path == '/api/versions' and method == 'GET':
                self.scope(c, a, query.get('branch'))
                require(a['role'] != 'employee', 'Version history is available to managers.', 403)
                return [dict(r) | {'shifts': json.loads(r['shifts'])} for r in repo(c).versions_rows(a['org'],query.get('branch'),query.get('week'))]
            if path == '/api/analytics' and method == 'GET':
                return self.analytics(c, a, query.get('week'), query.get('branch'))
            if path == '/api/demand' and method == 'GET':
                return demand_report(self, c, a, query.get('week'), query.get('branch'))
            if path == '/api/support-candidates' and method == 'GET':
                self.scope(c, a, query.get('to_branch'), True)
                # Only limited public-within-tenant candidate fields; no balances, availability or schedules.
                return [dict(id=e['id'], name=e['name'], branch=e['branch'], skills=e['skills']) for e in self.rows(c, a['org'], 'employee') if e['active'] and e['branch'] != query.get('to_branch')]
            if method == 'POST':
                demand_handlers = {'/api/demand/preview': normalize, '/api/demand/import': import_rows, '/api/labor-policy': save_policy, '/api/assistant': assistant}
                if path in demand_handlers:
                    return demand_handlers[path](self, c, a, data)
                handlers = {'/api/branches': self.branch, '/api/employees': self.employee, '/api/members': self.member, '/api/schedule': self.save_schedule, '/api/generate': self.generate, '/api/leave': self.leave, '/api/leave/decide': self.leave_decide, '/api/support': self.support, '/api/support/decide': self.support_decide}
                if path in handlers:
                    return handlers[path](c, a, data)
                if path in ('/api/sessions/revoke','/api/members/update'):
                    from identity import revoke,member_update
                    return {'/api/sessions/revoke':revoke,'/api/members/update':member_update}[path](self,c,a,data)
                if path == '/api/leave/cancel':
                    from leave_ledger import cancel
                    return cancel(self,c,a,data)
                if path == '/api/leave/adjust':
                    from leave_ledger import adjust
                    return adjust(self,c,a,data)
                if path == '/api/demo':
                    return self.seed(c, a)
                if path == '/api/settings':
                    from organization import save_settings
                    return save_settings(self,c,a,data)
                if path == '/api/hierarchy':
                    from organization import hierarchy_save
                    return hierarchy_save(self,c,a,data)
                if path == '/api/availability':
                    e = self.entity(c, a['org'], 'employee', data.get('id'))
                    self.scope(c, a, e['branch'])
                    require(a['role'] != 'employee' or e['id'] == a['employee'], 'You can change only your own availability.', 403)
                    # Reuse schema validation; employee may only change availability.
                    manager = a | dict(role='branch_manager')
                    result = self.employee(c, manager, e | dict(availability=data.get('availability')))
                    errors = self.validate(c, a['org'], [s for s in self.all_shifts(c, a['org']) if s['employee'] == e['id']], context=[])
                    require(not errors, 'Availability conflicts with existing assignments. Ask a manager to update those first.', 409)
                    return result
            raise Problem('Endpoint not found.', 404)
