from repository import repo
"""Tenant-owned geographic entities and effective-dated business calendars."""
import calendar
import json
import time
from datetime import date, timedelta
from core import Problem, require, text, uid, settings, week_start

KINDS = ('country', 'market', 'area')


def parse_day(value):
    try:
        return date.fromisoformat(value)
    except (ValueError, TypeError):
        raise Problem('Use an ISO calendar date.') from None


def hierarchy_save(service, c, actor, data):
    service.admin(actor)
    kind = data.get('kind')
    require(kind in KINDS, 'Choose country, market, or area.')
    ident = data.get('id') or uid()
    old = service.entity(c, actor['org'], kind, ident) if data.get('id') else None
    parent = None
    if kind != 'country':
        parent = text(data.get('parent'), 'Parent ID')
        service.entity(c, actor['org'], KINDS[KINDS.index(kind)-1], parent)
    name = text(data.get('name'), f'{kind.title()} name')
    require(not any(node['id'] != ident and node['name'].casefold() == name.casefold() and node.get('parent') == parent for node in service.rows(c, actor['org'], kind)), 'That name already exists under this parent.', 409)
    if old:
        require(old.get('parent') == parent, 'Create a new hierarchy node to move locations; existing parent relationships are immutable.')
    result = service.put(c, actor['org'], kind, dict(id=ident, name=name, parent=parent))
    refresh_labels(service, c, actor['org'])
    service.audit(c, actor, f'hierarchy.{kind}.save', ident)
    return result


def resolve_labels(service, c, org, data):
    if data.get('area_id'):
        area = service.entity(c, org, 'area', data['area_id'])
        market = service.entity(c, org, 'market', area['parent'])
        country = service.entity(c, org, 'country', market['parent'])
        return dict(area_id=area['id'], market_id=market['id'], country_id=country['id'], area=area['name'], market=market['name'], country=country['name'])
    parent, result = None, {}
    # Compatibility adapter converts old labels to canonical first-class nodes.
    for kind in KINDS:
        name = text(data.get(kind), kind.title())
        node = next((n for n in service.rows(c, org, kind) if n['name'].casefold() == name.casefold() and n.get('parent') == parent), None)
        node = node or service.put(c, org, kind, dict(id=uid(), name=name, parent=parent))
        result[kind], result[f'{kind}_id'] = node['name'], node['id']
        parent = node['id']
    return result


def refresh_labels(service, c, org):
    for branch in service.rows(c, org, 'branch'):
        service.put(c, org, 'branch', branch | resolve_labels(service, c, org, branch))


def hierarchy(service, c, actor):
    allowed = service.scope(c, actor)
    branches = [b for b in service.rows(c, actor['org'], 'branch') if b['id'] in allowed]
    result = {}
    for kind in KINDS:
        visible = {b.get(f'{kind}_id') for b in branches}
        result['countries' if kind == 'country' else f'{kind}s'] = sorted([n for n in service.rows(c, actor['org'], kind) if actor['role'] in ('owner', 'admin') or n['id'] in visible], key=lambda n: n['name'].casefold())
    return result | dict(branches=branches)


def policy_versions(service, c, org):
    return [dict(r) | dict(policy=json.loads(r['policy'])) for r in repo(c).policy_rows(org)]


def policy_at(service, c, org, day):
    rows = policy_versions(service, c, org)
    eligible = [r for r in rows if r['effective'] <= str(day)]
    return eligible[-1] if eligible else dict(effective='0001-01-01', revision=0, policy=json.loads(repo(c).org_get(org)['settings']))


def policy_from(rows, day):
    return next(r for r in reversed(rows) if r['effective'] <= str(day))


def planning_period(service, c, org, day):
    return planning_from(policy_versions(service,c,org),day)


def planning_from(rows, day):
    version = policy_from(rows, day)
    start = week_start(day, version['policy']['week_start'])
    natural_end = start+timedelta(days=7)
    changes = [r for i, r in enumerate(rows[1:], 1) if r['policy']['week_start'] != rows[i-1]['policy']['week_start']]
    previous = [parse_day(r['effective']) for r in changes if r['effective'] <= str(day)]
    if previous:
        start = max(start, max(previous))
    end = natural_end
    future = [parse_day(r['effective']) for r in rows if str(start) < r['effective'] < str(end) and r['policy']['week_start'] != version['policy']['week_start']]
    if future:
        end = min(future)
    return dict(start=str(start), end=str(end-timedelta(days=1)), days=(end-start).days, next=str(end), previous=str(start-timedelta(days=1)))


def fiscal_period(service, c, org, day):
    rows = policy_versions(service, c, org)
    version = policy_at(service, c, org, day)
    p = version['policy']
    anchor = date(day.year, p['fiscal_start_month'], p.get('fiscal_start_day', 1))
    start = anchor if day >= anchor else anchor.replace(year=day.year-1)
    end = start.replace(year=start.year+1)
    keys = ('fiscal_start_month', 'fiscal_start_day')
    for i, r in enumerate(rows[1:], 1):
        if any(r['policy'].get(k, 1) != rows[i-1]['policy'].get(k, 1) for k in keys):
            boundary = parse_day(r['effective'])
            if boundary <= day:
                start = max(start, boundary)
            elif boundary < end:
                end = boundary
    return start, end


def pay_period(policy, day):
    cycle = policy['pay_cycle']
    anchor = parse_day(policy['pay_anchor'])
    if cycle in ('weekly', 'fortnightly'):
        length = 7 if cycle == 'weekly' else 14
        start = anchor + timedelta(days=((day-anchor).days // length) * length)
        end = start + timedelta(days=length)
    elif cycle == 'semimonthly':
        split = policy['pay_split_day']
        start = day.replace(day=1 if day.day < split else split)
        end = day.replace(day=split) if day.day < split else (day.replace(day=28)+timedelta(days=4)).replace(day=1)
    else:
        start = day.replace(day=anchor.day)
        if day < start:
            start = (day.replace(day=1)-timedelta(days=1)).replace(day=anchor.day)
        end = (start.replace(day=28)+timedelta(days=4)).replace(day=anchor.day)
    return dict(start=str(start), end=str(end-timedelta(days=1)), cycle=cycle)


def calendar_view(service, c, actor, value):
    day = parse_day(value or str(service.local_today(c,actor['org'])))
    version = policy_at(service, c, actor['org'], day)
    start, end = fiscal_period(service, c, actor['org'], day)
    pay = pay_period(version['policy'],day)
    rows = policy_versions(service,c,actor['org'])
    for i,r in enumerate(rows[1:],1):
        if any(r['policy'][k] != rows[i-1]['policy'][k] for k in ('pay_cycle','pay_anchor','pay_split_day')):
            boundary = r['effective']
            if boundary <= str(day):
                pay['start'] = max(pay['start'],boundary)
            elif boundary <= pay['end']:
                pay['end'] = str(parse_day(boundary)-timedelta(days=1))
    return dict(on=str(day), planning=planning_period(service,c,actor['org'],day), fiscal=dict(start=str(start),end=str(end-timedelta(days=1))), pay=pay, policy=version)


def save_settings(service, c, actor, data):
    service.admin(actor)
    store=repo(c)
    store.fence_policy(actor['org'])
    history = store.schedule_exists(actor['org']) or service.rows(c,actor['org'],'leave') or store.ledger_exists(actor['org'])
    effective = parse_day(data.get('effective', str(service.local_today(c,actor['org'])) if history else '0001-01-01'))
    old = policy_at(service,c,actor['org'],effective)['policy']
    new = settings(old | data)
    require(not history or effective >= service.local_today(c,actor['org']), 'Policies with history cannot be backdated.')
    require(old['week_start'] == new['week_start'] or effective.weekday() == new['week_start'] or not history, 'Activate a changed week start on the new first weekday.')
    if history and any(old[k] != new[k] for k in ('fiscal_start_month','fiscal_start_day','leave_accrual')):
        require(effective.month == new['fiscal_start_month'] and effective.day == new['fiscal_start_day'], 'Fiscal calendar/accrual-mode changes must begin a new configured fiscal period.')
    if effective == date.min and not history:
        store.policy_delete_baseline(actor['org'])
    require(not any(r['effective']==str(effective) for r in store.policy_rows(actor['org'])), 'A policy already exists on this effective date. Choose another date.',409)
    revision = max((r['revision'] for r in store.policy_rows(actor['org'])),default=0)+1
    store.policy_add(dict(org=actor['org'],effective=str(effective),revision=revision,policy=json.dumps(new),actor=actor['id'],created=time.time()))
    # Reject a transition that would orphan a saved shift in its historical week or invalidate it.
    affected=[]
    for row in store.schedule_rows(actor['org']):
        b=service.entity(c,actor['org'],'branch',row['branch'])
        from core import stamp
        from zoneinfo import ZoneInfo
        for s in json.loads(row['shifts'])+json.loads(row['published'] or '[]'):
            local=stamp(s['start']).astimezone(ZoneInfo(b['timezone'])).date()
            if local >= effective:
                require(planning_period(service,c,actor['org'],local)['start']==row['week'], 'Policy transition conflicts with saved weeks. Reschedule affected commitments or choose a later effective date.',409)
                affected.append(s)
    # Unique commitments prevent duplicate draft/published reservations from counting twice.
    unique=list({(s['employee'],s['start'],s['end'],s['role']):s for s in affected}.values())
    keys = {(s['employee'],s['start'],s['end'],s['role']) for s in unique}
    context = [s for s in service.all_shifts(c,actor['org'],employee_ids={s['employee'] for s in unique}) if (s['employee'],s['start'],s['end'],s['role']) not in keys]
    errors=service.validate(c,actor['org'],unique,context=context)
    require(not errors, f'Policy would invalidate committed shifts: {errors[0]["reason"]}' if errors else '',409)
    from leave_ledger import assert_funded
    for employee in store.ledger_employees(actor['org']):
        assert_funded(service,c,actor['org'],service.entity(c,actor['org'],'employee',employee))
    service.audit(c,actor,'policy.create',str(effective))
    return dict(effective=str(effective),revision=revision,policy=new)
