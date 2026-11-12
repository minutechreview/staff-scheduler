"""Transparent demand adapter: no ML, model calls, external integrations or invented peaks."""
import csv
import io
import math
from itertools import islice
from zoneinfo import ZoneInfo
from datetime import date, timedelta

from core import Problem, hours, iso, local_instant, require, stamp, uid


def normalize(service, c, actor, data):
    branch = data.get('branch')
    service.scope(c, actor, branch, True)
    b = service.entity(c, actor['org'], 'branch', branch)
    rows = data.get('rows')
    if data.get('csv'):
        require(isinstance(data['csv'], str) and len(data['csv']) <= 1_000_000, 'CSV is too large.')
        try:
            rows = list(islice(csv.DictReader(io.StringIO(data['csv'])),10001))
        except csv.Error:
            raise Problem('Malformed CSV or field exceeds the supported size.') from None
    require(isinstance(rows, list) and 0 < len(rows) <= 10000, 'Import 1–10,000 rows.')
    normalized, errors, seen = [], [], set()
    existing = {r['key'] for r in service.rows(c, actor['org'], 'demand') if r['branch'] == branch}
    for index, row in enumerate(rows):
        try:
            require(isinstance(row,dict),'Each demand row must be an object.')
            granularity = row.get('granularity', 'interval')
            require(granularity in ('interval', 'day', 'week'), 'Granularity must be interval, day, or week.')
            kind = row.get('kind', 'forecast')
            require(kind in ('actual', 'forecast'), 'Kind must be actual or forecast.')
            require(row.get('units', 'transactions') == 'transactions', 'Units must be transactions.')
            raw = row.get('transactions')
            value = float(raw)
            require(math.isfinite(value) and 0 <= value <= 1_000_000_000 and value.is_integer(), 'Transactions must be a whole number from 0 to 1,000,000,000.')
            start = local_instant(row.get('start', ''), b['timezone'])
            end = local_instant(row.get('end', ''), b['timezone'])
            length = (end - start).total_seconds() / 3600
            require(length > 0 and length <= 169, 'Period must have positive duration, no longer than one week.')
            if granularity == 'interval':
                require(length in (.25, .5, 1), 'Intervals must last 15, 30, or 60 minutes.')
            else:
                a, z = start.astimezone(ZoneInfo(b['timezone'])), end.astimezone(ZoneInfo(b['timezone']))
                require(a.strftime('%H:%M:%S') == '00:00:00' and z.strftime('%H:%M:%S') == '00:00:00', 'Day/week periods must start and end at branch-local midnight.')
                require((z.date() - a.date()).days == (1 if granularity == 'day' else 7), 'Day/week rows must span one/seven local calendar days, including DST changes.')
            role = row.get('role', 'associate')
            require(isinstance(role,str),'Role must be text.')
            role = role.strip()
            require(0 < len(role) <= 40, 'Role is required.')
            key = '|'.join([branch, iso(start), iso(end), kind, role])
            require(key not in seen and key not in existing, 'Duplicate period/kind/role. Existing data is not overwritten.')
            seen.add(key)
            normalized.append(dict(id=uid(), key=key, branch=branch, timezone=b['timezone'], start=iso(start), end=iso(end), transactions=int(value), kind=kind, granularity=granularity, role=role, units='transactions'))
        except (Problem, ValueError, TypeError) as error:
            errors.append(dict(row=index + 2, error=str(error)))
    return dict(rows=normalized, errors=errors, valid=not errors, timezone=b['timezone'], duplicate_policy='reject', saved=False)


def import_rows(service, c, actor, data):
    preview = normalize(service, c, actor, data)
    require(preview['valid'], 'Fix import errors before confirming. No rows were saved.')
    require(data.get('confirm') is True, 'Preview and explicitly confirm the import first.')
    for r in preview['rows']:
        service.put(c, actor['org'], 'demand', r)
    service.audit(c, actor, 'demand.import', data['branch'])
    return preview | dict(saved=True)


def save_policy(service, c, actor, data):
    branch = data.get('branch')
    service.scope(c, actor, branch, True)
    service.entity(c, actor['org'], 'branch', branch)
    existing = [p for p in service.rows(c, actor['org'], 'labor_policy') if p['branch'] == branch]
    baseline = existing[0] if existing else None
    tph = data.get('transactions_per_hour')
    require(type(tph) in (int, float) and math.isfinite(tph) and 0.01 <= tph <= 10000, 'Configure a transactions-per-labor-hour target from 0.01 to 10,000.')
    denominator = data.get('denominator')
    require(denominator in ('scheduled_paid_hours', 'scheduled_productive_hours'), 'Choose an explicit scheduled-hours denominator.')
    # Local shifts currently have no breaks/training segments. Productive must have an explicit factor.
    factor = data.get('productive_factor', 1)
    require(type(factor) in (int, float) and math.isfinite(factor) and 0.01 <= factor <= 1, 'Productive factor must be from 0.01 to 1.')
    if denominator == 'scheduled_paid_hours':
        factor = 1
    if actor['role'] == 'branch_manager':
        require(baseline is not None, 'An area manager must approve a baseline first.', 403)
        deviation = abs(tph - baseline['baseline_tph']) / baseline['baseline_tph'] * 100
        require(deviation <= baseline['allowed_override_percent'], 'This override exceeds the area-approved range.', 403)
        require(denominator == baseline['denominator'] and factor == baseline['productive_factor'], 'A branch cannot override the approved denominator.', 403)
        p = baseline | dict(transactions_per_hour=tph, overridden_by=actor['id'])
    else:
        require(actor['role'] in ('owner', 'admin', 'area_manager'), 'This role cannot set labor policy.', 403)
        limit = data.get('allowed_override_percent', 0)
        require(type(limit) in (int, float) and 0 <= limit <= 50, 'Override range must be 0–50%.')
        p = dict(id=branch, branch=branch, transactions_per_hour=tph, baseline_tph=tph, denominator=denominator, productive_factor=factor, allowed_override_percent=limit, approved_by=actor['id'], role=data.get('role', 'associate'))
    service.put(c, actor['org'], 'labor_policy', p)
    service.audit(c, actor, 'labor_policy.save', branch)
    return p


def targets(service, c, org, branch, week):
    policies = [p for p in service.rows(c, org, 'labor_policy') if p['branch'] == branch]
    if not policies:
        return []
    p = policies[0]
    b = service.entity(c, org, 'branch', branch)
    lo = local_instant(f'{week}T00:00', b['timezone'])
    from organization import planning_period
    period=planning_period(service,c,org,date.fromisoformat(week))
    hi = local_instant(f'{date.fromisoformat(period["end"]) + timedelta(days=1)}T00:00', b['timezone'])
    result = []
    for r in service.rows(c, org, 'demand'):
        if r['branch'] != branch or r['kind'] != 'forecast' or r['granularity'] != 'interval' or r['role'] != p['role'] or not lo <= stamp(r['start']) < hi:
            continue
        if stamp(r['start']).astimezone(ZoneInfo(b['timezone'])).weekday() not in service.org_settings(c,org,stamp(r['start']).astimezone(ZoneInfo(b['timezone'])).date())['workdays']:
            continue
        length = (stamp(r['end']) - stamp(r['start'])).total_seconds() / 3600
        needed = math.ceil(r['transactions'] / (p['transactions_per_hour'] * length * p['productive_factor']))
        result.append(dict(start=r['start'], end=r['end'], role=r['role'], required=needed, source=r['id'], assumption='Imported forecast; configured baseline; no learned forecast.'))
    return result


def demand_report(service, c, actor, week, branch=None):
    allowed = {branch} if branch else service.scope(c, actor)
    service.scope(c, actor, branch)
    require(actor['role'] != 'employee', 'Demand reporting is available to managers.', 403)
    records = []
    for bid in allowed:
        b = service.entity(c, actor['org'], 'branch', bid)
        lo = local_instant(f'{week}T00:00', b['timezone'])
        from organization import planning_period
        period=planning_period(service,c,actor['org'],date.fromisoformat(week))
        hi = local_instant(f'{date.fromisoformat(period["end"]) + timedelta(days=1)}T00:00', b['timezone'])
        schedule = service.schedule(c, actor, bid, week)
        for r in service.rows(c, actor['org'], 'demand'):
            if r['branch'] != bid or stamp(r['start']) >= hi or stamp(r['end']) <= lo:
                continue
            paid = 0
            for s in schedule['shifts']:
                if s['role'] == r['role']:
                    start, end = max(stamp(s['start']), stamp(r['start'])), min(stamp(s['end']), stamp(r['end']))
                    paid += max(0, (end - start).total_seconds() / 3600)
            # Ratio against scheduled hours is always projected, even when numerator is actual.
            records.append(r | dict(scheduled_paid_hours=round(paid, 2), transactions_per_scheduled_hour=round(r['transactions'] / paid, 2) if paid else None, ratio_label='Transactions / scheduled paid hours (not worked-hours productivity)'))
    return dict(records=records, policies=[p for p in service.rows(c, actor['org'], 'labor_policy') if p['branch'] in allowed], targets=[t | dict(branch=bid) for bid in allowed for t in targets(service, c, actor['org'], bid, week)], limitations=['Day/week totals do not establish hourly peaks.', 'Actual productivity needs actual worked hours; this adapter stores scheduled hours only.', 'Minimum and skill coverage still apply when transaction demand is zero.'])


def assistant(service, c, actor, data):
    import time
    from datetime import datetime, timezone
    question = str(data.get('question', '')).strip().lower()
    require(0 < len(question) <= 1000, 'Ask a question of up to 1,000 characters.')
    try:
        start = date.fromisoformat(data.get('start', str(date.today().replace(day=1))))
        end = date.fromisoformat(data.get('end', str(date.today())))
    except (ValueError, TypeError):
        raise Problem('Choose valid source dates.') from None
    require(start <= end and (end - start).days <= 366, 'Choose a date range of up to one year.')
    allowed = service.scope(c, actor)
    employees = {e['id']: e for e in service.rows(c, actor['org'], 'employee') if e['branch'] in allowed and (actor['role'] != 'employee' or e['id'] == actor['employee'])}
    leaves = [l for l in service.rows(c, actor['org'], 'leave') if l['employee'] in employees and l['status'] in ('approved','cancel_requested','partially_cancelled') and l['start'] <= str(end) and l['end'] >= str(start)]
    answer, records, source = '', [], ''
    if any(word in question for word in ('change', 'assign', 'publish', 'delete', 'approve', 'move', 'schedule a')):
        answer = 'This assistant is read-only. Use the normal schedule or request workflow to review and authorize changes.'
        source = 'Assistant capability policy'
    elif 'sick' in question:
        # No sickness category exists yet; never infer from free-text leave reason.
        answer = 'Current sickness cannot be determined: this adapter has no authorized sickness-status records. Leave reasons are never used to infer medical status.'
        source = 'Leave schema / data-quality check'
    elif 'leave' in question or 'off' in question:
        records = [dict(name=employees[l['employee']]['name'], branch=l['branch'], start=l['start'], end=l['end'], status=l['status']) for l in leaves]
        answer = f'{len(records)} approved leave request(s) overlap this range across your authorized employees.'
        source = 'Approved leave records (reasons excluded)'
    elif any(word in question for word in ('quiet', 'busy', 'transaction')):
        require(actor['role'] != 'employee', 'Demand records are outside your role.', 403)
        branches = {b['id']: b for b in service.rows(c, actor['org'], 'branch')}
        records = [dict(branch=r['branch'], start=r['start'], end=r['end'], transactions=r['transactions'], granularity=r['granularity'], role=r['role'], transactions_per_elapsed_hour=round(r['transactions']/hours(r), 2)) for r in service.rows(c, actor['org'], 'demand') if r['branch'] in allowed and r['kind'] == 'actual' and stamp(r['start']).astimezone(ZoneInfo(branches[r['branch']]['timezone'])).date() <= end and stamp(r['end']).astimezone(ZoneInfo(branches[r['branch']]['timezone'])).date() >= start]
        if not records:
            answer = 'No actual transaction data exists for this range. Quieter periods cannot be determined from schedules or forecasts alone.'
        else:
            groups = {}
            for record in records:
                key = (record['branch'], record['role'], record['granularity'], hours(record))
                groups.setdefault(key, []).append(record)
            comparable = [group for group in groups.values() if len(group) > 1]
            if comparable:
                records = [min(group, key=lambda r: r['transactions_per_elapsed_hour']) for group in comparable]
                answer = f'{len(records)} lowest-transaction period(s) shown within matching branch/role/duration groups. These use actual imported counts per elapsed hour, not staffing or forecasts. Weekly/day records cannot establish hourly peaks.'
            else:
                answer = 'Actual records are available, but there are no matching branch/role/duration groups to rank quieter periods.'
        source = 'Imported actual transaction records only'
    elif 'surplus' in question or 'coverage' in question:
        require(actor['role'] != 'employee', 'Coverage analytics are outside your role.', 403)
        from organization import planning_period
        report = service.analytics(c, actor, planning_period(service,c,actor['org'],start)['start'])
        records = [r for r in report['coverage'] if r['scheduled'] > r['required'] and str(start) <= r['date'] <= str(end)]
        answer = f'{len(records)} interval(s) have staffing above configured role minimums in the selected starting week. This is coverage surplus, not proof of quiet business demand.'
        source = 'Draft interval coverage and configured minima (starting week only)'
    elif 'count' in question or 'people' in question or 'employee' in question:
        answer = f'{sum(e["active"] for e in employees.values())} active employee(s) across {len(allowed)} assigned branch(es).'
        source = 'Authorized employee roster'
    else:
        answer = 'I can show approved leave, employee counts, coverage surplus, and actual-demand records. Choose source dates. An external language model is unconfigured; answers use local deterministic queries.'
        source = 'Assistant capability policy'
    return dict(answer=answer, records=records, source=source, start=str(start), end=str(end), scope=dict(role=actor['role'], branches=sorted(allowed)), refreshed_at=datetime.now(timezone.utc).isoformat(), adapter='local deterministic queries', model_state='unconfigured', read_only=True)
