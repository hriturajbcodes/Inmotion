"""Pretend N people have the dashboard open and measure how the site responds.

    python loadtest.py --url http://localhost:5002 --users 40 --seconds 60

Each pretend person loads the Overview page once, then asks for /api/dashboard
every --interval seconds (the real dashboard does this every 5 seconds) and
for /api/insights every 30 seconds, just like a browser would. Prints how long
answers took. Run it against a test copy, not during a critical shift: it
puts real load on the server and its database.
"""
import argparse
import statistics
import threading
import time
import urllib.request


def get(url, results, name):
    t0 = time.perf_counter()
    try:
        req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()
            ok = r.status == 200
    except Exception:
        ok = False
    results.append((name, (time.perf_counter() - t0) * 1000, ok))


def person(base, seconds, interval, results, offset):
    time.sleep(offset)                       # people do not all click at the same instant
    end = time.time() + seconds
    get(base + "/", results, "page")
    n = 0
    while time.time() < end:
        get(base + "/api/dashboard?days=all", results, "dashboard")
        if n % max(1, int(30 / interval)) == 0:
            get(base + "/api/insights?area=ALL", results, "insights")
        n += 1
        time.sleep(interval)


def pct(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, int(round((len(v) - 1) * p)))] if v else float("nan")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:5002")
    ap.add_argument("--users", type=int, default=20)
    ap.add_argument("--seconds", type=int, default=30)
    ap.add_argument("--interval", type=float, default=5.0)
    a = ap.parse_args()
    results = []
    ts = [threading.Thread(target=person, args=(a.url.rstrip("/"), a.seconds, a.interval, results, i * a.interval / a.users))
          for i in range(a.users)]
    t0 = time.time()
    [t.start() for t in ts]
    [t.join() for t in ts]
    took = time.time() - t0
    for name in ("page", "dashboard", "insights"):
        ms = [r[1] for r in results if r[0] == name]
        if ms:
            print("%-10s n=%-5d median %7.0f ms   95%% %7.0f ms   slowest %7.0f ms" % (name, len(ms), statistics.median(ms), pct(ms, .95), max(ms)))
    bad = sum(1 for r in results if not r[2])
    print("%d requests in %.0f s (%.1f per second), %d failed" % (len(results), took, len(results) / took, bad))
