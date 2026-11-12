"""Unambiguous UTF-8 JSON at both HTTP boundaries; never logs request data."""
import json
import math


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON field')
        result[key] = value
    return result


def _constant(_value):
    raise ValueError('Non-finite JSON number')


def _float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError('Non-finite JSON number')
    return number


def parse_request_object(raw):
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=_object,
                           parse_constant=_constant, parse_float=_float)
    except RecursionError:
        raise ValueError('JSON nesting exceeds the parser limit') from None
    if not isinstance(value, dict):
        raise ValueError('A JSON object is required')
    # Python runtimes differ in when their decoder hits the recursion limit.
    # Keep application nesting predictable even when decoding itself succeeds.
    # Iterator frames keep the validation stack bounded by depth, including for
    # a wide payload containing many small objects within the transport limit.
    pending = [iter(value.values())]
    while pending:
        try:
            child = next(pending[-1])
        except StopIteration:
            pending.pop()
            continue
        if isinstance(child, (dict, list)):
            if len(pending) >= 32:
                raise ValueError('JSON nesting exceeds the application limit')
            pending.append(iter(child.values()) if isinstance(child, dict) else iter(child))
    return value
