/* Overview page. Data: /api/dashboard (polled), export: POST /api/export. */
(function () {
  'use strict';
  var WP = window.WP, $ = WP.$, esc = WP.esc;
  var DAY = 86400000, PAGE = 10;
  var S = {
    area: 'ALL', rows: [], first: true,
    /* ONE date selection drives the trip cards, the chart, the summary and the table. */
    d: { preset: 'shift', from: '', to: '', mode: 'range', pd: false },
    c: { key: null },
    g: { type: 'scatter', hi: '', grp: 'day', pinned: null, view: null, note: '' },
    t: { shown: PAGE, f: { cast: '', torp: '', area: '', shift: '', dir: '', status: '', min: 0, sort: 'abs' } }
  };
  var PRESET_LABEL = { shift: 'Current shift', day: 'Current production day', '7': 'Last 7 days', '30': 'Last 30 days', all: 'All available data' };

  function key(r) { return r.cast + '|' + r.torp + '|' + r.ts; }
  function statusOf(d) { return WP.within(d) ? { k: 'ok', t: 'Inside tolerance' } : { k: 'bad', t: 'Outside tolerance' }; }
  function dayMs(s) { return WP.parseWall(s + ' 00:00:00'); }
  function cmpNat(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true }); }

  /* ---------- date ranges ---------- */
  function resolve(o) {
    var now = WP.plantNow();
    if (o.pd && o.from && o.from === o.to) return { from: dayMs(o.from) - 2 * 3600000, to: dayMs(o.from) + 22 * 3600000 };
    if (o.from || o.to) return { from: o.from ? dayMs(o.from) : -Infinity, to: o.to ? dayMs(o.to) + DAY : Infinity };
    switch (o.preset) {
      case 'shift': var st = WP.shiftStart(now); return { from: st, to: st + 8 * 3600000 };
      case 'day': var e = dayMs(WP.prodDateOf(now)) + 22 * 3600000; return { from: e - DAY, to: e };
      case '7': return { from: now - 7 * DAY, to: now + 60000 };
      case '30': return { from: now - 30 * DAY, to: now + 60000 };
      default: return { from: -Infinity, to: Infinity };
    }
  }
  function inRange(rows, rg) { return rows.filter(function (r) { return r.t >= rg.from && r.t < rg.to; }); }
  function describe(o) {
    if (o.from && o.from === o.to) return o.pd ? 'Production day ' + WP.dayLabel(dayMs(o.from)) + ' (22:00 to 22:00)' : WP.dayLabel(dayMs(o.from)) + ' (full day)';
    if (o.from || o.to) {
      return (o.from ? WP.dayLabel(dayMs(o.from)) : 'start') + ' to ' + (o.to ? WP.dayLabel(dayMs(o.to)) : 'now');
    }
    return PRESET_LABEL[o.preset];
  }
  function syncSeg(id, v) {
    var el = $(id); if (!el) return;
    Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-v') === v ? 'true' : 'false'); });
  }
  function syncRange(o, segId, fromId, toId) {
    var p = fromId.charAt(0), day = o.mode === 'day', ctl = $(p + 'Ctl');
    if (segId) syncSeg(segId, (o.from || o.to) ? null : o.preset);
    $(fromId).value = o.from; $(toId).value = o.to;
    ctl.querySelector('.dr-range').hidden = day; ctl.querySelector('.dr-day').hidden = !day;
    syncSeg(p + 'Mode', o.mode);
    $(p + 'Day').value = (o.from && o.from === o.to) ? o.from : '';
    $(p + 'Pd').checked = !!o.pd;
  }
  /* Date controls shared by cards, chart and table: range or single day (with prev/next). */
  function wireDate(p, o, segId, onChange) {
    function refresh() { syncRange(o, segId, p + 'From', p + 'To'); onChange(); }
    WP.seg(p + 'Mode', function (v) {
      o.mode = v;
      if (v === 'day') { var d = o.from || o.to || $(p + 'Day').max; if (d) { o.from = o.to = d; } } else { o.pd = false; }
      refresh();
    });
    function rangeChanged() {
      o.from = $(p + 'From').value; o.to = $(p + 'To').value; o.pd = false;
      if (o.from && o.to && o.from > o.to) { var t = o.from; o.from = o.to; o.to = t; }
      refresh();
    }
    $(p + 'From').addEventListener('change', rangeChanged); $(p + 'To').addEventListener('change', rangeChanged);
    $(p + 'Day').addEventListener('change', function () { o.from = o.to = this.value; if (!this.value) o.from = o.to = ''; refresh(); });
    function step(dir) {
      var inp = $(p + 'Day'), base = (o.from && o.from === o.to) ? o.from : (inp.max || WP.wallStr(WP.plantNow()).slice(0, 10));
      var d = WP.wallStr(dayMs(base) + dir * DAY).slice(0, 10);
      if (inp.min && d < inp.min) d = inp.min;
      if (inp.max && d > inp.max) d = inp.max;
      o.from = o.to = d; refresh();
    }
    $(p + 'DPrev').addEventListener('click', function () { step(-1); });
    $(p + 'DNext').addEventListener('click', function () { step(1); });
    $(p + 'Pd').addEventListener('change', function () { o.pd = this.checked; refresh(); });
  }
  function setBounds() {
    if (!S.rows.length) return;
    var min = WP.wallStr(S.rows[S.rows.length - 1].t).slice(0, 10), max = WP.wallStr(Math.max(WP.plantNow(), S.rows[0].t)).slice(0, 10);
    ['dFrom', 'dTo', 'dDay'].forEach(function (id) { $(id).min = min; $(id).max = max; });
  }

  /* ---------- load ---------- */
  var inflight = false, lastOk = 0;
  function load() {
    if (inflight) return;
    inflight = true;
    WP.getJSON('/api/dashboard?days=all&area=' + encodeURIComponent(S.area)).then(function (j) {
      S.rows = (j.rows || []).map(WP.mapRow).filter(function (r) { return r.ok && !isNaN(r.t); }).sort(function (a, b) { return b.t - a.t; });
      lastOk = Date.now();
      WP.setLive(true, 'Live · updated ' + WP.hhmm(WP.plantNow()) + ' IST');
      if (S.first) {
        S.first = false;
        var now = WP.plantNow();
        if (S.d.preset === 'shift' && !inRange(S.rows, resolve(S.d)).length && S.rows.length) {
          S.d.preset = inRange(S.rows, { from: now - 7 * DAY, to: now + 60000 }).length ? '7' : 'all';
          S.d.note = 'No trips in the current shift yet, so ' + PRESET_LABEL[S.d.preset].toLowerCase() + ' is shown.';
        }
        syncRange(S.d, 'dPresetSeg', 'dFrom', 'dTo');
      }
      setBounds();
      renderAll();
    }).catch(function () {
      WP.setLive(false, lastOk ? 'Connection lost · showing data from ' + WP.hhmm(WP.plantNow() - (Date.now() - lastOk)) + ' IST' : 'Cannot reach server');
      if (!lastOk) renderAll();
    }).then(function () { inflight = false; });
  }

  /* ---------- latest trip cards ---------- */
  function cardRows() { return inRange(S.rows, resolve(S.d)); }
  function renderCards() {
    var list = cardRows(), idx = 0;
    if (S.c.key) { idx = list.findIndex(function (r) { return key(r) === S.c.key; }); if (idx < 0) { idx = 0; S.c.key = null; } }
    var r = list[idx];
    function set(id, v) { var e = $(id); if (e) e.textContent = v; }
    $('cPrev').disabled = !list.length || idx >= list.length - 1;
    $('cNext').disabled = idx <= 0;
    $('cClear').disabled = !S.c.key;
    if (!r) {
      ['lCast', 'lTorp', 'lArea', 'lIG', 'lIT', 'lIN', 'lSG', 'lST', 'lSN', 'nIN', 'nSN', 'nD'].forEach(function (i) { set(i, '—'); });
      set('lITime', 'Weighed at —'); set('lSTime', 'Weighed at —');
      set('latestSub', S.rows.length ? 'No complete trips in the selected period' : 'No complete trips yet'); $('nD').className = 'strong'; return;
    }
    var inP = (S.d.from || S.d.to || S.d.preset !== 'all') ? ' in the selected period' : '';
    var label = idx === 0 ? 'Latest complete trip' + inP : 'Trip ' + (idx + 1) + ' of ' + list.length + inP;
    set('latestSub', label + ', weighed ' + WP.dateTimeLabel(r.t) + ' IST');
    set('lCast', r.cast); set('lTorp', r.torp); set('lArea', r.area);
    set('lITime', 'Weighed ' + (isNaN(r.inTime) ? '—' : WP.dateTimeLabel(r.inTime)) + ' IST');
    set('lSTime', 'Weighed ' + WP.dateTimeLabel(r.t) + ' IST');
    set('lIG', WP.mt(r.inG)); set('lIT', WP.mt(r.inT)); set('lIN', WP.mt(r.inN));
    set('lSG', WP.mt(r.stG)); set('lST', WP.mt(r.stT)); set('lSN', WP.mt(r.stN));
    set('nIN', WP.mt(r.inN)); set('nSN', WP.mt(r.stN));
    var d = $('nD'); d.textContent = WP.sgn(r.diff) + ' MT'; d.className = 'strong ' + (WP.within(r.diff) ? 'ok' : 'bad');
  }
  function wireCards() {
    $('cClear').addEventListener('click', function () { S.c.key = null; renderCards(); });
    function step(dir) {
      var list = cardRows(), i = S.c.key ? list.findIndex(function (r) { return key(r) === S.c.key; }) : 0;
      if (i < 0) i = 0;
      var n = Math.max(0, Math.min(list.length - 1, i + dir));
      S.c.key = n === 0 ? null : key(list[n]); renderCards();
    }
    $('cPrev').addEventListener('click', function () { step(1); });
    $('cNext').addEventListener('click', function () { step(-1); });
  }

  /* ---------- summary (follows the chart range) ---------- */
  function chartRows() { return inRange(S.rows, resolve(S.d)); }
  function renderSummary() {
    var rows = chartRows(), st = WP.stats(rows);
    $('sumSub').textContent = describe(S.d) + ' · tolerance ±' + WP.fmt(WP.cfg.tolerance, 1) + ' MT';
    var cells = [
      ['Trips', st.n], ['Within tolerance', st.n ? WP.fmt(st.pct, 1) + '%' : '—'], ['Average bias', st.n ? WP.sgn(st.bias) + ' MT' : '—'],
      ['Std deviation', st.n ? WP.fmt(st.sd) + ' MT' : '—'], ['Largest gap', st.n ? WP.fmt(st.maxAbs) + ' MT' : '—'], ['Static tonnes', st.n ? WP.fmt(st.tons, 0) : '—']
    ];
    $('sumStats').innerHTML = cells.map(function (c) { return '<div class="stat"><div class="t">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>'; }).join('');
    $('shifts').innerHTML = ['C', 'A', 'B'].map(function (s) {
      var rs = rows.filter(function (r) { return r.shift === s; }), x = WP.stats(rs), sx = WP.shiftStatus(x);
      return '<div class="shift"><div class="shift-top"><b>' + esc(WP.SHIFT_LABEL[s]) + '</b>' + WP.pillHtml(sx.k, sx.t) + '</div>' +
        (x.n ? '<div class="shift-m"><span>' + x.n + ' trips</span><span>' + WP.fmt(x.pct, 0) + '% within tolerance</span><span>Bias ' + WP.sgn(x.bias) + ' MT</span></div><div class="bar-track" aria-hidden="true"><div class="bar-fill" style="width:' + Math.min(100, x.pct).toFixed(1) + '%"></div></div>'
          : '<div class="shift-m"><span>No complete trips in this range</span></div>') + '</div>';
    }).join('');
    var by = {}, tot = {};
    rows.forEach(function (r) { tot[r.torp] = (tot[r.torp] || 0) + 1; if (!WP.within(r.diff)) by[r.torp] = (by[r.torp] || 0) + 1; });
    var top = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; }).slice(0, 5);
    $('topT').innerHTML = top.length ? top.map(function (t) {
      return '<div class="list-row"><b>' + esc(t) + '</b><span>' + by[t] + ' of ' + tot[t] + ' trips <span class="m">· ' + WP.fmt(by[t] / tot[t] * 100, 0) + '%</span></span></div>';
    }).join('') : '<div class="sub" style="padding:8px 0">' + (rows.length ? 'No trips outside tolerance in this range.' : 'No trips in this range.') + '</div>';
  }

  /* ---------- chart engine (SVG, zoom + pan) ---------- */
  var CH = { m: { l: 60, r: 20, t: 14, b: 50 }, H: 400, W: 800, pw: 0, ph: 0, view: null, fit: null, rows: [], groups: [], pts: [], drag: null };
  function niceTicks(a, b, n) {
    var span = b - a, raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    var step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p, out = [];
    for (var v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(Math.abs(v) < 1e-9 ? 0 : v);
    return { step: step, ticks: out };
  }
  function timeTicks(a, b, px) {
    var steps = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 7200, 10080, 20160].map(function (m) { return m * 60000; });
    var want = Math.max(3, px / 90), step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) { if ((b - a) / steps[i] <= want) { step = steps[i]; break; } }
    var out = [], off = step >= DAY ? 0 : 0;
    for (var t = Math.ceil(a / step) * step; t <= b; t += step) out.push(t);
    return { step: step, ticks: out };
  }
  function quant(xs, q) { var p = (xs.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return xs[lo] + (xs[hi] - xs[lo]) * (p - lo); }
  function effGrp() { return (S.g.grp === 'day' && S.d.from && S.d.from === S.d.to) ? 'shift' : S.g.grp; }
  function grouping(rows) {
    var g = effGrp(), m = {};
    rows.forEach(function (r) { var k = g === 'day' ? r.pd : g === 'shift' ? r.shift : g === 'hour' ? WP.pad(new Date(r.t).getUTCHours()) : g === 'torp' ? r.torp : r.area; (m[k] = m[k] || []).push(r); });
    var keys = Object.keys(m);
    keys.sort(g === 'shift' ? function (a, b) { return 'CAB'.indexOf(a) - 'CAB'.indexOf(b); } : cmpNat);
    return keys.map(function (k) {
      var d = m[k].map(function (r) { return r.diff; }).sort(function (a, b) { return a - b; });
      var q1 = quant(d, .25), med = quant(d, .5), q3 = quant(d, .75), iqr = q3 - q1;
      var lo = d.filter(function (v) { return v >= q1 - 1.5 * iqr; })[0], hi = d.filter(function (v) { return v <= q3 + 1.5 * iqr; }).pop();
      var out = d.filter(function (v) { return v < lo || v > hi; });
      var label = g === 'day' ? WP.pdLabel(k) : g === 'shift' ? 'Shift ' + k : g === 'hour' ? k + ':00' : k;
      return { k: k, label: label, n: d.length, q1: q1, med: med, q3: q3, lo: lo, hi: hi, out: out, min: d[0], max: d[d.length - 1], outside: d.filter(function (v) { return !WP.within(v); }).length };
    });
  }
  function computeFit() {
    var rows = CH.rows, tol = WP.cfg.tolerance, rg = resolve(S.d), box = S.g.type === 'box';
    var lo = -tol * 1.5, hi = tol * 1.5;
    rows.forEach(function (r) { lo = Math.min(lo, r.diff); hi = Math.max(hi, r.diff); });
    var pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    var x0, x1;
    if (box) { x0 = -0.6; x1 = Math.max(CH.groups.length, 1) - 0.4; }
    else {
      var tmin = rows.length ? Math.min.apply(null, rows.map(function (r) { return r.t; })) : WP.plantNow() - 3600000;
      var tmax = rows.length ? Math.max.apply(null, rows.map(function (r) { return r.t; })) : WP.plantNow();
      x0 = isFinite(rg.from) ? rg.from : tmin; x1 = isFinite(rg.to) ? Math.min(rg.to, Math.max(tmax, rg.from + 3600000)) : tmax;
      if (S.d.preset === 'shift' && !S.d.from && !S.d.to) x1 = rg.to;
      var singleDay = S.d.from && S.d.from === S.d.to;
      if (singleDay) { x0 = rg.from; x1 = rg.to; }
      if (x1 - x0 < 1800000) { var mid = (x0 + x1) / 2; x0 = mid - 900000; x1 = mid + 900000; }
      var xp = (x1 - x0) * 0.02; if (!singleDay && (S.d.preset !== 'shift' || S.d.from || S.d.to)) { x0 -= xp; x1 += xp; }
    }
    return { x0: x0, x1: x1, y0: lo, y1: hi };
  }
  function drawChart() {
    var box = $('plotBox'), g = S.g, tol = WP.cfg.tolerance, isBox = g.type === 'box', isBars = g.type === 'bars';
    CH.rows = chartRows();
    CH.groups = isBox ? grouping(CH.rows) : [];
    CH.fit = computeFit();
    var v = CH.view = g.view || CH.fit, m = CH.m;
    var W = CH.W = Math.max(320, box.clientWidth), H = CH.H;
    CH.pw = W - m.l - m.r; CH.ph = H - m.t - m.b;
    var sx = function (x) { return m.l + (x - v.x0) / (v.x1 - v.x0) * CH.pw; };
    var sy = function (y) { return m.t + (1 - (y - v.y0) / (v.y1 - v.y0)) * CH.ph; };
    CH.sx = sx; CH.sy = sy;
    var o = '<svg id="svg" width="' + W + '" height="' + H + '" role="img" aria-label="' + (isBox ? 'Box plot' : g.type === 'bars' ? 'Bar chart' : 'Scatter plot') + ' of difference in MT against ' + (isBox ? 'group' : 'time of weighing') + '. ' + CH.rows.length + ' trips. Use the table below for exact values."><defs><clipPath id="clip"><rect x="' + m.l + '" y="' + m.t + '" width="' + CH.pw + '" height="' + CH.ph + '"/></clipPath></defs>';
    // y grid + labels
    var yt = niceTicks(v.y0, v.y1, 7);
    yt.ticks.forEach(function (t) {
      var y = sy(t);
      o += '<line class="gridl" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/><text class="ax" x="' + (m.l - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + (t > 0 ? '+' : t < 0 ? '−' : '') + Math.abs(t).toFixed(yt.step < 1 ? 1 : 0) + '</text>';
    });
    o += '<g clip-path="url(#clip)">';
    // tolerance zone
    var yT = sy(tol), yB = sy(-tol);
    o += '<rect class="zone" x="' + m.l + '" y="' + yT.toFixed(1) + '" width="' + CH.pw + '" height="' + Math.max(0, yB - yT).toFixed(1) + '"/>';
    o += '<line class="zline" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + yT.toFixed(1) + '" y2="' + yT.toFixed(1) + '"/><line class="zline" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + yB.toFixed(1) + '" y2="' + yB.toFixed(1) + '"/>';
    o += '<line class="zero" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + sy(0).toFixed(1) + '" y2="' + sy(0).toFixed(1) + '"/>';
    CH.pts = [];
    if (isBars) {
      var gaps = [], ts = CH.rows.map(function (r) { return r.t; }).sort(function (a, b) { return a - b; });
      for (var gi = 1; gi < ts.length; gi++) if (ts[gi] > ts[gi - 1]) gaps.push(ts[gi] - ts[gi - 1]);
      gaps.sort(function (a, b) { return a - b; });
      var medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 3600000;
      var barW = Math.max(3, Math.min(18, medGap * CH.pw / (v.x1 - v.x0) * 0.6)), y0 = sy(0);
      CH.rows.forEach(function (r) {
        var x = sx(r.t), y = sy(r.diff);
        if (x < m.l - 10 || x > W - m.r + 10) return;
        CH.pts.push({ r: r, x: x, y: y, y0: y0, bw: barW });
        o += '<rect class="br ' + (WP.within(r.diff) ? 'in' : 'out') + (g.hi && g.hi !== r.torp ? ' dim' : '') + '" x="' + (x - barW / 2).toFixed(1) + '" y="' + Math.min(y, y0).toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(1.5, Math.abs(y - y0)).toFixed(1) + '"/>';
        if (g.pinned === key(r)) o += '<circle class="ring" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="8"/>';
      });
    } else if (!isBox) {
      CH.rows.forEach(function (r) {
        var x = sx(r.t), y = sy(r.diff);
        if (x < m.l - 8 || x > W - m.r + 8 || y < m.t - 8 || y > m.t + CH.ph + 8) return;
        CH.pts.push({ r: r, x: x, y: y });
        o += '<circle class="pt ' + (WP.within(r.diff) ? 'in' : 'out') + (g.hi && g.hi !== r.torp ? ' dim' : '') + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="5"/>';
        if (g.pinned === key(r)) o += '<circle class="ring" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="9"/>';
      });
    } else {
      var bw = Math.max(8, Math.min(70, CH.pw / (v.x1 - v.x0) * 0.55));
      CH.groups.forEach(function (gr, i) {
        var cx = sx(i); if (cx < m.l - bw || cx > W - m.r + bw) return;
        var hov = CH.hov === i;
        o += '<line class="wh" x1="' + cx.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y1="' + sy(gr.hi).toFixed(1) + '" y2="' + sy(gr.lo).toFixed(1) + '"/>';
        o += '<line class="wh" x1="' + (cx - bw / 4).toFixed(1) + '" x2="' + (cx + bw / 4).toFixed(1) + '" y1="' + sy(gr.hi).toFixed(1) + '" y2="' + sy(gr.hi).toFixed(1) + '"/><line class="wh" x1="' + (cx - bw / 4).toFixed(1) + '" x2="' + (cx + bw / 4).toFixed(1) + '" y1="' + sy(gr.lo).toFixed(1) + '" y2="' + sy(gr.lo).toFixed(1) + '"/>';
        o += '<rect class="bx' + (hov ? ' hov' : '') + '" x="' + (cx - bw / 2).toFixed(1) + '" y="' + sy(gr.q3).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(1, sy(gr.q1) - sy(gr.q3)).toFixed(1) + '" rx="2"/>';
        o += '<line class="med" x1="' + (cx - bw / 2).toFixed(1) + '" x2="' + (cx + bw / 2).toFixed(1) + '" y1="' + sy(gr.med).toFixed(1) + '" y2="' + sy(gr.med).toFixed(1) + '"/>';
        gr.out.forEach(function (d) { o += '<circle class="olr" cx="' + cx.toFixed(1) + '" cy="' + sy(d).toFixed(1) + '" r="3.5"/>'; });
      });
    }
    var labY = (yB - yT) >= 34 ? yT + 15 : yT - 6;
    o += '<text class="zlab" x="' + (m.l + 8) + '" y="' + labY.toFixed(1) + '">Tolerance zone ±' + WP.fmt(tol, 1) + ' MT</text>';
    o += '<text class="zlab" x="' + (W - m.r - 6) + '" y="' + (yT - 4).toFixed(1) + '" text-anchor="end">+' + WP.fmt(tol, 1) + '</text><text class="zlab" x="' + (W - m.r - 6) + '" y="' + (yB + 12).toFixed(1) + '" text-anchor="end">−' + WP.fmt(tol, 1) + '</text>';
    o += '</g>';
    // axes
    o += '<line class="axl" x1="' + m.l + '" x2="' + m.l + '" y1="' + m.t + '" y2="' + (m.t + CH.ph) + '"/><line class="axl" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + (m.t + CH.ph) + '" y2="' + (m.t + CH.ph) + '"/>';
    var by = m.t + CH.ph;
    if (!isBox) {
      var tt = timeTicks(v.x0, v.x1, CH.pw), lastDay = null;
      tt.ticks.forEach(function (t) {
        var x = sx(t), d = new Date(t), mid = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
        var lab = tt.step >= DAY ? WP.dayLabel(t) : WP.hhmm(t);
        o += '<line class="axl" x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + by + '" y2="' + (by + 4) + '"/><text class="ax" x="' + x.toFixed(1) + '" y="' + (by + 17) + '" text-anchor="middle">' + lab + '</text>';
        if (tt.step < DAY) { var dl = WP.dayLabel(t); if (mid || dl !== lastDay) { if (mid || lastDay === null) o += '<text class="ax" x="' + x.toFixed(1) + '" y="' + (by + 30) + '" text-anchor="middle" style="font-weight:600">' + dl + '</text>'; } lastDay = dl; }
      });
    } else {
      var stride = Math.max(1, Math.ceil(54 / (CH.pw / (v.x1 - v.x0))));
      CH.groups.forEach(function (gr, i) {
        var x = sx(i); if (x < m.l - 10 || x > W - m.r + 10 || i % stride) return;
        o += '<text class="ax" x="' + x.toFixed(1) + '" y="' + (by + 17) + '" text-anchor="middle">' + esc(gr.label) + '</text><text class="ax" x="' + x.toFixed(1) + '" y="' + (by + 30) + '" text-anchor="middle" style="opacity:.75">n=' + gr.n + '</text>';
      });
    }
    var xtitle = isBox ? 'Group: ' + ({ day: 'production day', shift: 'shift', hour: 'hour of day', torp: 'torpedo', area: 'area' }[effGrp()]) : 'Time of weighing (IST)';
    o += '<text class="axt" x="' + (m.l + CH.pw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + xtitle + '</text>';
    o += '<text class="axt" transform="translate(14 ' + (m.t + CH.ph / 2) + ') rotate(-90)" text-anchor="middle">Difference (MT)</text>';
    if (!CH.rows.length) o += '<text class="ax" x="' + (m.l + CH.pw / 2) + '" y="' + (m.t + CH.ph / 2 - 24) + '" text-anchor="middle" style="font-size:13px">No complete trips in this range</text>';
    o += '</svg>';
    box.innerHTML = o;
    CH.svg = $('svg');
    if (g.pinned && !isBox) {
      var p = CH.pts.filter(function (q) { return key(q.r) === g.pinned; })[0];
      if (p) openPop(p, box); else if (!CH.rows.some(function (r) { return key(r) === g.pinned; })) g.pinned = null;
    }
  }
  function renderChart() {
    var g = S.g, isBox = g.type === 'box', rows = chartRows(), tol = WP.cfg.tolerance;
    $('chartTitle').textContent = isBox ? 'Distribution of differences' : g.type === 'bars' ? 'Difference per trip' : 'Torpedo by torpedo';
    $('chartSub').textContent = describe(S.d) + ' · ' + rows.length + ' trip' + (rows.length === 1 ? '' : 's') + (isBox ? '. Hover a box for its statistics.' : '. Hover a ' + (g.type === 'bars' ? 'bar' : 'dot') + ' for details, select it to pin them.');
    $('legend').innerHTML = (isBox
      ? '<span><i class="sw" style="background:var(--neu-bg);border:1.5px solid var(--blue)"></i>Middle 50% (box)</span><span><i style="background:var(--ink);width:14px;height:3px;border-radius:0"></i>Median</span><span><i style="background:var(--ember)"></i>Outlier</span>'
      : '<span><i' + (g.type === 'bars' ? ' class="sw"' : '') + ' style="background:var(--ok)"></i>Within ±' + WP.fmt(tol, 1) + ' MT</span><span><i' + (g.type === 'bars' ? ' class="sw"' : '') + ' style="background:var(--ember)"></i>Outside</span>') +
      '<span><i class="sw" style="background:var(--ok-bg);border:1px dashed var(--ok)"></i>Tolerance zone</span>';
    $('hiWrap').hidden = isBox; $('grpWrap').hidden = !isBox;
    var torps = Array.from(new Set(rows.map(function (r) { return r.torp; }))).sort(cmpNat), sel = $('hiSel');
    sel.innerHTML = '<option value="">All</option>' + torps.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
    if (torps.indexOf(g.hi) < 0) g.hi = ''; sel.value = g.hi;
    $('grpSel').value = effGrp();
    $('chartNote').textContent = 'Scroll to zoom, Shift+scroll to zoom one axis, drag to pan, double-click to reset. Difference = static net minus in-motion net.';
    drawChart();
  }
  function setView(v) { S.g.view = v; drawChart(); }
  function zoom(f, cx, cy, mode) {
    var v = CH.view, fit = CH.fit;
    var nx0 = v.x0, nx1 = v.x1, ny0 = v.y0, ny1 = v.y1;
    var xmin = S.g.type === 'box' ? 0.8 : 5 * 60000, ymin = 0.05;
    if (mode !== 'y') { var c = cx == null ? (v.x0 + v.x1) / 2 : cx, a = c + (v.x0 - c) * f, b = c + (v.x1 - c) * f; if (b - a >= xmin && b - a <= (fit.x1 - fit.x0) * 3) { nx0 = a; nx1 = b; } }
    if (mode !== 'x') { var d = cy == null ? (v.y0 + v.y1) / 2 : cy, a2 = d + (v.y0 - d) * f, b2 = d + (v.y1 - d) * f; if (b2 - a2 >= ymin && b2 - a2 <= (fit.y1 - fit.y0) * 3) { ny0 = a2; ny1 = b2; } }
    setView({ x0: nx0, x1: nx1, y0: ny0, y1: ny1 });
  }
  function tipHtml(r) {
    var st = statusOf(r.diff);
    return '<b>Torpedo ' + esc(r.torp) + '</b> · Cast ' + esc(r.cast) + '<br>' + WP.dateTimeLabel(r.t) + ' IST<br>In-motion ' + WP.mt(r.inN) + ' · Static ' + WP.mt(r.stN) + '<br>Difference <b>' + WP.sgn(r.diff) + ' MT</b> (' + st.t.toLowerCase() + ')';
  }
  function boxTip(gr) {
    return '<b>' + esc(gr.label) + '</b> · ' + gr.n + ' trips<br>Median ' + WP.sgn(gr.med) + ' MT<br>Middle 50%: ' + WP.sgn(gr.q1) + ' to ' + WP.sgn(gr.q3) + '<br>Range: ' + WP.sgn(gr.min) + ' to ' + WP.sgn(gr.max) + '<br>' + gr.outside + ' outside tolerance';
  }
  function openPop(pt, box) {
    var old = $('pop'); if (old) old.remove();
    var r = pt.r, st = statusOf(r.diff), el = document.createElement('div');
    el.className = 'pop'; el.id = 'pop'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Trip details');
    el.innerHTML = '<button type="button" class="x" aria-label="Close">×</button><h4>Torpedo ' + esc(r.torp) + '</h4>' +
      '<div class="kv"><span>Cast ID</span><b>' + esc(r.cast) + '</b></div><div class="kv"><span>Weighed</span><b>' + WP.dateTimeLabel(r.t) + '</b></div>' +
      '<div class="kv"><span>In-motion net</span><b>' + WP.mt(r.inN) + '</b></div><div class="kv"><span>Static net</span><b>' + WP.mt(r.stN) + '</b></div>' +
      '<div class="kv"><span>Difference</span><b class="' + (WP.within(r.diff) ? 'ok' : 'bad') + '">' + WP.sgn(r.diff) + ' MT</b></div><div style="margin-top:8px">' + WP.pillHtml(st.k, st.t) + '</div>';
    box.appendChild(el);
    var left = pt.x + 16; if (left + 250 > CH.W) left = pt.x - 266;
    el.style.left = Math.max(4, left) + 'px'; el.style.top = Math.max(4, Math.min(pt.y - 20, CH.H - el.offsetHeight - 4)) + 'px';
    el.querySelector('.x').addEventListener('click', function (e) { e.stopPropagation(); S.g.pinned = null; drawChart(); });
    el.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    el.addEventListener('click', function (e) { e.stopPropagation(); });
  }
  function nearest(mx, my) {
    var best = null, bd = 11 * 11;
    if (S.g.type === 'bars') {
      var bs = Infinity;
      CH.pts.forEach(function (p) {
        var dx = Math.abs(p.x - mx); if (dx > Math.max(7, p.bw / 2 + 3)) return;
        var lo = Math.min(p.y, p.y0) - 5, hi = Math.max(p.y, p.y0) + 5, dy = my < lo ? lo - my : my > hi ? my - hi : 0;
        var sc = dx + dy * 0.5; if (dy < 12 && sc < bs) { bs = sc; best = p; }
      });
      return best;
    }
    CH.pts.forEach(function (p) { var d = (p.x - mx) * (p.x - mx) + (p.y - my) * (p.y - my); if (d < bd) { bd = d; best = p; } });
    return best;
  }
  function wireChart() {
    var box = $('plotBox');
    function local(e) { var rc = CH.svg.getBoundingClientRect(); return { x: e.clientX - rc.left, y: e.clientY - rc.top }; }
    box.addEventListener('mousedown', function (e) {
      if (!CH.svg || e.button !== 0 || !e.target.closest('svg')) return;
      var p = local(e); CH.drag = { x: p.x, y: p.y, v: Object.assign({}, CH.view), moved: false };
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!CH.drag) return;
      var p = local(e), dx = p.x - CH.drag.x, dy = p.y - CH.drag.y;
      if (!CH.drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!CH.drag.moved) { CH.drag.moved = true; WP.tip.hide(); CH.svg.classList.add('drag'); }
      var v = CH.drag.v, xs = (v.x1 - v.x0) / CH.pw, ys = (v.y1 - v.y0) / CH.ph;
      S.g.view = { x0: v.x0 - dx * xs, x1: v.x1 - dx * xs, y0: v.y0 + dy * ys, y1: v.y1 + dy * ys };
      drawChart(); CH.svg.classList.add('drag');
    });
    window.addEventListener('mouseup', function (e) {
      var d = CH.drag; CH.drag = null; if (!d) return;
      if (CH.svg) CH.svg.classList.remove('drag');
      if (d.moved || S.g.type === 'box') return;
      var p = nearest(d.x, d.y);
      S.g.pinned = p && S.g.pinned !== key(p.r) ? key(p.r) : null; WP.tip.hide(); drawChart();
    });
    box.addEventListener('mousemove', function (e) {
      if (CH.drag || !CH.svg || !e.target.closest('svg')) return;
      var p = local(e);
      if (S.g.type === 'box') {
        var i = Math.round(CH.view.x0 + (p.x - CH.m.l) / CH.pw * (CH.view.x1 - CH.view.x0)), gr = CH.groups[i];
        var inside = p.x >= CH.m.l && p.x <= CH.m.l + CH.pw && p.y >= CH.m.t && p.y <= CH.m.t + CH.ph;
        var hov = gr && inside && Math.abs(CH.sx(i) - p.x) < Math.max(10, CH.pw / (CH.view.x1 - CH.view.x0) * 0.4) ? i : undefined;
        if (hov !== CH.hov) { CH.hov = hov; drawChart(); }
        if (hov != null) WP.tip.show(boxTip(gr), e.clientX, e.clientY); else WP.tip.hide();
        return;
      }
      var n = nearest(p.x, p.y);
      CH.svg.style.cursor = n ? 'pointer' : '';
      if (n) WP.tip.show(tipHtml(n.r), e.clientX, e.clientY); else WP.tip.hide();
    });
    box.addEventListener('mouseleave', function () { WP.tip.hide(); if (CH.hov != null) { CH.hov = undefined; drawChart(); } });
    box.addEventListener('wheel', function (e) {
      if (!CH.svg || !e.target.closest('svg')) return;
      e.preventDefault();
      var p = local(e), v = CH.view, f = Math.exp(e.deltaY * 0.0016);
      var cx = v.x0 + (p.x - CH.m.l) / CH.pw * (v.x1 - v.x0), cy = v.y0 + (1 - (p.y - CH.m.t) / CH.ph) * (v.y1 - v.y0);
      WP.tip.hide(); zoom(f, cx, cy, e.shiftKey ? 'x' : 'both');
    }, { passive: false });
    box.addEventListener('dblclick', function (e) { if (e.target.closest('svg')) setView(null); });
    $('zIn').addEventListener('click', function () { zoom(0.6, null, null, 'both'); });
    $('zOut').addEventListener('click', function () { zoom(1 / 0.6, null, null, 'both'); });
    $('zFit').addEventListener('click', function () { setView(null); });
    $('zTol').addEventListener('click', function () { var t = WP.cfg.tolerance * 2.2, v = CH.view; setView({ x0: v.x0, x1: v.x1, y0: -t, y1: t }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.g.pinned) { S.g.pinned = null; drawChart(); } });
    document.addEventListener('mousedown', function (e) { if (S.g.pinned && !e.target.closest('#plotBox')) { S.g.pinned = null; drawChart(); } });
    var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(drawChart, 120); });
    $('hiSel').addEventListener('change', function (e) { S.g.hi = e.target.value; drawChart(); });
    $('grpSel').addEventListener('change', function (e) { S.g.grp = e.target.value; S.g.view = null; renderChart(); });
    WP.seg('typeSeg', function (v) { S.g.type = v; S.g.view = null; S.g.pinned = null; CH.hov = undefined; renderChart(); });
  }

  /* ---------- table ---------- */
  function tableRange() { return inRange(S.rows, resolve(S.d)); }
  function filtered() {
    var f = S.t.f, cast = f.cast.trim().toLowerCase();
    var rows = tableRange().filter(function (r) {
      if (cast && String(r.cast).toLowerCase().indexOf(cast) < 0) return false;
      if (f.torp && r.torp !== f.torp) return false;
      if (f.area && r.area !== f.area) return false;
      if (f.shift && r.shift !== f.shift) return false;
      if (f.dir === 'hi' && !(r.diff > 0)) return false;
      if (f.dir === 'lo' && !(r.diff < 0)) return false;
      if (f.status === 'out' && WP.within(r.diff)) return false;
      if (f.status === 'in' && !WP.within(r.diff)) return false;
      if (f.min && Math.abs(r.diff) < f.min) return false;
      return true;
    });
    var cmp = {
      abs: function (a, b) { return Math.abs(b.diff) - Math.abs(a.diff); },
      time: function (a, b) { return b.t - a.t; },
      torp: function (a, b) { return cmpNat(a.torp, b.torp) || b.t - a.t; },
      cast: function (a, b) { return cmpNat(a.cast, b.cast) || b.t - a.t; }
    }[f.sort];
    return rows.sort(cmp);
  }
  function renderTable() {
    var base = tableRange(), rows = filtered();
    $('diffNote').textContent = describe(S.d) + ': ' + base.length + ' complete trip' + (base.length === 1 ? '' : 's') + ', ' + base.filter(function (r) { return !WP.within(r.diff); }).length + ' outside ±' + WP.fmt(WP.cfg.tolerance, 1) + ' MT. Static net minus in-motion net, in MT.';
    var ts = Array.from(new Set(base.map(function (r) { return r.torp; }))).sort(cmpNat), sel = $('fTorp');
    sel.innerHTML = '<option value="">All</option>' + ts.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
    sel.value = ts.indexOf(S.t.f.torp) >= 0 ? S.t.f.torp : (S.t.f.torp = '');
    var vis = rows.slice(0, S.t.shown);
    $('tbody').innerHTML = vis.map(function (r) {
      var st = statusOf(r.diff);
      return '<div class="tr" role="row"><div role="cell">' + WP.dateTimeLabel(r.t) + '</div><div role="cell">' + esc(r.cast) + '</div><div role="cell"><b>' + esc(r.torp) + '</b></div><div role="cell">' + esc(r.area) + '</div><div role="cell">' + r.shift + '</div>' +
        '<div role="cell" class="r">' + WP.fmt(r.stN) + '</div><div role="cell" class="r">' + WP.fmt(r.inN) + '</div><div role="cell" class="r"><b class="' + (WP.within(r.diff) ? 'diff-in' : 'diff-out') + '">' + WP.sgn(r.diff) + '</b></div><div role="cell">' + WP.pillHtml(st.k, st.t.replace(' tolerance', '')) + '</div></div>';
    }).join('');
    $('tEmpty').hidden = rows.length > 0;
    $('tCount').textContent = 'Showing ' + vis.length + ' of ' + rows.length + ' trips';
    $('tFoot').textContent = rows.length ? 'Export includes all ' + rows.length + ' filtered trips, not only those shown.' : '';
    $('tMore').hidden = rows.length <= S.t.shown;
    $('exportBtn').disabled = !rows.length;
  }
  function wireTable() {
    var map = { fCast: 'cast', fTorp: 'torp', fArea: 'area', fShift: 'shift', fDir: 'dir', fStatus: 'status', fSort: 'sort' };
    Object.keys(map).forEach(function (id) {
      $(id).addEventListener(id === 'fCast' ? 'input' : 'change', function (e) { S.t.f[map[id]] = e.target.value; S.t.shown = PAGE; renderTable(); });
    });
    $('fMin').addEventListener('change', function (e) { S.t.f.min = +e.target.value; S.t.shown = PAGE; renderTable(); });
    $('fReset').addEventListener('click', function () {
      S.t.f = { cast: '', torp: '', area: '', shift: '', dir: '', status: '', min: 0, sort: 'abs' }; S.t.shown = PAGE;
      $('fCast').value = ''; $('fArea').value = ''; $('fShift').value = ''; $('fDir').value = ''; $('fStatus').value = ''; $('fMin').value = '0'; $('fSort').value = 'abs';
      renderTable();
    });
    $('tMore').addEventListener('click', function () { S.t.shown += PAGE; renderTable(); });
    $('exportBtn').addEventListener('click', doExport);
  }
  function msg(text, err) { var m = $('exportMsg'); m.textContent = text; m.className = 'note' + (err ? ' err' : ''); m.hidden = !text; }
  function doExport() {
    var rows = filtered();
    if (!rows.length) { msg('Nothing to export with the current filters.', true); return; }
    var f = S.t.f, active = { Period: describe(S.d) };
    if (f.cast) active['Cast ID'] = f.cast;
    if (f.torp) active.Torpedo = f.torp;
    if (f.area) active.Area = f.area;
    if (f.shift) active.Shift = f.shift;
    if (f.dir) active.Direction = f.dir === 'hi' ? 'Static higher' : 'In-motion higher';
    if (f.status) active.Status = f.status === 'out' ? 'Outside tolerance' : 'Inside tolerance';
    if (f.min) active['Min difference'] = f.min + ' MT';
    var btn = $('exportBtn'); btn.disabled = true; msg('Preparing Excel file…');
    fetch('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'xlsx', scope: 'current_view', area: S.area, filters: active, visible_rows: rows.map(function (r) { return r.raw; }) })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var cd = res.headers.get('Content-Disposition') || '', m = /filename=([^;]+)/.exec(cd);
      return res.blob().then(function (b) { return { b: b, name: m ? m[1].replace(/"/g, '') : 'IMWB_Weighbridge_Report.xlsx' }; });
    }).then(function (o) {
      var a = document.createElement('a'), u = URL.createObjectURL(o.b);
      a.href = u; a.download = o.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 2000);
      msg('Exported ' + rows.length + ' trips to ' + o.name + '.');
    }).catch(function () { msg('Export failed. Check the server connection and try again.', true); })
      .then(function () { btn.disabled = false; });
  }

  function renderPeriod() {
    var n = inRange(S.rows, resolve(S.d)).length;
    $('dNow').textContent = describe(S.d) + ' · ' + n + ' complete trip' + (n === 1 ? '' : 's');
    $('dNote').textContent = S.d.note || ''; $('dNote').hidden = !S.d.note;
  }
  function renderAll() { renderPeriod(); renderCards(); renderSummary(); renderChart(); renderTable(); }

  document.addEventListener('DOMContentLoaded', function () {
    $('tolTxt').textContent = WP.fmt(WP.cfg.tolerance, 1);
    $('tgtTxt').textContent = WP.fmt(WP.cfg.target, 0);
    WP.seg('areaSeg', function (v) { S.area = v; S.g.pinned = null; S.g.view = null; S.t.shown = PAGE; S.first = true; load(); });
    wireCards(); wireChart(); wireTable();
    function datePicked() {
      S.c.key = null; S.g.view = null; S.g.pinned = null; S.g.hi = ''; S.t.shown = PAGE; S.d.note = '';
      renderAll();
    }
    WP.seg('dPresetSeg', function (v) { S.d.preset = v; S.d.from = S.d.to = ''; S.d.pd = false; syncRange(S.d, 'dPresetSeg', 'dFrom', 'dTo'); datePicked(); });
    wireDate('d', S.d, 'dPresetSeg', datePicked);
    syncRange(S.d, 'dPresetSeg', 'dFrom', 'dTo');
    renderAll(); load();
    setInterval(load, 5000);
  });
})();
