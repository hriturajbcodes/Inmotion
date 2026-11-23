"""Admin page: who is on the site and whether the server is keeping up.

Access:
  * ADMIN_KEY set in .env   -> open /admin?key=<ADMIN_KEY> once; the browser then
                               remembers it. Works from any computer.
  * ADMIN_KEY not set       -> only the server computer itself (localhost) may open it.
"""
import hashlib
import hmac
import os
import threading
import time

from flask import Blueprint, Response, jsonify, make_response, redirect, render_template, request, url_for

import usage_log
from activity import ACT

bp = Blueprint("admin", __name__)
COOKIE = "imwb_admin"
_fails = {}
_fail_lock = threading.Lock()


def _digest(key):
    return hmac.new(b"imwb-admin", key.encode("utf-8"), hashlib.sha256).hexdigest()


def _too_many_failures(ip):
    now = time.time()
    with _fail_lock:
        recent = [t for t in _fails.get(ip, []) if t > now - 60]
        _fails[ip] = recent
        return len(recent) >= 5


def _note_failure(ip):
    with _fail_lock:
        _fails.setdefault(ip, []).append(time.time())


def _state():
    """Returns 'ok', 'login' (key needed), 'blocked' (remote and no key set) or 'locked'."""
    key = os.environ.get("ADMIN_KEY", "")
    ip = request.remote_addr or ""
    if not key:
        return "ok" if ip in ("127.0.0.1", "::1") else "blocked"
    if _too_many_failures(ip):
        return "locked"
    want = _digest(key)
    given = request.headers.get("X-Admin-Key")
    if given is not None and hmac.compare_digest(_digest(given), want):
        return "ok"
    if hmac.compare_digest(request.cookies.get(COOKIE, ""), want):
        return "ok"
    return "login"


def init_admin(app, page_config, extra_info):
    """page_config() -> template values; extra_info() -> dict merged into the stats."""
    app.register_blueprint(bp)
    bp.page_config = page_config
    bp.extra_info = extra_info


def _no_store(resp):
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.route("/admin")
def page():
    key = os.environ.get("ADMIN_KEY", "")
    supplied = request.args.get("key")
    if key and supplied is not None:
        ip = request.remote_addr or ""
        if _too_many_failures(ip):
            state = "locked"
        elif hmac.compare_digest(_digest(supplied), _digest(key)):
            resp = redirect(url_for("admin.page"))
            resp.set_cookie(COOKIE, _digest(key), max_age=30 * 86400, httponly=True, samesite="Strict")
            return _no_store(resp)
        else:
            _note_failure(ip)
            state = "login"
    else:
        state = _state()
    code = {"ok": 200, "login": 401, "blocked": 403, "locked": 429}[state]
    resp = make_response(render_template("admin.html", state=state, **bp.page_config()), code)
    return _no_store(resp)


@bp.route("/api/admin/stats")
def stats():
    state = _state()
    if state != "ok":
        return _no_store(make_response(jsonify({"error": state}), {"login": 401, "blocked": 403, "locked": 429}[state]))
    out = ACT.snapshot(extra=bp.extra_info())
    out["usage"] = usage_log.USAGE.summary()
    return _no_store(jsonify(out))


def _download(name, mimetype, text_fn):
    state = _state()
    if state != "ok":
        return _no_store(make_response("Not allowed", {"login": 401, "blocked": 403, "locked": 429}[state]))
    resp = Response(text_fn(), mimetype=mimetype)
    resp.headers["Content-Disposition"] = "attachment; filename=" + name
    return _no_store(resp)


@bp.route("/admin/usage.csv")
def usage_csv():
    """One row per day: different users, new users, visits, running total. Opens in Excel."""
    return _download("dashboard_usage_by_day.csv", "text/csv", usage_log.USAGE.daily_csv)


@bp.route("/admin/usage.jsonl")
def usage_raw():
    """The raw log file, one JSON line per visit."""
    def read():
        try:
            with open(usage_log.USAGE.path, "r", encoding="utf-8") as f:
                return f.read()
        except OSError:
            return ""
    return _download("dashboard_usage_log.jsonl", "application/x-ndjson", read)
