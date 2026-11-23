/* Admin page: polls /api/admin/stats every 5 seconds. */
(function () {
  'use strict';
  var WP = window.WP, $ = WP.$, esc = WP.esc;
  var PAGE_NAMES = { '/api/dashboard': 'Dashboard data', '/api/insights': 'Insights data', '/api/export': 'Excel export (POST)', '/api/export.csv': 'CSV export', '/': 'Overview page', '/insights': 'Insights page' };

  function ago(sec) {
    if (sec < 5) return 'just now';
    if (sec < 60) return Math.round(sec) + ' s ago';
    if (sec < 3600) return Math.round(sec / 60) + ' min ago';
    return Math.round(sec / 3600) + ' h ago';
  }
  function clock(ts) {
    var d = new Date(ts * 1000 + 5.5 * 3600 * 1000);
    return WP.pad(d.getUTCHours()) + ':' + WP.pad(d.getUTCMinutes()) + ':' + WP.pad(d.getUTCSeconds());
  }
  function ms(v) { return v == null ? '—' : (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ms'; }

  function bars(id, series, key, tip, errKey) {
    var el = $(id), W = 600, H = 150, n = series.length, bw = W / n;
    var max = Math.max.apply(null, series.map(function (s) { return s[key]; }).concat([1]));
    var top = max <= 5 ? 5 : Math.ceil(max / 5) * 5;
    var o = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(key) + ' chart">';
    [0.5, 1].forEach(function (f) { var y = H - f * (H - 4); o += '<line class="g" x1="0" x2="' + W + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>'; });
    series.forEach(function (s, i) {
      var h = s[key] / top * (H - 4), x = i * bw;
      o += '<rect class="b" data-i="' + i + '" x="' + (x + 1).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + Math.max(h, s[key] ? 1.5 : 0).toFixed(1) + '"/>';
      if (errKey && s[errKey]) { var eh = s[errKey] / top * (H - 4); o += '<rect class="e" x="' + (x + 1).toFixed(1) + '" y="' + (H - eh).toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + eh.toFixed(1) + '"/>'; }
    });
    o += '</svg><span class="mx">' + top + '</span>';
    el.innerHTML = o; el._s = series; el._tip = tip;
  }
  function area(id, series, key, tip) {
    var el = $(id), W = 600, H = 150, n = series.length;
    var lo = Math.min.apply(null, series.map(function (s) { return s[key]; })), hi = Math.max.apply(null, series.map(function (s) { return s[key]; }).concat([1]));
    var base = lo === hi ? 0 : Math.max(0, lo - (hi - lo) * 0.15), span = (hi - base) || 1;
    var pts = series.map(function (s, i) { return [(n > 1 ? i / (n - 1) : 1) * W, H - 4 - (s[key] - base) / span * (H - 12)]; });
    var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(key) + ' over time"><path class="ar" d="' + path + ' L' + W + ' ' + H + ' L0 ' + H + ' Z"/><path class="ln" d="' + path + '"/></svg><span class="mx">' + hi + '</span>';
    el._s = series; el._tip = tip;
  }
  function wireChart(id) {
    var el = $(id);
    el.addEventListener('mousemove', function (e) {
      var svg = el.querySelector('svg'); if (!svg || !el._s || !el._tip) return;
      var rc = svg.getBoundingClientRect(), i = Math.min(el._s.length - 1, Math.max(0, Math.floor((e.clientX - rc.left) / rc.width * el._s.length)));
      WP.tip.show(el._tip(el._s[i]), e.clientX, e.clientY);
    });
    el.addEventListener('mouseleave', WP.tip.hide);
  }
  function dayLab(iso) { return WP.dayLabel(WP.parseWall(iso + ' 00:00:00')); }
  function dtLab(ts) { var d = new Date(ts * 1000 + 5.5 * 3600 * 1000); return WP.dayLabel(d.getTime()) + ' ' + WP.pad(d.getUTCHours()) + ':' + WP.pad(d.getUTCMinutes()); }
  function bytes(n) { return n == null ? '—' : n < 1024 ? n + ' bytes' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

  function renderUsage(u) {
    if (!u) return;
    $('usErr').hidden = !u.error; $('usErr').textContent = u.error || '';
    $('usSub').textContent = !u.enabled ? 'Logging is switched off (USAGE_LOG=0)'
      : u.first_seen ? 'Recording since ' + dtLab(u.first_seen) + ' IST' : 'No visits recorded yet';
    var cells = [
      ['Different users to date', u.total_users], ['Different computers to date', u.total_computers],
      ['Visits to date', u.total_visits], ['New users this week', u.week_new],
      ['Users this week', u.week_users], ['Users today', u.today_users + (u.today_new ? ' (' + u.today_new + ' new)' : '')]
    ];
    $('usKpi').innerHTML = cells.map(function (x) { return '<div class="stat"><div class="t">' + x[0] + '</div><div class="v">' + esc(x[1]) + '</div></div>'; }).join('');
    var dl = u.daily;
    bars('chDaily', dl, 'users', function (s) { return '<b>' + dayLab(s.date) + '</b><br>' + s.users + ' different users<br>' + s.new + ' new, ' + s.visits + ' visits'; });
    area('chTotal', dl, 'total', function (s) { return '<b>' + dayLab(s.date) + '</b><br>' + s.total + ' users to date'; });
    var ax = '<span>' + dayLab(dl[0].date) + '</span><span>' + dayLab(dl[Math.floor(dl.length / 2)].date) + '</span><span>' + dayLab(dl[dl.length - 1].date) + '</span>';
    $('usAx1').innerHTML = ax; $('usAx2').innerHTML = ax;
    $('usPc').innerHTML = u.computers.length ? u.computers.map(function (c) {
      return '<div class="tr" role="row"><div><b>' + esc(c.ip) + '</b></div><div>' + esc(c.browsers.join(', ')) + '</div><div>' + dtLab(c.first) + '</div><div>' + dtLab(c.last) + '</div><div class="r">' + c.days + '</div><div class="r">' + c.visits + '</div></div>';
    }).join('') : '<div class="empty">No computers recorded yet.</div>';
    $('usFile').innerHTML = u.enabled
      ? 'Log file: <b>' + esc(u.path) + '</b> · ' + u.lines + ' lines · ' + bytes(u.size_bytes) + (u.last_write ? ' · last written ' + dtLab(u.last_write) + ' IST' : '') +
        ' · <a href="/admin/usage.csv" style="text-decoration:underline">Download daily summary (Excel)</a> · <a href="/admin/usage.jsonl" style="text-decoration:underline">Download raw log</a>. A "user" is one browser; the same person on two browsers counts twice.'
      : '';
  }

  function health(d) {
    var thr = d.worker_threads, lat = d.latency_5m, inf = d.inflight_peak_1m, errPct = lat.n ? lat.errors / lat.n * 100 : 0;
    var k = 'ok', t = 'Healthy', why = [];
    if (errPct > 5) { k = 'bad'; t = 'Errors'; why.push(errPct.toFixed(0) + '% of requests failed in the last 5 minutes'); }
    if (thr && inf >= thr) { k = 'bad'; t = 'At capacity'; why.push('all ' + thr + ' worker threads were busy at the same time'); }
    else if (thr && inf >= thr * 0.7 && k === 'ok') { k = 'warn'; t = 'Busy'; why.push(inf + ' of ' + thr + ' worker threads were busy at once'); }
    if (lat.p95 != null && lat.p95 > 1500) { if (k === 'ok') { k = 'warn'; t = 'Slow'; } why.push('the slowest 5% of requests took over ' + ms(lat.p95)); }
    if (!lat.n) return { k: 'neu', t: 'No traffic', msg: 'No requests in the last 5 minutes.' };
    return { k: k, t: t, msg: why.length ? why.join('; ') + '.' : 'Typical request took ' + ms(lat.p50) + '; the slowest 5% took ' + ms(lat.p95) + (thr ? '; at most ' + inf + ' of ' + thr + ' worker threads were busy at once.' : '.') };
  }

  function render(d) {
    $('adSub').textContent = 'Updated ' + clock(d.now) + ' IST · refreshes every 5 seconds · server up ' + ago(d.uptime_s).replace(' ago', '');
    $('adWin').textContent = d.active_window_s;
    $('kNow').textContent = d.active_now; $('kNowS').textContent = 'requested data in the last ' + d.active_window_s + ' s';
    $('k5').textContent = d.active_5m; $('kDay').textContent = d.unique_today;
    $('kReq').textContent = d.requests_last_min; $('kReqS').textContent = d.requests_total + ' since start';
    $('kIn').textContent = d.inflight;
    $('kInS').textContent = 'busiest this minute: ' + d.inflight_peak_1m + (d.worker_threads ? ' of ' + d.worker_threads + ' threads' : '');
    var h = health(d); $('adHealth').className = 'pill ' + h.k; $('adHealth').textContent = h.t; $('adVerdict').textContent = h.msg;
    bars('chUsers', d.series, 'users', function (s) { return '<b>' + clock(s.t) + '</b><br>' + s.users + ' people'; });
    bars('chReq', d.series, 'req', function (s) { return '<b>' + clock(s.t) + '</b><br>' + s.req + ' requests' + (s.err ? '<br>' + s.err + ' errors' : ''); }, 'err');
    renderUsage(d.usage);

    var l = d.latency_5m, c = d.cache;
    var cells = [
      ['Typical response', ms(l.p50)], ['Slowest 5%', ms(l.p95)], ['Slowest', ms(l.max)], ['Requests (5 min)', l.n],
      ['Served from cache', c.hit_pct == null ? '—' : c.hit_pct + '%'], ['Errors (5 min)', l.errors],
      ['Worker threads', d.worker_threads || 'unknown'], ['Data source', d.data_source],
      ['Cache lifetime', d.cache_ttl_s > 0 ? d.cache_ttl_s + ' s' : 'off'], ['Peak at once', d.inflight_peak]
    ];
    $('adCap').innerHTML = cells.map(function (x) { return '<div class="stat"><div class="t">' + x[0] + '</div><div class="v">' + esc(x[1]) + '</div></div>'; }).join('');

    $('adEp').innerHTML = d.endpoints.length ? d.endpoints.map(function (e) {
      return '<div class="tr" role="row"><div><b>' + esc(PAGE_NAMES[e.endpoint] || e.endpoint) + '</b><br><span class="sub">' + esc(e.endpoint) + '</span></div><div class="r">' + e.recent + '</div><div class="r">' + e.total + '</div><div class="r">' + ms(e.avg_ms) + '</div><div class="r">' + ms(e.p95_ms) + '</div><div class="r">' + (e.cache_pct == null ? '—' : e.cache_pct + '%') + '</div><div class="r">' + e.errors + '</div></div>';
    }).join('') : '<div class="empty">No requests yet.</div>';

    $('adWhoSub').textContent = d.visitors.length + ' most recent visitors · ' + d.active_now + ' active now';
    $('adWhoEmpty').hidden = d.visitors.length > 0;
    $('adWho').innerHTML = d.visitors.map(function (v) {
      var a = d.now - v.last;
      return '<div class="tr" role="row"><div><code>#' + esc(v.id) + '</code></div><div>' + esc(v.ip) + '</div><div>' + esc(v.browser) + '</div><div>' + esc(v.page || '—') + '</div><div>' + clock(v.first) + '</div><div>' + ago(a) + '</div><div class="r">' + v.requests + '</div><div>' + WP.pillHtml(v.active ? 'ok' : 'neu', v.active ? 'Active' : 'Idle') + '</div></div>';
    }).join('');
    WP.setLive(true, 'Admin · updated ' + clock(d.now) + ' IST');
  }

  function load() {
    fetch('/api/admin/stats', { cache: 'no-store' }).then(function (r) {
      if (r.status === 401 || r.status === 403 || r.status === 429) { location.reload(); throw new Error('auth'); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(render).catch(function (e) { if (e.message !== 'auth') WP.setLive(false, 'Cannot reach server'); });
  }
  document.addEventListener('DOMContentLoaded', function () {
    wireChart('chUsers'); wireChart('chReq'); wireChart('chDaily'); wireChart('chTotal');
    load(); setInterval(load, 5000);
  });
})();
