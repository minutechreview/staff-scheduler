"""Bounded process-local cache. Authority and input versions are always reread.

Cache contents are private, immutable copies. Entries are inserted only after the
read transaction commits and expire even when application versions are unchanged.
"""
import json
import threading
import time
from collections import OrderedDict
from copy import deepcopy


class AnalyticsCache:
    MAX_ENTRIES=128
    MAX_BYTES=24*1024*1024
    MAX_ENTRY_BYTES=4*1024*1024
    MAX_AGE_SECONDS=30
    def __init__(self):
        self.lock=threading.Lock();self.entries=OrderedDict();self.bytes=0
    def get(self,slot,fingerprint):
        with self.lock:
            entry=self.entries.get(slot)
            if not entry:return None
            if entry['fingerprint']!=fingerprint or time.monotonic()-entry['created']>=self.MAX_AGE_SECONDS:
                self.bytes-=entry['bytes'];del self.entries[slot];return None
            self.entries.move_to_end(slot)
            return deepcopy(entry['value']),entry['computed_at']
    def put(self,slot,fingerprint,value,computed_at):
        size=len(json.dumps(value,separators=(',',':'),allow_nan=False).encode())
        if size>self.MAX_ENTRY_BYTES:return
        with self.lock:
            old=self.entries.pop(slot,None)
            if old:self.bytes-=old['bytes']
            self.entries[slot]=dict(fingerprint=fingerprint,value=deepcopy(value),computed_at=computed_at,created=time.monotonic(),bytes=size)
            self.bytes+=size
            while len(self.entries)>self.MAX_ENTRIES or self.bytes>self.MAX_BYTES:
                _,evicted=self.entries.popitem(last=False);self.bytes-=evicted['bytes']
