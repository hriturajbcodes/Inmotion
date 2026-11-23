"""Run with:  python -m unittest test_hardening -v

Regression tests for the hardening fixes:
  * a database outage is reported as "unavailable" (never replaced by made-up data)
  * one damaged row cannot break Insights or the exports
  * /api/export answers bad input with a clean 400 instead of crashing
"""
import io
import json
import logging
import os
import tempfile
import threading
import time
import unittest
from decimal import Decimal

os.environ.pop("ADMIN_KEY", None)
os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "4"
_TMP = tempfile.mkdtemp()
os.environ["USAGE_LOG_PATH"] = os.path.join(_TMP, "app_usage.jsonl")   # tests never touch the real log
import openpyxl                   # noqa: E402
import app as appmod              # noqa: E402
import respcache                  # noqa: E402

appmod.app.config["PROPAGATE_EXCEPTIONS"] = False   # a crash shows up as a 500 the tests can see
logging.getLogger("imwb_app").setLevel(logging.CRITICAL)

GOOD_ROW = {
    "MATCH_STATUS": "MATCHED", "STATIC_GROSS_WT": 400, "STATIC_TARE_WT": 120, "STATIC_NET_WT": 280,
    "IMWB_GROSS_WT": 399, "IMWB_TARE_WT": 120, "IMWB_NET_WT": 279, "NET_WT_DIFFERENCE": 1.0,
    "NET_WT_DIFFERENCE_PCT": 0.35, "BFCASTID": "C1", "TORPEDO_NO": "T-01", "STATIC_SOURCE": "BF1",
    "STATIC_RECORD_TIME": "2026-11-23 10:00:00",
}


# ---------------------------------------------------------------------------
# A stand-in for pyodbc: connect() either works or fails like an unreachable SQL Server
# ---------------------------------------------------------------------------
class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self.description = None
        self._rows = []

    def execute(self, query, params=()):
        self.conn.queries.append((query, list(params)))
        sample = [r for r in appmod.generate_sample_dataset() if r["MATCH_STATUS"] == "MATCHED"][:3]
        cols = list(sample[0].keys())
        self.description = [(c,) for c in cols]
        self._rows = [tuple(r[c] for c in cols) for r in sample]
        return self

    def fetchone(self):
        return (1,)

    def fetchall(self):
        return self._rows


class FakeConn:
    def __init__(self, queries):
        self.queries = queries

    def cursor(self):
        return FakeCursor(self)

    def close(self):
        pass


class FakePyodbc:
    def __init__(self):
        self.down = False
        self.delay = 0.0
        self.connects = 0
        self.queries = []
        self._lock = threading.Lock()

    def connect(self, *args, **kwargs):
        with self._lock:
            self.connects += 1
        if self.delay:
            time.sleep(self.delay)
        if self.down:
            raise RuntimeError("[08001] SQL Server does not exist or access denied")
        return FakeConn(self.queries)


_MISSING = object()


class LiveDbCase(unittest.TestCase):
    """The app is configured for a live database, served by the FakePyodbc above."""

    def setUp(self):
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "4"
        respcache.clear()
        self.fake = FakePyodbc()
        self._saved = (appmod.IMWB_SERVER, appmod.PYODBC_AVAILABLE,
                       getattr(appmod, "pyodbc", _MISSING), appmod.LAST_DB_ERROR)
        appmod.IMWB_SERVER = "10.0.0.5"
        appmod.PYODBC_AVAILABLE = True
        appmod.pyodbc = self.fake
        self.c = appmod.app.test_client()

    def tearDown(self):
        appmod.IMWB_SERVER, appmod.PYODBC_AVAILABLE, saved, appmod.LAST_DB_ERROR = self._saved
        if saved is _MISSING:
            if hasattr(appmod, "pyodbc"):
                del appmod.pyodbc
        else:
            appmod.pyodbc = saved
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "4"
        respcache.clear()


class DatabaseOutageTests(LiveDbCase):
    def test_live_database_is_read(self):
        r = self.c.get("/api/dashboard?days=all")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.get_json()["rows"]), 3)
        stats = self.c.get("/api/admin/stats").get_json()
        self.assertEqual(stats["data_source"], "Live database")
        self.assertIsNone(stats["db_error"])

    def test_outage_is_reported_not_replaced_by_simulated_data(self):
        self.fake.down = True
        r = self.c.get("/api/dashboard?days=all")
        self.assertEqual(r.status_code, 503)
        body = r.get_json()
        self.assertEqual(body["error"], "database_unavailable")
        self.assertNotIn("rows", body)                       # no made-up trips
        self.assertEqual(r.headers.get("Cache-Control"), "no-store")
        self.assertEqual(self.c.get("/api/insights").status_code, 503)
        self.assertEqual(self.c.post("/api/export", json={"scope": "all", "format": "xlsx"}).status_code, 503)
        self.assertEqual(self.c.post("/api/export", json={"scope": "all", "format": "csv"}).status_code, 503)
        self.assertEqual(self.c.get("/api/export.csv").status_code, 503)
        self.assertEqual(self.c.get("/healthz").status_code, 503)

    def test_admin_page_shows_the_reason(self):
        self.fake.down = True
        self.c.get("/api/dashboard?days=all")
        stats = self.c.get("/api/admin/stats").get_json()
        self.assertIn("SQL Server does not exist", stats["db_error"])

    def test_recovers_by_itself_when_the_database_returns(self):
        self.fake.down = True
        self.assertEqual(self.c.get("/api/dashboard?days=all").status_code, 503)
        self.fake.down = False
        respcache.clear()
        self.assertEqual(self.c.get("/api/dashboard?days=all").status_code, 200)
        self.assertIsNone(appmod.LAST_DB_ERROR)

    def test_outage_answer_is_held_briefly_then_retried(self):
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "0.3"
        self.fake.down = True
        for _ in range(6):
            self.assertEqual(self.c.get("/api/dashboard?days=all").status_code, 503)
        self.assertEqual(self.fake.connects, 1, "repeat requests inside the hold time must not reconnect")
        time.sleep(0.4)
        self.fake.down = False
        self.assertEqual(self.c.get("/api/dashboard?days=all").status_code, 200)
        self.assertEqual(self.fake.connects, 2)

    def test_a_crowd_during_a_slow_outage_makes_one_attempt(self):
        self.fake.down = True
        self.fake.delay = 0.3                                # a slow, failing connection
        codes = []

        def hit():
            codes.append(appmod.app.test_client().get("/api/dashboard?days=all").status_code)
        ts = [threading.Thread(target=hit) for _ in range(20)]
        started = time.time()
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(set(codes), {503})
        self.assertEqual(self.fake.connects, 1, "20 waiting browsers must share one failed attempt")
        self.assertLess(time.time() - started, 2.0, "they must not queue up one after another")

    def test_503_answers_are_not_gzipped_or_given_an_etag(self):
        self.fake.down = True
        r = self.c.get("/api/dashboard?days=all", headers={"Accept-Encoding": "gzip"})
        self.assertEqual(r.status_code, 503)
        self.assertIsNone(r.headers.get("Content-Encoding"))
        self.assertIsNone(r.headers.get("ETag"))
        r2 = self.c.get("/api/dashboard?days=all", headers={"Accept-Encoding": "gzip"})   # served from the hold
        self.assertEqual(r2.status_code, 503)
        self.assertEqual(r2.get_json()["error"], "database_unavailable")

    def test_missing_pyodbc_with_a_server_configured_is_an_error_not_demo_mode(self):
        appmod.PYODBC_AVAILABLE = False
        r = self.c.get("/api/dashboard?days=all")
        self.assertEqual(r.status_code, 503)
        self.assertIn("pyodbc", appmod.LAST_DB_ERROR)
        self.assertEqual(self.c.get("/healthz").status_code, 503)

    def test_no_server_configured_still_means_demo_data(self):
        appmod.IMWB_SERVER = ""
        r = self.c.get("/api/dashboard?days=all")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(r.get_json()["rows"]), 50)
        self.assertEqual(self.c.get("/healthz").get_json().get("mode"), "simulated_plant")

    def test_days_filter_is_kept_in_a_safe_range(self):
        r = self.c.get("/api/dashboard?days=99999999999999999999")
        self.assertEqual(r.status_code, 200, "a silly 'days' value must not look like a database outage")
        params = [q[1] for q in self.fake.queries]
        self.assertIn([36500], params)
        self.assertTrue(all(abs(p) <= 36500 for ps in params for p in ps if isinstance(p, int)))

    def test_junk_days_value_means_no_date_filter(self):
        self.assertEqual(self.c.get("/api/dashboard?days=abc").status_code, 200)
        self.assertTrue(all("DATEADD" not in q[0] for q in self.fake.queries))


class DamagedRowTests(unittest.TestCase):
    """One bad row from the database must never break a page."""

    def setUp(self):
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "0"
        respcache.clear()
        self.real = appmod.fetch_dashboard_rows
        self.c = appmod.app.test_client()
        self.baseline = self.c.get("/api/dashboard?days=all").get_json()["summary"]["matched_records"]

    def tearDown(self):
        appmod.fetch_dashboard_rows = self.real
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "4"
        respcache.clear()

    def damage(self, mutate):
        real = self.real

        def fake(area=None, days=None, limit=None):
            rows = real(area=area, days=days, limit=limit)
            mutate(rows)
            return rows
        appmod.fetch_dashboard_rows = fake

    @staticmethod
    def first_matched(rows):
        return next(r for r in rows if r["MATCH_STATUS"] == "MATCHED")

    def assert_everything_still_works(self, expected_matched):
        d = self.c.get("/api/dashboard?days=all")
        self.assertEqual(d.status_code, 200)
        self.assertEqual(d.get_json()["summary"]["matched_records"], expected_matched)
        self.assertEqual(self.c.get("/api/insights").status_code, 200)
        x = self.c.post("/api/export", json={"scope": "all", "format": "xlsx"})
        self.assertEqual(x.status_code, 200)
        openpyxl.load_workbook(io.BytesIO(x.data))           # the file really opens
        self.assertEqual(self.c.post("/api/export", json={"scope": "all", "format": "csv"}).status_code, 200)
        return x

    def test_matched_row_with_null_difference_is_left_out(self):
        self.damage(lambda rows: self.first_matched(rows).update(NET_WT_DIFFERENCE=None))
        self.assert_everything_still_works(self.baseline - 1)

    def test_nan_difference_is_left_out(self):
        self.damage(lambda rows: self.first_matched(rows).update(NET_WT_DIFFERENCE=float("nan")))
        self.assert_everything_still_works(self.baseline - 1)

    def test_weight_arriving_as_text_is_left_out(self):
        self.damage(lambda rows: self.first_matched(rows).update(STATIC_NET_WT="280.5"))
        self.assert_everything_still_works(self.baseline - 1)

    def test_row_with_no_time_does_not_break_anything(self):
        self.damage(lambda rows: rows[3].update(STATIC_RECORD_TIME=None))
        self.assertEqual(self.c.post("/api/export", json={"scope": "current_day", "format": "xlsx"}).status_code, 200)
        self.assertEqual(self.c.post("/api/export", json={"scope": "custom", "from_date": "2020-01-01",
                                                          "to_date": "2030-01-01"}).status_code, 200)
        self.assert_everything_still_works(self.baseline)

    def test_control_character_in_text_is_removed_from_the_excel_file(self):
        self.damage(lambda rows: rows[2].update(TORPEDO_NO="ZZ\x0b9"))
        x = self.assert_everything_still_works(self.baseline)
        ws = openpyxl.load_workbook(io.BytesIO(x.data))["Weighment Records"]
        self.assertIn("ZZ9", [ws.cell(row=r, column=2).value for r in range(6, ws.max_row + 1)])

    def test_is_complete_matched_rules(self):
        ok = dict(GOOD_ROW)
        self.assertTrue(appmod.is_complete_matched(ok))
        self.assertTrue(appmod.is_complete_matched(dict(ok, NET_WT_DIFFERENCE=0)))
        for field in ("STATIC_GROSS_WT", "IMWB_NET_WT", "NET_WT_DIFFERENCE"):
            self.assertFalse(appmod.is_complete_matched(dict(ok, **{field: None})), field)
            self.assertFalse(appmod.is_complete_matched(dict(ok, **{field: "1.0"})), field)
            self.assertFalse(appmod.is_complete_matched(dict(ok, **{field: float("inf")})), field)
        self.assertFalse(appmod.is_complete_matched(dict(ok, MATCH_STATUS="PENDING")))
        self.assertFalse(appmod.is_complete_matched(None))
        self.assertFalse(appmod.is_complete_matched("row"))

    def test_serialize_val_never_produces_invalid_json_numbers(self):
        self.assertIsNone(appmod.serialize_val(float("nan")))
        self.assertIsNone(appmod.serialize_val(float("inf")))
        self.assertIsNone(appmod.serialize_val(Decimal("NaN")))
        self.assertEqual(appmod.serialize_val(Decimal("1.5")), 1.5)
        self.assertEqual(appmod.serialize_val(0), 0)


class ExportInputTests(unittest.TestCase):
    def setUp(self):
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "0"
        respcache.clear()
        self.c = appmod.app.test_client()

    def tearDown(self):
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "4"
        respcache.clear()

    def post(self, body):
        data = body if isinstance(body, bytes) else json.dumps(body)
        return self.c.post("/api/export", data=data, content_type="application/json")

    def test_bad_input_never_crashes(self):
        cases = [
            ({"format": None}, 200), ({"format": 5}, 400), ({"format": "pdf"}, 400),
            ({"format": "CSV"}, 200),
            ({"scope": "custom", "from_date": "garbage", "to_date": "2026-11-23"}, 400),
            ({"scope": "custom", "from_date": "2026-11-23", "to_date": "garbage"}, 400),
            ({"scope": "custom", "from_date": "9999-12-31", "to_date": "9999-12-31"}, 400),
            ({"scope": "custom", "from_date": 20261101, "to_date": 20261123}, 400),
            ({"scope": "custom", "from_date": "2026-11-01", "to_date": "2026-11-23"}, 200),
            ({"scope": "custom", "from_date": "0001-01-01", "to_date": "0001-01-01"}, 200),
            ({"scope": "custom", "from_date": "2026-11-23", "to_date": "2026-11-01"}, 200),
            ({"scope": "custom", "from_date": "2026-11-01"}, 200),
            ({"scope": "nonsense"}, 200), ({"scope": 5}, 200), ({"scope": ["x"]}, 200),
            ([1, 2, 3], 200), ("null", 200), (b"123", 200), (b"not json at all", 200), (b"", 200),
            ({"filters": ["a", "b"]}, 200), ({"filters": "x"}, 200), ({"filters": {"a": None}}, 200),
            ({"area": 5}, 200), ({"area": None}, 200),
            ({"scope": "current_view", "visible_rows": "string"}, 400),
            ({"scope": "current_view", "visible_rows": ["a", "b"]}, 400),
            ({"scope": "current_view", "visible_rows": [1, 2]}, 400),
            ({"scope": "current_view", "visible_rows": [None]}, 400),
            ({"scope": "current_view", "visible_rows": [{}]}, 200),
            ({"scope": "current_view", "visible_rows": []}, 200),
        ]
        for body, expected in cases:
            r = self.post(body)
            self.assertEqual(r.status_code, expected, "%r -> %s" % (body, r.status_code))
            if expected == 400:
                self.assertIn("error", r.get_json())

    def test_text_in_number_columns_does_not_crash_either_format(self):
        row = dict(GOOD_ROW, STATIC_GROSS_WT="400.5", NET_WT_DIFFERENCE="1.0", IMWB_NET_WT="abc")
        for fmt in ("csv", "xlsx"):
            r = self.post({"scope": "current_view", "visible_rows": [row], "format": fmt})
            self.assertEqual(r.status_code, 200, fmt)
        csv_text = self.post({"scope": "current_view", "visible_rows": [row], "format": "csv"}).get_data(as_text=True)
        self.assertEqual(csv_text.splitlines()[1].split(",")[3], "400.50")      # text that is a number still formats

    def test_odd_cell_contents_still_give_an_openable_file(self):
        rows = [dict(GOOD_ROW, BFCASTID="bad\x00\x01ctrl"), dict(GOOD_ROW, BFCASTID="x" * 40000),
                dict(GOOD_ROW, TORPEDO_NO=["not", "text"]), dict(GOOD_ROW, STATIC_GROSS_WT=float("nan"))]
        r = self.post({"scope": "current_view", "visible_rows": rows, "format": "xlsx"})
        self.assertEqual(r.status_code, 200)
        ws = openpyxl.load_workbook(io.BytesIO(r.data))["Weighment Records"]
        self.assertEqual(ws.cell(row=6, column=1).value, "badctrl")
        self.assertEqual(len(ws.cell(row=7, column=1).value), 32767)

    def test_nan_in_the_request_body_is_tolerated(self):
        body = b'{"scope":"current_view","format":"xlsx","visible_rows":[{"STATIC_GROSS_WT": NaN}]}'
        self.assertEqual(self.post(body).status_code, 200)

    def test_valid_requests_still_work(self):
        r = self.post({"scope": "current_view", "visible_rows": [GOOD_ROW], "format": "csv"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_data(as_text=True).splitlines()[1].split(",")[:3], ["C1", "T-01", "BF1"])
        for scope in ("current_day", "7_days", "14_days", "30_days", "all"):
            for fmt in ("csv", "xlsx"):
                self.assertEqual(self.post({"scope": scope, "format": fmt}).status_code, 200, (scope, fmt))


class SmallFixTests(unittest.TestCase):
    def setUp(self):
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "0"
        self.c = appmod.app.test_client()

    def tearDown(self):
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "4"

    def test_insights_survives_extreme_production_dates(self):
        for d in ("0001-01-01", "9999-12-31", "2026-02-30", "garbage", ""):
            self.assertEqual(self.c.get("/api/insights?production_date=" + d).status_code, 200, d)

    def test_favicon_request_is_quiet(self):
        r = self.c.get("/favicon.ico")
        self.assertEqual(r.status_code, 204)
        self.assertEqual(r.data, b"")

    def test_other_errors_are_still_never_cached(self):
        calls = []
        real = appmod.fetch_dashboard_rows
        os.environ["RESPONSE_CACHE_TTL_SECONDS"] = "4"
        respcache.clear()

        def boom(*a, **k):
            calls.append(1)
            raise RuntimeError("not a database error")
        appmod.fetch_dashboard_rows = boom
        try:
            self.assertEqual(self.c.get("/api/dashboard?days=all").status_code, 500)
            self.assertEqual(self.c.get("/api/dashboard?days=all").status_code, 500)
        finally:
            appmod.fetch_dashboard_rows = real
        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
