/* 관리자 — KPI (본사용)
   매출(룸별 · 기간별, 이용일/결제일 기준) · 예약률(24시간 × 기간) · 이용인원 · 취소율 · 홈페이지 방문을 한 화면에 보여 줍니다.
   데이터: GET /api/admin/kpi (functions/api/admin/kpi.js). 그래프는 외부 도구 없이 SVG · HTML로 그립니다. */
(function () {
  "use strict";
  var A = window.SF_ADMIN;
  if (!A) return;
  var $ = A.$, esc = A.esc, api = A.api;
  // 관리자 화면을 연 브라우저는 홈페이지 방문 통계에서 뺍니다 (js/visit.js 가 확인).
  try { window.localStorage.setItem("sf-notrack", "1"); } catch (e) { /* 저장소를 못 쓰는 브라우저 */ }

  var ROOM_COLOR = { r1: "#2a78d6", r2: "#eb6834", r3: "#1baf7a", r4: "#eda100", r5: "#e87ba4" };
  var OTHER = "#B4BCCB", BRAND = "#2855E8";
  var SEQ = ["#F3F6FB", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
  var state = { preset: "month", from: "", to: "", basis: "use", data: null, loading: 0 };
  var tips = {}, tipEl = null, resizeT = 0;

  /* ---------- 숫자 ---------- */
  var num = function (v) { return Math.round(+v || 0).toLocaleString("ko-KR"); };
  var won = function (v) { return num(v) + "원"; };
  var man = function (v) {
    v = +v || 0; var a = Math.abs(v);
    if (a >= 1e8) return (Math.round(v / 1e7) / 10).toLocaleString("ko-KR") + "억";
    if (a >= 1e4) return Math.round(v / 1e4).toLocaleString("ko-KR") + "만";
    return num(v);
  };
  var pct = function (v, d) { return (+v || 0).toFixed(d === undefined ? 1 : d) + "%"; };
  var dur = function (ms) {
    var s = Math.round((+ms || 0) / 1000);
    if (s < 60) return s + "초";
    var m = Math.floor(s / 60); return m < 60 ? m + "분 " + (s % 60) + "초" : Math.floor(m / 60) + "시간 " + (m % 60) + "분";
  };
  var hours = function (min) { var h = (+min || 0) / 60; return (Math.round(h * 10) / 10).toLocaleString("ko-KR") + "시간"; };
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var iso = function (d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); };
  var kst = function () { return new Date(Date.now() + 9 * 3600000); };
  var dot = function (s) { return s ? s.replace(/-/g, ".") : ""; };
  var bucketLabel = function (k, multiYear) {
    if (k.length === 10) return +k.slice(5, 7) + "." + +k.slice(8, 10);
    return multiYear ? k.slice(2, 4) + "." + k.slice(5, 7) : +k.slice(5, 7) + "월";
  };
  var bucketLong = function (k) {
    if (k.length === 10) { var w = "일월화수목금토"[new Date(k + "T00:00:00Z").getUTCDay()]; return dot(k) + " (" + w + ")"; }
    return k.slice(0, 4) + "년 " + +k.slice(5, 7) + "월";
  };

  /* ---------- 기간 ---------- */
  function presetRange(p) {
    var t = kst(), y = t.getUTCFullYear(), m = t.getUTCMonth();
    var first = function (yy, mm) { return new Date(Date.UTC(yy, mm, 1)); }, last = function (yy, mm) { return new Date(Date.UTC(yy, mm + 1, 0)); };
    if (p === "month") return [iso(first(y, m)), iso(last(y, m))];
    if (p === "prev") return [iso(first(y, m - 1)), iso(last(y, m - 1))];
    if (p === "q3") return [iso(first(y, m - 2)), iso(last(y, m))];
    if (p === "year") return [y + "-01-01", y + "-12-31"];
    if (p === "y12") return [iso(first(y, m - 11)), iso(last(y, m))];
    if (p === "d30") return [iso(new Date(Date.UTC(y, m, t.getUTCDate() - 29))), iso(t)];
    return [state.from, state.to];
  }

  /* ---------- 툴팁 (값이 먼저, 이름이 뒤) ---------- */
  function tip(id, fn) { tips[id] = fn; return id; }
  function showTip(target, ev) {
    var fn = tips[target.getAttribute("data-tip")]; if (!fn) return;
    var d = fn(); if (!d) return;
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "kpi-tip"; tipEl.setAttribute("role", "tooltip"); document.body.appendChild(tipEl); }
    tipEl.textContent = "";
    var h = document.createElement("div"); h.className = "kpi-tip-h"; h.textContent = d.title; tipEl.appendChild(h);
    (d.rows || []).forEach(function (r) {
      var row = document.createElement("div"); row.className = "kpi-tip-r";
      if (r.color) { var k = document.createElement("i"); k.style.background = r.color; if (r.hatch) k.className = "hatch"; row.appendChild(k); }
      var v = document.createElement("b"); v.textContent = r.value; row.appendChild(v);
      var l = document.createElement("span"); l.textContent = r.label; row.appendChild(l);
      tipEl.appendChild(row);
    });
    tipEl.hidden = false;
    var rect = target.getBoundingClientRect(), x = ev && ev.clientX ? ev.clientX : rect.left + rect.width / 2, yy = ev && ev.clientY ? ev.clientY : rect.top;
    var w = tipEl.offsetWidth, hh = tipEl.offsetHeight;
    var left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 14)), top = yy - hh - 12 < 8 ? yy + 16 : yy - hh - 12;
    tipEl.style.left = left + "px"; tipEl.style.top = top + "px";
  }
  function hideTip() { if (tipEl) tipEl.hidden = true; }
  document.addEventListener("pointermove", function (e) { var t = e.target.closest && e.target.closest("#view-kpi [data-tip]"); if (t) showTip(t, e); else hideTip(); });
  document.addEventListener("focusin", function (e) { var t = e.target.closest && e.target.closest("#view-kpi [data-tip]"); if (t) showTip(t); });
  document.addEventListener("focusout", hideTip);

  /* ---------- 그래프 ---------- */
  /* 축 최댓값 — 눈금 4칸이 깔끔한 수가 되도록 (건수 · 인원은 정수 눈금) */
  function niceMax(v, integer) {
    var raw = (+v || 0) / 4;
    if (!(raw > 0)) return integer ? 4 : 1;
    var p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p, c = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10], step = 10 * p;
    for (var i = 0; i < c.length; i++) if (f <= c[i] + 1e-9) { step = c[i] * p; break; }
    if (integer) step = Math.max(1, Math.ceil(step));
    return step * 4;
  }
  var pctAxis = function (v) { return (Math.abs(v % 1) > 1e-9 ? v.toFixed(1) : String(Math.round(v))) + "%"; };
  /* 쌓은 막대 — series: [{key,label,color,hatch,values[]}] */
  function columns(id, keys, series, opt) {
    opt = opt || {};
    var el = $("#" + id); if (!el) return;
    var W = Math.max(320, el.clientWidth || 640), H = opt.height || 220, L = 48, R = 8, T = 14, Bm = 26;
    var totals = keys.map(function (_, i) { return series.reduce(function (s, x) { return s + (+x.values[i] || 0); }, 0); });
    var max = niceMax(opt.max || Math.max.apply(null, totals.concat([0])), opt.integer), iw = W - L - R, ih = H - T - Bm, band = iw / Math.max(1, keys.length);
    var bw = Math.max(2, Math.min(24, band * 0.62)), fmt = opt.axis || man, multiYear = keys.length && keys[0].slice(0, 4) !== keys[keys.length - 1].slice(0, 4);
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" height="' + H + '" role="img" aria-label="' + esc(opt.label || "") + '">';
    s += '<defs><pattern id="' + id + '-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#DCE7FF"/><line x1="0" y1="0" x2="0" y2="6" stroke="#6da7ec" stroke-width="2.4"/></pattern></defs>';
    for (var g = 0; g <= 4; g++) {
      var gy = T + ih - ih * g / 4;
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '" class="kpi-grid"/><text x="' + (L - 6) + '" y="' + (gy + 4) + '" class="kpi-ax" text-anchor="end">' + esc(fmt(max * g / 4)) + "</text>";
    }
    var every = Math.ceil(keys.length / Math.max(1, Math.floor(iw / 44)));
    keys.forEach(function (k, i) {
      var x = L + band * i + (band - bw) / 2, y = T + ih;
      var visible = series.filter(function (x2) { return (+x2.values[i] || 0) > 0; }), topKey = visible.length ? visible[visible.length - 1].key : "";
      series.forEach(function (ser) {
        var v = +ser.values[i] || 0; if (v <= 0) return;
        var h = Math.max(1, ih * v / max), gap = ser.key === topKey ? 0 : 2, hh = Math.max(1, h - gap);
        y -= h;
        var top = ser.key === topKey, r = top ? Math.min(4, bw / 2, hh) : 0;
        s += top ? '<path d="' + roundTop(x, y + gap * 0, bw, hh, r) + '" fill="' + (ser.hatch ? "url(#" + id + "-hatch)" : ser.color) + '"/>'
          : '<rect x="' + x + '" y="' + (y + gap) + '" width="' + bw + '" height="' + hh + '" fill="' + (ser.hatch ? "url(#" + id + "-hatch)" : ser.color) + '"/>';
      });
      if (i % every === 0) s += '<text x="' + (L + band * i + band / 2) + '" y="' + (H - 8) + '" class="kpi-ax" text-anchor="middle">' + esc(bucketLabel(k, multiYear)) + "</text>";
      var tid = tip(id + ":" + i, function () {
        return { title: bucketLong(k), rows: series.map(function (ser) { return { color: ser.color, hatch: ser.hatch, label: ser.label, value: (opt.value || won)(+ser.values[i] || 0) }; }).concat(series.length > 1 ? [{ label: "합계", value: (opt.value || won)(totals[i]) }] : []) };
      });
      s += '<rect x="' + (L + band * i) + '" y="' + T + '" width="' + band + '" height="' + ih + '" fill="transparent" data-tip="' + tid + '" tabindex="-1"/>';
    });
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (T + ih) + '" y2="' + (T + ih) + '" class="kpi-base"/></svg>';
    el.innerHTML = s + legend(series);
  }
  function roundTop(x, y, w, h, r) {
    return "M" + x + "," + (y + h) + "V" + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y + "H" + (x + w - r) + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "V" + (y + h) + "Z";
  }
  function legend(series) {
    if (series.length < 2) return "";
    return '<div class="kpi-legend">' + series.map(function (s) { return '<span><i class="' + (s.hatch ? "hatch" : "") + '" style="background:' + s.color + '"></i>' + esc(s.label) + "</span>"; }).join("") + "</div>";
  }
  /* 꺾은선 — 같은 단위의 값만 함께 그립니다 (축 하나) */
  function lines(id, keys, series, opt) {
    opt = opt || {};
    var el = $("#" + id); if (!el) return;
    var W = Math.max(320, el.clientWidth || 640), H = opt.height || 200, L = 44, R = 12, T = 14, Bm = 26;
    var all = []; series.forEach(function (s) { all = all.concat(s.values.map(Number)); });
    var max = opt.max || niceMax(Math.max.apply(null, all.concat([0])), opt.integer), iw = W - L - R, ih = H - T - Bm, n = keys.length;
    var X = function (i) { return L + (n <= 1 ? iw / 2 : iw * i / (n - 1)); }, Y = function (v) { return T + ih - ih * Math.min(v, max) / max; };
    var fmt = opt.axis || function (v) { return num(v); }, multiYear = n && keys[0].slice(0, 4) !== keys[n - 1].slice(0, 4);
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" width="100%" height="' + H + '" role="img" aria-label="' + esc(opt.label || "") + '">';
    for (var g = 0; g <= 4; g++) { var gy = T + ih - ih * g / 4; s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '" class="kpi-grid"/><text x="' + (L - 6) + '" y="' + (gy + 4) + '" class="kpi-ax" text-anchor="end">' + esc(fmt(max * g / 4)) + "</text>"; }
    // 오늘 이후(아직 오지 않은 날)는 선을 그리지 않습니다.
    var last = n - 1;
    if (opt.until) while (last > 0 && keys[last] > opt.until.slice(0, keys[last].length)) last--;
    series.forEach(function (ser) {
      var vals = ser.values.slice(0, last + 1);
      if (opt.area && series.length === 1) s += '<path d="M' + X(0) + "," + (T + ih) + vals.map(function (v, i) { return "L" + X(i) + "," + Y(+v || 0); }).join("") + "L" + X(last) + "," + (T + ih) + 'Z" fill="' + ser.color + '" opacity=".1"/>';
      s += '<path d="' + vals.map(function (v, i) { return (i ? "L" : "M") + X(i) + "," + Y(+v || 0); }).join("") + '" fill="none" stroke="' + ser.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      s += '<circle cx="' + X(last) + '" cy="' + Y(+ser.values[last] || 0) + '" r="4" fill="' + ser.color + '" stroke="#fff" stroke-width="2"/>';
    });
    var every = Math.ceil(n / Math.max(1, Math.floor(iw / 44)));
    keys.forEach(function (k, i) {
      if (i % every === 0) s += '<text x="' + X(i) + '" y="' + (H - 8) + '" class="kpi-ax" text-anchor="middle">' + esc(bucketLabel(k, multiYear)) + "</text>";
      var w = n <= 1 ? iw : iw / (n - 1), tid = tip(id + ":" + i, function () {
        return { title: bucketLong(k), rows: series.map(function (ser) { return { color: ser.color, label: ser.label, value: (opt.value || num)(+ser.values[i] || 0) }; }) };
      });
      s += '<rect x="' + (X(i) - w / 2) + '" y="' + T + '" width="' + w + '" height="' + ih + '" fill="transparent" data-tip="' + tid + '"/>';
    });
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (T + ih) + '" y2="' + (T + ih) + '" class="kpi-base"/></svg>';
    el.innerHTML = s + legend(series);
  }
  /* 가로 막대 (HTML) — rows: [{label, value, text, sub, color}] */
  function hbars(rows, opt) {
    opt = opt || {};
    var max = opt.max || Math.max.apply(null, rows.map(function (r) { return +r.value || 0; }).concat([0])) || 1;
    return '<div class="kpi-hbars">' + rows.map(function (r, i) {
      var w = Math.max(0, Math.min(100, (+r.value || 0) / max * 100));
      return '<div class="kpi-hbar"' + (r.tip ? ' data-tip="' + tip((opt.id || "hb") + ":" + i, r.tip) + '" tabindex="0"' : "") + '><div class="kpi-hbar-l">' + (r.key ? '<i style="background:' + r.color + '"></i>' : "") + esc(r.label) + '</div><div class="kpi-hbar-t"><span style="width:' + w + "%;background:" + (r.color || BRAND) + '"></span></div><div class="kpi-hbar-v"><b>' + esc(r.text) + "</b>" + (r.sub ? "<small>" + esc(r.sub) + "</small>" : "") + "</div></div>";
    }).join("") + "</div>";
  }

  /* ---------- 지표 카드 ---------- */
  function delta(cur, prev, betterUp, unit, hasPrev) {
    if (prev === null || prev === undefined) return "";
    if (hasPrev === false) return '<span class="kpi-d flat">직전 기간 기록 없음</span>';
    var diff = cur - prev;
    if (unit === "pt") {
      if (Math.abs(diff) < 0.05) return '<span class="kpi-d flat">직전 기간과 같음</span>';
      var good = betterUp ? diff > 0 : diff < 0;
      return '<span class="kpi-d ' + (good ? "up" : "down") + '">' + (diff > 0 ? "▲ " : "▼ ") + Math.abs(diff).toFixed(1) + "%p</span>";
    }
    if (!prev) return cur ? '<span class="kpi-d flat">직전 기간 기록 없음</span>' : "";
    var r = diff / prev * 100;
    if (Math.abs(r) < 0.5) return '<span class="kpi-d flat">직전 기간과 비슷</span>';
    var ok = betterUp ? r > 0 : r < 0;
    return '<span class="kpi-d ' + (ok ? "up" : "down") + '">' + (r > 0 ? "▲ " : "▼ ") + (Math.abs(r) > 999 ? "999%+" : Math.abs(r).toFixed(0) + "%") + "</span>";
  }
  function tile(label, value, sub, d, go) {
    return '<div class="kpi-tile"' + (go ? ' data-kpi-go="' + go + '" role="button" tabindex="0"' : "") + "><span>" + esc(label) + '</span><b>' + esc(value) + "</b>" + (d || "") + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</div>";
  }

  /* ---------- 화면 ---------- */
  function render() {
    var d = state.data; if (!d) return;
    tips = {};
    var p = d.period, cur = d.summary, prev = d.prev.summary, keys = d.buckets, rooms = d.rooms;
    var multiYear = p.from.slice(0, 4) !== p.to.slice(0, 4);
    $("#kpi-range").textContent = dot(p.from) + " – " + dot(p.to) + " · " + p.days + "일 · " + (p.basis === "paid" ? "결제일 기준" : "이용일 기준") + " · 비교: 직전 " + p.days + "일 (" + dot(d.prev.from) + " – " + dot(d.prev.to) + ")";
    var avail = d.occupancy.available / 60;
    $("#kpi-tiles").innerHTML = [
      tile("총매출", man(cur.sales) + "원", won(cur.sales), delta(cur.sales, prev.sales, true), "sales"),
      tile("룸 대관 매출", man(cur.rooms) + "원", "총매출의 " + pct(cur.sales ? cur.rooms / cur.sales * 100 : 0, 0), delta(cur.rooms, prev.rooms, true), "sales"),
      tile("예약률 (1~5번룸)", pct(cur.occupancy), hours(d.occupancy.minutes) + " / " + num(avail) + "시간", delta(cur.occupancy, prev.occupancy, true, "pt", prev.bookings > 0), "occ"),
      tile("이용인원", num(cur.people) + "명", num(cur.bookings) + "건 · 평균 " + (d.people.avg || 0).toFixed(1) + "명", delta(cur.people, prev.people, true), "people"),
      tile("취소율", pct(cur.cancelRate), num(d.cancel.cancelled) + "건 / " + num(d.cancel.total) + "건", delta(cur.cancelRate, prev.cancelRate, false, "pt", prev.bookings > 0), "cancel"),
      tile("홈페이지 방문자", num(cur.visitors) + "명", "방문 " + num(cur.sessions) + "회 · 페이지 " + num(cur.pageviews) + "회", delta(cur.visitors, prev.visitors, true), "web"),
      tile("평균 체류시간", dur(cur.avgSessionMs), "방문 1회 기준", delta(cur.avgSessionMs, prev.avgSessionMs, true), "web"),
      tile("홈페이지 예약 신청", num(cur.requests) + "건", "결제 확정 " + num(d.webBooking.confirmed) + "건 · 문의 " + num(cur.inquiries) + "건", delta(cur.requests, prev.requests, true), "cancel")
    ].join("");

    /* 매출 */
    var sv = d.sales, roomSeries = rooms.map(function (r) { return { key: r.key, label: r.name, color: ROOM_COLOR[r.key], values: keys.map(function (k) { return sv.series[k][r.key]; }) }; });
    var otherVals = keys.map(function (k) { var x = sv.series[k]; return x.space_other + x.orders + x.kiosk + x.office + x.terminal + x.payapp; });
    columns("kpi-sales-chart", keys, roomSeries.concat([{ key: "other", label: "그 외 매출", color: OTHER, values: otherVals }]), { label: "기간별 매출" });
    $("#kpi-sales-rooms").innerHTML = hbars(rooms.map(function (r) {
      var x = sv.byRoom[r.key];
      return { key: r.key, label: r.name, color: ROOM_COLOR[r.key], value: x.amount, text: won(x.amount), sub: pct(x.share, 0) + " · 시간당 " + won(x.perHour),
        tip: function () { return { title: r.name, rows: [{ value: won(x.amount), label: "매출 (" + num(x.n) + "건)" }, { value: hours(x.hours * 60), label: "예약된 시간" }, { value: won(x.perHour), label: "예약 1시간당 매출" }, { value: won(x.refunds), label: "환불액" }] }; } };
    }), { id: "sr" });
    $("#kpi-sales-cats").innerHTML = '<table class="tbl kpi-t"><thead><tr><th>구분</th><th class="r">매출</th><th class="r">건수</th><th class="r">비중</th></tr></thead><tbody>' +
      sv.categories.map(function (c) { return "<tr><td>" + esc(c.label) + '</td><td class="r">' + won(c.amount) + '</td><td class="r">' + num(c.n) + '</td><td class="r"><span class="kpi-share"><i style="width:' + Math.min(100, c.share) + '%"></i></span>' + pct(c.share, 0) + "</td></tr>"; }).join("") +
      '<tr class="kpi-sum"><td>합계</td><td class="r">' + won(sv.total) + '</td><td class="r">' + num(sv.categories.reduce(function (s, c) { return s + c.n; }, 0)) + '</td><td class="r">100%</td></tr></tbody></table>';
    $("#kpi-sales-table").innerHTML = '<table class="tbl kpi-t"><thead><tr><th>' + (p.bucket === "day" ? "날짜" : "월") + "</th>" + rooms.map(function (r) { return '<th class="r">' + esc(r.name) + "</th>"; }).join("") + '<th class="r">룸 합계</th><th class="r">그 외</th><th class="r">전체</th></tr></thead><tbody>' +
      keys.map(function (k, i) {
        var x = sv.series[k], roomSum = rooms.reduce(function (s, r) { return s + x[r.key]; }, 0);
        return "<tr><td>" + esc(p.bucket === "day" ? bucketLong(k).slice(5) : k.replace("-", ".")) + "</td>" + rooms.map(function (r) { return '<td class="r">' + (x[r.key] ? num(x[r.key]) : '<span class="muted">0</span>') + "</td>"; }).join("") + '<td class="r"><b>' + num(roomSum) + '</b></td><td class="r">' + num(otherVals[i]) + '</td><td class="r"><b>' + num(roomSum + otherVals[i]) + "</b></td></tr>";
      }).join("") + "</tbody></table>";
    $("#kpi-basis-note").textContent = p.basis === "paid" ? "결제일 기준: 결제(입금) 확인된 날짜로 묶습니다." : "이용일 기준: 룸 대관은 이용한 날짜로 묶습니다. 이용권 · 사무실 · 단말기 매출은 이용일이 따로 없어 결제일로 묶습니다.";

    /* 예약률 */
    var oc = d.occupancy;
    $("#kpi-occ-rooms").innerHTML = hbars(rooms.map(function (r) {
      var x = oc.byRoom[r.key];
      return { key: r.key, label: r.name, color: ROOM_COLOR[r.key], value: x.rate, text: pct(x.rate), sub: hours(x.minutes) + " / " + num(x.available / 60) + "시간",
        tip: function () { return { title: r.name + " 예약률", rows: [{ value: pct(x.rate), label: "24시간 × " + p.days + "일 기준" }, { value: hours(x.minutes), label: "예약된 시간" }] }; } };
    }), { id: "or", max: Math.max(10, niceMax(Math.max.apply(null, rooms.map(function (r) { return oc.byRoom[r.key].rate; })))) });
    lines("kpi-occ-chart", keys, [{ key: "all", label: "1~5번룸 전체", color: BRAND, values: keys.map(function (k) { return oc.series[k].rate; }) }],
      { label: "기간별 예약률", axis: pctAxis, value: function (v) { return pct(v); }, max: Math.max(4, niceMax(Math.max.apply(null, keys.map(function (k) { return oc.series[k].rate; })))), area: true });
    heat(oc.heat);
    var occNote = [];
    if (!oc.calendar.configured) occNote.push("스페이스클라우드 일정이 연결되지 않아 관리자 기록 예약만 계산했습니다.");
    else if (oc.calendar.error) occNote.push("스페이스클라우드 일정을 최신으로 읽지 못했습니다: " + oc.calendar.error);
    if (oc.untimed) occNote.push("시간 정보가 없는 스페이스클라우드 정산 " + oc.untimed + "건은 예약률에서 빠지고 이용인원에는 들어갑니다.");
    $("#kpi-occ-note").textContent = occNote.join(" ");
    $("#kpi-occ-note").hidden = !occNote.length;

    /* 이용인원 */
    var pp = d.people;
    columns("kpi-people-chart", keys, [
      { key: "rec", label: "기록된 인원", color: BRAND, values: keys.map(function (k) { return pp.series[k].recorded; }) },
      { key: "est", label: "추정 인원 (인원 미기록 → 최대 인원의 절반)", color: "#6da7ec", hatch: true, values: keys.map(function (k) { return pp.series[k].estimated; }) }
    ], { label: "기간별 이용인원", axis: function (v) { return num(v); }, value: function (v) { return num(v) + "명"; }, height: 200, integer: true });
    $("#kpi-people-sum").innerHTML = '<div class="kpi-mini"><span>이용인원</span><b>' + num(pp.total) + '명</b><small>기록 ' + num(pp.recorded) + "명 · 추정 " + num(pp.estimated) + "명 (" + num(pp.estimatedBookings) + "건)</small></div>" +
      '<div class="kpi-mini"><span>예약 건수</span><b>' + num(pp.bookings) + '건</b><small>예약 1건 평균 ' + (pp.avg || 0).toFixed(1) + "명</small></div>" +
      '<div class="kpi-mini"><span>평균 이용시간</span><b>' + (pp.avgHours || 0).toFixed(1) + '시간</b><small>최대 인원 대비 평균 ' + pct(pp.capacityUse, 0) + "</small></div>";
    $("#kpi-people-table").innerHTML = '<table class="tbl kpi-t"><thead><tr><th>룸</th><th class="r">최대</th><th class="r">예약</th><th class="r">이용인원</th><th class="r">추정 포함</th><th class="r">1건 평균</th><th class="r">평균 이용시간</th></tr></thead><tbody>' +
      rooms.map(function (r) { var x = pp.byRoom[r.key]; return '<tr><td><i class="kpi-key" style="background:' + ROOM_COLOR[r.key] + '"></i>' + esc(r.name) + '</td><td class="r">' + r.max + '명</td><td class="r">' + num(x.bookings) + '건</td><td class="r"><b>' + num(x.people) + '명</b></td><td class="r">' + (x.estimated ? num(x.estimated) + "명" : "—") + '</td><td class="r">' + (x.bookings ? (x.people / x.bookings).toFixed(1) + "명" : "—") + '</td><td class="r">' + (x.bookings ? (x.minutes / 60 / x.bookings).toFixed(1) + "시간" : "—") + "</td></tr>"; }).join("") + "</tbody></table>";

    /* 취소 */
    var cc = d.cancel, wb = d.webBooking;
    columns("kpi-cancel-chart", keys, [
      { key: "ok", label: "이용 · 확정", color: BRAND, values: keys.map(function (k) { return cc.series[k].total - cc.series[k].cancelled; }) },
      { key: "cx", label: "취소", color: "#eb6834", values: keys.map(function (k) { return cc.series[k].cancelled; }) }
    ], { label: "기간별 예약 · 취소 건수", axis: function (v) { return num(v); }, value: function (v) { return num(v) + "건"; }, height: 190, integer: true });
    var chs = Object.keys(cc.byChannel).map(function (k) { return cc.byChannel[k]; }).sort(function (a, b) { return b.total - a.total; });
    $("#kpi-cancel-table").innerHTML = '<table class="tbl kpi-t"><thead><tr><th>예약 경로 · 룸</th><th class="r">예약</th><th class="r">취소</th><th class="r">취소율</th></tr></thead><tbody>' +
      chs.map(function (x) { return "<tr><td>" + esc(x.label) + '</td><td class="r">' + num(x.total) + '</td><td class="r">' + num(x.cancelled) + '</td><td class="r"><b>' + pct(x.rate) + "</b></td></tr>"; }).join("") +
      rooms.map(function (r) { var x = cc.byRoom[r.key]; return '<tr class="kpi-sub"><td><i class="kpi-key" style="background:' + ROOM_COLOR[r.key] + '"></i>' + esc(r.name) + '</td><td class="r">' + num(x.total) + '</td><td class="r">' + num(x.cancelled) + '</td><td class="r">' + pct(x.rate) + "</td></tr>"; }).join("") +
      '<tr class="kpi-sum"><td>전체</td><td class="r">' + num(cc.total) + '</td><td class="r">' + num(cc.cancelled) + '</td><td class="r">' + pct(cc.rate) + "</td></tr></tbody></table>" +
      '<p class="tiny muted">환불액 합계 ' + won(cc.refunds) + " · 스페이스클라우드는 전액 환불된 정산 건을 취소로 셉니다.</p>";
    $("#kpi-webbooking").innerHTML = hbars([
      { label: "홈페이지 예약 신청", value: wb.requests, text: num(wb.requests) + "건", color: SEQ[6] },
      { label: "결제 확정", value: wb.confirmed, text: num(wb.confirmed) + "건", sub: "신청 대비 " + pct(wb.conversion, 0), color: SEQ[5] },
      { label: "진행 중 (확인 · 결제 대기)", value: wb.pending, text: num(wb.pending) + "건", color: SEQ[3] },
      { label: "결제 전 취소", value: wb.cancelled, text: num(wb.cancelled) + "건", color: OTHER },
      { label: "결제 기한 만료", value: wb.expired, text: num(wb.expired) + "건", color: OTHER }
    ], { max: Math.max(1, wb.requests) });

    /* 홈페이지 */
    var v = d.visits;
    $("#kpi-web-tiles").innerHTML = [
      ["방문자", num(v.visitors) + "명", "하루 단위로 센 사람 수의 합"], ["방문", num(v.sessions) + "회", "30분 넘게 쉬면 새 방문"], ["페이지 조회", num(v.pageviews) + "회", "방문 1회 평균 " + (v.pagesPerSession || 0).toFixed(1) + "페이지"],
      ["평균 체류시간", dur(v.avgSessionMs), "방문 1회 · 화면을 보고 있던 시간"], ["페이지당 체류", dur(v.avgPageMs), "페이지 1개 평균"], ["한 페이지만 보고 나감", pct(v.bounceRate, 0), "전체 방문 중"]
    ].map(function (x) { return '<div class="kpi-mini"><span>' + esc(x[0]) + "</span><b>" + esc(x[1]) + "</b><small>" + esc(x[2]) + "</small></div>"; }).join("");
    lines("kpi-web-chart", keys, [
      { key: "visitors", label: "방문자", color: "#2a78d6", values: keys.map(function (k) { return v.series[k].visitors; }) },
      { key: "sessions", label: "방문", color: "#eb6834", values: keys.map(function (k) { return v.series[k].sessions; }) },
      { key: "pv", label: "페이지 조회", color: "#1baf7a", values: keys.map(function (k) { return v.series[k].pageviews; }) }
    ], { label: "기간별 방문", value: function (x) { return num(x) + "회"; }, integer: true, until: d.today });
    var maxPv = v.topPages.length ? v.topPages[0].pageviews : 1;
    $("#kpi-pages").innerHTML = v.topPages.length ? '<table class="tbl kpi-t"><thead><tr><th>페이지</th><th class="r">조회</th><th class="r">평균 체류</th><th class="r">첫 화면</th><th class="r">스크롤</th></tr></thead><tbody>' +
      v.topPages.map(function (x) { return '<tr><td><b>' + esc(x.title || x.path) + '</b><small>' + esc(x.path) + '</small></td><td class="r"><span class="kpi-share"><i style="width:' + (x.pageviews / maxPv * 100) + '%"></i></span>' + num(x.pageviews) + '</td><td class="r">' + dur(x.avgMs) + '</td><td class="r">' + num(x.entries) + '</td><td class="r">' + pct(x.scroll, 0) + "</td></tr>"; }).join("") + "</tbody></table>"
      : A.emptyMsg("아직 방문 기록이 없습니다. 이번 업데이트를 올린 날부터 쌓입니다.");
    var srcTotal = v.sources.reduce(function (s, x) { return s + x.sessions; }, 0) || 1;
    $("#kpi-sources").innerHTML = v.sources.length ? hbars(v.sources.map(function (x) { return { label: x.label, value: x.sessions, text: num(x.sessions) + "회", sub: pct(x.sessions / srcTotal * 100, 0) }; })) +
      (v.campaigns.length ? '<p class="kpi-cap">광고 · 캠페인 링크</p>' + v.campaigns.slice(0, 5).map(function (c) { return '<p class="tiny">' + esc(c.source) + (c.campaign ? " · " + esc(c.campaign) : "") + " — <b>" + num(c.sessions) + "회</b></p>"; }).join("") : "") +
      (v.referrers.length ? '<p class="kpi-cap">들어온 사이트</p>' + v.referrers.slice(0, 5).map(function (r) { return '<p class="tiny">' + esc(r.host) + " — <b>" + num(r.sessions) + "회</b></p>"; }).join("") : "")
      : A.emptyMsg("방문 기록이 쌓이면 보입니다.");
    var dv = v.devices || {}, dvT = (dv.mobile || 0) + (dv.desktop || 0) + (dv.tablet || 0);
    $("#kpi-devices").innerHTML = dvT ? '<div class="kpi-stack">' + [["mobile", "모바일", "#2a78d6"], ["desktop", "PC", "#eb6834"], ["tablet", "태블릿", "#1baf7a"]].filter(function (x) { return dv[x[0]]; }).map(function (x) {
      return '<span style="flex:' + dv[x[0]] + ";background:" + x[2] + '" data-tip="' + tip("dv:" + x[0], function () { return { title: x[1], rows: [{ value: num(dv[x[0]]) + "회", label: "방문" }, { value: pct(dv[x[0]] / dvT * 100, 0), label: "비중" }] }; }) + '"></span>';
    }).join("") + '</div><div class="kpi-legend">' + [["mobile", "모바일", "#2a78d6"], ["desktop", "PC", "#eb6834"], ["tablet", "태블릿", "#1baf7a"]].filter(function (x) { return dv[x[0]]; }).map(function (x) { return '<span><i style="background:' + x[2] + '"></i>' + x[1] + " " + pct(dv[x[0]] / dvT * 100, 0) + "</span>"; }).join("") + "</div>" : "";
    $("#kpi-clicks").innerHTML = v.clicks.total ? hbars(v.clicks.byKind.map(function (x) { return { label: x.label, value: x.clicks, text: num(x.clicks) + "회", sub: "방문 " + num(x.sessions) + "회에서" }; })) +
      (v.clicks.top.length ? '<table class="tbl kpi-t mt-s"><thead><tr><th>많이 누른 링크 · 버튼</th><th class="r">클릭</th></tr></thead><tbody>' + v.clicks.top.map(function (x) { return "<tr><td><b>" + esc(x.label || x.kindLabel) + "</b><small>" + esc(x.kindLabel + (x.target ? " · " + x.target : "")) + '</small></td><td class="r">' + num(x.clicks) + "</td></tr>"; }).join("") + "</tbody></table>" : "")
      : A.emptyMsg("링크 클릭 기록이 쌓이면 보입니다.");
    var f = v.funnel || {}, fmax = Math.max(1, f.sessions || 0);
    $("#kpi-funnel").innerHTML = hbars([
      { label: "홈페이지 방문", value: f.sessions, text: num(f.sessions) + "회", color: SEQ[7] },
      { label: "예약 페이지 방문", value: f.bookingSessions, text: num(f.bookingSessions) + "회", sub: f.sessions ? "방문의 " + pct(f.bookingSessions / f.sessions * 100) : "", color: SEQ[6] },
      { label: "예약 신청", value: f.requests, text: num(f.requests) + "건", sub: f.bookingSessions ? "예약 페이지 방문의 " + pct(f.requests / f.bookingSessions * 100) : "", color: SEQ[5] },
      { label: "결제 확정", value: f.confirmed, text: num(f.confirmed) + "건", sub: f.requests ? "신청의 " + pct(f.confirmed / f.requests * 100, 0) : "", color: SEQ[4] }
    ], { max: fmax }) + '<p class="tiny muted">같은 기간 카카오톡 문의 버튼을 누른 방문 ' + num(f.kakaoSessions) + "회 · 문의 폼 접수 " + num(f.inquiries) + "건" + (f.quotes === null || f.quotes === undefined ? "" : " · 견적서 발급 " + num(f.quotes) + "건") + "</p>";
  }
  function heat(m) {
    var el = $("#kpi-heat"); if (!el) return;
    var max = 0; m.forEach(function (r) { r.forEach(function (x) { if (x > max) max = x; }); });
    var days = ["월", "화", "수", "목", "금", "토", "일"], step = function (x) { if (!x) return SEQ[0]; var i = Math.min(SEQ.length - 1, 1 + Math.floor(x / Math.max(max, 1) * (SEQ.length - 1.01))); return SEQ[i]; };
    var h = '<div class="kpi-heat"><span></span>';
    for (var c = 0; c < 24; c++) h += '<span class="hh">' + (c % 3 === 0 ? c : "") + "</span>";
    m.forEach(function (row, w) {
      h += '<span class="hd">' + days[w] + "</span>";
      row.forEach(function (x, hr) { h += '<span class="hc" style="background:' + step(x) + '" data-tip="' + tip("ht:" + w + ":" + hr, function () { return { title: days[w] + "요일 " + pad(hr) + ":00–" + pad(hr + 1) + ":00", rows: [{ value: pct(x), label: "예약률 (1~5번룸 평균)" }] }; }) + '"></span>'; });
    });
    h += "</div>";
    el.innerHTML = h + '<div class="kpi-heat-key"><span>낮음</span>' + SEQ.slice(1).map(function (c) { return '<i style="background:' + c + '"></i>'; }).join("") + "<span>높음 (" + pct(max, 0) + ")</span></div>";
  }

  /* ---------- 불러오기 ---------- */
  function load() {
    var r = presetRange(state.preset); state.from = r[0]; state.to = r[1];
    $("#kpi-from").value = state.from; $("#kpi-to").value = state.to;
    Array.prototype.forEach.call(document.querySelectorAll("#kpi-presets [data-preset]"), function (b) { b.classList.toggle("on", b.dataset.preset === state.preset); });
    Array.prototype.forEach.call(document.querySelectorAll("#kpi-basis [data-basis]"), function (b) { b.classList.toggle("on", b.dataset.basis === state.basis); });
    var serial = ++state.loading;
    $("#kpi-body").setAttribute("aria-busy", "true"); $("#kpi-status").textContent = "KPI를 계산하고 있습니다…"; $("#kpi-status").hidden = false;
    return api("/api/admin/kpi?from=" + state.from + "&to=" + state.to + "&basis=" + state.basis).then(function (d) {
      if (serial !== state.loading) return;
      state.data = d; $("#kpi-status").hidden = true; $("#kpi-body").hidden = false; render();
    }).catch(function (e) {
      if (serial !== state.loading || A.guard(e)) return;
      $("#kpi-status").textContent = (e.data && e.data.message) || e.message;
    }).finally(function () { if (serial === state.loading) $("#kpi-body").setAttribute("aria-busy", "false"); });
  }
  function csv() {
    var d = state.data; if (!d) return;
    var cols = ["기간"].concat(d.rooms.map(function (r) { return r.name + " 매출"; }), ["그 외 매출", "예약률(%)"], d.rooms.map(function (r) { return r.name + " 예약률(%)"; }), ["이용인원(기록)", "이용인원(추정)", "예약 건수", "취소 건수", "취소율(%)", "방문자", "방문", "페이지 조회"]);
    var rows = d.buckets.map(function (k) {
      var s = d.sales.series[k], o = d.occupancy.series[k], p = d.people.series[k], c = d.cancel.series[k], v = d.visits.series[k];
      return [k].concat(d.rooms.map(function (r) { return s[r.key]; }), [s.space_other + s.orders + s.kiosk + s.office + s.terminal + s.payapp, o.rate.toFixed(2)], d.rooms.map(function (r) { return o.roomRate[r.key].toFixed(2); }),
        [p.recorded, p.estimated, p.bookings, c.cancelled, c.rate.toFixed(1), v.visitors, v.sessions, v.pageviews]);
    });
    A.csvDownload("socialfactory-kpi_" + d.period.from + "_" + d.period.to + "_" + d.period.basis + ".csv", cols, rows);
  }

  $("#kpi-presets").addEventListener("click", function (e) { var b = e.target.closest("[data-preset]"); if (!b) return; state.preset = b.dataset.preset; load(); });
  $("#kpi-basis").addEventListener("click", function (e) { var b = e.target.closest("[data-basis]"); if (!b) return; state.basis = b.dataset.basis; load(); });
  $("#kpi-apply").addEventListener("click", function () {
    var f = $("#kpi-from").value, t = $("#kpi-to").value;
    if (!f || !t) { A.toast("시작일과 종료일을 골라 주세요."); return; }
    if (f > t) { A.toast("시작일이 종료일보다 늦습니다."); return; }
    state.preset = "custom"; state.from = f; state.to = t; load();
  });
  $("#kpi-reload").addEventListener("click", load);
  $("#kpi-csv").addEventListener("click", csv);
  $("#view-kpi").addEventListener("click", function (e) { var t = e.target.closest("[data-kpi-go]"); if (!t) return; var s = $("#kpi-sec-" + t.dataset.kpiGo); if (s) s.scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("#view-kpi").addEventListener("keydown", function (e) { if (e.key === "Enter") { var t = e.target.closest("[data-kpi-go]"); if (t) t.click(); } });
  window.addEventListener("resize", function () { clearTimeout(resizeT); resizeT = setTimeout(function () { if (!$("#view-kpi").hidden && state.data) render(); }, 200); });

  A.LOAD.kpi = load;
})();
