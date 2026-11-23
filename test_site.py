"""Run with:  python -m unittest test_site -v
Checks the shared cache, the activity counts and the admin page's access rules."""
import json
import os
import tempfile
import threading
import time
import unittest

os.environ.pop("ADMIN_KEY", None)
os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "4"
_TMP = tempfile.mkdtemp()
os.environ["USAGE_LOG_PATH"] = os.path.join(_TMP, "app_usage.jsonl")   # tests never touch the real log
import app as appmod          # noqa: E402
import respcache              # noqa: E402
from activity import ACT      # noqa: E402


def fresh():
    respcache.clear()
    return appmod.app.test_client()


class CacheTests(unittest.TestCase):
    def test_same_answer_as_uncached(self):
        c = fresh()
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "0"
        a = c.get("/api/dashboard?days=all").get_json()
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "4"
        b = c.get("/api/dashboard?days=all").get_json()
        self.assertEqual(a["rows"], b["rows"])
        self.assertEqual(a["summary"], b["summary"])

    def test_many_simultaneous_requests_cause_one_query(self):
        c = fresh()
        calls = []
        real = appmod.fetch_dashboard_rows

        def slow(*a, **k):
            calls.append(1)
            time.sleep(0.3)
            return real(*a, **k)
        appmod.fetch_dashboard_rows = slow
        try:
            codes = []

            def hit():
                codes.append(appmod.app.test_client().get("/api/dashboard?days=all").status_code)
            ts = [threading.Thread(target=hit) for _ in range(25)]
            [t.start() for t in ts]
            [t.join() for t in ts]
        finally:
            appmod.fetch_dashboard_rows = real
        self.assertEqual(set(codes), {200})
        self.assertEqual(len(calls), 1, "25 people asking at once should run the query once")

    def test_etag_gives_304_and_gzip_is_offered(self):
        c = fresh()
        r = c.get("/api/dashboard?days=all", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(r.headers.get("Content-Encoding"), "gzip")
        r2 = c.get("/api/dashboard?days=all", headers={"If-None-Match": r.headers["ETag"]})
        self.assertEqual(r2.status_code, 304)
        self.assertEqual(r2.data, b"")

    def test_errors_are_not_cached(self):
        c = fresh()
        calls = []
        real = appmod.fetch_dashboard_rows

        def boom(*a, **k):
            calls.append(1)
            raise RuntimeError("db down")
        appmod.fetch_dashboard_rows = boom
        appmod.app.config["PROPAGATE_EXCEPTIONS"] = False
        try:
            self.assertEqual(c.get("/api/dashboard?days=all").status_code, 500)
            self.assertEqual(c.get("/api/dashboard?days=all").status_code, 500)
        finally:
            appmod.fetch_dashboard_rows = real
        self.assertEqual(len(calls), 2)

    def test_cache_size_is_capped(self):
        c = fresh()
        for i in range(respcache.MAX_ENTRIES + 20):
            c.get("/api/dashboard?days=%d" % (i + 1))
        self.assertLessEqual(len(respcache._store), respcache.MAX_ENTRIES)


class ActivityTests(unittest.TestCase):
    def test_two_browsers_count_as_two_people_and_one_browser_as_one(self):
        ACT.__init__(ACT.tz)
        a, b = appmod.app.test_client(), appmod.app.test_client()
        for c in (a, b):
            c.get("/")                              # first visit sets the cookie
        for _ in range(3):
            a.get("/api/dashboard?days=all")
            b.get("/api/insights")
        s = ACT.snapshot()
        self.assertEqual(s["active_now"], 2)
        self.assertEqual(s["unique_today"], 2)
        self.assertEqual(s["requests_total"], 8)

    def test_admin_and_static_requests_are_not_counted(self):
        ACT.__init__(ACT.tz)
        c = appmod.app.test_client()
        c.get("/admin", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
        c.get("/api/admin/stats", environ_overrides={"REMOTE_ADDR": "127.0.0.1"})
        c.get("/static/dashboard.css")
        c.get("/healthz")
        self.assertEqual(ACT.snapshot()["requests_total"], 0)

    def test_active_window(self):
        ACT.__init__(ACT.tz)
        now = time.time()
        ACT.record("a" * 32, "10.0.0.1", "Mozilla Chrome/1 Windows", "/", "/", 200, 5, now=now - 120)
        ACT.record("b" * 32, "10.0.0.2", "Mozilla Chrome/1 Windows", "/", "/", 200, 5, now=now - 5)
        s = ACT.snapshot(now=now)
        self.assertEqual((s["active_now"], s["active_5m"]), (1, 2))

    def test_inflight_returns_to_zero(self):
        ACT.__init__(ACT.tz)
        appmod.app.test_client().get("/api/dashboard?days=all")
        self.assertEqual(ACT.snapshot()["inflight"], 0)


class AdminAccessTests(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("ADMIN_KEY", None)

    def get(self, path, ip="127.0.0.1", **kw):
        return appmod.app.test_client().get(path, environ_overrides={"REMOTE_ADDR": ip}, **kw)

    def test_without_key_only_the_server_itself_may_open_it(self):
        self.assertEqual(self.get("/admin").status_code, 200)
        self.assertEqual(self.get("/api/admin/stats").status_code, 200)
        self.assertEqual(self.get("/admin", ip="10.1.2.3").status_code, 403)
        self.assertEqual(self.get("/api/admin/stats", ip="10.1.2.3").status_code, 403)

    def test_with_key_remote_users_need_it(self):
        os.environ["ADMIN_KEY"] = "s3cret"
        self.assertEqual(self.get("/admin", ip="10.1.2.3").status_code, 401)
        self.assertEqual(self.get("/api/admin/stats", ip="10.1.2.3").status_code, 401)
        self.assertEqual(self.get("/api/admin/stats", ip="10.1.2.3", headers={"X-Admin-Key": "s3cret"}).status_code, 200)
        c = appmod.app.test_client()
        r = c.get("/admin?key=s3cret", environ_overrides={"REMOTE_ADDR": "10.9.9.9"})
        self.assertEqual(r.status_code, 302)            # cookie set, redirected to a clean URL
        self.assertEqual(c.get("/api/admin/stats", environ_overrides={"REMOTE_ADDR": "10.9.9.9"}).status_code, 200)

    def test_wrong_key_is_rate_limited(self):
        os.environ["ADMIN_KEY"] = "s3cret"
        from admin import _fails
        _fails.clear()
        for _ in range(5):
            self.assertEqual(self.get("/admin?key=nope", ip="10.7.7.7").status_code, 401)
        self.assertEqual(self.get("/admin?key=s3cret", ip="10.7.7.7").status_code, 429)


class UsageLogTests(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), "sub", "u.jsonl")
        import usage_log
        self.mod = usage_log

    def log(self):
        return self.mod.UsageLog(None, self.path)

    def lines(self):
        if not os.path.exists(self.path):
            return []
        with open(self.path, encoding="utf-8") as f:
            return f.read().splitlines()

    def test_new_browser_is_logged_once_and_polling_adds_nothing(self):
        u, t = self.log(), 1_700_000_000
        for i in range(50):
            u.touch("a" * 32, "10.0.0.1", "Chrome", "Overview", now=t + i * 5)
        self.assertEqual(len(self.lines()), 1)
        self.assertTrue(json.loads(self.lines()[0])["new"])
        self.assertEqual(u.summary(now=t + 300)["total_users"], 1)

    def test_return_after_gap_is_a_new_visit_not_a_new_user(self):
        u, t = self.log(), 1_700_000_000
        u.touch("a" * 32, "10.0.0.1", "Chrome", "Overview", now=t)
        u.touch("a" * 32, "10.0.0.1", "Chrome", "Overview", now=t + 3 * 3600)
        s = u.summary(now=t + 3 * 3600)
        self.assertEqual((s["total_users"], s["total_visits"], len(self.lines())), (1, 2, 2))

    def test_screen_left_open_overnight_logs_a_day_line(self):
        u, t = self.log(), 1_700_000_000
        for k in range(0, 3 * 86400, 600):           # polls every 10 minutes for 3 days
            u.touch("b" * 32, "10.0.0.2", "Chrome", "Overview", now=t + k)
        kinds = [json.loads(x)["kind"] for x in self.lines()]
        self.assertEqual(kinds[0], "visit")
        self.assertGreaterEqual(kinds.count("day"), 2)
        self.assertEqual(u.summary(now=t + 3 * 86400)["total_users"], 1)

    def test_totals_survive_a_restart(self):
        u, t = self.log(), 1_700_000_000
        for i in range(7):
            u.touch("%x" % i + "f" * 31, "10.0.0.%d" % (i % 3), "Edge", "Insights", now=t + i * 86400)
        before = u.summary(now=t + 7 * 86400)
        again = self.log().summary(now=t + 7 * 86400)
        for k in ("total_users", "total_computers", "total_visits", "week_users", "daily", "first_seen"):
            self.assertEqual(before[k], again[k], k)
        self.assertEqual(again["total_users"], 7)
        self.assertEqual(again["total_computers"], 3)

    def test_damaged_line_is_skipped(self):
        u, t = self.log(), 1_700_000_000
        u.touch("a" * 32, "10.0.0.1", "Chrome", "Overview", now=t)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write("not json at all\n{\"t\": \"x\"}\n\n")
        u.touch("c" * 32, "10.0.0.3", "Chrome", "Overview", now=t + 5)
        self.assertEqual(self.log().summary(now=t + 10)["total_users"], 2)

    def test_unwritable_path_reports_error_but_keeps_counting(self):
        blocker = os.path.join(tempfile.mkdtemp(), "file")
        open(blocker, "w").close()
        u = self.mod.UsageLog(None, os.path.join(blocker, "x", "u.jsonl"))   # parent is a file
        u.touch("a" * 32, "10.0.0.1", "Chrome", "Overview", now=1_700_000_000)
        s = u.summary(now=1_700_000_010)
        self.assertTrue(s["error"])
        self.assertEqual(s["total_users"], 1)

    def test_can_be_switched_off(self):
        os.environ["USAGE_LOG"] = "0"
        try:
            u = self.log()
            u.touch("a" * 32, "10.0.0.1", "Chrome", "Overview", now=1_700_000_000)
        finally:
            os.environ.pop("USAGE_LOG")
        self.assertEqual((self.lines(), u.summary()["total_users"], u.summary()["enabled"]), ([], 0, False))

    def test_csv_lists_every_day(self):
        u, t = self.log(), 1_700_000_000
        u.touch("a" * 32, "10.0.0.1", "Chrome", "Overview", now=t)
        u.touch("b" * 32, "10.0.0.2", "Chrome", "Overview", now=t + 86400)
        rows = u.daily_csv().strip().splitlines()
        self.assertEqual(len(rows), 3)
        self.assertTrue(rows[-1].endswith(",1,1,1,2"))


class UsageOnSiteTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("ADMIN_KEY", None)
        import usage_log
        usage_log.init_usage(appmod.PLANT_TZ, os.path.join(tempfile.mkdtemp(), "site.jsonl"))
        self.ul = usage_log

    def test_browsers_are_counted_in_the_admin_stats(self):
        for _ in range(2):
            c = appmod.app.test_client()        # each test client has its own cookie jar = one browser
            for _ in range(3):
                c.get("/")
                c.get("/api/dashboard?days=all")
        r = appmod.app.test_client().get("/api/admin/stats").get_json()["usage"]
        self.assertEqual(r["total_users"], 2)
        with open(self.ul.USAGE.path) as f:
            self.assertEqual(len(f.read().splitlines()), 2)

    def test_admin_page_visits_are_not_logged(self):
        appmod.app.test_client().get("/api/admin/stats")
        self.assertEqual(self.ul.USAGE.summary()["total_users"], 0)

    def test_downloads_work_locally_and_need_the_key_remotely(self):
        appmod.app.test_client().get("/")
        c = appmod.app.test_client()
        self.assertEqual(c.get("/admin/usage.csv").status_code, 200)
        self.assertIn("different_users", c.get("/admin/usage.csv").get_data(as_text=True))
        self.assertEqual(c.get("/admin/usage.jsonl").status_code, 200)
        os.environ["ADMIN_KEY"] = "s3cret"
        try:
            for u in ("/admin/usage.csv", "/admin/usage.jsonl"):
                self.assertEqual(c.get(u, environ_overrides={"REMOTE_ADDR": "10.9.9.9"}).status_code, 401, u)
        finally:
            os.environ.pop("ADMIN_KEY")


if __name__ == "__main__":
    unittest.main()
