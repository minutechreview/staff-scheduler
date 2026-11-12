"""Reproducible synthetic large-team probe; never reads a real dataset."""
import json
import statistics
import sys
import tempfile
import time
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from core import Service, DEFAULTS


def main(label='current'):
    with tempfile.TemporaryDirectory() as temp:
        service = Service(Path(temp) / 'benchmark.sqlite3')
        org, branch_count, employees_per_branch, week_count = 'synthetic-benchmark', 40, 50, 12
        actor = dict(id='benchmark-owner', org=org, role='owner', branches=[], employee=None)
        target = '2026-10-12'
        start = time.perf_counter()
        with service.connect() as c:
            c.execute('INSERT INTO organizations VALUES(?,?,?)', (org, 'Synthetic benchmark only', json.dumps(DEFAULTS)))
            c.execute('INSERT INTO policy_versions VALUES(?,?,?,?,?,?)',(org,'0001-01-01',0,json.dumps(DEFAULTS),actor['id'],time.time()))
            from organization import resolve_labels
            for bi in range(branch_count):
                branch = f'b-{bi}'
                service.put(c, org, 'branch', dict(id=branch, name=f'Fictional Branch {bi}', **resolve_labels(service,c,org,dict(country='Testland',market='Metro',area=f'Area {bi//10}')), timezone='Europe/London', coverage=[dict(start='09:00', end='17:00', role='associate', required=10)]))
                for ei in range(employees_per_branch):
                    ident = f'e-{bi}-{ei}'
                    service.put(c, org, 'employee', dict(id=ident, name=f'Fictional Employee {bi}/{ei}', branch=branch, skills=['associate'], contract_hours=40, active=True, hourly_rate=None, availability={str(i): [dict(start='08:00', end='22:00')] for i in range(7)}))
                for wi in range(week_count):
                    week = date.fromisoformat(target) - timedelta(weeks=wi+1)
                    shifts = [dict(id=f's-{bi}-{wi}-{ei}-{di}', employee=f'e-{bi}-{ei}', branch=branch, role='associate', start=f'{week+timedelta(days=di)}T08:00:00+00:00', end=f'{week+timedelta(days=di)}T16:00:00+00:00') for ei in range(employees_per_branch) for di in range(5)]
                    encoded = json.dumps(shifts)
                    c.execute('INSERT INTO schedules VALUES(?,?,?,?,?,?,?)', (org, branch, str(week), 1, 'published', encoded, encoded))
            if hasattr(service, 'rebuild_reservations'):
                service.rebuild_reservations(c)
        seed_seconds = time.perf_counter() - start
        results = dict(label=label, branches=branch_count, employees=branch_count*employees_per_branch, weeks=week_count, historical_shifts=branch_count*employees_per_branch*5*week_count, database_mib=round(Path(service.path).stat().st_size/1024**2, 2), seed_seconds=round(seed_seconds, 3), timings={})
        with service.connect() as c:
            operations = {'owner_bootstrap': lambda: service.bootstrap(c,actor), 'selected_week_analytics': lambda: service.analytics(c, actor, target, 'b-0'), 'selected_populated_week_analytics': lambda: service.analytics(c, actor, '2026-10-05', 'b-0'), 'generate_selected_branch': lambda: service.generate(c, actor, dict(branch='b-0', week=target, revision=0)), 'all_authorized_branch_analytics': lambda: service.analytics(c, actor, target), 'all_populated_branch_analytics': lambda: service.analytics(c, actor, '2026-10-05')}
            for name, operation in operations.items():
                samples = []
                for _ in range(2):
                    t = time.perf_counter()
                    value = operation()
                    samples.append(time.perf_counter() - t)
                results['timings'][name] = dict(samples_seconds=[round(x, 3) for x in samples], mean_seconds=round(statistics.mean(samples), 3), output_shifts=len(value.get('shifts', [])), output_gaps=len(value.get('coverage', [])))
        print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'current')
