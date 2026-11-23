"""Who is using the site right now, and how hard it is working.

An in-memory, thread-safe tracker. It records one entry per page or data
request (static files, /healthz and the admin page itself are ignored), then
answers "how many people are active?" and "is the server keeping up?".

Visitors are told apart by a random cookie (`imwb_vid`) set on their first
visit, so two people behind the same office IP count as two. Clients that
refuse cookies (scripts, curl) fall back to IP + browser string.

Everything lives in the memory of one server process and resets on restart.
Run the site as a single process with threads (waitress does this) and the
numbers are exact. With several worker processes each one would count only
its own visitors.
"""
import datetime
import hashlib
import os
import re
import threading
import time
import uuid
from collections import deque

from flask import g, request

import usage_log

VID_COOKIE = "imwb_vid"
_VID_RE = re.compile(r"^[0-9a-f]{32}$")
PAGES = {"/": "Overview", "/insights": "Insights"}

ACTIVE_WINDOW = int(os.environ.get("ACTIVE_WINDOW_SECONDS", "30"))   # "active now"
RECENT_WINDOW = 300                                                  # "last 5 minutes"
RETENTION = 24 * 3600                                                # visitors remembered
MAX_VISITORS = 5000
MAX_MINUTES = 120


def _tracked(path):
    if path in PAGES:
        return True
    return path.startswith("/api/") and not path.startswith("/api/admin")


def _browser(ua):
    ua = ua or ""
    name = "Edge" if "Edg/" in ua else "Firefox" if "Firefox/" in ua else \
        "Chrome" if ("Chrome/" in ua or "CriOS" in ua) else "Safari" if "Safari/" in ua else \
        "Script" if re.search(r"curl|python|requests|urllib|wget|bot", ua, re.I) else "Other"
    os_ = "Windows" if "Windows" in ua else "Android" if "Android" in ua else \
        "iOS" if ("iPhone" in ua or "iPad" in ua) else "Mac" if "Mac OS" in ua else \
        "Linux" if "Linux" in ua else ""
    return name + (" · " + os_ if os_ else "")


def _pct(sorted_vals, p):
    if not sorted_vals:
        return None
    i = min(len(sorted_vals) - 1, int(round((len(sorted_vals) - 1) * p)))
    return sorted_vals[i]


class Activity:
    def __init__(self, tz=None):
        self.tz = tz
        self.lock = threading.Lock()
        self.started = time.time()
        self.visitors = {}            # vid -> dict
        self.minutes = {}             # minute -> {"req": n, "err": n, "users": set()}
        self.samples = deque(maxlen=6000)   # (ts, ms, endpoint, status, cache)
        self.endpoints = {}           # rule -> {"total": n, "err": n}
        self.inflight = 0
        self.peak_inflight = 0
        self.peak_window = deque()    # (ts, inflight) to answer "peak in last minute"
        self.total = 0
        self.errors = 0
        self.cache = {"hit": 0, "miss": 0, "304": 0}

    # ---- recording -------------------------------------------------------
    def begin(self):
        with self.lock:
            self.inflight += 1
            self.peak_inflight = max(self.peak_inflight, self.inflight)
            now = time.time()
            self.peak_window.append((now, self.inflight))
            while self.peak_window and self.peak_window[0][0] < now - 60:
                self.peak_window.popleft()

    def end(self):
        with self.lock:
            self.inflight = max(0, self.inflight - 1)

    def record(self, vid, ip, ua, path, endpoint, status, ms, cache=None, now=None):
        now = time.time() if now is None else now
        minute = int(now // 60)
        with self.lock:
            v = self.visitors.get(vid)
            if v is None:
                if len(self.visitors) >= MAX_VISITORS:
                    oldest = min(self.visitors, key=lambda k: self.visitors[k]["last"])
                    del self.visitors[oldest]
                v = self.visitors[vid] = {"first": now, "last": now, "req": 0, "page": None,
                                          "ip": ip, "browser": _browser(ua)}
            v["last"] = max(v["last"], now)
            v["req"] += 1
            v["ip"] = ip
            if path in PAGES:
                v["page"] = PAGES[path]
            elif v["page"] is None:
                v["page"] = "(data only)"

            m = self.minutes.get(minute)
            if m is None:
                m = self.minutes[minute] = {"req": 0, "err": 0, "users": set()}
                for k in [k for k in self.minutes if k < minute - MAX_MINUTES]:
                    del self.minutes[k]
            m["req"] += 1
            m["users"].add(vid)
            self.total += 1
            if status >= 500:
                m["err"] += 1
                self.errors += 1
            e = self.endpoints.setdefault(endpoint, {"total": 0, "err": 0})
            e["total"] += 1
            if status >= 500:
                e["err"] += 1
            if cache in self.cache:
                self.cache[cache] += 1
            self.samples.append((now, ms, endpoint, status, cache))

    # ---- reporting -------------------------------------------------------
    def snapshot(self, extra=None, now=None):
        now = time.time() if now is None else now
        with self.lock:
            cutoff_ret = now - RETENTION
            for k in [k for k, v in self.visitors.items() if v["last"] < cutoff_ret]:
                del self.visitors[k]

            def active(window):
                return sum(1 for v in self.visitors.values() if v["last"] >= now - window)

            if self.tz is not None:
                local = datetime.datetime.fromtimestamp(now, self.tz)
                midnight = local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
            else:
                midnight = now - (now % 86400)

            cur = int(now // 60)
            series = []
            for mi in range(cur - 59, cur + 1):
                m = self.minutes.get(mi)
                series.append({"t": mi * 60, "users": len(m["users"]) if m else 0,
                               "req": m["req"] if m else 0, "err": m["err"] if m else 0})

            recent = [s for s in self.samples if s[0] >= now - RECENT_WINDOW]
            durs = sorted(s[1] for s in recent)
            by_ep = {}
            for s in recent:
                by_ep.setdefault(s[2], []).append(s)
            eps = []
            for name, tot in self.endpoints.items():
                rs = by_ep.get(name, [])
                d = sorted(x[1] for x in rs)
                served = [x for x in rs if x[4] is not None]
                hits = sum(1 for x in served if x[4] in ("hit", "304"))
                eps.append({
                    "endpoint": name, "recent": len(rs), "total": tot["total"], "errors": tot["err"],
                    "avg_ms": round(sum(d) / len(d), 1) if d else None, "p95_ms": _pct(d, 0.95),
                    "cache_pct": round(hits / len(served) * 100) if served else None,
                })
            eps.sort(key=lambda r: (-r["recent"], -r["total"]))

            vis = sorted(self.visitors.items(), key=lambda kv: -kv[1]["last"])[:60]
            visitors = [{
                "id": vid[:6], "ip": v["ip"], "browser": v["browser"], "page": v["page"],
                "first": v["first"], "last": v["last"], "requests": v["req"],
                "active": v["last"] >= now - ACTIVE_WINDOW,
            } for vid, v in vis]

            peak_min = max([x[1] for x in self.peak_window] + [self.inflight])
            served_total = sum(self.cache.values())
            out = {
                "now": now, "uptime_s": int(now - self.started),
                "active_window_s": ACTIVE_WINDOW,
                "active_now": active(ACTIVE_WINDOW), "active_5m": active(RECENT_WINDOW),
                "active_1h": active(3600),
                "unique_today": sum(1 for v in self.visitors.values() if v["last"] >= midnight),
                "peak_active_hour": max([s["users"] for s in series] + [0]),
                "requests_last_min": sum(1 for x in self.samples if x[0] >= now - 60),
                "requests_total": self.total, "errors_total": self.errors,
                "inflight": self.inflight, "inflight_peak_1m": peak_min, "inflight_peak": self.peak_inflight,
                "latency_5m": {"n": len(durs), "p50": _pct(durs, 0.5), "p95": _pct(durs, 0.95),
                               "max": durs[-1] if durs else None,
                               "errors": sum(1 for s in recent if s[3] >= 500)},
                "cache": dict(self.cache, hit_pct=round((self.cache["hit"] + self.cache["304"]) / served_total * 100)
                              if served_total else None),
                "series": series, "endpoints": eps, "visitors": visitors,
            }
        if extra:
            out.update(extra)
        return out


ACT = Activity()


def init_activity(app, tz=None):
    """Attach the tracker to a Flask app."""
    ACT.tz = tz
    usage_log.init_usage(tz)
    trust_proxy = os.environ.get("TRUST_PROXY", "").lower() in ("1", "true", "yes")

    def client_ip():
        if trust_proxy:
            fwd = request.headers.get("X-Forwarded-For", "")
            if fwd:
                return fwd.split(",")[0].strip()
        return request.remote_addr or "?"

    @app.before_request
    def _act_begin():
        g._act_t0 = time.perf_counter()
        g._act_tracked = _tracked(request.path)
        if g._act_tracked:
            g._act_inflight = True
            ACT.begin()

    @app.after_request
    def _act_after(resp):
        if getattr(g, "_act_tracked", False):
            ua = request.headers.get("User-Agent", "")
            ip = client_ip()
            vid = request.cookies.get(VID_COOKIE, "")
            set_cookie = False
            if not _VID_RE.match(vid):
                if request.path in PAGES:
                    vid = uuid.uuid4().hex          # first visit of a browser: give it an identity
                    set_cookie = True
                else:                               # script or cookie-less client: one identity per IP + browser
                    vid = hashlib.sha1((ip + "|" + ua).encode("utf-8", "replace")).hexdigest()[:32]
            ms = (time.perf_counter() - g._act_t0) * 1000
            ACT.record(vid, ip, ua, request.path,
                       request.url_rule.rule if request.url_rule else request.path,
                       resp.status_code, ms, getattr(g, "_cache_outcome", None))
            usage_log.USAGE.touch(vid, ip, _browser(ua), PAGES.get(request.path, "(data only)"))
            if set_cookie:
                resp.set_cookie(VID_COOKIE, vid, max_age=365 * 86400, httponly=True, samesite="Lax")
        return resp

    @app.teardown_request
    def _act_teardown(exc):
        if getattr(g, "_act_inflight", False):
            g._act_inflight = False
            ACT.end()
