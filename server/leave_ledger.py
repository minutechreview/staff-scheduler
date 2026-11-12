from repository import repo
"""Annual leave: immutable credits, dated reservations, releases and projections.

Accrual is a configured business rule, never an assertion about a jurisdiction.
GETs project unposted credits; writes materialize credits earned through today.
"""
import json
import time
from datetime import date,timedelta
from decimal import Decimal,ROUND_HALF_UP
from core import Problem,require,text,uid,local_instant,iso,overlap
from organization import parse_day,policy_at,fiscal_period

ACTIVE = ('approved','cancel_requested','partially_cancelled')


def amount(value):
    return Decimal(str(value)).quantize(Decimal('.0001'),rounding=ROUND_HALF_UP)


def charges(service,c,org,start,end):
    lo,hi=parse_day(start),parse_day(end)
    require(lo<=hi and (hi-lo).days<366,'Leave must be 1–366 calendar days.')
    return [str(lo+timedelta(days=i)) for i in range((hi-lo).days+1) if (lo+timedelta(days=i)).weekday() in service.org_settings(c,org,lo+timedelta(days=i))['leave_workdays']]


def events(service,c,org,employee,start,end,on):
    join=parse_day(employee.get('start_date','1970-01-01'))
    if join>=end or on<join:
        return []
    p=service.org_settings(c,org,start)
    mode=p['leave_accrual']
    result=[]
    if mode=='annual_upfront':
        day=max(start,join)
        policy=policy_at(service,c,org,day)
        grant=Decimal(str(policy['policy']['annual_leave_days']))
        if policy['policy'].get('leave_prorate_joiners') and join>start:
            grant*=Decimal((end-join).days)/Decimal((end-start).days)
        if day<=on:
            result.append(dict(effective=str(day),days=float(amount(grant)),kind='accrual',source=f'accrual/{start}/{day}/annual',policy_revision=policy['revision']))
    elif mode=='monthly':
        for month in range(12):
            year=start.year+(start.month-1+month)//12
            m=(start.month-1+month)%12+1
            day=date(year,m,start.day)
            if day<join or day>=end or day>on:
                continue
            policy=policy_at(service,c,org,day)
            annual=Decimal(str(policy['policy']['annual_leave_days']))
            credit=amount(annual*Decimal(month+1)/12)-amount(annual*Decimal(month)/12)
            result.append(dict(effective=str(day),days=float(credit),kind='accrual',source=f'accrual/{start}/{day}/monthly',policy_revision=policy['revision']))
    else:
        for i in range((min(on,end-timedelta(days=1))-max(start,join)).days+1):
            day=max(start,join)+timedelta(days=i)
            policy=policy_at(service,c,org,day)
            annual=Decimal(str(policy['policy']['annual_leave_days']))
            index=(day-start).days
            credit=amount(annual*Decimal(index+1)/(end-start).days)-amount(annual*Decimal(index)/(end-start).days)
            result.append(dict(effective=str(day),days=float(credit),kind='accrual',source=f'accrual/{start}/{day}/daily',policy_revision=policy['revision']))
    return result


def rows(c,org,employee,start,end):
    return repo(c).ledger_rows(org,employee,start,end)


def credits(service,c,org,employee,start,end,on,depth=0):
    require(depth<100,'Carryover history exceeds the local supported 100-period projection.')
    expected=events(service,c,org,employee,start,end,on)
    stored=rows(c,org,employee['id'],start,end)
    posted={r['source']:r for r in stored if r['kind'] in ('accrual','carryover')}
    result=[posted.get(r['source'],r) for r in expected]
    p=service.org_settings(c,org,start)
    if p['max_carryover_days'] and parse_day(employee.get('start_date','1970-01-01'))<start:
        previous=start-timedelta(days=1)
        ps,pe=fiscal_period(service,c,org,previous)
        oldcredits=credits(service,c,org,employee,ps,pe,previous,depth+1)
        oldrows=rows(c,org,employee['id'],ps,pe)
        leftover=sum(amount(r['days']) for r in oldcredits)+sum(amount(r['days']) for r in oldrows if r['kind'] not in ('accrual','carryover'))
        carry=min(amount(p['max_carryover_days']),max(Decimal(0),leftover))
        if carry and start<=on:
            r=dict(effective=str(start),days=float(carry),kind='carryover',source=f'carryover/{start}',policy_revision=policy_at(service,c,org,start)['revision'])
            result.append(posted.get(r['source'],r))
    return result


def post(c,org,employee,event,actor,reason,leave_id=None):
    existing=repo(c).ledger_source(org,employee,event['source'])
    if existing:
        require(amount(existing['days'])==amount(event['days']) and existing['effective']==event['effective'] and existing['kind']==event['kind'] and (event['kind']!='adjustment' or existing['reason']==reason),'This idempotency key has different content.',409)
        return dict(existing)
    entry=dict(id=uid(),org=org,employee=employee,effective=event['effective'],kind=event['kind'],days=float(amount(event['days'])),source=event['source'],policy_revision=event.get('policy_revision'),leave_id=leave_id,actor=actor,reason=reason,created=time.time())
    repo(c).fence(org,{employee})
    repo(c).ledger_add(entry)
    return entry


def materialize(service,c,org,employee,on,actor):
    start,end=fiscal_period(service,c,org,on)
    for event in credits(service,c,org,employee,start,end,on):
        if 'id' not in event:
            post(c,org,employee['id'],event,actor,'Configured leave accrual/carryover')


def balance(service,c,org,employee_id,on=None):
    employee=service.entity(c,org,'employee',employee_id)
    on=on or service.local_today(c,org,employee)
    start,end=fiscal_period(service,c,org,on)
    policy=service.org_settings(c,org,on)
    stored=rows(c,org,employee_id,start,end)
    earned=credits(service,c,org,employee,start,end,on)
    full=credits(service,c,org,employee,start,end,end-timedelta(days=1))
    adjustments=sum(amount(r['days']) for r in stored if r['kind']=='adjustment' and r['effective']<=str(on))
    all_adjustments=sum(amount(r['days']) for r in stored if r['kind']=='adjustment')
    movement=[r for r in stored if r['kind'] in ('reserve','release')]
    booked=-sum(amount(r['days']) for r in movement)
    consumed=-sum(amount(r['days']) for r in movement if r['effective']<=str(on))
    future=booked-consumed
    pending=sum(sum(str(start)<=day<str(end) for day in l.get('charge_days',charges(service,c,org,l['start'],l['end']))) for l in service.rows(c,org,'leave') if l['employee']==employee_id and l['status']=='pending')
    earned_amount=sum(amount(r['days']) for r in earned if r['kind']=='accrual')
    carry=sum(amount(r['days']) for r in earned if r['kind']=='carryover')
    return dict(employee=employee_id,on=str(on),period_start=str(start),period_end=str(end-timedelta(days=1)),allowance=policy['annual_leave_days'],accrual=policy['leave_accrual'],earned=float(earned_amount),carryover=float(carry),adjusted=float(adjustments),used=float(booked),consumed=float(consumed),reserved=float(future),pending=pending,remaining=float(earned_amount+carry+adjustments-booked),projected_remaining=float(sum(amount(r['days']) for r in full)+all_adjustments-booked))


def assert_funded(service,c,org,employee):
    records=repo(c).ledger_rows(org,employee['id'],non_credit=True)
    periods={fiscal_period(service,c,org,parse_day(r['effective'])) for r in records}
    for start,end in periods:
        moves=[r for r in records if str(start)<=r['effective']<str(end)]
        future=credits(service,c,org,employee,start,end,end-timedelta(days=1))
        days=sorted({r['effective'] for r in moves+future})
        running=Decimal(0)
        for day in days:
            running+=sum(amount(r['days']) for r in moves+future if r['effective']==day)
            require(running>=Decimal('-.0001'),'Insufficient accrued/projected leave balance on '+day+'.',409)


def reserve(service,c,actor,leave):
    employee=service.entity(c,actor['org'],'employee',leave['employee'])
    materialize(service,c,actor['org'],employee,service.local_today(c,actor['org'],employee),actor['id'])
    for day in leave['charge_days']:
        post(c,actor['org'],employee['id'],dict(effective=day,days=-1,kind='reserve',source=f'leave/{leave["id"]}/{day}/reserve',policy_revision=policy_at(service,c,actor['org'],parse_day(day))['revision']),actor['id'],'Approved annual leave',leave['id'])
    assert_funded(service,c,actor['org'],employee)


def ledger(service,c,actor,query):
    employee=service.entity(c,actor['org'],'employee',query.get('employee'))
    service.scope(c,actor,employee['branch'])
    require(actor['role']!='employee' or actor['employee']==employee['id'],'You can read only your own leave ledger.',403)
    on=parse_day(query.get('on',str(service.local_today(c,actor['org'],employee))))
    start,end=fiscal_period(service,c,actor['org'],on)
    stored=rows(c,actor['org'],employee['id'],start,end)
    posted={r['source'] for r in stored}
    projections=[r|dict(projected=True) for r in credits(service,c,actor['org'],employee,start,end,on) if r['source'] not in posted]
    return dict(balance=balance(service,c,actor['org'],employee['id'],on),entries=stored,unposted_earned=projections)


def adjust(service,c,actor,data):
    service.admin(actor)
    employee=service.entity(c,actor['org'],'employee',data.get('employee'))
    require(type(data.get('days')) in (int,float) and 0<abs(data['days'])<=366,'Adjustment must be a nonzero number within ±366 days.')
    reason=text(data.get('reason'),'Adjustment reason',500)
    effective=parse_day(data.get('effective'))
    source='adjustment/'+text(data.get('idempotency_key'),'Idempotency key',120)
    materialize(service,c,actor['org'],employee,service.local_today(c,actor['org'],employee),actor['id'])
    result=post(c,actor['org'],employee['id'],dict(effective=str(effective),days=data['days'],kind='adjustment',source=source),actor['id'],reason)
    assert_funded(service,c,actor['org'],employee)
    service.audit(c,actor,'leave.adjust',result['id'])
    return result


def cancel(service,c,actor,data):
    leave=service.entity(c,actor['org'],'leave',data.get('id'))
    service.scope(c,actor,leave['branch'])
    require(actor['role']!='employee' or actor['employee']==leave['employee'],'You can cancel only your own leave.',403)
    require(leave['status'] in ('pending','approved','cancel_requested','partially_cancelled'),'This leave request cannot be cancelled again.',409)
    if data.get('decision')=='reject':
        service.scope(c,actor,leave['branch'],True)
        require(leave['status']=='cancel_requested','No cancellation awaits approval.',409)
        leave.update(status=leave.get('prior_status','approved'),cancellation_rejected_by=actor['id'])
    elif leave['status']=='pending':
        leave.update(status='cancelled',cancelled_by=actor['id'])
    else:
        today=service.local_today(c,actor['org'],service.entity(c,actor['org'],'employee',leave['employee']))
        requested=data.get('cancel_from')
        if requested is None:
            requested=str(max(today+timedelta(days=1),parse_day(leave.get('cancel_from',leave['start']))))
        cancel_from=parse_day(requested)
        require(today<cancel_from<=parse_day(leave['end']) and cancel_from>=parse_day(leave['start']),'Cancellation can release only unconsumed future dates.')
        if actor['role']=='employee':
            require(leave['status']!='cancel_requested','Cancellation is already awaiting manager approval.',409)
            leave.update(prior_status=leave['status'],status='cancel_requested',cancel_from=str(cancel_from),cancellation_requested_by=actor['id'])
        else:
            service.scope(c,actor,leave['branch'],True)
            original=list(leave['charge_days'])
            released=[day for day in original if day>=str(cancel_from)]
            for day in released:
                post(c,actor['org'],leave['employee'],dict(effective=day,days=1,kind='release',source=f'leave/{leave["id"]}/{day}/release'),actor['id'],'Approved cancellation',leave['id'])
            remaining=[day for day in original if day<str(cancel_from)]
            leave.update(status='partially_cancelled' if remaining else 'cancelled',original_end=leave.get('original_end',leave['end']),charge_days=remaining,days=len(remaining),cancelled_days=leave.get('cancelled_days',0)+len(released),cancelled_by=actor['id'])
            if remaining:
                leave['end']=str(cancel_from-timedelta(days=1))
    service.put(c,actor['org'],'leave',leave)
    service.audit(c,actor,'leave.cancel',leave['id'])
    return leave
