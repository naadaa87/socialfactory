/* 소셜팩토리 건대 — 예상 금액 계산기 (이용 요금 페이지)
   요금 원본은 js/site-config.js 의 pricing 입니다. */
(function () {
  "use strict";
  var root = document.querySelector("[data-estimator]");
  if (!root) return;
  var CFG = window.SF_CONFIG || {};
  var PR = CFG.pricing || {};
  var ROOMS = PR.rooms || {};
  var HOL = {};
  (PR.holidays || []).forEach(function (d) { HOL[d] = true; });
  var $ = function (s, r) { return (r || root).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || root).querySelectorAll(s)); };
  var form = $(".est-form");
  var won = function (n) { return Math.round(n).toLocaleString("ko-KR") + "원"; };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var DOW = ["일", "월", "화", "수", "목", "금", "토"];
  var ROOM_NAME = { r1: "1번룸", r2: "2번룸", r3: "3번룸", r4: "4번룸", r5: "5번룸" };
  var LABEL = { wdEarly: "평일 오전·심야", wdStd: "평일 오후·저녁", hdEarly: "주말·공휴일 오전·심야", hdStd: "주말·공휴일 오후·저녁" };
  var mode = "room";
  var last = null;

  /* ---------- 날짜 도구 (기기 시간대 기준) ---------- */
  var iso = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  var parse = function (s) { var p = (s || "").split("-"); return p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : null; };
  var addDays = function (d, n) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
  var md = function (d) { return (d.getMonth() + 1) + "월 " + d.getDate() + "일(" + DOW[d.getDay()] + ")"; };
  var isHolidayBase = function (d) { return d.getDay() === 0 || d.getDay() === 6 || !!HOL[iso(d)]; };

  /* ---------- 룸 요금 계산 ----------
     07~24시는 그날 기준(07~12 오전, 12~24 오후·저녁), 0~7시는 전날 밤으로 봅니다.
     심야는 전날과 그날이 모두 주말·공휴일일 때만 주말 요금입니다. */
  var calcRoom = function (s) {
    var p = ROOMS[s.room];
    if (!p || !s.date) return null;
    var manual = s.holiday;          // 선택한 날짜를 공휴일로 볼지 (자동 표시 + 직접 체크)
    var startIso = iso(s.date);
    var isHol = function (d) { return (manual && iso(d) === startIso) || isHolidayBase(d); };
    var groups = [], total = 0;
    for (var i = 0; i < s.hours; i++) {
      var t = s.start + i;
      var day = addDays(s.date, Math.floor(t / 24));
      var h = t % 24, key;
      if (h >= 7) key = (isHol(day) ? "hd" : "wd") + (h < 12 ? "Early" : "Std");
      else key = (isHol(addDays(day, -1)) && isHol(day)) ? "hdEarly" : "wdEarly";
      var price = +p[key] || 0;
      total += price;
      var g = groups[groups.length - 1];
      if (g && g.key === key) { g.n++; g.to = t + 1; } else groups.push({ key: key, price: price, n: 1, from: t, to: t + 1 });
    }
    var end = s.start + s.hours;
    var endDay = addDays(s.date, Math.floor(end / 24));
    return { groups: groups, rent: total, max: +p.max || 0, endDay: endDay, endHour: end % 24 };
  };

  var options = function () {
    var list = [], sum = 0;
    (PR.options || []).forEach(function (o) {
      if (o.key === "laptop") {
        var q = Math.max(0, Math.min(10, parseInt(form.elements["opt-laptop"].value, 10) || 0));
        if (q) { var v = q * (o.price || 0); sum += v; list.push({ name: o.name + " " + q + o.unit, amount: v, text: won(v) }); }
      } else if (form.elements["opt-" + o.key] && form.elements["opt-" + o.key].checked) {
        list.push({ name: o.name, amount: 0, text: o.price === 0 ? "무료" : (o.note || "별도 안내") });
      }
    });
    return { list: list, sum: sum };
  };

  var refundRows = function (date) {
    var rows = [{ when: "예약 후 2시간 이내", rate: 100 }];
    (PR.refund || []).forEach(function (r) {
      if (r.minDays === undefined) return;
      var label;
      if (r.minDays >= 8) label = md(addDays(date, -8)) + "까지";
      else if (r.minDays === 0) label = md(addDays(date, -1)) + " ~ 이용 당일";
      else label = md(addDays(date, -(r.minDays + 1))) + " ~ " + md(addDays(date, -r.minDays));
      rows.push({ when: label + " (" + r.when.replace("이용일 ", "") + ")", rate: r.rate });
    });
    return rows;
  };

  /* ---------- 입력 읽기 ---------- */
  var readRoom = function () {
    var el = form.elements;
    var room = (form.querySelector("input[name=room]:checked") || {}).value || "";
    return {
      room: room, date: parse(el.date.value), start: parseInt(el.start.value, 10) || 0,
      hours: parseInt(el.hours.value, 10) || 1, holiday: el.holiday.checked,
      people: parseInt(el.people.value, 10) || 0, type: el.type.value
    };
  };

  /* ---------- 결과 그리기 ---------- */
  var info = $("[data-es-info]"), lines = $("[data-es-lines]"), totalEl = $("[data-es-total]"), sub = $("[data-es-sub]");
  var barTotal = $("[data-es-bar-total]"), refundWrap = $("[data-es-refund-wrap]"), refundList = $("[data-es-refund]");
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var dl = function (rows) { return rows.map(function (r) { return "<div><dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>"; }).join(""); };
  var li = function (rows) { return rows.map(function (r) { return "<li><span>" + esc(r[0]) + "</span><b>" + esc(r[1]) + "</b></li>"; }).join(""); };

  var render = function () {
    var r = null;
    if (mode === "room") r = renderRoom();
    else if (mode === "cowork") r = renderCowork();
    else r = renderOffice();
    last = r;
    info.innerHTML = r ? dl(r.info) : "";
    lines.innerHTML = r ? li(r.lines) : "";
    totalEl.textContent = r ? r.totalText : "—";
    if (barTotal) barTotal.textContent = r ? r.totalText : "—";
    sub.textContent = r ? (r.sub || "") : "룸과 날짜를 고르면 바로 계산됩니다.";
    if (refundWrap) {
      refundWrap.hidden = !(r && r.refund);
      if (r && r.refund) refundList.innerHTML = li(r.refund.map(function (x) { return [x.when, x.rate ? x.rate + "% 환불" : "환불 불가"]; }));
    }
    updateLinks();
  };

  var renderRoom = function () {
    var s = readRoom();
    var whenEl = $("[data-when]"), warn = $("[data-cap-warn]");
    var hol = form.elements.holiday;
    // 날짜가 바뀌면 공휴일 표시를 그 날짜 기준으로 다시 맞춘다 (등록된 공휴일은 자동 체크, 직접 체크한 값은 같은 날짜에서만 유지)
    if (s.date && hol.dataset.autoFor !== iso(s.date)) {
      hol.checked = !!HOL[iso(s.date)];
      hol.dataset.autoFor = iso(s.date);
      s = readRoom();
    }
    var c = calcRoom(s);
    if (!c) { if (whenEl) whenEl.textContent = s.date ? "" : "이용 날짜를 고르면 요일과 요금이 표시됩니다."; return null; }
    var tag = (s.date.getDay() === 0 || s.date.getDay() === 6) ? "주말" : (HOL[iso(s.date)] || s.holiday) ? "공휴일" : "평일";
    var endTxt = (iso(c.endDay) !== iso(s.date) ? md(c.endDay) + " " : "") + pad(c.endHour) + ":00";
    var whenTxt = md(s.date) + " " + pad(s.start) + ":00 ~ " + endTxt;
    if (whenEl) whenEl.textContent = whenTxt + " · " + s.hours + "시간 · " + tag + (HOL[iso(s.date)] ? " (공휴일)" : "");
    if (warn) {
      if (s.people && c.max && s.people > c.max) {
        var bigger = Object.keys(ROOMS).filter(function (k) { return (+ROOMS[k].max || 0) >= s.people; }).sort(function (a, b) { return ROOMS[a].max - ROOMS[b].max; })[0];
        warn.textContent = ROOM_NAME[s.room] + "은 최대 " + c.max + "명입니다. " + (bigger ? ROOM_NAME[bigger] + "(최대 " + ROOMS[bigger].max + "명)을 고르거나, " : "") + "여러 룸을 함께 쓰는 방법을 상담해 드립니다.";
        warn.hidden = false;
      } else warn.hidden = true;
    }
    var op = options();
    var total = c.rent + op.sum;
    var rows = c.groups.map(function (g) {
      return [LABEL[g.key] + " " + won(g.price) + " × " + g.n + "시간", won(g.price * g.n)];
    });
    op.list.forEach(function (o) { rows.push([o.name, o.text]); });
    var inf = [["공간", ROOM_NAME[s.room] + " (최대 " + c.max + "명)"], ["일시", whenTxt], ["이용 시간", s.hours + "시간"]];
    if (s.people) inf.push(["인원", s.people + "명"]);
    if (s.type) inf.push(["모임 유형", s.type]);
    var subTxt = "부가세 포함 · 인원 추가 요금 없음";
    if (s.people) subTxt += " · 1인당 약 " + won(Math.round(total / s.people / 10) * 10);
    return {
      kind: "room", space: s.room, title: ROOM_NAME[s.room] + " 대관", info: inf, lines: rows, total: total, totalText: won(total),
      sub: subTxt, refund: refundRows(s.date), when: whenTxt, people: s.people, type: s.type, vat: "부가세 포함"
    };
  };

  var renderCowork = function () {
    var el = form.elements;
    var passes = (PR.coworkingPasses || []);
    var p = passes[parseInt(el.pass.value, 10) || 0];
    if (!p) return null;
    var q = Math.max(1, Math.min(30, parseInt(el.passQty.value, 10) || 1));
    var rows = [[p.name + " " + won(p.price) + " × " + q, won(p.price * q)]];
    var total = p.price * q;
    var locker = passes.filter(function (x) { return x.name.indexOf("사물함") >= 0; })[0];
    if (el.locker.checked && locker) {
      var m = Math.max(1, Math.min(12, parseInt(el.lockerMonths.value, 10) || 1));
      rows.push([locker.name + " " + won(locker.price) + " × " + m + "개월", won(locker.price * m)]);
      total += locker.price * m;
    }
    return {
      kind: "cowork", space: "coworking", title: "24시 코워킹 이용권", info: [["공간", "24시 코워킹 · 스터디 공간 (" + ((CFG.rooms || {}).coworking || {}).seats + ")"], ["이용권", p.name + " × " + q]],
      lines: rows, total: total, totalText: won(total), sub: "부가세 포함 · 24시간 이용", refund: null, vat: "부가세 포함"
    };
  };

  var renderOffice = function () {
    var el = form.elements;
    var o = (PR.officeRooms || [])[parseInt(el.office.value, 10) || 0];
    if (!o) return null;
    var term = parseInt(el.term.value, 10) || 1;
    var rate = 0;
    (PR.officeDiscounts || []).forEach(function (d) { if (term === d.months) rate = d.rate; });
    var monthly = Math.round(o.monthly * (100 - rate) / 100);
    var supply = monthly * term, vat = Math.round(supply * 0.1);
    var rows = [["월 이용료 " + won(o.monthly) + (rate ? " → " + rate + "% 할인 " + won(monthly) : ""), won(monthly) + "/월"],
                ["공급가 (" + term + "개월)", won(supply)], ["부가세 10%", won(vat)]];
    return {
      kind: "office", space: "office", title: "독립사무실 " + o.name, info: [["호실", "독립사무실 " + o.name + " · " + o.people], ["계약 기간", term + "개월" + (rate ? " (" + rate + "% 할인)" : "")]],
      lines: rows, total: supply + vat, totalText: won(supply + vat), sub: "부가세 포함 합계 · 월 " + won(Math.round(monthly * 1.1)) + " (부가세 포함)", refund: null, vat: "부가세 별도 요금 · 합계는 부가세 포함"
    };
  };

  /* ---------- 문의로 넘기기 ---------- */
  var summaryText = function (r) {
    if (!r) return "";
    var t = ["[소셜팩토리 건대 예상 금액]", r.title];
    r.info.forEach(function (x) { t.push(x[0] + ": " + x[1]); });
    t.push("");
    r.lines.forEach(function (x) { t.push("- " + x[0] + ": " + x[1]); });
    t.push("합계: " + r.totalText + " (" + r.vat + ")");
    return t.join("\n");
  };
  var updateLinks = function () {
    var r = last;
    var a = $("[data-es-inquiry]"), mail = $("[data-es-mail]");
    var purpose = !r ? "rental" : r.kind === "room" ? "rental" : r.kind === "cowork" ? "coworking" : "office";
    var q = ["purpose=" + purpose];
    if (r) {
      if (r.space) q.push("space=" + encodeURIComponent(r.space));
      if (r.when) q.push("when=" + encodeURIComponent(r.when));
      if (r.people) q.push("people=" + encodeURIComponent(r.people + "명"));
      if (r.type) q.push("type=" + encodeURIComponent(r.type));
      q.push("msg=" + encodeURIComponent(summaryText(r)));
    }
    if (a) a.href = "/contact?" + q.join("&") + "#inquiry";
    var email = ((CFG.contact || {}).email) || "";
    if (mail) {
      mail.hidden = !email;
      mail.href = "mailto:" + email + "?subject=" + encodeURIComponent("[소셜팩토리 건대] " + (r ? r.title : "이용") + " 문의") + "&body=" + encodeURIComponent(summaryText(r) + "\n\n이름:\n연락처:\n");
    }
  };
  var toast = function (msg) {
    var t = $("[data-es-toast]"); if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 4000);
  };
  var copy = function (text, done) {
    var ok = function () { done(true); }, fail = function () {
      try {
        var ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); var r = document.execCommand("copy"); document.body.removeChild(ta); done(r);
      } catch (e) { done(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, fail); else fail();
  };
  // 카카오톡: 링크는 새 창으로 열리고, 누르는 순간 예상 금액 내용을 복사해 둔다
  var kakaoBtn = $("[data-es-kakao]");
  var kakaoUrl = ((CFG.contact || {}).kakao) || "";
  if (kakaoBtn) {
    kakaoBtn.hidden = !kakaoUrl;
    if (kakaoUrl) kakaoBtn.href = kakaoUrl;
    kakaoBtn.addEventListener("click", function () {
      copy(summaryText(last), function (ok) {
        toast(ok ? "예상 금액 내용을 복사했습니다. 카카오톡 채팅창에 붙여 넣어 보내 주세요." : "카카오톡 채널이 열립니다. 날짜·시간·인원·모임 유형을 적어 보내 주세요.");
      });
    });
  }
  var copyBtn = $("[data-es-copy]");
  if (copyBtn) copyBtn.addEventListener("click", function () {
    copy(summaryText(last), function (ok) { toast(ok ? "예상 금액 내용을 복사했습니다." : "복사하지 못했습니다. 화면의 내용을 직접 적어 주세요."); });
  });

  /* ---------- PDF 저장 · 인쇄 ---------- */
  var printSheet = function () {
    var r = last; if (!r) { toast("먼저 공간과 날짜를 골라 주세요."); return; }
    var sheet = document.getElementById("est-print");
    if (!sheet) { sheet = document.createElement("div"); sheet.id = "est-print"; document.body.appendChild(sheet); }
    var c = CFG.contact || {};
    var today = new Date();
    var refund = r.refund ? "<h3>취소 · 환불 (이 날짜 기준)</h3><table class='ep-t'>" + r.refund.map(function (x) { return "<tr><td>" + esc(x.when) + "</td><td class='n'>" + (x.rate ? x.rate + "% 환불" : "환불 불가") + "</td></tr>"; }).join("") + "</table>" : "";
    sheet.innerHTML =
      "<div class='ep'>" +
      "<header class='ep-h'><div><div class='ep-brand'>SOCIAL FACTORY</div><div class='ep-sub'>소셜팩토리 건대 · " + esc(CFG.address || "") + "</div></div>" +
      "<div class='ep-meta'><strong>예상 금액 안내</strong><span>" + today.getFullYear() + ". " + (today.getMonth() + 1) + ". " + today.getDate() + ". 발행</span></div></header>" +
      "<h2 class='ep-title'>" + esc(r.title) + "</h2>" +
      "<table class='ep-t'>" + r.info.map(function (x) { return "<tr><th>" + esc(x[0]) + "</th><td>" + esc(x[1]) + "</td></tr>"; }).join("") + "</table>" +
      "<h3>금액 구성</h3><table class='ep-t'>" + r.lines.map(function (x) { return "<tr><td>" + esc(x[0]) + "</td><td class='n'>" + esc(x[1]) + "</td></tr>"; }).join("") +
      "<tr class='ep-sum'><td>합계 (" + esc(r.vat) + ")</td><td class='n'>" + esc(r.totalText) + "</td></tr></table>" +
      (r.sub ? "<p class='ep-note'>" + esc(r.sub) + "</p>" : "") + refund +
      "<p class='ep-note'>예상 금액입니다. 예약 가능 여부와 최종 금액은 상담 후 확정해 안내해 드립니다.</p>" +
      "<footer class='ep-f'><div><strong>일자 · 시간 · 인원 · 모임 유형을 알려 주시면 빠르게 안내해 드립니다.</strong>" +
      (c.kakao ? "<span>카카오톡 문의채널 " + esc(c.kakao.replace(/^https?:\/\//, "")) + "</span>" : "") +
      (c.email ? "<span>이메일 " + esc(c.email) + "</span>" : "") +
      "<span>홈페이지 문의 " + esc((CFG.siteUrl || "").replace(/^https?:\/\//, "")) + "/contact</span></div>" +
      (c.kakao ? "<img src='images/kakao-qr.svg' alt='카카오톡 문의채널 QR' width='84' height='84'>" : "") + "</footer></div>";
    // 이 클래스는 인쇄 화면에서만 효과가 있다 (화면 표시는 그대로). 인쇄 창이 닫히면 지운다.
    document.documentElement.classList.add("is-printing-est");
    var done = function () { document.documentElement.classList.remove("is-printing-est"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    var img = sheet.querySelector("img"), started = false;
    var go = function () { if (started) return; started = true; window.print(); };
    if (img && !img.complete) { img.onload = img.onerror = go; setTimeout(go, 800); } else go();
  };
  // 계산 내용을 바꾸면 다음 인쇄(Ctrl+P)는 다시 페이지 전체가 되도록
  form.addEventListener("input", function () { document.documentElement.classList.remove("is-printing-est"); });
  var pBtn = $("[data-es-print]"); if (pBtn) pBtn.addEventListener("click", printSheet);

  /* ---------- 탭 · 입력 이벤트 ---------- */
  var tabs = $$("[role=tab]");
  var setMode = function (m, focus) {
    mode = m;
    tabs.forEach(function (t) {
      var on = t.getAttribute("data-mode") === m;
      t.setAttribute("aria-selected", on ? "true" : "false"); t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    $$("[data-panel]").forEach(function (p) { p.hidden = p.getAttribute("data-panel") !== m; });
    render();
  };
  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { setMode(t.getAttribute("data-mode")); });
    t.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      var n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      setMode(n.getAttribute("data-mode"), true);
    });
  });
  $$("[data-stepper]").forEach(function (st) {
    var input = st.querySelector("input");
    $$("[data-step]", st).forEach(function (b) {
      b.addEventListener("click", function () {
        var v = (parseInt(input.value, 10) || 0) + parseInt(b.getAttribute("data-step"), 10);
        input.value = Math.max(+input.min || 0, Math.min(+input.max || 99, v)); render();
      });
    });
  });
  form.addEventListener("input", render);
  form.addEventListener("change", function (e) {
    if (e.target && e.target.name === "date") form.elements.holiday.dataset.autoFor = "";
    render();
  });

  /* ---------- 처음 값 (주소의 ?room=r2 · 오늘 날짜) ---------- */
  var today = new Date();
  form.elements.date.min = iso(today);
  form.elements.date.value = iso(addDays(today, 1));
  var params = {};
  location.search.replace(/^\?/, "").split("&").forEach(function (kv) { if (kv) { var p = kv.split("="); params[p[0]] = decodeURIComponent(p[1] || ""); } });
  if (params.room && ROOMS[params.room]) {
    var radio = form.querySelector("input[name=room][value=" + params.room + "]"); if (radio) radio.checked = true;
  }
  if (params.mode === "cowork" || params.mode === "office") setMode(params.mode); else render();
  if (params.room && location.hash === "#estimate") {
    setTimeout(function () { var t = document.getElementById("estimate"); if (t) t.scrollIntoView(); }, 50);
  }

  /* 모바일: 합계 막대는 계산 영역이 보일 때만 */
  var bar = $("[data-es-bar]"), sum = document.getElementById("est-summary");
  if (bar && "IntersectionObserver" in window) {
    var formVisible = false, sumVisible = false;
    var sync = function () { bar.classList.toggle("is-on", formVisible && !sumVisible); };
    new IntersectionObserver(function (es) { es.forEach(function (e) { formVisible = e.isIntersecting; }); sync(); }, { threshold: 0 }).observe(form);
    new IntersectionObserver(function (es) { es.forEach(function (e) { sumVisible = e.isIntersecting; }); sync(); }, { threshold: 0.15 }).observe(sum);
  }
  window.SF_ESTIMATE = { calcRoom: calcRoom, parse: parse, render: render };
})();
