"""Share one computed answer between everyone asking for it.

Every open dashboard polls /api/dashboard every 5 seconds and the answer is the
same for everybody, so computing it once per few seconds is enough. This module
wraps a Flask view that returns JSON and:

  * keeps the finished response for RESPONSE_CACHE_TTL_SECONDS (default 4,
    0 turns the cache off),
  * lets only ONE request rebuild an expired answer while the others wait for
    it (so 30 browsers cause 1 database query, not 30),
  * sends it gzip-compressed when the browser accepts that,
  * answers "304 Not Modified" with no body when the browser already has the
    current version (ETag).

Only successful (200) answers are cached, plus a 503 "database unavailable"
answer, which is held for the same short time so that a database outage does
not make every waiting browser retry a slow connection in turn. Other errors are
never cached. Entries are capped, so unusual query strings cannot grow memory
without limit.
"""
import gzip
import hashlib
import os
import threading
import time
from functools import wraps

from flask import Response, g, make_response, request

MAX_ENTRIES = 64
_store = {}
_locks = {}
_guard = threading.Lock()


def _ttl():
    try:
        return float(os.environ.get("RESPONSE_CACHE_TTL_SECONDS", "4"))
    except ValueError:
        return 4.0


def clear():
    with _guard:
        _store.clear()


def _lock_for(key):
    with _guard:
        return _locks.setdefault(key, threading.Lock())


def _put(key, entry):
    with _guard:
        _store[key] = entry
        while len(_store) > MAX_ENTRIES:
            oldest = min(_store, key=lambda k: _store[k]["t"])
            del _store[oldest]
            _locks.pop(oldest, None)


def _respond(e):
    if e.get("status", 200) != 200:
        # a remembered "database unavailable" answer: never gzip/ETag it, never let a browser keep it
        return Response(e["body"], status=e["status"], mimetype=e["mime"],
                        headers={"Cache-Control": "no-store", "Retry-After": "5"})
    etag = e["etag"]
    headers = {"ETag": etag, "Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
    if request.headers.get("If-None-Match") == etag:
        g._cache_outcome = "304"
        return Response(status=304, headers=headers)
    if e["gz"] is not None and "gzip" in request.headers.get("Accept-Encoding", "").lower():
        headers["Content-Encoding"] = "gzip"
        return Response(e["gz"], status=200, mimetype=e["mime"], headers=headers)
    return Response(e["body"], status=200, mimetype=e["mime"], headers=headers)


def cached_view(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        ttl = _ttl()
        if ttl <= 0:
            return fn(*args, **kwargs)
        key = request.path + "?" + "&".join(sorted("%s=%s" % kv for kv in request.args.items(multi=True)))
        e = _store.get(key)
        outcome = "hit"
        if e is None or time.monotonic() - e["t"] >= ttl:
            with _lock_for(key):
                e = _store.get(key)                       # someone may have rebuilt it while we waited
                if e is None or time.monotonic() - e["t"] >= ttl:
                    resp = make_response(fn(*args, **kwargs))
                    if resp.status_code == 503:
                        # "database unavailable": hold it for the same few seconds so the browsers
                        # waiting on this lock get the answer at once instead of each retrying a
                        # slow connection one after another (which would stall every thread).
                        e = {"t": time.monotonic(), "body": resp.get_data(),
                             "mime": resp.mimetype or "application/json",
                             "status": 503, "etag": None, "gz": None}
                        _put(key, e)
                        outcome = "miss"
                    elif resp.status_code != 200:
                        return resp
                    else:
                        body = resp.get_data()
                        e = {"t": time.monotonic(), "body": body, "mime": resp.mimetype or "application/json",
                             "etag": '"%s"' % hashlib.sha1(body).hexdigest()[:20],
                             "gz": gzip.compress(body, 5) if len(body) > 1024 else None}
                        _put(key, e)
                        outcome = "miss"
        g._cache_outcome = outcome
        return _respond(e)
    return wrapper
