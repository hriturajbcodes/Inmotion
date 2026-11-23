/* Insights page. Decisions are rules applied to the last 7 days of complete trips. */
(function () {
  'use strict';
  var WP = window.WP, $ = WP.$, esc = WP.esc, DAY = 86400000;
  var S = { all: [], rows: [], tol: WP.cfg.tolerance };

  function pctStr(v) { return v == null ? '—' : WP.fmt(v, 1) + '%'; }
  function passAt(rows, tol) {
    if (!rows.length) return { n: 0, pass: 0, pct: null };
    var p = rows.filter(function (r) { return Math.abs(r.diff) <= tol + 1e-9; }).length;
    return { n: rows.length, pass: p, pct: p / rows.length * 100 };
  }
  function confidence(n) { return n >= 200 ? 'High · ' + n + ' trips' : n >= 50 ? 'Medium · ' + n + ' trips' : 'Low · only ' + n + ' trips'; }
  function shiftStats() {
    var o = {};
    ['C', 'A', 'B'].forEach(function (s) {
      var rs = S.rows.filter(function (r) { return r.shift === s; });
      o[s] = { rows: rs, st: WP.stats(rs) };
      o[s].sx = WP.shiftStatus(o[s].st);
    });
    return o;
  }
  function terciles() {
    var xs = S.rows.map(function (r) { return r.stN; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
    if (xs.length < 3) return null;
    return [xs[Math.floor(xs.length / 3)], xs[Math.floor(xs.length * 2 / 3)]];
  }
  function band(v, q) { return v < q[0] ? 0 : v < q[1] ? 1 : 2; }

  /* ---------- decisions ---------- */
  var DECS = [];
  function buildDecisions() {
    var ss = shiftStats(), n = S.rows.length, tol = WP.cfg.tolerance, out = [];
    if (!n) { DECS = []; return; }
    var ready = ['A', 'B', 'C'].filter(function (s) { return ss[s].sx.k === 'ok'; });
    var tripsReady = ready.reduce(function (t, s) { return t + ss[s].st.n; }, 0);
    function ev(s) { return 'Shift ' + s + ': ' + pctStr(ss[s].st.pct) + ' within ±' + WP.fmt(tol, 1) + ' MT, average bias ' + WP.sgn(ss[s].st.bias) + ' MT'; }
    if (ready.length) {
      out.push({
        n: 1, k: 'ok', rec: 'Recommend: approve',
        title: 'Rely on in-motion weighing for Shift' + (ready.length > 1 ? 's ' + ready.join(' and ') : ' ' + ready[0]),
        evidence: ready.map(ev).join('. ') + '.',
        impact: 'Removes the second, static weighing on about ' + tripsReady + ' trips a week and frees the static bridge for exceptions.',
        owner: 'Plant head', conf: confidence(n)
      });
    } else {
      out.push({
        n: 1, k: 'bad', rec: 'Recommend: hold',
        title: 'Keep static weighing on every shift for now',
        evidence: ['A', 'B', 'C'].filter(function (s) { return ss[s].st.n; }).map(ev).join('. ') + '.',
        impact: 'No shift meets the bar (at least ' + WP.fmt(WP.cfg.target, 0) + '% within tolerance and average bias within ±0.3 MT).',
        owner: 'Plant head', conf: confidence(n)
      });
    }
    var worst = ['A', 'B', 'C'].filter(function (s) { return ss[s].st.n; }).sort(function (a, b) { return Math.abs(ss[b].st.bias) - Math.abs(ss[a].st.bias); })[0];
    if (worst && ss[worst].sx.k !== 'ok') {
      var outAll = S.rows.filter(function (r) { return !WP.within(r.diff); }).length;
      var outW = ss[worst].rows.filter(function (r) { return !WP.within(r.diff); }).length;
      var share = outAll ? outW / outAll * 100 : null;
      var q = terciles(), heavy = '';
      if (q) {
        var hv = ss[worst].rows.filter(function (r) { return band(r.stN, q) === 2; });
        if (hv.length) heavy = ' Heavy loads average ' + WP.sgn(WP.stats(hv).bias) + ' MT.';
      }
      out.push({
        n: 2, k: 'warn', rec: 'Recommend: do now',
        title: 'Recalibrate the in-motion bridge before relying on it on Shift ' + worst,
        evidence: ev(worst) + '.' + heavy,
        impact: share != null ? 'Shift ' + worst + ' has ' + outW + ' of the ' + outAll + ' trips outside tolerance (' + WP.fmt(share, 0) + '%). Fixing it should lift the overall pass rate.' : 'Shift ' + worst + ' has the largest bias.',
        owner: 'Instrumentation', conf: confidence(ss[worst].st.n)
      });
    } else {
      out.push({
        n: 2, k: 'ok', rec: 'Recommend: no action',
        title: 'No recalibration needed this week',
        evidence: 'Every shift with data meets the bar. Largest average bias is ' + (worst ? WP.sgn(ss[worst].st.bias) + ' MT on Shift ' + worst : 'not available') + '.',
        impact: 'Keep monitoring. Revisit if a shift drops below ' + WP.fmt(WP.cfg.target, 0) + '%.',
        owner: 'Instrumentation', conf: confidence(n)
      });
    }
    var lo = passAt(S.rows, 0.5), cur = passAt(S.rows, tol), hi = passAt(S.rows, 1.5);
    out.push({
      n: 3, k: 'neu', rec: 'Recommend: decide',
      title: 'Confirm the official tolerance and the ' + WP.fmt(WP.cfg.target, 0) + '% pass target',
      evidence: 'The same week passes ' + pctStr(lo.pct) + ' at ±0.5 MT, ' + pctStr(cur.pct) + ' at ±' + WP.fmt(tol, 1) + ' MT (current) and ' + pctStr(hi.pct) + ' at ±1.5 MT.',
      impact: 'Gives operators one agreed limit, and gives this dashboard a verdict that holds up when challenged.',
      owner: 'Quality head', conf: confidence(n) + ' · needs a policy call'
    });
    DECS = out;
  }
  function renderDecisions() {
    var box = $('decisions');
    if (!DECS.length) { box.innerHTML = '<article class="card"><p class="sub">Not enough complete trips in the last 7 days to make recommendations.</p></article>'; return; }
    box.innerHTML = DECS.map(function (d) {
      return '<article class="card dec"><div class="shift-top"><span class="q">Decision ' + d.n + '</span>' + WP.pillHtml(d.k, d.rec) + '</div>' +
        '<h2 class="a">' + esc(d.title) + '</h2>' +
        '<div><div class="q">Evidence</div><div class="why">' + esc(d.evidence) + '</div></div>' +
        '<div><div class="q">What it changes</div><div class="why">' + esc(d.impact) + '</div></div>' +
        '<div class="conf">Proposed owner <b>' + esc(d.owner) + '</b> · Confidence <b>' + esc(d.conf) + '</b></div></article>';
    }).join('');
  }

  /* ---------- material gap by production day ---------- */
  function renderGap() {
    var byDay = {};
    S.rows.forEach(function (r) { (byDay[r.pd] = byDay[r.pd] || []).push(r); });
    var days = Object.keys(byDay).sort();
    var tot = S.rows.reduce(function (t, r) { return t + r.diff; }, 0), moved = S.rows.reduce(function (t, r) { return t + (r.stN || 0); }, 0);
    $('gapSub').textContent = S.rows.length
      ? 'Daily total of static minus in-motion, in MT. ' + WP.sgn(tot, 1) + ' MT for the week, ' + WP.fmt(moved ? Math.abs(tot) / moved * 100 : 0, 2) + '% of the ' + WP.fmt(moved, 0) + ' MT weighed.'
      : 'No complete trips in the last 7 days.';
    var max = Math.max.apply(null, days.map(function (d) { return Math.abs(byDay[d].reduce(function (t, r) { return t + r.diff; }, 0)); }).concat([1]));
    $('gapRows').innerHTML = days.map(function (d) {
      var rs = byDay[d], sum = rs.reduce(function (t, r) { return t + r.diff; }, 0), w = Math.abs(sum) / max * 50;
      var out = rs.filter(function (r) { return !WP.within(r.diff); }).length;
      return '<div class="gap-row"><span>' + esc(WP.pdLabel(d)) + '<br><span class="sub">' + rs.length + ' trips · ' + out + ' outside</span></span>' +
        '<div class="gap-track" aria-hidden="true"><div class="gap-zero"></div><div class="gap-fill ' + (sum >= 0 ? 'pos' : 'neg') + '" style="' + (sum >= 0 ? 'left:50%' : 'right:50%') + ';width:' + w.toFixed(1) + '%"></div></div>' +
        '<span class="num">' + WP.sgn(sum, 1) + ' MT</span></div>';
    }).join('');
    var pos = days.filter(function (d) { return byDay[d].reduce(function (t, r) { return t + r.diff; }, 0) > 0; }).length;
    $('gapRead').textContent = !days.length ? '' : pos === days.length
      ? 'The gap is positive every day. A steady offset like this can be corrected with calibration. Random error could not.'
      : pos === 0 ? 'The gap is negative every day, so in-motion reads consistently higher than static.'
        : 'The gap changes sign between days, which points to random error more than a steady offset.';
  }

  /* ---------- tolerance what-if ---------- */
  function renderWhatIf() {
    var opts = [0.5, 1, 1.5, 2];
    if (opts.indexOf(WP.cfg.tolerance) < 0) opts.push(WP.cfg.tolerance);
    opts.sort(function (a, b) { return a - b; });
    $('whatif').innerHTML = opts.map(function (o) {
      var p = passAt(S.rows, o);
      return '<button type="button" class="wi" data-o="' + o + '" aria-pressed="' + (o === S.tol ? 'true' : 'false') + '"><div class="t">±' + WP.fmt(o, 1) + ' MT' + (o === WP.cfg.tolerance ? ' (current)' : '') + '</div><div class="v">' + pctStr(p.pct) + '</div></button>';
    }).join('');
    var p = passAt(S.rows, S.tol);
    $('wiPct').textContent = pctStr(p.pct);
    $('wiFlag').textContent = p.n ? (p.n - p.pass) + ' of ' + p.n : '—';
    $('wiBar').style.width = (p.pct || 0).toFixed(1) + '%';
    $('wiRead').textContent = !p.n ? '' : p.pct >= WP.cfg.target
      ? 'At ±' + WP.fmt(S.tol, 1) + ' MT the week meets the ' + WP.fmt(WP.cfg.target, 0) + '% target.'
      : 'At ±' + WP.fmt(S.tol, 1) + ' MT the week is ' + WP.fmt(WP.cfg.target - p.pct, 1) + ' points short of the ' + WP.fmt(WP.cfg.target, 0) + '% target.';
  }

  /* ---------- heatmap ---------- */
  function renderHeat() {
    var q = terciles(), box = $('heat');
    if (!q) { box.innerHTML = '<div class="h" style="grid-column:1/-1">Not enough trips yet.</div>'; $('heatRead').textContent = ''; return; }
    var labels = ['Under ' + WP.fmt(q[0], 0) + ' MT', WP.fmt(q[0], 0) + '–' + WP.fmt(q[1], 0) + ' MT', 'Over ' + WP.fmt(q[1], 0) + ' MT'];
    var cells = {}, maxAbs = 0.01;
    ['C', 'A', 'B'].forEach(function (s) {
      cells[s] = [[], [], []];
      S.rows.filter(function (r) { return r.shift === s && r.stN != null; }).forEach(function (r) { cells[s][band(r.stN, q)].push(r); });
    });
    var best = null;
    var html = '<div></div>' + labels.map(function (l) { return '<div class="h" role="columnheader" style="text-align:center">' + esc(l) + '</div>'; }).join('');
    ['C', 'A', 'B'].forEach(function (s) {
      cells[s].forEach(function (rs) { if (rs.length) maxAbs = Math.max(maxAbs, Math.abs(WP.stats(rs).bias)); });
    });
    ['C', 'A', 'B'].forEach(function (s) {
      var tot = cells[s].reduce(function (t, c) { return t + c.length; }, 0);
      html += '<div class="h" role="rowheader">Shift ' + s + '<br><small>' + tot + ' trips</small></div>';
      cells[s].forEach(function (rs, i) {
        if (!rs.length) { html += '<div class="c" role="cell" style="background:var(--track)">—</div>'; return; }
        var b = WP.stats(rs).bias, a = Math.abs(b) / maxAbs * 70 + 8;
        if (!best || Math.abs(b) > Math.abs(best.b)) best = { s: s, i: i, b: b, n: rs.length };
        html += '<div class="c" role="cell" style="background:color-mix(in srgb,' + (b >= 0 ? 'var(--blue)' : 'var(--ember)') + ' ' + a.toFixed(0) + '%,var(--card));color:var(--ink)"><b>' + WP.sgn(b) + '</b><small>' + rs.length + ' trips</small></div>';
      });
    });
    box.innerHTML = html;
    $('heatRead').textContent = best ? 'Largest gap: Shift ' + best.s + ', ' + labels[best.i].toLowerCase() + ', averaging ' + WP.sgn(best.b) + ' MT over ' + best.n + ' trips. Load bands are thirds of this week\'s static net weights.' : '';
  }

  /* ---------- patterns ---------- */
  function renderPatterns() {
    var h = '<div class="sub" style="margin:6px 0">In tolerance by blast furnace</div>';
    ['BF1', 'BF2'].forEach(function (a) {
      var rs = S.rows.filter(function (r) { return r.area === a; }), p = passAt(rs, WP.cfg.tolerance);
      h += '<div class="list-row"><span>' + a + '</span><span><b>' + pctStr(p.pct) + '</b> <span class="m">· ' + rs.length + ' trips</span></span></div>';
    });
    var outRows = S.rows.filter(function (r) { return !WP.within(r.diff); }), by = {};
    outRows.forEach(function (r) { by[r.torp] = (by[r.torp] || 0) + 1; });
    var top = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; })[0];
    h += '<div class="sub" style="margin:14px 0 6px">Torpedo most often outside tolerance</div>';
    h += top && by[top] >= 3
      ? '<div class="why" style="font-size:13px;color:var(--ink2)">Torpedo ' + esc(top) + ' is in ' + by[top] + ' of the ' + outRows.length + ' trips outside tolerance. Checking one vessel is cheaper than recalibrating a scale, so look at it first.</div>'
      : '<div class="why" style="font-size:13px;color:var(--ink2)">No single torpedo stands out this week.</div>';
    var from = WP.plantNow() - 7 * DAY, all7 = S.all.filter(function (r) { return r.t >= from; }), miss = all7.length - S.rows.length;
    h += '<div class="sub" style="margin:14px 0 6px">Missing readings</div><div class="why" style="font-size:13px;color:var(--ink2)">' +
      (all7.length ? miss + ' of ' + all7.length + ' trips (' + WP.fmt(miss / all7.length * 100, 1) + '%) lack a complete matched reading. They are left out of every figure here.' : 'No trips in the last 7 days.') + '</div>';
    $('patterns').innerHTML = h;
  }

  /* ---------- actions ---------- */
  function renderActions() {
    var items = DECS.map(function (d) { return { t: d.title, o: d.owner }; });
    if (DECS.length) items.push({ t: 'Re-run this review one week after any recalibration', o: 'Quality head' });
    $('actions').innerHTML = items.length ? items.map(function (a) {
      return '<div class="act"><div style="flex:1"><b>' + esc(a.t) + '</b><p>Proposed owner: ' + esc(a.o) + ' · Due: to be agreed</p></div>' + WP.pillHtml('neu', 'Proposed') + '</div>';
    }).join('') : '<div class="empty">No actions proposed yet.</div>';
  }

  function renderInterp(j) {
    $('interpSub').textContent = j && j.production_date ? 'Production day ' + WP.pdLabel(j.production_date) + ' · from the server analysis' : '';
    $('interp').innerHTML = (j && j.interpretation || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') || '<li>No analysis available yet.</li>';
  }

  function renderAll() {
    S.rows = S.all.filter(function (r) { return r.ok && r.t >= WP.plantNow() - 7 * DAY; });
    buildDecisions(); renderDecisions(); renderGap(); renderWhatIf(); renderHeat(); renderPatterns(); renderActions();
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('tolTxt').textContent = WP.fmt(WP.cfg.tolerance, 1);
    $('tgtTxt').textContent = WP.fmt(WP.cfg.target, 0);
    $('whatif').addEventListener('click', function (e) {
      var b = e.target.closest('.wi'); if (!b) return;
      S.tol = +b.getAttribute('data-o'); renderWhatIf();
    });
    function load() {
      WP.getJSON('/api/dashboard?days=all&area=ALL').then(function (j) {
        S.all = (j.rows || []).map(WP.mapRow).filter(function (r) { return !isNaN(r.t); });
        WP.setLive(true, 'Live · updated ' + WP.hhmm(WP.plantNow()) + ' IST');
        renderAll();
      }).catch(function (e) { WP.setLive(false, e && e.status === 503 ? 'Database unavailable' : 'Cannot reach server'); });
      WP.getJSON('/api/insights?area=ALL').then(renderInterp).catch(function () { renderInterp(null); });
    }
    load(); setInterval(load, 30000);
  });
})();
