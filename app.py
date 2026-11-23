"""
Jindal Steel & Power - SMS Digital Transformation & Automation
In-Motion + Static Weighbridge Dashboard Application
Flask + pyodbc + Waitress
"""

import os
import io
import math
import logging
import datetime
import statistics
from functools import wraps
from decimal import Decimal
from zoneinfo import ZoneInfo

# Safe .env loader (auto-loads if python-dotenv is installed)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from flask import Flask, request, jsonify, render_template, Response
import export_service
from respcache import cached_view
from activity import init_activity
from admin import init_admin
logger = logging.getLogger("imwb_app")

app = Flask(__name__)

# Security Headers Middleware
@app.after_request
def apply_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "same-origin"
    return response

# Configuration via Environment Variables
IMWB_SERVER = os.environ.get("IMWB_SERVER")
IMWB_DATABASE = os.environ.get("IMWB_DATABASE", "IMWB_STWB")
IMWB_USER = os.environ.get("IMWB_USER")
IMWB_PASSWORD = os.environ.get("IMWB_PASSWORD")
ODBC_DRIVER = os.environ.get("ODBC_DRIVER", "ODBC Driver 18 for SQL Server")
TIMEZONE_STR = os.environ.get("IMWB_TIMEZONE", "Asia/Kolkata")
PLANT_TZ = ZoneInfo(TIMEZONE_STR)

# Try pyodbc import
try:
    import pyodbc
    PYODBC_AVAILABLE = True
except ImportError:
    PYODBC_AVAILABLE = False
    logger.warning("pyodbc is not installed. Live database access is unavailable "
                   "(simulated demo data is used only while IMWB_SERVER is empty).")


class DataSourceError(Exception):
    """The live database is configured but could not be read.

    Raised instead of quietly showing simulated numbers: when the plant database
    is down the dashboard must say "unavailable", never show made-up weighments
    as if they were real.
    """


LAST_DB_ERROR = None   # text of the latest database failure; None while healthy


def get_db_connection():
    if not IMWB_SERVER:
        return None                      # no database configured: simulated demo data
    if not PYODBC_AVAILABLE:
        raise DataSourceError("IMWB_SERVER is set but the pyodbc package is not installed")
    conn_str = (
        f"DRIVER={{{ODBC_DRIVER}}};"
        f"SERVER={IMWB_SERVER};"
        f"DATABASE={IMWB_DATABASE};"
        f"UID={IMWB_USER};"
        f"PWD={IMWB_PASSWORD};"
        f"TrustServerCertificate=yes;"
        f"Connection Timeout=5;"
    )
    return pyodbc.connect(conn_str)


# Production Day & Shift Calculation (Authoritative Section 9)
def get_production_date_and_shift(dt):
    """
    Production Date D runs D-1 22:00 -> D 22:00.
    Shift C: D-1 22:00 -> D 06:00
    Shift A: D 06:00 -> D 14:00
    Shift B: D 14:00 -> D 22:00
    """
    h = dt.hour
    if h >= 22:
        prod_date = dt.date() + datetime.timedelta(days=1)
        shift = "C"
    elif h < 6:
        prod_date = dt.date()
        shift = "C"
    elif 6 <= h < 14:
        prod_date = dt.date()
        shift = "A"
    else:
        prod_date = dt.date()
        shift = "B"
    return prod_date, shift


def get_production_window_bounds(prod_date):
    """Returns start and end datetime for production date D."""
    prev_date = prod_date - datetime.timedelta(days=1)
    start_dt = datetime.datetime(prev_date.year, prev_date.month, prev_date.day, 22, 0, 0, tzinfo=PLANT_TZ)
    end_dt = datetime.datetime(prod_date.year, prod_date.month, prod_date.day, 22, 0, 0, tzinfo=PLANT_TZ)
    return start_dt, end_dt


# Complete Matched Trip Definition (Section 8)
def _is_num(v):
    """A real, finite number (not None, not text, not NaN/Infinity)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def is_complete_matched(r):
    # A row only counts when every figure the statistics need is a usable number,
    # so one damaged row can never break the Insights page or the exports.
    if not isinstance(r, dict) or r.get("MATCH_STATUS") != "MATCHED":
        return False
    required_fields = [
        "STATIC_GROSS_WT", "STATIC_TARE_WT", "STATIC_NET_WT",
        "IMWB_GROSS_WT", "IMWB_TARE_WT", "IMWB_NET_WT",
        "NET_WT_DIFFERENCE"
    ]
    return all(_is_num(r.get(f)) for f in required_fields)


# Format helper for JSON
def serialize_val(val):
    if isinstance(val, (datetime.datetime, datetime.date)):
        return val.strftime("%Y-%m-%d %H:%M:%S") if isinstance(val, datetime.datetime) else val.isoformat()
    if isinstance(val, Decimal):
        val = float(val)
    if isinstance(val, float) and not math.isfinite(val):
        return None            # NaN / Infinity are not valid JSON
    return val


def _days_to_int(days):
    """'all' or junk -> None (no date filter); otherwise whole days kept in a safe range."""
    if not days or days == "all":
        return None
    try:
        return max(0, min(int(days), 36500))
    except (TypeError, ValueError):
        return None


def _in_window(r, start, end):
    """True if the row's STATIC_RECORD_TIME falls in [start, end); unreadable times never match."""
    try:
        t = datetime.datetime.fromisoformat(r["STATIC_RECORD_TIME"]).replace(tzinfo=PLANT_TZ)
    except (KeyError, TypeError, ValueError):
        return False
    return start <= t < end


# Simulated Data Generator for Offline / Local Verification
def generate_sample_dataset():
    now = datetime.datetime.now(PLANT_TZ)
    records = []
    torpedo_pool = ["T-01", "T-04", "T-06", "T-08", "T-12", "T-15", "T-19", "T-22"]
    
    # Generate 50 realistic historical hot-metal torpedo movements
    for i in range(50):
        t = now - datetime.timedelta(minutes=35 * i)
        torp = torpedo_pool[i % len(torpedo_pool)]
        cast_id = f"C26{1000 + (i // 2)}"
        source = "BF1" if (i % 2 == 0) else "BF2"

        static_gross = round(410.0 + (i * 1.7) % 20, 2)
        static_tare = round(125.0 + (i * 0.9) % 10, 2)
        static_net = round(static_gross - static_tare, 2)

        # Seeded deltas
        if i == 0:
            delta = 9.48   # Exact spec validation delta
        elif i == 4:
            delta = -14.29 # Negative IMWB higher
        elif i == 8:
            delta = 0.00
        else:
            delta = round(((i * 5) % 13 - 6) * 0.55, 2)

        imwb_net = round(static_net - delta, 2)
        imwb_tare = round(static_tare + 0.35, 2)
        imwb_gross = round(imwb_net + imwb_tare, 2)
        delta_pct = round((delta / static_net) * 100, 2) if static_net else 0.0

        # Incomplete rows for edge testing
        if i == 47:
            match_status = "GROSS_ONLY"
            imwb_tare = None
            imwb_net = None
            delta = None
            delta_pct = None
        elif i == 48:
            match_status = "PENDING"
        else:
            match_status = "MATCHED"

        gross_time = t - datetime.timedelta(minutes=20)
        tare_time = t + datetime.timedelta(minutes=40)

        records.append({
            "STATIC_SOURCE": source,
            "STATIC_SOURCE_ID": 20000 + i,
            "BFCASTID": cast_id,
            "TORPEDO_NO": torp,
            "STATIC_SEQNO": i + 1,
            "STATIC_GROSS_WT": static_gross,
            "STATIC_GROSS_TIME": gross_time.strftime("%Y-%m-%d %H:%M:%S"),
            "STATIC_TARE_WT": static_tare,
            "STATIC_TARE_TIME": tare_time.strftime("%Y-%m-%d %H:%M:%S"),
            "STATIC_NET_WT": static_net,
            "STATIC_RECORD_TIME": t.strftime("%Y-%m-%d %H:%M:%S"),
            "IMWB_GROSS_LOAD_ID": 70000 + i,
            "IMWB_GROSS_WT": imwb_gross,
            "IMWB_GROSS_TIME": (gross_time + datetime.timedelta(seconds=55)).strftime("%Y-%m-%d %H:%M:%S"),
            "GROSS_TIME_DIFF_SECONDS": 55,
            "IMWB_TARE_LOAD_ID": 80000 + i if imwb_tare is not None else None,
            "IMWB_TARE_WT": imwb_tare,
            "IMWB_TARE_TIME": (tare_time - datetime.timedelta(seconds=25)).strftime("%Y-%m-%d %H:%M:%S") if imwb_tare is not None else None,
            "TARE_TIME_DIFF_SECONDS": 25 if imwb_tare is not None else None,
            "IMWB_NET_WT": imwb_net,
            "NET_WT_DIFFERENCE": delta,
            "NET_WT_DIFFERENCE_PCT": delta_pct,
            "MATCH_STATUS": match_status
        })

    return records


def fetch_dashboard_rows(area=None, days=None, limit=None):
    """Queries dbo.dashboard.

    Simulated demo data is used ONLY when no database is configured (IMWB_SERVER
    empty). If a configured database cannot be read, DataSourceError is raised so
    the pages report "unavailable" instead of showing made-up numbers.
    """
    global LAST_DB_ERROR
    d_int = _days_to_int(days)
    conn = None
    try:
        conn = get_db_connection()
        if conn:
            cursor = conn.cursor()
            query = "SELECT * FROM dbo.dashboard WHERE 1=1"
            params = []
            if area and area.upper() in ("BF1", "BF2"):
                query += " AND STATIC_SOURCE = ?"
                params.append(area.upper())
            if d_int is not None:
                query += " AND STATIC_RECORD_TIME >= DATEADD(day, -?, GETDATE())"
                params.append(d_int)
            query += " ORDER BY STATIC_RECORD_TIME DESC, STATIC_SOURCE_ID DESC"
            cursor.execute(query, params)
            columns = [column[0] for column in cursor.description]
            raw_rows = cursor.fetchall()
            if limit:
                raw_rows = raw_rows[:limit]
            results = []
            for row in raw_rows:
                r_dict = {}
                for idx, col in enumerate(columns):
                    r_dict[col] = serialize_val(row[idx])
                results.append(r_dict)
            LAST_DB_ERROR = None
            return results
    except DataSourceError as e:
        LAST_DB_ERROR = str(e)
        logger.error(f"Database not usable: {e}")
        raise
    except Exception as e:
        LAST_DB_ERROR = f"{type(e).__name__}: {e}"
        logger.error(f"Database query failed: {e}")
        raise DataSourceError("database_unavailable") from e
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass

    # No database configured: deterministic sample dataset (demo / offline mode)
    data = generate_sample_dataset()
    if area and area.upper() in ("BF1", "BF2"):
        data = [r for r in data if r["STATIC_SOURCE"] == area.upper()]
    if d_int is not None:
        cutoff = datetime.datetime.now(PLANT_TZ) - datetime.timedelta(days=d_int)
        data = [
            r for r in data
            if datetime.datetime.fromisoformat(r["STATIC_RECORD_TIME"]).replace(tzinfo=PLANT_TZ) >= cutoff
        ]
    if limit:
        data = data[:limit]
    return data


# Statistical Engine for Insights (Section 21)
def calculate_complete_stats(matched_rows):
    # EDGE CASE: If no matched trips exist for this shift/day
    if not matched_rows:
        return {
            "count": 0, "mean": 0.0, "median": 0.0, "mode": 0.0, "stdev": 0.0,
            "q1": 0.0, "q3": 0.0, "iqr": 0.0, "q5": 0.0, "q95": 0.0, 
            "p90_abs": 0.0, "min": 0.0, "max": 0.0,
            "outlier_count": 0, "outlier_rate": 0.0, "static_net_total": 0.0,
            "imwb_net_total": 0.0, "total_signed_delta": 0.0
        }

    deltas = [r["NET_WT_DIFFERENCE"] for r in matched_rows]
    n = len(deltas)
    s_deltas = sorted(deltas)

    mean_val = round(sum(s_deltas) / n, 2)
    median_val = round(statistics.median(s_deltas), 2)

    # Mode rounded to 0.1 MT
    rounded_deltas = [round(x, 1) for x in s_deltas]
    counts = {}
    for r_val in rounded_deltas:
        counts[r_val] = counts.get(r_val, 0) + 1
    max_c = max(counts.values())
    mode_val = round([k for k, v in counts.items() if v == max_c][0], 2)

    std_val = round(statistics.stdev(s_deltas), 2) if n > 1 else 0.0

    # Q1, Q3, IQR
    if n >= 4:
        q1, _, q3 = statistics.quantiles(s_deltas, n=4, method="inclusive")
    elif n == 3:
        q1, q3 = s_deltas[0], s_deltas[2]
    elif n == 2:
        q1, q3 = s_deltas[0], s_deltas[1]
    else:
        q1, q3 = s_deltas[0], s_deltas[0]
    q1 = round(q1, 2)
    q3 = round(q3, 2)
    iqr = round(q3 - q1, 2)

    lower_bound = q1 - 1.5 * iqr
    upper_bound = q3 + 1.5 * iqr
    outliers = [x for x in s_deltas if x < lower_bound or x > upper_bound]
    outlier_count = len(outliers)
    outlier_rate = round((outlier_count / n) * 100, 1)

    # P90 Absolute Delta
    abs_deltas = sorted([abs(x) for x in s_deltas])
    p90_idx = max(0, min(n - 1, int(math.ceil(0.9 * n)) - 1))
    p90_abs = round(abs_deltas[p90_idx], 2)

    # Q5 and Q95
    q5 = round(statistics.quantiles(s_deltas, n=20, method="inclusive")[0], 2) if n > 1 else s_deltas[0]
    q95 = round(statistics.quantiles(s_deltas, n=20, method="inclusive")[-1], 2) if n > 1 else s_deltas[0]

    static_net_total = round(sum(r["STATIC_NET_WT"] for r in matched_rows), 2)
    imwb_net_total = round(sum(r["IMWB_NET_WT"] for r in matched_rows), 2)
    total_signed_delta = round(static_net_total - imwb_net_total, 2)

    return {
        "count": n,
        "mean": mean_val,
        "median": median_val,
        "mode": mode_val,
        "stdev": std_val,
        "q1": q1,
        "q3": q3,
        "iqr": iqr,
        "q5": q5,
        "q95": q95,
        "p90_abs": p90_abs,
        "min": round(s_deltas[0], 2),
        "max": round(s_deltas[-1], 2),
        "outlier_count": outlier_count,
        "outlier_rate": outlier_rate,
        "static_net_total": static_net_total,
        "imwb_net_total": imwb_net_total,
        "total_signed_delta": total_signed_delta
    }


# Deterministic Operational Interpretation Engine (Section 23)
def generate_operational_interpretation(stats):
    if not stats or stats["count"] == 0:
        return ["No complete matched trips recorded for the selected production window."]

    lines = []
    n = stats["count"]
    mean = stats["mean"]
    median = stats["median"]
    stdev = stats["stdev"]
    iqr = stats["iqr"]
    outlier_count = stats["outlier_count"]
    outlier_rate = stats["outlier_rate"]

    # 1. Systematic signed bias
    if abs(mean) < 0.25:
        lines.append(
            f"Systematic Signed Bias: Negligible average bias ({mean:+.2f} MT across {n} complete trips). "
            f"Static and In-Motion scale measurements demonstrate tight mean alignment across the operational cycle."
        )
    elif mean > 0:
        lines.append(
            f"Systematic Signed Bias: Positive systematic bias of {mean:+.2f} MT across {n} complete trips. "
            f"Static weighbridge yields higher net hot-metal weights on average compared to the in-motion weighbridge."
        )
    else:
        lines.append(
            f"Systematic Signed Bias: Negative systematic bias of {mean:+.2f} MT across {n} complete trips. "
            f"In-motion weighbridge registers higher net hot-metal weights on average than the static platform."
        )

    # 2. Typical trip (median) & Mean/Median skew
    skew_diff = round(mean - median, 2)
    if abs(skew_diff) < 0.2:
        lines.append(
            f"Central Tendency: Symmetrical distribution. The typical trip delta (median: {median:+.2f} MT) "
            f"closely tracks the mean ({mean:+.2f} MT), indicating that operational trips are not distorted by heavy tails."
        )
    elif skew_diff > 0:
        lines.append(
            f"Central Tendency & Skew: Right-skewed distribution. The typical trip delta (median: {median:+.2f} MT) "
            f"is lower than the mean ({mean:+.2f} MT), pulled upward by high positive tare/gross measurement excursions."
        )
    else:
        lines.append(
            f"Central Tendency & Skew: Left-skewed distribution. The typical trip delta (median: {median:+.2f} MT) "
            f"is higher than the mean ({mean:+.2f} MT), pulled lower by heavier dynamic impact readings."
        )

    # 3. Repeatability & Robust spread (IQR)
    if iqr == 0:
        lines.append(
            f"Robust Spread & Repeatability: Standard deviation is {stdev:.2f} MT. "
            f"The interquartile range (IQR) is 0.00 MT, showing that the middle 50% of torpedo trips share "
            f"the exact same signed delta ({stats['q1']:+.2f} MT)."
        )
    else:
        lines.append(
            f"Robust Spread & Repeatability: Standard deviation is {stdev:.2f} MT, with a middle 50% spread "
            f"(IQR) of {iqr:.2f} MT (Q1: {stats['q1']:+.2f} MT, Q3: {stats['q3']:+.2f} MT)."
        )

    # 4. Outliers
    if outlier_count == 0:
        lines.append(
            "Weighment Stability: Zero statistical outliers detected outside 1.5× IQR thresholds; "
            "all dynamic torpedo passes conformed to normal operational variance."
        )
    else:
        lines.append(
            f"Weighment Stability: {outlier_count} outlier trip(s) detected ({outlier_rate:.1f}% of matched trips) "
            f"outside 1.5× IQR bounds, indicating localized transient rail vibrations or slag build-up."
        )
        
    # 5. Q5-Q95 Error Envelope
    lines.append(
        f"Observed Error Envelope: 90% of all trips fall between the Q5 ({stats['q5']:+.2f} MT) and Q95 ({stats['q95']:+.2f} MT) bounds, "
        f"representing the core operational variance of the weighbridges."
    )

    return lines


# Web Routes
def page_config():
    """Tolerance (MT) and pass target (%) shown on the dashboard pages."""
    def _f(name, default):
        try:
            return float(os.environ.get(name, default))
        except ValueError:
            return float(default)
    return {"tolerance": _f("DELTA_TOLERANCE_MT", "1.0"), "target": _f("PASS_TARGET_PCT", "95")}


@app.route("/")
def index():
    return render_template("index.html", **page_config())


@app.route("/insights")
def insights():
    return render_template("insights.html", **page_config())


@app.route("/healthz")
def healthz():
    conn = None
    try:
        conn = get_db_connection()
        if conn:
            cursor = conn.cursor()
            cursor.execute("SELECT 1")
            cursor.fetchone()
            return jsonify({"status": "ok"}), 200
        else:
            return jsonify({"status": "ok", "mode": "simulated_plant"}), 200
    except Exception as e:
        logger.error(f"Health check database failure: {e}")
        return jsonify({"status": "error", "error": "database_unavailable"}), 503
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def _db_unavailable_response():
    resp = jsonify({
        "status": "error",
        "error": "database_unavailable",
        "message": "The plant database could not be read. Figures on screen may be out of date.",
    })
    resp.status_code = 503
    resp.headers["Retry-After"] = "5"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.errorhandler(DataSourceError)
def handle_data_source_error(e):
    return _db_unavailable_response()


def db_guard(fn):
    """Turn a database failure into a clean 503 response (which respcache holds for a
    few seconds, so a crowd of waiting browsers does not each retry a slow connection)."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except DataSourceError:
            return _db_unavailable_response()
    return wrapper


@app.route("/favicon.ico")
def favicon():
    return "", 204


@app.route("/api/dashboard")
@cached_view
@db_guard
def api_dashboard():
    area = request.args.get("area", "ALL")
    days = request.args.get("days", "7")
    chart_count = request.args.get("chart_count", "10")

    all_rows = fetch_dashboard_rows(area=area, days=days)
    all_matched = [r for r in all_rows if is_complete_matched(r)]

    # Latest Complete Matched Trip (Card 1 rule: newest complete matched trip)
    latest_matched = all_matched[0] if all_matched else None

    # Chart Selection: Independent of date filter (fetched from recent matched trips)
    unfiltered_rows = all_rows if days == "all" else fetch_dashboard_rows(area=area, days="all")
    unfiltered_matched = [r for r in unfiltered_rows if is_complete_matched(r)]

    if chart_count.lower() == "all":
        chart_trips = unfiltered_matched[:20000]
        chart_capped = len(unfiltered_matched) > 20000
    else:
        try:
            c_int = int(chart_count)
            chart_trips = unfiltered_matched[:c_int]
            chart_capped = False
        except ValueError:
            chart_trips = unfiltered_matched[:10]
            chart_capped = False

    # Chart data points chronologically (oldest to newest for visual sequence)
    chart_data = []
    for r in reversed(chart_trips):
        t_raw = r.get("STATIC_RECORD_TIME") or ""
        t_short = t_raw[11:16] if len(t_raw) >= 16 else t_raw
        chart_data.append({
            "torpedo_no": r.get("TORPEDO_NO") or "-",
            "prod_time": t_short,
            "delta": r.get("NET_WT_DIFFERENCE") or 0.0
        })

    summary = {
        "total_records": len(all_rows),
        "matched_records": len(all_matched),
        "match_rate": round((len(all_matched) / len(all_rows) * 100), 1) if all_rows else 0.0,
        "latest_complete_matched": latest_matched,
        "chart_capped": chart_capped,
        "total_matched_available": len(unfiltered_matched)
    }

    return jsonify({
        "summary": summary,
        "chart_data": chart_data,
        "rows": all_rows,
        "returned_records": len(all_rows),
        "truncated": False
    })


@app.route("/api/insights")
@cached_view
@db_guard
def api_insights():
    area = request.args.get("area", "ALL")
    date_param = request.args.get("production_date")

    now = datetime.datetime.now(PLANT_TZ)
    if date_param:
        try:
            prod_date = datetime.date.fromisoformat(date_param)
        except ValueError:
            prod_date, _ = get_production_date_and_shift(now)
    else:
        prod_date, _ = get_production_date_and_shift(now)

    try:
        start_window, end_window = get_production_window_bounds(prod_date)
    except OverflowError:                 # e.g. production_date=0001-01-01
        prod_date, _ = get_production_date_and_shift(now)
        start_window, end_window = get_production_window_bounds(prod_date)

    all_rows = fetch_dashboard_rows(area=area, days="all")
    day_rows = []
    for r in all_rows:
        try:
            dt = datetime.datetime.fromisoformat(r["STATIC_RECORD_TIME"]).replace(tzinfo=PLANT_TZ)
            if start_window <= dt < end_window:
                day_rows.append(r)
        except Exception:
            continue

    # Classify by Shifts in authoritative order: C, A, B
    shifts_data = {"C": [], "A": [], "B": []}
    for r in day_rows:
        dt = datetime.datetime.fromisoformat(r["STATIC_RECORD_TIME"]).replace(tzinfo=PLANT_TZ)
        _, shift = get_production_date_and_shift(dt)
        shifts_data[shift].append(r)

    shift_cards = []
    pivot_rows = []
    for s_name in ["C", "A", "B"]:
        rows = shifts_data[s_name]
        matched = [r for r in rows if is_complete_matched(r)]
        stats = calculate_complete_stats(matched)

        shift_cards.append({
            "shift": s_name,
            "total_records": len(rows),
            "complete_matched": len(matched),
            "static_net_total": stats["static_net_total"],
            "imwb_net_total": stats["imwb_net_total"],
            "total_signed_delta": stats["total_signed_delta"],
            "mean_delta": stats["mean"]
        })

        pivot_rows.append({
            "shift": s_name,
            "trips": len(matched),
            "static_total": stats["static_net_total"],
            "imwb_total": stats["imwb_net_total"],
            "delta_total": stats["total_signed_delta"],
            "mean": stats["mean"],
            "median": stats["median"],
            "mode": stats["mode"],
            "stdev": stats["stdev"],
            "iqr": stats["iqr"],
            "q5": stats["q5"],       
            "q95": stats["q95"],     
            "p90_abs": stats["p90_abs"], 
            "outlier_pct": stats["outlier_rate"]
        })

    day_matched = [r for r in day_rows if is_complete_matched(r)]
    day_stats = calculate_complete_stats(day_matched)
    interpretation = generate_operational_interpretation(day_stats)

    return jsonify({
        "production_date": prod_date.isoformat(),
        "production_window": {
            "start": start_window.strftime("%Y-%m-%d %H:%M:%S"),
            "end": end_window.strftime("%Y-%m-%d %H:%M:%S")
        },
        "shift_cards": shift_cards,
        "statistics": day_stats,
        "by_shift": pivot_rows,
        "interpretation": interpretation
    })


@app.route("/api/export", methods=["POST"])
def api_export():
    def bad_request(code, message):
        return jsonify({"status": "error", "error": code, "message": message}), 400

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}
    scope = payload.get("scope")
    scope = scope if isinstance(scope, str) else "current_view"
    area = payload.get("area")
    area = area if isinstance(area, str) else "ALL"
    fmt = payload.get("format") or "xlsx"
    fmt = fmt.lower() if isinstance(fmt, str) else ""
    if fmt not in ("xlsx", "csv"):
        return bad_request("unsupported_format", "format must be 'xlsx' or 'csv'")
    custom_from = payload.get("from_date")
    custom_to = payload.get("to_date")
    active_filters = payload.get("filters")
    if not isinstance(active_filters, dict):
        active_filters = {}

    now = datetime.datetime.now(PLANT_TZ)
    if scope == "current_day":
        prod_date, _ = get_production_date_and_shift(now)
        start_w, end_w = get_production_window_bounds(prod_date)
        raw_rows = fetch_dashboard_rows(area=area, days="all")
        rows = [r for r in raw_rows if _in_window(r, start_w, end_w)]
        date_desc = f"Production Day {prod_date.isoformat()}"
    elif scope == "7_days":
        rows = fetch_dashboard_rows(area=area, days="7")
        date_desc = "Last 7 Days"
    elif scope == "14_days":
        rows = fetch_dashboard_rows(area=area, days="14")
        date_desc = "Last 14 Days"
    elif scope == "30_days":
        rows = fetch_dashboard_rows(area=area, days="30")
        date_desc = "Last 30 Days"
    elif scope == "custom" and custom_from and custom_to:
        try:
            f_day = datetime.datetime.fromisoformat(custom_from).date()
            t_day = datetime.datetime.fromisoformat(custom_to).date()
            f_dt = datetime.datetime(f_day.year, f_day.month, f_day.day, tzinfo=PLANT_TZ)
            t_dt = datetime.datetime(t_day.year, t_day.month, t_day.day, tzinfo=PLANT_TZ) + datetime.timedelta(days=1)
        except (TypeError, ValueError, OverflowError):
            return bad_request("invalid_date", "from_date and to_date must be dates like 2026-11-23")
        raw_rows = fetch_dashboard_rows(area=area, days="all")
        rows = [r for r in raw_rows if _in_window(r, f_dt, t_dt)]
        date_desc = f"{custom_from} to {custom_to}"
    elif scope == "all":
        rows = fetch_dashboard_rows(area=area, days="all")
        date_desc = "All Available History"
    else:  # current_view
        visible = payload.get("visible_rows")
        if visible is None or visible == []:
            rows = fetch_dashboard_rows(area=area, days="7")
        elif isinstance(visible, list) and all(isinstance(r, dict) for r in visible):
            rows = visible
        else:
            return bad_request("invalid_rows", "visible_rows must be a list of row objects")
        date_desc = "Current Filtered Table View"

    # Filter application
    if active_filters:
        filter_str = ", ".join(f"{k}: {v}" for k, v in active_filters.items())
    else:
        filter_str = "None"

    matched = [r for r in rows if is_complete_matched(r)]
    stats = calculate_complete_stats(matched)
    stats["total_records"] = len(rows)
    stats["matched_records"] = len(matched)

    metadata = {
        "generated_at": now.strftime("%Y-%m-%d %H:%M:%S"),
        "area": area,
        "date_range": date_desc,
        "filters": filter_str
    }

    timestamp_str = now.strftime("%Y%m%d_%H%M%S")
    if fmt == "csv":
        csv_bytes = export_service.generate_csv_report(rows)
        return Response(
            csv_bytes,
            mimetype="text/csv",
            headers={"Content-Disposition": f"attachment; filename=IMWB_Weighbridge_Report_{timestamp_str}.csv"}
        )

    excel_bytes = export_service.generate_excel_report(rows, stats, metadata)
    return Response(
        excel_bytes,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=IMWB_Weighbridge_Report_{timestamp_str}.xlsx"}
    )


@app.route("/api/export.csv")
def legacy_export_csv():
    rows = fetch_dashboard_rows()
    csv_bytes = export_service.generate_csv_report(rows)
    timestamp_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    return Response(
        csv_bytes,
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=IMWB_Weighbridge_Report_{timestamp_str}.csv"}
    )


def _admin_info():
    """Server facts shown on the admin page."""
    try:
        threads = int(os.environ.get("WAITRESS_THREADS", ""))
    except ValueError:
        threads = None
    try:
        ttl = float(os.environ.get("RESPONSE_CACHE_TTL_SECONDS", "4"))
    except ValueError:
        ttl = 4.0
    live = bool(IMWB_SERVER)
    return {"worker_threads": threads, "cache_ttl_s": ttl,
            "data_source": "Live database" if live else "Simulated data",
            "db_error": LAST_DB_ERROR}


# Who is using the site (admin page) and the shared-answer cache
init_activity(app, PLANT_TZ)
init_admin(app, page_config, _admin_info)


if __name__ == "__main__":
    # Development only. For real use run:  python serve.py   (waitress).
    # The Flask debugger is OFF unless FLASK_DEBUG=1 is set on purpose, because it
    # must never be reachable from the plant network.
    port = int(os.environ.get("PORT", 5002))
    debug = os.environ.get("FLASK_DEBUG", "").lower() in ("1", "true", "yes")
    app.run(host=os.environ.get("HOST", "0.0.0.0"), port=port, debug=debug)