(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var TOL = (window.PULSE && window.PULSE.tolerance) || 1.0;   // ± MT considered acceptable (env DELTA_TOLERANCE_MT)
  try { var tv = parseFloat(localStorage.getItem('imwb_tol')); if (tv > 0) TOL = tv; } catch (e) {}

  /* ---------- Plant clock (Asia/Kolkata), expressed as a "naive" local Date ---------- */
  function plantNow() {
    var p = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    return new Date(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  }
  function isoOf(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function prodDateOf(d) { var x = new Date(d.getTime() + (d.getHours() >= 22 ? 86400000 : 0)); return isoOf(x); }
  var NOW = plantNow(), TODAY = prodDateOf(NOW);
  function r2(n) { return n == null ? null : Math.round(n * 100) / 100; }
  function dayStart(iso) { var p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2] - 1, 22, 0, 0); }

  /* ---------- Real data: /api/dashboard rows -> trip objects ---------- */
  var ALL = [];
  function num(v) { return v == null || v === '' ? null : +v; }
  function mapRow(x) {
    var t = new Date(String(x.STATIC_RECORD_TIME).replace(' ', 'T'));
    var o = { id: x.BFCASTID || '-', torp: x.TORPEDO_NO || '-', area: x.STATIC_SOURCE || '', src: x.STATIC_SOURCE || '-', t: t,
      sg: num(x.STATIC_GROSS_WT), st: num(x.STATIC_TARE_WT), sn: num(x.STATIC_NET_WT),
      ig: num(x.IMWB_GROSS_WT), it: num(x.IMWB_TARE_WT), 'in': num(x.IMWB_NET_WT), raw: x };
    var full = [o.sg, o.st, o.sn, o.ig, o.it, o['in']].every(function (v) { return v != null; });
    o.d = full ? r2(o.sn - o['in']) : null;
    o.shift = shiftOf(t);
    return o;
  }
  function classify() {
    ALL.forEach(function (x) { x.status = x.d != null ? (Math.abs(x.d) > TOL ? 'out' : 'ok') : (x.sn != null && x.ig != null ? 'inc' : 'pend'); });
  }
  function shiftOf(d) { var h = d.getHours(); return h >= 22 || h < 6 ? 'C' : (h < 14 ? 'A' : 'B'); }

  /* ---------- State ---------- */
  var S = { date: TODAY, area: 'ALL', filter: 'all', q: '', sort: 't', dir: -1, limit: 10, sel: null };
    function dayRows() {
    var s = dayStart(S.date).getTime(), e = s + 86400000;
    return ALL.filter(function (r) { var k = r.t.getTime(); return k >= s && k < e && (S.area === 'ALL' || r.area === S.area); })
      .sort(function (a, b) { return a.t - b.t; });
  }

  /* ---------- Helpers ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function dm(d) { return pad(d.getDate()) + ' ' + MONTHS[d.getMonth()]; }
  function sgn(n, p) { return n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(p == null ? 2 : p); }
  function f2(n) { return n == null ? '—' : n.toFixed(2); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function stats(rows) {
    var m = rows.filter(function (r) { return r.d != null; }), n = m.length;
    if (!n) return { n: 0 };
    var mean = m.reduce(function (a, r) { return a + r.d; }, 0) / n;
    var sd = n > 1 ? Math.sqrt(m.reduce(function (a, r) { return a + Math.pow(r.d - mean, 2); }, 0) / (n - 1)) : 0;
    var within = m.filter(function (r) { return Math.abs(r.d) <= TOL; }).length;
    return { n: n, mean: mean, sd: sd, within: within, pct: within / n * 100, lo: mean - 1.96 * sd, hi: mean + 1.96 * sd, rows: m,
             sTot: m.reduce(function (a, r) { return a + r.sn; }, 0), iTot: m.reduce(function (a, r) { return a + r.in; }, 0) };
  }
  function dClass(d) { return d == null ? '' : Math.abs(d) > TOL ? 'bad-t' : 'ok-t'; }

  /* ---------- Rail ---------- */
  function renderRail(rows) {
    var w0 = dayStart(S.date).getTime(), span = 86400000, isToday = S.date === TODAY;
    var cur = isToday ? shiftOf(NOW) : null, names = [['C', '22:00–06:00'], ['A', '06:00–14:00'], ['B', '14:00–22:00']];
    var h = names.map(function (n) { return '<div class="seg-lane' + (cur === n[0] ? ' cur' : '') + '"><b>Shift ' + n[0] + '</b><span>' + n[1] + '</span></div>'; }).join('');
    var pins = rows.map(function (r, i) {
      var x = (r.t.getTime() - w0) / span * 100, cls = r.status === 'out' ? 'bad' : (r.status === 'ok' ? '' : 'inc');
      return '<span class="pin ' + cls + '" style="left:' + x.toFixed(2) + '%" data-i="' + i + '"></span>';
    }).join('');
    var now = isToday ? '<span class="now" style="left:' + ((NOW.getTime() - w0) / span * 100).toFixed(2) + '%"></span>' : '';
    $('track').innerHTML = h + '<div class="pins">' + pins + now + '</div>';
    var ws = new Date(w0), we = new Date(w0 + span);
    $('railWin').textContent = dm(ws) + ' 22:00 → ' + dm(we) + ' 22:00 IST';
    $('railTitle').textContent = isToday ? 'Production day · live' : 'Production day';
    $('tolTxt1').textContent = TOL.toFixed(1);
    $('track').querySelectorAll('.pin').forEach(function (p) {
      var r = rows[+p.dataset.i];
      p.addEventListener('mousemove', function (e) { showTip(e, tipHtml(r)); });
      p.addEventListener('mouseleave', hideTip);
      p.addEventListener('click', function () { openDrawer(r); });
    });
  }

  /* ---------- Verdict ---------- */
  function renderVerdict(st) {
    var v = $('verdict');
    if (!st.n) { $('vChipTxt').textContent = 'No data'; $('vTitle').textContent = 'No complete trips in this window'; $('vRead').textContent = 'Nothing to compare yet.'; ['sBias','sSd','sTol','sN'].forEach(function (i) { $(i).textContent = '—'; }); $('gaugeWrap').innerHTML = ''; return; }
    var level = st.pct >= 95 && Math.abs(st.mean) <= 0.3 ? 'ok' : (st.pct >= 85 ? 'warn' : 'bad');
    var col = 'var(--' + level + ')', soft = 'var(--' + level + '-soft)';
    v.style.setProperty('--vc', soft); v.style.setProperty('--vcol', col); v.style.setProperty('--vsoft', soft);
    $('vChip').style.cssText = 'background:' + soft + ';color:' + col;
    $('vChipTxt').textContent = { ok: 'Tracking well', warn: 'Watch closely', bad: 'Drifting' }[level];
    $('vTitle').textContent = { ok: 'In-motion is agreeing with static.', warn: 'Mostly agreeing, but some trips are off.', bad: 'In-motion is disagreeing with static.' }[level];
    var dir = st.mean > 0.05 ? 'higher' : st.mean < -0.05 ? 'lower' : 'level';
    var outN = st.n - st.within, parts = [];
    parts.push('Across ' + st.n + ' complete trips, static reads ' + (dir === 'level' ? 'level with in-motion' : Math.abs(st.mean).toFixed(2) + ' MT ' + dir + ' than in-motion on average') + '.');
    parts.push(outN ? outN + ' trip' + (outN > 1 ? 's sit' : ' sits') + ' outside ±' + TOL.toFixed(1) + ' MT.' : 'Every trip is inside ±' + TOL.toFixed(1) + ' MT.');
    $('vRead').textContent = parts.join(' ');
    $('sBias').innerHTML = '<span style="color:' + col + '">' + sgn(st.mean) + '</span><small>MT</small>';
    $('sSd').innerHTML = st.sd.toFixed(2) + '<small>MT</small>';
    $('sTol').innerHTML = st.pct.toFixed(0) + '<small>%</small>';
    $('sN').textContent = st.n;
    renderGauge(st, col);
  }

  function renderGauge(st, col) {
    var el = $('gaugeWrap'), W = Math.max(el.clientWidth, 260), H = 62, L = 6, pw = W - 12;
    var sc = function (x) { return L + (Math.max(-2.5, Math.min(2.5, x)) + 2.5) / 5 * pw; };
    var g = '<rect x="' + L + '" y="20" width="' + pw + '" height="20" rx="10" fill="var(--panel2)" stroke="var(--line)"/>' +
      '<rect x="' + sc(-TOL) + '" y="20" width="' + (sc(TOL) - sc(-TOL)) + '" height="20" fill="var(--ok-soft)" stroke="var(--ok)" stroke-opacity=".4"/>' +
      '<line x1="' + sc(0) + '" x2="' + sc(0) + '" y1="14" y2="46" stroke="var(--line2)"/>' +
      '<rect x="' + sc(st.lo) + '" y="26" width="' + Math.max(3, sc(st.hi) - sc(st.lo)) + '" height="8" rx="4" fill="' + col + '" opacity=".3"/>' +
      '<rect x="' + (sc(st.mean) - 2.5) + '" y="15" width="5" height="30" rx="2.5" fill="' + col + '"/>';
    [[-2.5, 'start', '−2.5'], [-TOL, 'middle', '−' + TOL.toFixed(1)], [0, 'middle', '0'], [TOL, 'middle', '+' + TOL.toFixed(1)], [2.5, 'end', '+2.5 MT']].forEach(function (t) {
      g += '<text x="' + sc(t[0]) + '" y="' + (H - 4) + '" text-anchor="' + t[1] + '">' + t[2] + '</text>';
    });
    g += '<text x="' + sc(st.lo) + '" y="10" text-anchor="start" style="fill:var(--faint)">95% of trips</text>';
    el.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;height:' + H + 'px"><style>text{font:400 10.5px var(--mono);fill:var(--faint)}</style>' + g + '</svg>';
  }

  /* ---------- Ticket ---------- */
  function renderTicket(rows) {
    var m = rows.filter(function (r) { return r.d != null; }), r = m[m.length - 1];
    if (!r) { $('tTorp').textContent = '—'; return; }
    $('tTorp').textContent = r.torp; $('tMeta').textContent = r.id + ' · ' + r.src;
    $('tSrc').textContent = ''; $('tTime').textContent = dm(r.t) + ', ' + hm(r.t);
    $('tSNet').innerHTML = f2(r.sn) + '<small>MT</small>'; $('tINet').innerHTML = f2(r.in) + '<small>MT</small>';
    $('tSG').textContent = f2(r.sg); $('tST').textContent = f2(r.st); $('tIG').textContent = f2(r.ig); $('tIT').textContent = f2(r.it);
    var d = $('tD'); d.textContent = sgn(r.d); d.className = 'd ' + dClass(r.d);
    $('tP').textContent = sgn(r.d / r.sn * 100) + ' %';
    var prev = m.slice(-7, -1).reverse();
    $('recent').innerHTML = prev.map(function (x, i) { return '<span class="rchip" data-i="' + i + '"><span>' + x.torp + '</span><b class="' + dClass(x.d) + '">' + sgn(x.d) + '</b></span>'; }).join('');
    $('recent').querySelectorAll('.rchip').forEach(function (c) { c.onclick = function () { openDrawer(prev[+c.dataset.i]); }; });
  }

  /* ---------- Charts ---------- */
  function svgEl(w, h, inner) { return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img">' + inner + '</svg>'; }
  function yDom(rows) { var mx = Math.max.apply(null, rows.map(function (r) { return Math.abs(r.d); }).concat([2])); return Math.ceil((mx + .25) * 2) / 2; }

  function renderStream(rows) {
    var el = $('stream'), W = Math.max(el.clientWidth, 320), H = 290, L = 40, R = 12, T = 22, B = 26, pw = W - L - R, ph = H - T - B;
    var m = rows.filter(function (r) { return r.d != null; }), ymax = yDom(m.length ? m : [{ d: 0 }]);
    var w0 = dayStart(S.date).getTime(), x = function (t) { return L + (t - w0) / 86400000 * pw; }, y = function (v) { return T + ph / 2 - v / ymax * (ph / 2); };
    var s = '';
    s += '<rect x="' + L + '" y="' + y(TOL) + '" width="' + pw + '" height="' + (y(-TOL) - y(TOL)) + '" fill="var(--ok-soft)"/>';
    [-ymax, -TOL, 0, TOL, ymax].forEach(function (v) {
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="' + (v === 0 ? 'var(--line2)' : 'var(--line)') + '" stroke-dasharray="' + (v === 0 ? '' : '2 3') + '"/>' +
           '<text x="' + (L - 8) + '" y="' + (y(v) + 3.5) + '" text-anchor="end">' + (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '</text>';
    });
    [8, 16].forEach(function (h) { var xx = x(w0 + h * 3600000); s += '<line x1="' + xx + '" x2="' + xx + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--line)"/>'; });
    [['C', 0], ['A', 8], ['B', 16]].forEach(function (a) { s += '<text x="' + (x(w0 + (a[1] + 4) * 3600000)) + '" y="12" text-anchor="middle" style="fill:var(--mute)">SHIFT ' + a[0] + '</text>'; });
    for (var hh = 0; hh <= 24; hh += 4) { var hr = (22 + hh) % 24; s += '<text x="' + x(w0 + hh * 3600000) + '" y="' + (H - 8) + '" text-anchor="middle">' + pad(hr) + ':00</text>'; }
    if (S.date === TODAY) s += '<line x1="' + x(NOW.getTime()) + '" x2="' + x(NOW.getTime()) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--imwb)" stroke-width="1.5"/>';
    if (m.length > 1) s += '<polyline fill="none" stroke="var(--faint)" stroke-opacity=".45" stroke-width="1" points="' + m.map(function (r) { return x(r.t.getTime()).toFixed(1) + ',' + y(r.d).toFixed(1); }).join(' ') + '"/>';
    m.forEach(function (r, i) {
      var bad = Math.abs(r.d) > TOL;
      s += '<line x1="' + x(r.t.getTime()) + '" x2="' + x(r.t.getTime()) + '" y1="' + y(0) + '" y2="' + y(r.d) + '" stroke="' + (bad ? 'var(--bad)' : 'var(--static)') + '" stroke-opacity=".35"/>' +
           '<circle class="pt" data-i="' + i + '" cx="' + x(r.t.getTime()) + '" cy="' + y(r.d) + '" r="' + (bad ? 5 : 3.6) + '" fill="' + (bad ? 'var(--bad)' : 'var(--static)') + '"/>';
    });
    el.innerHTML = svgEl(W, H, s);
    el.querySelectorAll('.pt').forEach(function (c) {
      var r = m[+c.dataset.i];
      c.addEventListener('mousemove', function (e) { showTip(e, tipHtml(r)); c.setAttribute('r', 6); });
      c.addEventListener('mouseleave', function () { hideTip(); c.setAttribute('r', Math.abs(r.d) > TOL ? 5 : 3.6); });
      c.addEventListener('click', function () { openDrawer(r); });
    });
    $('legStream').innerHTML = '<span><i style="background:var(--static)"></i>Within ±' + TOL.toFixed(1) + ' MT</span><span><i style="background:var(--bad)"></i>Outside</span><span><i style="background:var(--imwb)"></i>Now</span>';
  }

  function renderBA(st) {
    var el = $('ba'), W = Math.max(el.clientWidth, 280), H = 290, L = 40, R = 52, T = 14, B = 44, pw = W - L - R, ph = H - T - B;
    if (!st.n) { el.innerHTML = '<div class="empty">No complete trips.</div>'; return; }
    var m = st.rows, ymax = yDom(m), mn = Math.floor(Math.min.apply(null, m.map(function (r) { return (r.sn + r.in) / 2; })) - 1), mx = Math.ceil(Math.max.apply(null, m.map(function (r) { return (r.sn + r.in) / 2; })) + 1);
    var x = function (v) { return L + (v - mn) / (mx - mn) * pw; }, y = function (v) { return T + ph / 2 - v / ymax * (ph / 2); }, s = '';
    s += '<rect x="' + L + '" y="' + y(TOL) + '" width="' + pw + '" height="' + (y(-TOL) - y(TOL)) + '" fill="var(--ok-soft)"/>';
    [-ymax, 0, ymax].forEach(function (v) { s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)" stroke-dasharray="2 3"/><text x="' + (L - 8) + '" y="' + (y(v) + 3.5) + '" text-anchor="end">' + (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '</text>'; });
    [[st.mean, 'bias', 'var(--imwb)', ''], [st.hi, '+1.96σ', 'var(--mute)', '4 4'], [st.lo, '−1.96σ', 'var(--mute)', '4 4']].forEach(function (l) {
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(l[0]) + '" y2="' + y(l[0]) + '" stroke="' + l[2] + '" stroke-dasharray="' + l[3] + '" stroke-width="1.4"/>' +
           '<text x="' + (W - R + 6) + '" y="' + (y(l[0]) + 3.5) + '" style="fill:' + l[2] + '">' + l[1] + '</text>';
    });
    for (var v = Math.ceil(mn / 5) * 5; v <= mx; v += 5) s += '<text x="' + x(v) + '" y="' + (H - 26) + '" text-anchor="middle">' + v + '</text>';
    s += '<text x="' + (L + pw / 2) + '" y="' + (H - 6) + '" text-anchor="middle" style="fill:var(--mute)">Mean of static &amp; in-motion net (MT) →</text>';
    m.forEach(function (r, i) { var bad = Math.abs(r.d) > TOL; s += '<circle class="pt" data-i="' + i + '" cx="' + x((r.sn + r.in) / 2) + '" cy="' + y(r.d) + '" r="' + (bad ? 5 : 3.6) + '" fill="' + (bad ? 'var(--bad)' : 'var(--static)') + '" fill-opacity=".85"/>'; });
    el.innerHTML = svgEl(W, H, s);
    el.querySelectorAll('.pt').forEach(function (c) { var r = m[+c.dataset.i]; c.addEventListener('mousemove', function (e) { showTip(e, tipHtml(r)); }); c.addEventListener('mouseleave', hideTip); c.addEventListener('click', function () { openDrawer(r); }); });
  }

  /* ---------- Shift lanes ---------- */
  function renderLanes(rows) {
    var cur = S.date === TODAY ? shiftOf(NOW) : null, defs = { C: '22:00 → 06:00', A: '06:00 → 14:00', B: '14:00 → 22:00' };
    $('lanes').innerHTML = ['C', 'A', 'B'].map(function (k) {
      var all = rows.filter(function (r) { return r.shift === k; }), st = stats(all), tot = all.length;
      var spark = '';
      if (st.n > 1) {
        var W = 300, H = 44, ym = Math.max(2, Math.ceil(Math.max.apply(null, st.rows.map(function (r) { return Math.abs(r.d); })) + .2)), n = st.rows.length;
        var xx = function (i) { return 4 + i / (n - 1) * (W - 8); }, yy = function (v) { return H / 2 - v / ym * (H / 2 - 3); };
        spark = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none"><rect x="0" y="' + yy(TOL) + '" width="' + W + '" height="' + (yy(-TOL) - yy(TOL)) + '" fill="var(--ok-soft)"/><line x1="0" x2="' + W + '" y1="' + yy(0) + '" y2="' + yy(0) + '" stroke="var(--line2)"/>' +
          '<polyline fill="none" stroke="var(--static)" stroke-width="1.6" vector-effect="non-scaling-stroke" points="' + st.rows.map(function (r, i) { return xx(i).toFixed(1) + ',' + yy(r.d).toFixed(1); }).join(' ') + '"/>' +
          st.rows.filter(function (r) { return Math.abs(r.d) > TOL; }).map(function (r) { return '<circle cx="' + xx(st.rows.indexOf(r)) + '" cy="' + yy(r.d) + '" r="3" fill="var(--bad)"/>'; }).join('') + '</svg>';
      } else spark = '<svg viewBox="0 0 300 44"></svg>';
      return '<article class="card pad lane"><h3>Shift ' + k + (cur === k ? '<span class="tag">LIVE</span>' : '') + '</h3><div class="win mono">' + defs[k] + '</div>' +
        '<div class="row"><div class="bias ' + (st.n ? (Math.abs(st.mean) > .5 ? 'warn-t' : '') : '') + '">' + (st.n ? sgn(st.mean) : '—') + '<small style="font-size:12px;color:var(--mute);margin-left:4px">MT bias</small></div>' +
        '<div class="kv"><div><b>' + (st.n || 0) + '</b> / ' + tot + ' matched</div><div>SD <b>' + (st.n ? st.sd.toFixed(2) : '—') + '</b> · <b>' + (st.n ? st.pct.toFixed(0) : '—') + '%</b> in tol.</div></div></div>' + spark + '</article>';
    }).join('');
  }

  /* ---------- Ledger ---------- */
  var COLS = [['t', 'Time'], ['id', 'Cast'], ['torp', 'Torpedo'], ['src', 'Source'], ['sn', 'Static net', 1], ['in', 'In-motion net', 1], ['d', 'Δ MT', 0, 1], ['status', 'Status']];
  function ledgerRows(all) {
    var q = S.q.trim().toLowerCase();
    var rows = all.filter(function (r) {
      if (S.filter === 'matched' && r.d == null) return false;
      if (S.filter === 'out' && r.status !== 'out') return false;
      if (S.filter === 'inc' && (r.status === 'ok' || r.status === 'out')) return false;
      return !q || (r.id + ' ' + r.torp + ' ' + r.src).toLowerCase().indexOf(q) > -1;
    });
    rows.sort(function (a, b) {
      var x = a[S.sort], y = b[S.sort]; if (S.sort === 't') { x = +x; y = +y; }
      if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * S.dir;
    });
    return rows;
  }
  function dbar(d) {
    if (d == null) return '<span class="sub">—</span>';
    var half = 75, len = Math.min(1, Math.abs(d) / 2.5) * half, bad = Math.abs(d) > TOL, col = bad ? 'var(--bad)' : 'var(--static)';
    return '<span class="dbar"><span class="tol" style="left:' + (half - TOL / 2.5 * half) + 'px;width:' + (TOL / 2.5 * half * 2) + 'px"></span><span class="fill" style="background:' + col + ';' + (d >= 0 ? 'left:' + half + 'px' : 'left:' + (half - len) + 'px') + ';width:' + Math.max(len, 2) + 'px"></span></span>';
  }
  function stBadge(s) { return s === 'ok' ? '<span class="st ok">In tolerance</span>' : s === 'out' ? '<span class="st bad">Outside</span>' : s === 'inc' ? '<span class="st inc">Incomplete</span>' : '<span class="st pend">Pending</span>'; }
  function renderLedger(all) {
    $('thead').innerHTML = COLS.map(function (c) { return '<th data-k="' + c[0] + '" class="' + (c[2] ? 'r' : '') + '"' + (S.sort === c[0] ? ' data-dir="' + (S.dir > 0 ? '↑' : '↓') + '"' : '') + '>' + c[1] + '</th>'; }).join('');
    $('thead').querySelectorAll('th').forEach(function (th) { th.onclick = function () { var k = th.dataset.k; S.dir = S.sort === k ? -S.dir : (k === 't' ? -1 : 1); S.sort = k; renderLedger(all); }; });
    var rows = ledgerRows(all), shown = rows.slice(0, S.limit);
    $('tbody').innerHTML = shown.map(function (r, i) {
      return '<tr data-i="' + i + '" class="' + (S.sel === r.id ? 'sel' : '') + '"><td class="mono">' + hm(r.t) + ' <span class="sub">' + dm(r.t) + '</span></td><td class="id">' + r.id + '</td><td class="mono">' + r.torp + '</td><td>' + r.src + '</td>' +
        '<td class="r num">' + f2(r.sn) + '</td><td class="r num">' + f2(r.in) + '</td><td class="num ' + dClass(r.d) + '">' + '<span style="display:inline-block;width:52px;text-align:right;margin-right:10px">' + sgn(r.d) + '</span>' + dbar(r.d) + '</td><td>' + stBadge(r.status) + '</td></tr>';
    }).join('');
    $('tbody').querySelectorAll('tr').forEach(function (tr) { tr.onclick = function () { openDrawer(shown[+tr.dataset.i]); }; });
    $('empty').classList.toggle('hidden', rows.length > 0);
    $('ledgerCount').textContent = rows.length + ' of ' + all.length + ' trips';
    $('foot').textContent = rows.length ? 'Showing ' + shown.length + ' of ' + rows.length : '';
    $('more').classList.toggle('hidden', rows.length <= S.limit);
    $('more').onclick = function () { S.limit += 15; renderLedger(all); };
  }

  /* ---------- Tooltip + drawer ---------- */
  function tipHtml(r) {
    return '<b>' + r.torp + '</b> · ' + r.id + '<br><span style="color:var(--mute)">' + dm(r.t) + ', ' + hm(r.t) + ' · ' + r.src + '</span><br>' + (r.d != null ? 'Δ <b class="' + dClass(r.d) + '">' + sgn(r.d) + ' MT</b>' : '<span style="color:var(--warn)">Incomplete</span>');
  }
  function showTip(e, html) { var t = $('tip'); t.innerHTML = html; t.classList.remove('hidden'); var x = e.clientX + 14, y = e.clientY + 14; if (x + 200 > innerWidth) x = e.clientX - 200; t.style.left = x + 'px'; t.style.top = y + 'px'; }
  function hideTip() { $('tip').classList.add('hidden'); }

  function openDrawer(r) {
    S.sel = r.id;
    var row = function (lab, a, b) { var d = (a != null && b != null) ? a - b : null; return '<tr><td>' + lab + '</td><td class="r num" style="color:var(--static)">' + f2(a) + '</td><td class="r num" style="color:var(--imwb)">' + f2(b) + '</td><td class="r num">' + (d == null ? '—' : sgn(d)) + '</td></tr>'; };
    var max = Math.max(r.sn || 0, r.in || 0, 1);
    var bar = function (lab, v, col) { return '<div class="b"><span>' + lab + '</span><div class="t"><i style="width:' + ((v || 0) / max * 100) + '%;background:' + col + '"></i></div><span class="num" style="color:var(--text)">' + f2(v) + '</span></div>'; };
    $('layer').innerHTML = '<div class="scrim" id="scrim"></div><aside class="drawer" role="dialog" aria-label="Trip detail"><button class="icon x" id="close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>' +
      '<div class="eyebrow">' + r.id + ' · ' + r.src + '</div><h3>' + r.torp + '</h3><div style="color:var(--mute);font-size:12.5px">' + dm(r.t) + ', ' + hm(r.t) + ' · Shift ' + r.shift + '</div>' +
      '<div style="margin-top:16px;display:flex;align-items:center;gap:12px"><div class="num ' + dClass(r.d) + '" style="font-size:30px;letter-spacing:-.03em">' + (r.d == null ? '—' : sgn(r.d) + ' MT') + '</div>' + stBadge(r.status) + '</div>' +
      '<table class="cmp"><thead><tr><th></th><th class="r">Static</th><th class="r">In-motion</th><th class="r">Δ</th></tr></thead><tbody>' + row('Gross', r.sg, r.ig) + row('Tare', r.st, r.it) + row('Net', r.sn, r.in) + '</tbody></table>' +
      '<div class="bars">' + bar('Static net', r.sn, 'var(--static)') + bar('In-motion', r.in, 'var(--imwb)') + '</div>' +
      (r.d != null ? '<p style="margin-top:18px;color:var(--mute);font-size:13px">' + (Math.abs(r.d) > TOL ? 'This trip is outside the ±' + TOL.toFixed(1) + ' MT tolerance. ' : 'This trip is inside the ±' + TOL.toFixed(1) + ' MT tolerance. ') + 'The difference is ' + (Math.abs(r.d / r.sn * 100)).toFixed(2) + '% of the static net weight.</p>' : '<p style="margin-top:18px;color:var(--mute);font-size:13px">One side of this trip has not been captured yet, so no comparison is possible.</p>') + '</aside>';
    $('close').onclick = $('scrim').onclick = closeDrawer; $('close').focus();
    renderLedger(dayRows());
  }
  function closeDrawer() { $('layer').innerHTML = ''; S.sel = null; renderLedger(dayRows()); }

  /* ---------- Export ---------- */
  $('export').onclick = function () {
    var rows = ledgerRows(dayRows()), s = dayStart(S.date), e = new Date(s.getTime() + 86400000);
    var btn = $('export'); btn.disabled = true;
    fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      scope: 'current_view', area: S.area, format: 'csv', from_date: isoOf(s), to_date: isoOf(e), filters: { Area: S.area, Status: S.filter, Day: S.date }, visible_rows: rows.map(function (r) { return r.raw; })
    }) }).then(function (res) { if (!res.ok) throw new Error(res.status); return res.blob(); }).then(function (b) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'weighbridge_' + S.date + '.csv'; a.click();
    }).catch(function () { alert('Export failed'); }).then(function () { btn.disabled = false; });
  };

  /* ---------- Controls ---------- */
  function seg(id, key, after) { $(id).addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; $(id).querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); }); S[key] = b.dataset.v; S.limit = 10; after(); }); }
  seg('areaSeg', 'area', render); seg('fSeg', 'filter', function () { renderLedger(dayRows()); });
  $('q').addEventListener('input', function () { S.q = this.value; S.limit = 10; renderLedger(dayRows()); });
  $('date').value = S.date = TODAY;
  $('date').addEventListener('change', function () { if (this.value) { S.date = this.value; S.limit = 10; render(); } });
  function step(n) { var d = new Date(S.date + 'T12:00:00'); d.setDate(d.getDate() + n); var iso = d.toISOString().slice(0, 10); if (iso > TODAY) return; $('date').value = S.date = iso; S.limit = 10; render(); }
  $('prev').onclick = function () { step(-1); }; $('next').onclick = function () { step(1); };
  var MOON = 'M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z', SUN = 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4';
  function themeIcon() { $('themePath').setAttribute('d', document.documentElement.getAttribute('data-theme') === 'dark' ? SUN : MOON); }
  function toggleTheme() { var n = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', n); try { localStorage.setItem('imwb_theme', n); } catch (e) {} themeIcon(); }
  $('theme').onclick = toggleTheme; themeIcon();
  document.addEventListener('keydown', function (e) {
    var typing = /input|select|textarea/i.test((e.target.tagName || ''));
    if (e.key === 'Escape') closeDrawer();
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('q').focus(); }
    if (e.key === 't') toggleTheme();
    if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1);
  });

  /* ---------- Render ---------- */
  function render() {
    var rows = dayRows(), st = stats(rows), isToday = S.date === TODAY;
    $('tolInput').value = TOL;
    $('dot').classList.toggle('off', !isToday);
    $('liveTxt').textContent = isToday ? 'Live · updated ' + hm(plantNow()) : 'Historical day · ' + dm(new Date(S.date + 'T12:00:00'));
    renderRail(rows); renderVerdict(st); renderTicket(rows); renderStream(rows); renderBA(st); renderLanes(rows); renderLedger(rows);
  }
  var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { var rows = dayRows(); renderStream(rows); renderBA(stats(rows)); }, 120); });
  $('tolInput').addEventListener('change', function () {
    var v = parseFloat(this.value); if (!(v > 0)) { this.value = TOL; return; }
    TOL = v; try { localStorage.setItem('imwb_tol', String(v)); } catch (e) {}
    classify(); render();
  });
  function load() {
    fetch('/api/dashboard?days=all&area=ALL&chart_count=10').then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (j) {
      ALL = (j.rows || []).filter(function (x) { return x.STATIC_RECORD_TIME; }).map(mapRow); classify();
      NOW = plantNow(); TODAY = prodDateOf(NOW);
      render();
    }).catch(function () { $('dot').classList.add('off'); $('liveTxt').textContent = 'Connection lost — retrying'; });
  }
  load(); setInterval(load, 5000);
})();
