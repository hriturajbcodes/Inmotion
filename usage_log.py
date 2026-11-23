"""A permanent record of who has used the dashboard.

Every time a browser starts using the dashboard, one line is appended to a log
file (default: logs/usage_log.jsonl next to app.py). The file survives restarts
and is read back when the server starts, so the totals on the admin page cover
the whole history, not just the current run.

What is written (one JSON object per line, a few hundred bytes):
    {"t": 1763571665.2, "ts": "2026-11-19T22:31:05+05:30", "date": "2026-11-19",
     "vid": "9f3a1c0d5e7b", "ip": "10.20.4.11", "browser": "Chrome · Windows",
     "page": "Overview", "kind": "visit", "new": true}

A line is written when:
    * a browser is seen for the first time          (new = true)
    * a browser comes back after VISIT_GAP minutes  (kind = "visit")
    * a browser left open for days, such as a control-room screen, is still
      there on a new calendar day                   (kind = "day")
Normal polling every few seconds writes nothing, so the file grows slowly:
about 20 KB per 100 visits.

"Different users" means different browsers, told apart by a cookie. One person
using two browsers counts twice; clearing cookies makes a browser count again.
Different computers are counted separately by IP address, which is steadier.

Settings:
    USAGE_LOG_PATH   where the file lives          (default logs/usage_log.jsonl)
    USAGE_LOG        set to 0 to switch logging off
    USAGE_VISIT_GAP_MINUTES   idle time that starts a new visit (default 30)
"""
import datetime
import json
import os
import threading
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _default_path():
    return os.environ.get("USAGE_LOG_PATH") or os.path.join(BASE_DIR, "logs", "usage_log.jsonl")


class UsageLog:
    def __init__(self, tz=None, path=None):
        self.tz = tz
        self.lock = threading.Lock()
        self.path = path or _default_path()
        self.enabled = os.environ.get("USAGE_LOG", "1").lower() not in ("0", "false", "no", "off")
        try:
            self.gap = float(os.environ.get("USAGE_VISIT_GAP_MINUTES", "30")) * 60
        except ValueError:
            self.gap = 1800.0
        self.users = {}      # vid -> {"first","last","last_logged_date","visits","days":set,"ip","browser"}
        self.days = {}       # date -> {"users": set(vid), "new": int, "visits": int}
        self.ips = {}        # ip -> {"first","last","visits","days":set,"browsers":set}
        self.last_error = None
        self.last_write = None
        self.lines = 0
        self._load()

    # ---- helpers ---------------------------------------------------------
    def _local(self, ts):
        return datetime.datetime.fromtimestamp(ts, self.tz) if self.tz else datetime.datetime.fromtimestamp(ts)

    def _date(self, ts):
        return self._local(ts).strftime("%Y-%m-%d")

    def _apply(self, t, vid, ip, browser, kind, new, date=None):
        date = date or self._date(t)
        u = self.users.get(vid)
        if u is None:
            u = self.users[vid] = {"first": t, "last": t, "last_logged_date": None, "visits": 0,
                                   "days": set(), "ip": ip, "browser": browser}
        d = self.days.setdefault(date, {"users": set(), "new": 0, "visits": 0})
        if new:
            d["new"] += 1
        d["users"].add(vid)
        if kind == "visit":
            d["visits"] += 1
            u["visits"] += 1
        u["first"] = min(u["first"], t)
        u["last"] = max(u["last"], t)
        u["last_logged_date"] = date
        u["days"].add(date)
        u["ip"], u["browser"] = ip, browser
        p = self.ips.setdefault(ip, {"first": t, "last": t, "visits": 0, "days": set(), "browsers": set()})
        p["first"] = min(p["first"], t)
        p["last"] = max(p["last"], t)
        p["days"].add(date)
        p["browsers"].add(browser)
        if kind == "visit":
            p["visits"] += 1

    def _load(self):
        if not self.enabled or not os.path.exists(self.path):
            return
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        r = json.loads(line)
                        self._apply(float(r["t"]), str(r["vid"]), str(r.get("ip", "?")), str(r.get("browser", "")),
                                    r.get("kind", "visit"), bool(r.get("new")), r.get("date"))
                        self.lines += 1
                    except (ValueError, KeyError, TypeError):
                        continue          # a damaged line never stops the server
        except OSError as e:
            self.last_error = "Could not read %s: %s" % (self.path, e)

    # ---- recording -------------------------------------------------------
    def touch(self, vid, ip, browser, page, now=None):
        """Call for every dashboard request. Writes to the file only when a visit or a new day starts."""
        if not self.enabled:
            return
        now = time.time() if now is None else now
        vid = vid[:12]
        with self.lock:
            u = self.users.get(vid)
            date = self._date(now)
            if u is None:
                kind, new = "visit", True
            elif now - u["last"] > self.gap:
                kind, new = "visit", False
            elif u["last_logged_date"] != date:
                kind, new = "day", False
            else:
                u["last"] = now
                return
            self._apply(now, vid, ip, browser, kind, new, date)
            rec = {"t": round(now, 1), "ts": self._local(now).isoformat(timespec="seconds"), "date": date,
                   "vid": vid, "ip": ip, "browser": browser, "page": page, "kind": kind, "new": new}
            try:
                os.makedirs(os.path.dirname(self.path), exist_ok=True)
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                self.lines += 1
                self.last_write = now
                self.last_error = None
            except OSError as e:
                self.last_error = "Could not write %s: %s" % (self.path, e)

    # ---- reporting -------------------------------------------------------
    def summary(self, now=None, days=60):
        now = time.time() if now is None else now
        with self.lock:
            today = self._date(now)
            today_dt = self._local(now).date()
            series, total = [], 0
            before = sum(d["new"] for k, d in self.days.items() if k < (today_dt - datetime.timedelta(days=days - 1)).isoformat())
            total = before
            for i in range(days - 1, -1, -1):
                k = (today_dt - datetime.timedelta(days=i)).isoformat()
                d = self.days.get(k)
                total += d["new"] if d else 0
                series.append({"date": k, "users": len(d["users"]) if d else 0, "new": d["new"] if d else 0,
                               "visits": d["visits"] if d else 0, "total": total})
            week = {(today_dt - datetime.timedelta(days=i)).isoformat() for i in range(7)}
            week_users = set()
            for k in week:
                if k in self.days:
                    week_users |= self.days[k]["users"]
            firsts = [u["first"] for u in self.users.values()]
            top = sorted(self.ips.items(), key=lambda kv: (-len(kv[1]["days"]), -kv[1]["visits"]))[:15]
            try:
                size = os.path.getsize(self.path) if os.path.exists(self.path) else 0
            except OSError:
                size = None
            return {
                "enabled": self.enabled, "path": self.path, "size_bytes": size, "lines": self.lines,
                "last_write": self.last_write, "error": self.last_error,
                "total_users": len(self.users), "total_computers": len(self.ips),
                "total_visits": sum(u["visits"] for u in self.users.values()),
                "first_seen": min(firsts) if firsts else None,
                "today_users": len(self.days[today]["users"]) if today in self.days else 0,
                "today_new": self.days[today]["new"] if today in self.days else 0,
                "week_users": len(week_users),
                "week_new": sum(self.days[k]["new"] for k in week if k in self.days),
                "daily": series,
                "computers": [{"ip": ip, "browsers": sorted(p["browsers"])[:3], "first": p["first"], "last": p["last"],
                               "visits": p["visits"], "days": len(p["days"])} for ip, p in top],
            }

    def daily_csv(self):
        """All days on record, oldest first, as CSV text (opens in Excel)."""
        with self.lock:
            rows, total = ["date,different_users,new_users,visits,total_users_to_date"], 0
            for k in sorted(self.days):
                d = self.days[k]
                total += d["new"]
                rows.append("%s,%d,%d,%d,%d" % (k, len(d["users"]), d["new"], d["visits"], total))
            return "\n".join(rows) + "\n"


USAGE = UsageLog()


def init_usage(tz=None, path=None):
    """(Re)create the global log for this server run; reads the existing file."""
    global USAGE
    USAGE = UsageLog(tz, path)
    return USAGE
