"""Pure validation of a bounded Scheduler preview window; no IO or cloud access."""
import datetime as dt

def parse_start(value):
    try:
        start = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except (ValueError, AttributeError):
        raise ValueError('start must be an ISO-8601 UTC timestamp') from None
    if start.tzinfo is None or start.utcoffset() != dt.timedelta(0) or start.microsecond:
        raise ValueError('start must be UTC at whole-second precision')
    return start

def schedule(value):
    start = parse_start(value)
    end = start + dt.timedelta(minutes=30)
    return {'start': start, 'end': end, 'creation_cutoff': end-dt.timedelta(minutes=12),
            'security_cutoff': end-dt.timedelta(minutes=6, seconds=30),
            'owner_write_cutoff': end-dt.timedelta(minutes=6),
            'owner_window_end': end-dt.timedelta(minutes=5),
            'cleanup_start': end-dt.timedelta(minutes=5),
            'run_id': start.strftime('%Y%m%dt%H%M%Sz')}
