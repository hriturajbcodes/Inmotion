/* Shared helpers for Overview and Insights. Exposes window.WP. */
(function () {
  'use strict';
  var WP = window.WP = window.WP || {};
  var cfg = WP.cfg = WP.cfg || { tolerance: 1.0, target: 95 };
  cfg.tolerance = Number(cfg.tolerance) || 1.0;
  cfg.target = Number(cfg.target) || 95;

  /* ---------- small utilities ---------- */
  WP.$ = function (id) { return document.getElementById(id); };
  WP.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  WP.fmt = function (v, d) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toLocaleString('en-IN', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
  };
  WP.sgn = function (v, d) {
    if (v == null || isNaN(v)) return '—';
    d = d == null ? 2 : d;
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
  };
  WP.mt = function (v, d) { return v == null || isNaN(v) ? '—' : WP.fmt(v, d) + ' MT'; };
  WP.pad = function (n) { return n < 10 ? '0' + n : '' + n; };

  /* ---------- plant clock (IST). All times are wall-clock strings. ---------- */
  WP.parseWall = function (s) {
    if (!s) return NaN;
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  };
  WP.wallStr = function (ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + WP.pad(d.getUTCMonth() + 1) + '-' + WP.pad(d.getUTCDate()) + ' ' +
      WP.pad(d.getUTCHours()) + ':' + WP.pad(d.getUTCMinutes()) + ':' + WP.pad(d.getUTCSeconds());
  };
  WP.plantNow = function () {
    try {
      var parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).formatToParts(new Date());
      var o = {};
      parts.forEach(function (p) { o[p.type] = p.value; });
      var h = o.hour === '24' ? '00' : o.hour;
      return WP.parseWall(o.year + '-' + o.month + '-' + o.day + ' ' + h + ':' + o.minute + ':' + o.second);
    } catch (e) {
      return Date.now() + 5.5 * 3600 * 1000;
    }
  };
  var DAY = 86400000;
  /* Production day D runs D-1 22:00 to D 22:00. Returns 'YYYY-MM-DD'. */
  WP.prodDateOf = function (ms) {
    var d = new Date(ms);
    var base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (d.getUTCHours() >= 22) base += DAY;
    return WP.wallStr(base).slice(0, 10);
  };
  WP.shiftOf = function (ms) {
    var h = new Date(ms).getUTCHours();
    if (h >= 22 || h < 6) return 'C';
    return h < 14 ? 'A' : 'B';
  };
  /* Start (ms) of the shift that contains ms. */
  WP.shiftStart = function (ms) {
    var d = new Date(ms);
    var day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    var h = d.getUTCHours();
    if (h >= 22) return day + 22 * 3600000;
    if (h < 6) return day - DAY + 22 * 3600000;
    if (h < 14) return day + 6 * 3600000;
    return day + 14 * 3600000;
  };
  WP.SHIFT_LABEL = { C: 'Shift C · 22:00–06:00', A: 'Shift A · 06:00–14:00', B: 'Shift B · 14:00–22:00' };
  WP.hhmm = function (ms) {
    var d = new Date(ms);
    return WP.pad(d.getUTCHours()) + ':' + WP.pad(d.getUTCMinutes());
  };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  WP.dayLabel = function (ms) { var d = new Date(ms); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; };
  WP.dateTimeLabel = function (ms) { return WP.dayLabel(ms) + ', ' + WP.hhmm(ms); };
  WP.pdLabel = function (pd) { return WP.dayLabel(WP.parseWall(pd + ' 00:00:00')); };

  /* ---------- row mapping and stats ---------- */
  function num(v) { return v == null || v === '' || isNaN(v) ? null : Number(v); }
  WP.isComplete = function (r) {
    return r.MATCH_STATUS === 'MATCHED' &&
      ['STATIC_GROSS_WT', 'STATIC_TARE_WT', 'STATIC_NET_WT', 'IMWB_GROSS_WT', 'IMWB_TARE_WT', 'IMWB_NET_WT']
        .every(function (k) { return r[k] != null; });
  };
  WP.mapRow = function (r) {
    var t = WP.parseWall(r.STATIC_RECORD_TIME);
    var stN = num(r.STATIC_NET_WT), inN = num(r.IMWB_NET_WT);
    var diff = num(r.NET_WT_DIFFERENCE);
    if (diff == null && stN != null && inN != null) diff = stN - inN;
    var inTimeStr = r.IMWB_TARE_TIME || r.IMWB_GROSS_TIME || '';
    return {
      raw: r, t: t, ts: r.STATIC_RECORD_TIME,
      cast: r.BFCASTID || '—', torp: r.TORPEDO_NO || '—', area: r.STATIC_SOURCE || '—',
      stG: num(r.STATIC_GROSS_WT), stT: num(r.STATIC_TARE_WT), stN: stN,
      inG: num(r.IMWB_GROSS_WT), inT: num(r.IMWB_TARE_WT), inN: inN,
      diff: diff, pct: num(r.NET_WT_DIFFERENCE_PCT),
      inTime: WP.parseWall(inTimeStr), inTimeStr: inTimeStr,
      pd: WP.prodDateOf(t), shift: WP.shiftOf(t),
      ok: WP.isComplete(r) && diff != null
    };
  };
  WP.within = function (d) { return d != null && Math.abs(d) <= cfg.tolerance + 1e-9; };
  WP.stats = function (rows) {
    var xs = rows.filter(function (r) { return r.diff != null; });
    var n = xs.length;
    if (!n) return { n: 0, pass: 0, pct: null, bias: null, mean: null, sd: null, maxAbs: null, tons: 0 };
    var sum = 0, pass = 0, maxAbs = 0, tons = 0;
    xs.forEach(function (r) {
      sum += r.diff; if (WP.within(r.diff)) pass++;
      maxAbs = Math.max(maxAbs, Math.abs(r.diff)); tons += r.stN || 0;
    });
    var mean = sum / n, v = 0;
    xs.forEach(function (r) { v += Math.pow(r.diff - mean, 2); });
    return { n: n, pass: pass, pct: pass / n * 100, bias: mean, mean: mean, sd: n > 1 ? Math.sqrt(v / (n - 1)) : 0, maxAbs: maxAbs, tons: tons };
  };
  /* Shift readiness: Ready if pct >= target and |bias| <= 0.3; Hold if pct < 90 or |bias| > 0.5; else Watch. */
  WP.shiftStatus = function (s) {
    if (!s.n) return { k: 'neu', t: 'No trips' };
    if (s.pct < 90 || Math.abs(s.bias) > 0.5) return { k: 'bad', t: 'Hold' };
    if (s.pct >= cfg.target && Math.abs(s.bias) <= 0.3) return { k: 'ok', t: 'Ready' };
    return { k: 'warn', t: 'Watch' };
  };

  /* ---------- network ---------- */
  WP.getJSON = function (url) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    return fetch(url, { cache: 'no-cache', signal: ctl ? ctl.signal : undefined }).then(function (res) {
      clearTimeout(to);
      if (!res.ok) { var err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
      return res.json();
    }, function (e) { clearTimeout(to); throw e; });
  };
  WP.setLive = function (ok, text) {
    var d = WP.$('dot'), t = WP.$('liveTxt');
    if (d) d.className = 'live-dot ' + (ok ? 'ok' : 'bad');
    if (t) t.textContent = text;
  };

  /* ---------- theme ---------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('imwb_theme', t); } catch (e) {}
    var l = WP.$('themeLight'), d = WP.$('themeDark');
    if (l) l.setAttribute('aria-pressed', t === 'light' ? 'true' : 'false');
    if (d) d.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
  }
  document.addEventListener('DOMContentLoaded', function () {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    var l = WP.$('themeLight'), d = WP.$('themeDark');
    if (l) l.addEventListener('click', function () { applyTheme('light'); });
    if (d) d.addEventListener('click', function () { applyTheme('dark'); });
  });

  /* ---------- tooltip ---------- */
  WP.tip = {
    show: function (html, x, y) {
      var t = WP.$('tip'); if (!t) return;
      t.innerHTML = html; t.hidden = false;
      var w = t.offsetWidth, h = t.offsetHeight;
      var left = Math.min(Math.max(8, x + 14), window.innerWidth - w - 8);
      var top = y - h - 14; if (top < 8) top = y + 18;
      t.style.left = left + 'px'; t.style.top = top + 'px';
    },
    hide: function () { var t = WP.$('tip'); if (t) t.hidden = true; }
  };

  /* Segmented control helper: onChange(value). */
  WP.seg = function (id, onChange) {
    var el = WP.$(id); if (!el) return;
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]'); if (!b) return;
      Array.prototype.forEach.call(el.querySelectorAll('button'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
      onChange(b.getAttribute('data-v'));
    });
  };
  WP.pillHtml = function (k, t) { return '<span class="pill ' + k + '">' + WP.esc(t) + '</span>'; };
})();
