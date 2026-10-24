/* 소셜팩토리 관리자 화면 — 로그인 · 대시보드 · 예약 현황 · 일자별 예약 · 예약 등록 · 매출 · 문의 · 주문 · 회원 · 상품 · 설정
   요금 · 공휴일 · 연락처는 js/site-config.js 를 그대로 씁니다. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var CFG = window.SF_CONFIG || {}, PR = CFG.pricing || {}, ROOMS = PR.rooms || {}, CT = CFG.contact || {};
  var HOL = {}; (PR.holidays || []).forEach(function (d) { HOL[d] = true; });
  var num = function (n) { return Math.round(Number(n || 0)).toLocaleString("ko-KR"); };
  var won = function (n) { return num(n) + "원"; };
  var manwon = function (n) { n = Number(n || 0); if (Math.abs(n) >= 1e8) return (Math.round(n / 1e7) / 10) + "억"; if (Math.abs(n) >= 1e4) return num(Math.round(n / 1e4)) + "만"; return num(n); };
  try { sessionStorage.removeItem("sf_admin_key"); } catch (e) { /* 예전 방식 키 정리 */ }

  /* ---------- 값 목록 ---------- */
  var PAY = [
    ["bank_blank", "계좌이체(블랭크)", "블랭크 계좌로 입금"],
    ["bank_other", "계좌이체(별도)", "블랭크 외 다른 계좌로 입금"],
    ["spacecloud", "스페이스클라우드", "스페이스클라우드에서 결제"],
    ["card_offline", "카드결제(오프라인)", "현장 단말기 · 수기 결제"],
    ["card_online", "카드결제(온라인)", "결제 링크 등 온라인 카드 결제"]
  ];
  var PAYL = { orders: "이용권 온라인 결제" }; PAY.forEach(function (p) { PAYL[p[0]] = p[1]; });
  var PST = { paid: ["결제 완료", "ok"], unpaid: ["결제 전", "warn"], refunded: ["환불", "gray"] };
  var SPACE_LIST = [["r1", "1번룸"], ["r2", "2번룸"], ["r3", "3번룸"], ["r4", "4번룸"], ["r5", "5번룸"], ["coworking", "코워킹 라운지"], ["office", "독립사무실"], ["other", "기타"]];
  var SPL = {}; SPACE_LIST.forEach(function (s) { SPL[s[0]] = s[1]; });
  var ROOM_KEYS = ["r1", "r2", "r3", "r4", "r5"];
  var CHANNELS = [["kakao", "카카오톡"], ["phone", "전화"], ["web", "홈페이지 문의"], ["spacecloud", "스페이스클라우드"], ["naver", "네이버"], ["visit", "방문"], ["other", "기타"]];
  var CHL = {}; CHANNELS.forEach(function (c) { CHL[c[0]] = c[1]; });
  var PURPOSES = ["강의 · 세미나", "스터디", "회의", "워크숍 · 교육", "모임 · 네트워킹", "촬영", "면접 · 시험", "정기대관", "기타"];
  var DOW = ["일", "월", "화", "수", "목", "금", "토"];
  var BAND = { wdEarly: "평일 오전 · 심야", wdStd: "평일 오후 · 저녁", hdEarly: "주말 · 공휴일 오전 · 심야", hdStd: "주말 · 공휴일 오후 · 저녁" };

  /* ---------- 날짜 · 시각 (한국 시간) ---------- */
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var isoOf = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  var parseIso = function (s) { var p = String(s || "").split("-"); return new Date(+p[0], +p[1] - 1, +p[2], 12); };
  var addDays = function (s, n) { var d = parseIso(s); d.setDate(d.getDate() + n); return isoOf(d); };
  var diffDays = function (a, b) { return Math.round((parseIso(b) - parseIso(a)) / 864e5); };
  var kstNow = function () { return new Date(Date.now() + (new Date().getTimezoneOffset() + 540) * 6e4); };
  var todayIso = function () { return isoOf(kstNow()); };
  var nowMin = function () { var d = kstNow(); return d.getHours() * 60 + d.getMinutes(); };
  var dow = function (s) { return parseIso(s).getDay(); };
  var isOff = function (s) { var w = dow(s); return w === 0 || w === 6 || !!HOL[s]; };
  var kdate = function (s) { return s ? (+s.slice(5, 7)) + "월 " + (+s.slice(8, 10)) + "일(" + DOW[dow(s)] + ")" : ""; };
  var kdateY = function (s) { return s ? s.slice(0, 4) + "년 " + kdate(s) : ""; };
  var hm = function (min) { if (min === 1440) return "24:00"; var d = Math.floor(min / 1440), m = ((min % 1440) + 1440) % 1440; return (d > 0 ? "익일 " : "") + pad(Math.floor(m / 60)) + ":" + pad(m % 60); };
  var dur = function (mins) { var h = Math.floor(mins / 60), m = mins % 60; return (h ? h + "시간" : "") + (m ? (h ? " " : "") + m + "분" : "") || "0분"; };
  var timeText = function (r) { return hm(r.start_min) + " – " + hm(r.end_min); };
  var ago = function (ts) { var t = Date.parse(String(ts || "").replace(" ", "T") + "+09:00"); if (!t) return ""; var h = Math.floor((Date.now() - t) / 36e5); if (h < 1) return "방금"; if (h < 24) return h + "시간 전"; return Math.floor(h / 24) + "일 전"; };
  /** 예약이 지금 기준으로 끝났는지 · 진행 중인지 */
  function phase(r) {
    var off = diffDays(todayIso(), r.date) * 1440, n = nowMin();
    if (off + r.end_min <= n) return "done";
    if (off + r.start_min <= n) return "now";
    return "soon";
  }

  /* ---------- 요금표 계산 (30분 단위) ----------
     07~24시는 그날 기준(07~12 오전, 12~24 오후 · 저녁), 0~7시는 전날 밤으로 봅니다.
     심야는 전날과 그날이 모두 주말 · 공휴일일 때만 주말 요금입니다. 30분은 시간 요금의 절반입니다. */
  function calcPrice(space, date, s, e) {
    var p = ROOMS[space]; if (!p || !date || !(e > s)) return null;
    var groups = [], total = 0;
    for (var t = s; t < e; t += 30) {
      var day = addDays(date, Math.floor(t / 1440)), h = Math.floor((t % 1440) / 60), key;
      if (h >= 7) key = (isOff(day) ? "hd" : "wd") + (h < 12 ? "Early" : "Std");
      else key = (isOff(addDays(day, -1)) && isOff(day)) ? "hdEarly" : "wdEarly";
      var rate = +p[key] || 0; total += rate / 2;
      var g = groups[groups.length - 1];
      if (g && g.key === key && g.to === t) { g.n++; g.to = t + 30; } else groups.push({ key: key, rate: rate, n: 1, from: t, to: t + 30 });
    }
    return { total: Math.round(total), groups: groups, max: +p.max || 0 };
  }

  /* ---------- 서버 ---------- */
  function errText(j, st) {
    if (j && j.message) return j.message;
    var c = j && (j.code || j.error);
    if (c === "NO_DB" || c === "no-db") return "데이터베이스(D1)가 연결되어 있지 않습니다.";
    if (c === "no-table") return "필요한 표가 아직 없습니다. 설정 상태 화면을 확인해 주세요.";
    if (c === "not-found") return "찾을 수 없습니다. 이미 지워졌을 수 있습니다.";
    if (st === 401) return "로그인이 필요합니다.";
    if (st === 403) return "허용되지 않은 요청입니다.";
    return "처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.";
  }
  function api(path, opt) {
    opt = opt || {};
    var init = { method: opt.method || "GET", credentials: "same-origin", headers: {} };
    if (opt.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opt.body); }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok && j.ok !== false) return j;
        var e = new Error(errText(j, r.status)); e.status = r.status; e.code = (j && (j.code || j.error)) || ""; e.data = j || {}; throw e;
      });
    }, function () { var e = new Error("서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요."); e.code = "NETWORK"; throw e; });
  }
  var toastT;
  function toast(msg) { var t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 3400); }
  function note(el, msg, ok) { el.innerHTML = msg; el.hidden = false; el.classList.toggle("ok", !!ok); }
  function guard(e) { if (e && e.status === 401) { showLogin("로그인이 만료되었습니다. 다시 로그인해 주세요.", true); return true; } return false; }
  function fail(box) { return function (e) { if (guard(e)) return; box.innerHTML = '<div class="empty">' + esc(e.message || "불러오지 못했습니다.") + "</div>"; }; }
  var emptyMsg = function (t) { return '<div class="empty">' + esc(t) + "</div>"; };
  function csvDownload(name, cols, rows) {
    var line = function (r) { return r.map(function (v) { v = String(v == null ? "" : v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(","); };
    var blob = new Blob(["﻿" + [line(cols)].concat(rows.map(line)).join("\r\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  function copyText(t) {
    return (navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(t) : Promise.reject()).catch(function () {
      var ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; } ta.remove(); if (!ok) throw new Error("copy");
    });
  }
  // 휴대폰 번호: 숫자만 입력해도 하이픈을 넣습니다 (010-1234-5678 · 02-123-4567)
  function fmtPhone(v) {
    var x = String(v || "").replace(/[^0-9]/g, "").slice(0, 11);
    if (/^02/.test(x)) { x = x.slice(0, 10); return x.length < 3 ? x : x.length < 6 ? x.slice(0, 2) + "-" + x.slice(2) : x.length < 10 ? x.slice(0, 2) + "-" + x.slice(2, 5) + "-" + x.slice(5) : x.slice(0, 2) + "-" + x.slice(2, 6) + "-" + x.slice(6); }
    return x.length < 4 ? x : x.length < 7 ? x.slice(0, 3) + "-" + x.slice(3) : x.length < 11 ? x.slice(0, 3) + "-" + x.slice(3, 6) + "-" + x.slice(6) : x.slice(0, 3) + "-" + x.slice(3, 7) + "-" + x.slice(7);
  }
  document.addEventListener("input", function (e) { var el = e.target; if (el && el.tagName === "INPUT" && el.type === "tel") { var v = fmtPhone(el.value); if (v !== el.value) el.value = v; } });

  /* ---------- 공통 표시 ---------- */
  var spaceName = function (r) { return r.space === "other" && r.space_note ? r.space_note : (SPL[r.space] || r.space) + (r.space !== "other" && r.space_note ? " · " + r.space_note : ""); };
  var pmTag = function (k) { return '<span class="pm" style="--pm:var(--m-' + esc(k) + ')">' + esc(PAYL[k] || k || "—") + "</span>"; };
  function pstTag(r) { if (r.external) return '<span class="st sc-tag">금액 미제공</span>'; var p = PST[r.pay_status] || [r.pay_status, ""]; var t = r.pay_status === "refunded" && r.refund_amount < r.amount ? "부분 환불" : p[0]; return '<span class="st ' + p[1] + '">' + esc(t) + "</span>"; }
  function resStTag(r) {
    if (r.external) return '<span class="st sc-tag">외부 일정</span>';
    if (r.status === "cancelled") return '<span class="st bad">취소</span>';
    var ph = phase(r); return ph === "done" ? '<span class="st gray">이용 완료</span>' : ph === "now" ? '<span class="st blue">이용 중</span>' : '<span class="st blue">예약 확정</span>';
  }
  var net = function (r) { if (r.external) return 0; return r.pay_status === "unpaid" ? 0 : Math.max(0, (r.amount || 0) - (r.refund_amount || 0)); };
  var RES = {};   // 예약번호 → 예약 (화면에 불러온 것)
  function remember(list) { (list || []).forEach(function (r) { RES[r.code] = r; }); return list || []; }
  function resRow(r, o) {
    o = o || {};
    var t = o.withDate ? kdate(r.date) + "<small>" + esc(timeText(r)) + "</small>" : esc(hm(r.start_min)) + "<small>~ " + esc(hm(r.end_min)) + "</small>";
    if (o.day && r.date !== o.day) t = "전날부터<small>~ " + esc(hm(r.end_min - 1440)) + "</small>";
    var sub = [r.people ? r.people + "명" : "", r.purpose, r.phone].filter(Boolean).map(esc).join(" · ");
    var btn = o.payBtn && r.pay_status === "unpaid" && r.status === "confirmed" ? '<button class="btn btn-ok btn-xs" type="button" data-pay-now="' + esc(r.code) + '">결제 확인</button>' : "";
    return '<div class="rrow' + (r.status === "cancelled" ? " cancelled" : "") + '" data-code="' + esc(r.code) + '" tabindex="0">'
      + '<div class="t">' + t + "</div>"
      + '<div class="w"><span class="room-tag">' + esc(spaceName(r)) + "</span><b>" + esc(r.customer_name) + "</b>" + (sub ? '<span class="sub">' + sub + "</span>" : "") + "</div>"
      + '<div class="a"><b>' + (r.external ? '금액 미제공' : won(r.amount)) + "</b><span>" + pmTag(r.pay_method) + " " + pstTag(r) + "</span>" + btn + "</div></div>";
  }

  /* =================== 로그인 =================== */
  var loginBox = $("#login"), app = $("#app");
  function loginErr(e) {
    if (e.code === "NO_DB") return "데이터베이스가 연결되지 않았습니다. Cloudflare Pages 프로젝트 <b>Settings → Bindings</b> 에 D1 데이터베이스를 <code>DB</code> 이름으로 연결하고 다시 배포해 주세요.";
    if (e.code === "NO_ADMIN_KEY") return "Cloudflare에 관리자 비밀번호가 아직 없습니다. Pages 프로젝트 <b>Settings → Variables and Secrets → Add</b> 에서 이름 <code>ADMIN_KEY</code>, 종류 <b>Secret</b> 으로 저장하고 <b>다시 배포</b>해 주세요.";
    if (e.code === "RATE_LIMIT") return "로그인 시도가 너무 많습니다. 15분 뒤에 다시 시도해 주세요.";
    if (e.code === "UNAUTHORIZED") return "관리자 비밀번호가 맞지 않습니다.";
    return esc(e.message || "로그인하지 못했습니다.");
  }
  function showApp() { loginBox.hidden = true; app.hidden = false; go(viewFromHash()); refreshCounts(); }
  function showLogin(msg, info) {
    closeAll(); app.hidden = true; loginBox.hidden = false;
    var m = $("#login-msg"); if (msg) { m.innerHTML = msg; m.hidden = false; m.classList.toggle("info", !!info); } else m.hidden = true;
    setTimeout(function () { $("#login-key").focus(); }, 50);
  }
  $("#login-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var k = $("#login-key").value.trim(), m = $("#login-msg"); m.hidden = true;
    if (!k) { m.textContent = "관리자 비밀번호를 입력해 주세요."; m.classList.remove("info"); m.hidden = false; return; }
    var b = $("#login-btn"); b.disabled = true; b.textContent = "확인 중…";
    api("/api/admin/login", { method: "POST", body: { key: k, remember: $("#login-remember").checked } })
      .then(function () { $("#login-key").value = ""; showApp(); })
      .catch(function (e) { m.innerHTML = loginErr(e); m.classList.remove("info"); m.hidden = false; })
      .then(function () { b.disabled = false; b.textContent = "로그인"; });
  });
  $("#logout").addEventListener("click", function () {
    api("/api/admin/logout", { method: "POST", body: {} }).catch(function () {}).then(function () { history.replaceState(null, "", location.pathname); showLogin("로그아웃했습니다.", true); });
  });

  /* =================== 화면 전환 =================== */
  var LOAD = {}, CUR = "dash";
  function viewFromHash() { var v = location.hash.replace("#", ""); return LOAD[v] ? v : "dash"; }
  function go(v) {
    if (!LOAD[v]) v = "dash";
    CUR = v;
    $$(".view").forEach(function (s) { s.hidden = s.id !== "view-" + v; });
    $$("#nav [data-view]").forEach(function (b) { b.classList.toggle("on", b.dataset.view === v); });
    if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
    window.scrollTo(0, 0); LOAD[v]();
  }
  function reloadCurrent() { if (!app.hidden && LOAD[CUR]) LOAD[CUR](); refreshCounts(); }
  $("#nav").addEventListener("click", function (e) { var b = e.target.closest("button[data-view]"); if (b) go(b.dataset.view); });
  window.addEventListener("hashchange", function () { if (!app.hidden) { var v = viewFromHash(); if (v !== CUR) go(v); } });
  function setCount(k, n, warn) { var el = $('[data-count="' + k + '"]'); if (!el) return; el.textContent = n || ""; el.hidden = !n; el.classList.toggle("warn", !!warn); }
  var countT;
  function refreshCounts() {
    clearTimeout(countT);
    countT = setTimeout(function () { api("/api/admin/dashboard").then(function (d) { applyCounts(d.counts || {}); }).catch(function () {}); }, 150);
  }
  function applyCounts(c) { setCount("unpaid", c.unpaid, true); setCount("inq", c.newInquiries); setCount("ord", c.refundRequests, true); }

  /* ---------- 패널 공통 ---------- */
  function openDrawer(id) { $(id).hidden = false; document.body.classList.add("lock"); }
  function closeDrawer(d) { d.hidden = true; if (!$$(".drawer").some(function (x) { return !x.hidden; })) document.body.classList.remove("lock"); }
  function closeAll() { $$(".drawer").forEach(function (d) { d.hidden = true; }); document.body.classList.remove("lock"); }
  $$(".drawer").forEach(function (d) { d.addEventListener("click", function (e) { if (e.target.closest("[data-close]")) closeDrawer(d); }); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { var open = $$(".drawer").filter(function (x) { return !x.hidden; }); if (open.length) closeDrawer(open[open.length - 1]); }
    if (e.key === "Enter" && e.target.closest && e.target.closest(".rrow[data-code]") && !e.target.closest("button")) openDetail(e.target.closest(".rrow").dataset.code);
  });
  document.addEventListener("click", function (e) {
    var g = e.target.closest("[data-go]"); if (g) { e.preventDefault(); go(g.dataset.go); return; }
    var n = e.target.closest("[data-new-res]"); if (n) { openForm({}); return; }
    var p = e.target.closest("[data-pay-now]"); if (p) { e.stopPropagation(); payNow(p.dataset.payNow, p); return; }
    var r = e.target.closest("[data-code]"); if (r && !e.target.closest("a, button, input, select, textarea, .blk")) { openDetail(r.dataset.code); }
  });

  /* ---------- 채널 바로가기 ---------- */
  var kakaoChat = CT.kakao ? String(CT.kakao).replace(/\/+$/, "").replace(/\/chat$/, "") + "/chat" : "";
  var LINKS = [
    { id: "kakao", name: "카카오톡 채널", mark: "K", sub: "대부분의 문의 · 예약 상담", links: [{ k: "관리자센터", s: "관리자", url: "https://business.kakao.com/" }, kakaoChat && { k: "고객 채팅방", s: "고객", url: kakaoChat }] },
    { id: "spacecloud", name: "스페이스클라우드", mark: "S", sub: "외부 예약 채널", links: [{ k: "호스트센터", s: "관리자", url: "https://partner.spacecloud.kr/manage/space" }, CT.spacecloud && { k: "공간 페이지", s: "고객", url: CT.spacecloud }] },
    CT.naver && { id: "naver", name: "네이버 예약", mark: "N", links: [{ k: "예약 페이지", s: "고객", url: CT.naver }] },
    { id: "gmail", name: "이메일", mark: "M", sub: CT.email || "", links: [{ k: "받은편지함", s: "메일함", url: "https://mail.google.com/mail/u/0/" }] },
    { id: "inicis", name: "KG이니시스", mark: "I", sub: "온라인 결제 취소 · 정산", links: [{ k: "가맹점관리자", s: "관리자", url: "https://iniweb.inicis.com/" }] },
    { id: "cloudflare", name: "Cloudflare", mark: "C", sub: "배포 · D1 · 설정값", links: [{ k: "대시보드", s: "관리자", url: "https://dash.cloudflare.com/" }] }
  ].filter(Boolean);
  (function drawLinks() {
    var cards = LINKS.map(function (g) {
      var ls = g.links.filter(Boolean);
      return '<div class="ch-link ' + g.id + '"><span class="ch-mark" aria-hidden="true">' + esc(g.mark) + "</span><div><b>" + esc(g.name) + "</b>" + (g.sub ? "<small>" + esc(g.sub) + "</small>" : "")
        + '<div class="ch-btns">' + ls.map(function (l) { return '<a class="btn btn-light btn-xs" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.k) + " ↗</a>"; }).join("") + "</div></div></div>";
    });
    $("#dash-links").innerHTML = cards.join("");
    $("#side-links").innerHTML = '<div class="side-cap">채널 바로가기</div>' + LINKS.map(function (g) { return g.links.filter(Boolean).map(function (l) { return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener"><span>' + esc(g.name) + "</span><small>" + esc(l.s) + " ↗</small></a>"; }).join(""); }).join("");
  })();

  /* =================== 대시보드 =================== */
  var INQP = { rental: "공간 대관", regular: "정기대관", business: "기업·단체·학교", coworking: "코워킹", office: "독립사무실", partner: "호스트·제휴·협업", proposal: "공간 활용 상담", other: "기타" };
  var INQS = { r1: "1번룸", r2: "2번룸", r3: "3번룸", r4: "4번룸", r5: "5번룸", coworking: "코워킹", office: "독립사무실", undecided: "미정", "": "-" };
  function loadDash() {
    $("#dash-date").textContent = kdateY(todayIso()) + " 기준";
    api("/api/admin/dashboard").then(function (d) {
      renderSpacecloudStatus(d.spacecloud);
      var c = d.counts || {}, mo = d.month || {};
      applyCounts(c);
      remember(d.todayList); remember(d.tomorrowList); remember(d.upcoming); remember(d.unpaid);
      $("#dash-kpis").innerHTML =
        '<button type="button" class="kpi' + (c.today ? " hot" : "") + '" data-go="board"><small>오늘 예약</small><b>' + num(c.today) + "<em>건</em></b></button>"
        + '<button type="button" class="kpi" data-go="board" data-board-date="' + esc(d.tomorrow) + '"><small>내일 예약</small><b>' + num(c.tomorrow) + "<em>건</em></b></button>"
        + '<button type="button" class="kpi' + (c.unpaid ? " warn" : "") + '" data-go-unpaid><small>결제 확인 필요</small><b>' + num(c.unpaid) + "<em>건</em></b><span>" + (c.unpaid ? won(c.unpaidAmount) + " 입금 대기" : "모두 결제 완료") + "</span></button>"
        + '<button type="button" class="kpi' + (c.newInquiries ? " hot" : "") + '" data-go="inq"><small>답하지 않은 문의</small><b>' + num(c.newInquiries) + "<em>건</em></b></button>"
        + '<button type="button" class="kpi accent" data-go="sales"><small>이번 달 매출</small><b>' + num(mo.total) + "<em>원</em></b><span>예약 " + num(mo.reservationsN) + "건 · 이용권 " + num(mo.ordersN) + "건</span></button>"
        + '<button type="button" class="kpi' + (c.refundRequests ? " warn" : "") + '" data-go="ord"><small>이용권 환불 요청</small><b>' + num(c.refundRequests) + "<em>건</em></b></button>";
      var today = d.today;
      $("#dash-today").innerHTML = (d.todayList || []).length ? d.todayList.map(function (r) { return resRow(r, { day: today, payBtn: true }); }).join("") : emptyMsg("오늘 잡힌 예약이 없습니다.");
      $("#dash-tomorrow").innerHTML = (d.tomorrowList || []).length ? d.tomorrowList.map(function (r) { return resRow(r, { payBtn: true }); }).join("") : emptyMsg("내일 잡힌 예약이 없습니다.");
      $("#dash-unpaid").innerHTML = (d.unpaid || []).length ? d.unpaid.map(function (r) { return resRow(r, { withDate: true, payBtn: true }); }).join("") : emptyMsg("결제를 기다리는 예약이 없습니다.");
      $("#dash-upcoming").innerHTML = (d.upcoming || []).length ? d.upcoming.map(function (r) { return resRow(r, { withDate: true }); }).join("") : emptyMsg("모레부터 7일 안에 잡힌 예약이 없습니다.");
      $("#dash-inq").innerHTML = (d.newInquiries || []).length ? d.newInquiries.slice(0, 6).map(function (q) {
        var late = (Date.now() - Date.parse(String(q.created_at).replace(" ", "T") + "+09:00")) > 864e5;
        INQ_CACHE[q.id] = q;
        return '<div class="irow"><div><b>' + esc(q.name) + "</b> <small class=\"muted\">" + esc(INQP[q.purpose] || q.purpose) + " · " + esc(INQS[q.space] || q.space || "-") + '</small><span class="sub">' + esc([q.when_text, q.people, q.phone].filter(Boolean).join(" · ")) + '</span><span class="sub ' + (late ? "late" : "") + '">' + esc(q.receipt) + " · " + esc(ago(q.created_at)) + '</span></div><div><button class="btn btn-light btn-xs" type="button" data-inq-res="' + q.id + '">예약 등록</button></div></div>';
      }).join("") + (c.newInquiries > 6 ? '<div class="irow"><span class="small muted">외 ' + (c.newInquiries - 6) + '건 더 있습니다.</span><button class="btn btn-light btn-xs" type="button" data-go="inq">모두 보기</button></div>' : "") : emptyMsg("새로 들어온 문의가 없습니다.");
      var tot = mo.total || 0, parts = PAY.map(function (p) { return [p[0], (mo.byMethod || {})[p[0]] || 0]; }).concat([["orders", mo.orders || 0]]);
      $("#dash-month").innerHTML = '<div class="mrow"><div class="mtotal"><small>' + esc(+String(mo.ym).slice(5, 7)) + "월 매출 합계</small><b>" + won(tot) + "</b><span>예약 " + num(mo.reservationsN) + "건 " + won(mo.reservations) + " · 이용권 " + num(mo.ordersN) + "건 " + won(mo.orders) + "</span><span>이번 달 예약 " + num(mo.booked) + "건 · 이용 " + esc(dur(mo.bookedMinutes || 0)) + "</span></div>"
        + '<div><div class="stack">' + (tot ? parts.filter(function (x) { return x[1] > 0; }).map(function (x) { return '<i style="--c:var(--m-' + x[0] + ');width:' + (x[1] / tot * 100).toFixed(2) + '%" title="' + esc(PAYL[x[0]]) + " " + won(x[1]) + '"></i>'; }).join("") : "") + "</div>"
        + '<div class="mlegend small">' + parts.map(function (x) { return '<span style="--c:var(--m-' + x[0] + ')">' + esc(PAYL[x[0]]) + " <b>" + won(x[1]) + "</b></span>"; }).join("") + "</div></div></div>";
      if (mo.byChannel) $("#dash-month").innerHTML += '<details class="mt-s"><summary>채널별 매출 상세보기</summary><div class="bars">' + bars(Object.keys(mo.byChannel).map(function (key) {
        var x = mo.byChannel[key]; return { k: key === "web" ? "홈페이지" : (CHL[key] || "경로 미기록"), v: x.amount, s: num(x.n) + "건" };
      }).sort(function (a,b) { return b.v-a.v; }), tot) + '</div><p class="tiny muted">스페이스클라우드 등 외부 일정은 실제 결제금액을 등록한 건만 합산합니다.</p></details>';
      var OST = { pending: ["결제 대기", ""], paid: ["결제 완료", "ok"], used: ["이용 완료", "blue"], cancelled: ["취소", "gray"], refund_requested: ["환불 요청", "warn"], refunded: ["환불 완료", "gray"], failed: ["결제 실패", "bad"] };
      $("#dash-orders").innerHTML = (d.ordersRecent || []).length ? d.ordersRecent.map(function (o) {
        var s = OST[o.status] || [o.status, ""];
        return '<div class="irow"><div><b>' + esc(o.buyer_name) + "</b> <small class=\"muted\">" + esc(o.product_name) + '</small><span class="sub mono">' + esc(o.oid) + " · " + esc(String(o.paid_at || o.created_at || "").slice(5, 16)) + '</span></div><div class="r"><b>' + won(o.amount) + '</b><br><span class="st ' + s[1] + '">' + esc(s[0]) + "</span>" + (o.test_mode ? ' <span class="st test">테스트</span>' : "") + "</div></div>";
      }).join("") : emptyMsg("아직 온라인 결제가 없습니다.");
    }).catch(fail($("#dash-today")));
  }
  $("#dash-reload").addEventListener("click", loadDash);
  document.addEventListener("click", function (e) {
    var u = e.target.closest("[data-go-unpaid]"); if (u) { LS.range = "all"; setRange("all"); $("#ls-pstatus").value = "unpaid"; $("#ls-status").value = "active"; go("list"); return; }
    var bd = e.target.closest("[data-board-date]"); if (bd) { BD.date = bd.dataset.boardDate; BD.mode = "day"; }
    var iq = e.target.closest("[data-inq-res]"); if (iq) { var q = INQ_CACHE[iq.dataset.inqRes]; if (q) openForm(fromInquiry(q)); }
  }, true);
  var INQ_CACHE = {};
  function fromInquiry(q) {
    var sp = ROOM_KEYS.indexOf(q.space) >= 0 ? q.space : (q.space === "coworking" || q.space === "office" ? q.space : "");
    var ppl = parseInt(String(q.people || "").replace(/[^0-9]/g, ""), 10);
    return { customer_name: q.name, phone: q.phone, space: sp, people: ppl > 0 && ppl < 500 ? ppl : "", channel: "web", inquiry_ref: q.receipt, purpose: q.purpose === "regular" ? "정기대관" : "",
      memo: [q.when_text ? "문의 일정: " + q.when_text : "", q.people ? "문의 인원: " + q.people : ""].filter(Boolean).join("\n") };
  }

  /* 결제 확인 (결제 전 → 결제 완료, 오늘 날짜 · 등록한 결제수단) */
  function payNow(code, btn) {
    var r = RES[code]; if (!r) return;
    if (!confirm(r.customer_name + " 님 예약 " + won(r.amount) + "을(를) 결제 완료로 바꿀까요?\n결제수단: " + (PAYL[r.pay_method] || "") + " · 결제일: 오늘")) return;
    if (btn) btn.disabled = true;
    api("/api/admin/reservations", { method: "PATCH", body: { code: code, action: "pay", paid_at: todayIso(), pay_method: r.pay_method } })
      .then(function (j) { RES[code] = j.item; toast("결제 완료로 바꿨습니다 · " + code); reloadCurrent(); if (!$("#dr-detail").hidden && DT.code === code) renderDetail(j.item); })
      .catch(function (e) { if (!guard(e)) toast(e.message); if (btn) btn.disabled = false; });
  }

  /* =================== 예약 등록 · 수정 =================== */
  var RF = { code: null, prev: null, auto: true, force: false, near: [], nearKey: "", calc: null };
  var rf = $("#rf");
  (function buildForm() {
    $("#rf-spaces").innerHTML = SPACE_LIST.map(function (s) {
      var p = ROOMS[s[0]];
      var low = p ? Math.min(+p.wdEarly || 0, +p.wdStd || 0, +p.hdEarly || 0, +p.hdStd || 0) : 0;
      var sub = p ? "최대 " + p.max + "명" : (s[0] === "other" ? "공간 직접 입력" : "금액 직접 입력");
      return '<label><input type="radio" name="space" value="' + s[0] + '"><b>' + esc(s[1]) + "</b><small>" + esc(sub) + "</small>" + (p ? '<small class="pr">시간당 ' + num(low) + "원~</small>" : "") + "</label>";
    }).join("");
    var so = ""; for (var m = 0; m <= 1410; m += 30) so += '<option value="' + m + '">' + hm(m) + "</option>";
    $("#rf-start").innerHTML = so;
    $("#rf-purpose").innerHTML = '<option value="">선택 안 함</option>' + PURPOSES.map(function (p) { return "<option>" + esc(p) + "</option>"; }).join("");
    $("#rf-channel").innerHTML = '<option value="">선택 안 함</option>' + CHANNELS.map(function (c) { return '<option value="' + c[0] + '">' + esc(c[1]) + "</option>"; }).join("");
    $("#rf-pay").innerHTML = PAY.map(function (p) { return '<label style="--pm:var(--m-' + p[0] + ')"><input type="radio" name="pay_method" value="' + p[0] + '"><b>' + esc(p[1]) + "</b><small>" + esc(p[2]) + "</small></label>"; }).join("");
    $("#rf-dur").innerHTML = [60, 90, 120, 180, 240, 360, 480, 720].map(function (m) { return '<button type="button" class="chip" data-dur="' + m + '">' + dur(m) + "</button>"; }).join("");
  })();
  function endOptions(start, sel) {
    var s = ""; for (var m = start + 30; m <= start + 1440; m += 30) s += '<option value="' + m + '"' + (m === sel ? " selected" : "") + ">" + hm(m) + " (" + dur(m - start) + ")</option>";
    $("#rf-end").innerHTML = s;
  }
  var rfVal = function (name) { var el = rf.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : ""; };
  function setRadio(name, v) { $$('input[name="' + name + '"]', rf).forEach(function (el) { el.checked = el.value === String(v); }); }
  function openForm(pre, item) {
    pre = pre || {};
    rf.reset(); RF.code = item ? item.code : null; RF.prev = item || null; RF.force = false; RF.near = []; RF.nearKey = "";
    $("#rf-msg").hidden = true; $("#rf-warn").hidden = true;
    $$(".err", rf).forEach(function (el) { el.classList.remove("err"); }); $("#rf-pay").classList.remove("err");
    var src = item || pre;
    setRadio("space", src.space || "");
    $("#rf-space-note").value = src.space_note || "";
    rf.date.value = src.date || todayIso();
    var st = src.start_min != null ? +src.start_min : 600;
    rf.start_min.value = String(st);
    endOptions(st, src.end_min != null ? +src.end_min : Math.min(st + 120, st + 1440));
    rf.customer_name.value = src.customer_name || ""; rf.phone.value = src.phone ? fmtPhone(src.phone) : "";
    rf.people.value = src.people != null ? src.people : "";
    if (src.purpose && !Array.prototype.some.call(rf.purpose.options, function (o) { return o.value === src.purpose; })) { var op = document.createElement("option"); op.textContent = src.purpose; rf.purpose.appendChild(op); }
    rf.purpose.value = src.purpose || ""; rf.channel.value = src.channel || (item ? "" : "kakao");
    rf.amount.value = item ? item.amount : (src.amount != null ? src.amount : "");
    rf.amount_note.value = src.amount_note || "";
    setRadio("pay_method", src.pay_method || "");
    setRadio("pay_status", item ? (item.pay_status === "unpaid" ? "unpaid" : "paid") : (src.pay_status || "paid"));
    rf.paid_at.value = (item && item.paid_at) || todayIso();
    rf.memo.value = src.memo || ""; rf.inquiry_ref.value = src.inquiry_ref || "";
    RF.auto = !item && (src.amount == null || src.amount === "");
    $("#rf-title").textContent = item ? "예약 수정 · " + item.code : "예약 등록";
    $("#rf-intro").textContent = item ? "예약 내용과 결제 정보를 고칩니다. 시간 · 공간을 바꾸면 겹치는 예약이 있는지 다시 확인합니다." : "카카오톡 · 전화 · 스페이스클라우드 등으로 받은 예약을 등록합니다. 시간은 30분 단위이고, 1~5번룸은 요금표 금액이 자동으로 계산됩니다.";
    $("#rf-submit").textContent = item ? "수정 저장" : "예약 등록";
    var rn = $("#rf-refund-note");
    if (item && item.pay_status === "refunded") { rn.hidden = false; rn.textContent = "환불 " + won(item.refund_amount) + " 기록이 있는 예약입니다. 결제 상태는 그대로 두고 금액 · 결제수단만 고칠 수 있습니다."; $$('input[name="pay_status"]', rf).forEach(function (x) { x.disabled = true; }); }
    else { rn.hidden = true; $$('input[name="pay_status"]', rf).forEach(function (x) { x.disabled = false; }); }
    rfSync(); openDrawer("#dr-form");
    setTimeout(function () { (rfVal("space") ? rf.customer_name : rf.querySelector('input[name="space"]')).focus(); }, 60);
  }
  function rfRead() {
    return { space: rfVal("space"), date: rf.date.value, start_min: +rf.start_min.value, end_min: +rf.end_min.value };
  }
  function rfSync(changed) {
    var v = rfRead();
    if (changed === "start") { var keep = v.end_min - (RF.lastStart != null ? RF.lastStart : v.start_min); if (!(keep > 0)) keep = 120; endOptions(v.start_min, Math.min(v.start_min + keep, v.start_min + 1440)); v = rfRead(); }
    RF.lastStart = v.start_min;
    $("#rf-space-note").hidden = !(v.space === "other" || v.space === "coworking" || v.space === "office");
    $("#rf-space-note").placeholder = v.space === "other" ? "공간 이름 (예: 2 · 4번룸 함께, 라운지 일부)" : "세부 내용 (선택, 예: 단체 20석, A호)";
    $$("#rf-dur [data-dur]").forEach(function (b) { b.classList.toggle("on", +b.dataset.dur === v.end_min - v.start_min); });
    var mins = v.end_min - v.start_min;
    $("#rf-when").innerHTML = v.date ? esc(kdateY(v.date)) + " · <b>" + esc(timeText(v)) + "</b> · " + esc(dur(mins)) + (v.end_min > 1440 ? ' <span class="st warn">' + esc(kdate(addDays(v.date, 1))) + "까지</span>" : "") + (isOff(v.date) ? ' <span class="st blue">' + (HOL[v.date] ? "공휴일" : "주말") + "</span>" : "") : "";
    $("#rf-paid-wrap").hidden = rfVal("pay_status") === "unpaid";
    // 요금표 금액
    var c = ROOM_KEYS.indexOf(v.space) >= 0 ? calcPrice(v.space, v.date, v.start_min, v.end_min) : null;
    RF.calc = c;
    var box = $("#rf-calc");
    if (!v.space) box.innerHTML = '<span class="none">공간을 고르면 요금표 금액을 계산합니다.</span>';
    else if (!c) box.innerHTML = '<span class="none">' + esc(SPL[v.space]) + " 은(는) 요금표 자동 계산이 없습니다. 받은 금액을 직접 적어 주세요." + (v.space === "coworking" ? " (코워킹 이용권: " + esc(PR.coworking || "") + ")" : v.space === "office" ? " (" + esc(PR.office || "") + ")" : "") + "</span>";
    else {
      box.innerHTML = '<div class="sum"><span>요금표 금액 <small class="muted">' + esc(SPL[v.space]) + " · 부가세 포함</small></span><b>" + won(c.total) + "</b></div>"
        + "<table>" + c.groups.map(function (g) { return "<tr><td>" + esc(BAND[g.key]) + " · " + esc(hm(g.from) + "–" + hm(g.to)) + " · " + esc(dur(g.n * 30)) + " × " + won(g.rate) + "/시간</td><td>" + won(g.rate * g.n / 2) + "</td></tr>"; }).join("") + "</table>";
    }
    if (c && RF.auto) rf.amount.value = c.total;
    var hint = $("#rf-amount-hint"), a = rf.amount.value === "" ? null : +rf.amount.value;
    if (c && a != null && a !== c.total) hint.innerHTML = "요금표보다 " + won(Math.abs(a - c.total)) + (a < c.total ? " 적습니다" : " 많습니다") + ' · <button type="button" class="linkish" id="rf-use-calc">요금표 금액 넣기</button>';
    else hint.textContent = c ? "요금표 금액과 같습니다." : "";
    var ppl = parseInt(rf.people.value, 10);
    if (c && ppl > c.max) hint.innerHTML += (hint.innerHTML ? "<br>" : "") + '<span style="color:var(--red)">' + esc(SPL[v.space]) + " 최대 인원(" + c.max + "명)보다 많습니다.</span>";
    rfConflicts();
  }
  function rfConflicts() {
    var v = rfRead(), w = $("#rf-warn");
    if (ROOM_KEYS.indexOf(v.space) < 0 || !v.date) { w.hidden = true; return; }
    var key = v.date;
    if (RF.nearKey !== key) {
      RF.nearKey = key; RF.near = [];
      api("/api/admin/reservations?status=confirmed&from=" + addDays(v.date, -1) + "&to=" + addDays(v.date, 1)).then(function (j) { if (RF.nearKey === key) { RF.near = remember(j.results); rfConflicts(); } }).catch(function () {});
      return;
    }
    var base = 0, s = base + v.start_min, e = base + v.end_min;
    var hit = RF.near.filter(function (r) { if (r.space !== v.space || r.code === RF.code || r.status !== "confirmed") return false; var o = diffDays(v.date, r.date) * 1440; return o + r.start_min < e && s < o + r.end_min; });
    var same = RF.near.filter(function (r) { return r.space === v.space && r.date === v.date && r.code !== RF.code && r.status === "confirmed" && hit.indexOf(r) < 0; });
    if (hit.length) { w.className = "alert bad"; w.innerHTML = "<b>같은 시간에 " + esc(SPL[v.space]) + " 예약이 있습니다.</b> " + hit.map(function (r) { return esc(r.customer_name) + " " + esc((r.date !== v.date ? kdate(r.date) + " " : "") + timeText(r)); }).join(", ") + " — 시간을 바꾸거나, 정말 함께 받는다면 그대로 등록하세요."; w.hidden = false; }
    else if (same.length) { w.className = "alert"; w.innerHTML = "이 날 " + esc(SPL[v.space]) + " 다른 예약: " + same.map(function (r) { return esc(r.customer_name) + " " + esc(timeText(r)); }).join(", ") + " — 시간이 겹치지 않습니다."; w.hidden = false; }
    else w.hidden = true;
  }
  rf.addEventListener("change", function (e) {
    var n = e.target.name;
    if (n === "amount") { RF.auto = false; }
    if (n === "start_min") { RF.force = false; rfSync("start"); return; }
    if (["space", "date", "end_min"].indexOf(n) >= 0) RF.force = false;
    if (n === "pay_method") $("#rf-pay").classList.remove("err");
    if (n === "space" || n === "date" || n === "end_min" || n === "pay_status" || n === "people" || n === "amount") rfSync();
  });
  rf.addEventListener("input", function (e) { if (e.target.name === "amount") { RF.auto = false; rfSync(); } if (e.target.name === "people") rfSync(); });
  $("#rf-dur").addEventListener("click", function (e) { var b = e.target.closest("[data-dur]"); if (!b) return; var s = +rf.start_min.value; endOptions(s, s + (+b.dataset.dur)); RF.force = false; rfSync(); });
  rf.addEventListener("click", function (e) { if (e.target.id === "rf-use-calc" && RF.calc) { rf.amount.value = RF.calc.total; RF.auto = true; rfSync(); } });
  rf.addEventListener("submit", function (e) {
    e.preventDefault();
    var msg = $("#rf-msg"); msg.hidden = true; $$(".err", rf).forEach(function (el) { el.classList.remove("err"); });
    var v = rfRead(), bad = function (el, t) { if (el) { el.classList.add("err"); el.focus(); } note(msg, t); };
    if (!v.space) return bad(rf.querySelector('input[name="space"]'), "공간을 골라 주세요.");
    if (!v.date) return bad(rf.date, "이용일을 골라 주세요.");
    if (!rf.customer_name.value.trim()) return bad(rf.customer_name, "예약자 이름을 적어 주세요.");
    if (rf.amount.value === "" || +rf.amount.value < 0) return bad(rf.amount, "결제 금액을 적어 주세요. (무료면 0)");
    if (!rfVal("pay_method")) { $("#rf-pay").classList.add("err"); $("#rf-pay").scrollIntoView({ block: "center", behavior: "smooth" }); return note(msg, "결제수단을 골라 주세요. 매출을 결제수단별로 나눠 보는 데 씁니다."); }
    var body = {
      space: v.space, space_note: $("#rf-space-note").hidden ? "" : $("#rf-space-note").value.trim(), date: v.date, start_min: v.start_min, end_min: v.end_min,
      customer_name: rf.customer_name.value.trim(), phone: rf.phone.value.trim(), people: rf.people.value.trim(), purpose: rf.purpose.value, channel: rf.channel.value,
      amount: +rf.amount.value, list_amount: RF.calc ? RF.calc.total : "", amount_note: rf.amount_note.value.trim(),
      pay_method: rfVal("pay_method"), pay_status: rfVal("pay_status") || "paid", paid_at: rf.paid_at.value, memo: rf.memo.value.trim(), inquiry_ref: rf.inquiry_ref.value.trim(), force: RF.force
    };
    if (RF.code) { body.code = RF.code; body.action = "update"; }
    var btn = $("#rf-submit"); btn.disabled = true;
    api("/api/admin/reservations", { method: RF.code ? "PATCH" : "POST", body: body }).then(function (j) {
      var it = j.item; RES[it.code] = it;
      closeDrawer($("#dr-form"));
      toast(RF.code ? "예약을 고쳤습니다 · " + it.code : "예약을 등록했습니다 · " + it.code + " · " + kdate(it.date) + " " + hm(it.start_min));
      reloadCurrent(); openDetail(it.code);
    }).catch(function (x) {
      if (guard(x)) return;
      if (x.code === "conflict") {
        var w = $("#rf-warn"); w.className = "alert bad";
        w.innerHTML = "<b>같은 룸 · 같은 시간에 이미 예약이 있습니다.</b> " + (x.data.conflicts || []).map(function (c) { return esc(c.name) + " " + esc((c.date !== v.date ? kdate(c.date) + " " : "") + c.time) + " (" + esc(c.code) + ")"; }).join(", ") + "<br>시간을 바꾸거나, 두 팀을 함께 받기로 했다면 <b>겹쳐도 등록</b>을 눌러 주세요.";
        w.hidden = false; RF.force = true; btn.textContent = RF.code ? "겹쳐도 저장" : "겹쳐도 등록"; w.scrollIntoView({ block: "center", behavior: "smooth" }); return;
      }
      if (x.data && x.data.field && rf.elements[x.data.field]) rf.elements[x.data.field].classList && rf.elements[x.data.field].classList.add("err");
      note(msg, esc(x.message));
    }).then(function () { btn.disabled = false; });
  });

  /* =================== 예약 상세 =================== */
  var DT = { code: null };
  function openDetail(code) {
    DT.code = code; var r = RES[code];
    if (r && r.external) { renderExternalDetail(r); openDrawer("#dr-detail"); return; }
    $("#dt-title").textContent = "예약 " + code;
    if (r) renderDetail(r); else $("#dt-body").innerHTML = emptyMsg("불러오는 중…");
    openDrawer("#dr-detail");
    api("/api/admin/reservations?code=" + encodeURIComponent(code)).then(function (j) {
      var it = (j.results || [])[0];
      if (!it) { if (DT.code === code) $("#dt-body").innerHTML = emptyMsg("예약을 찾을 수 없습니다. 이미 지웠을 수 있습니다."); return; }
      RES[code] = it; if (DT.code === code && !$("#dr-detail").hidden) renderDetail(it);
    }).catch(function (e) { if (!guard(e) && !r) $("#dt-body").innerHTML = emptyMsg(e.message); });
  }
  function refundRule(r) {
    var created = Date.parse(String(r.created_at || "").replace(" ", "T") + "+09:00");
    var d = diffDays(todayIso(), r.date);
    if (created && Date.now() - created < 2 * 3600e3 && d >= 0) return { rate: 100, why: "예약 후 2시간 이내" };
    if (d < 0) return { rate: 0, why: "이용일이 지났습니다" };
    var list = (PR.refund || []).filter(function (x) { return x.minDays !== undefined; }).sort(function (a, b) { return b.minDays - a.minDays; });
    var hit = list.filter(function (x) { return d >= x.minDays; })[0];
    return { rate: hit ? hit.rate : 0, why: d === 0 ? "이용 당일" : "이용일 " + d + "일 전" };
  }
  var kv = function (k, v) { return v === "" || v == null ? "" : '<div class="kv"><span>' + esc(k) + "</span><b>" + v + "</b></div>"; };
  function renderExternalDetail(r) {
    var stamp = r.synced_at ? new Date(r.synced_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "확인 중";
    $("#dt-title").textContent = "스페이스클라우드 일정";
    $("#dt-body").innerHTML = '<div class="dt-top"><span class="st sc-tag">외부 일정</span></div>'
      + '<div class="dt-when">' + esc(kdateY(r.date)) + " " + esc(timeText(r)) + '<small>' + esc(spaceName(r)) + '</small></div>'
      + '<div class="sec"><h3>스페이스클라우드</h3>' + kv("일정 제목", esc(r.customer_name)) + kv("마지막 확인", esc(stamp))
      + '<p class="small muted">캘린더에서 제공하는 예약 시간입니다. 예약자 연락처 · 인원 · 결제금액은 제공되지 않으며 매출에 합산하지 않습니다. 실제 결제금액을 아래에서 등록하면 총매출과 스페이스클라우드 매출에 포함됩니다. 일정 변경과 취소는 스페이스클라우드에서 처리하고, 등록한 매출의 환불 금액도 별도로 수정해 주세요.</p>'
      + (r.source_url ? '<a class="btn btn-primary btn-sm" target="_blank" rel="noopener noreferrer" href="' + esc(r.source_url) + '">스페이스클라우드에서 확인</a>' : '')
      + '<div class="sub-form"><h3>결제금액 등록</h3><p class="small muted">이 일정의 실제 결제금액을 입력하세요. 예상 요금이나 정산 입금액이 아닌 고객 결제금액 기준입니다. 이미 직접 등록한 예약이 있다면 중복 등록하지 마세요. 여러 날짜에 걸친 예약은 날짜별 배분 금액으로 직접 등록해 주세요.</p>'
      + '<label for="sc-sales-amount">결제 금액 (원)</label><input class="input" id="sc-sales-amount" type="number" min="0" max="100000000" step="1" inputmode="numeric" placeholder="실제 결제금액">'
      + '<label for="sc-sales-date">실제 결제일</label><input class="input" id="sc-sales-date" type="date">'
      + '<button class="btn btn-primary btn-sm mt-s" type="button" id="sc-sales-save">총매출에 등록</button><p class="small" id="sc-sales-status" role="status"></p></div></div>';
    $("#sc-sales-save").addEventListener("click", function () {
      var raw = $("#sc-sales-amount").value, amount = Number(raw), paid = $("#sc-sales-date").value;
      if (raw === "" || !Number.isSafeInteger(amount) || amount < 0 || amount > 100000000 || !paid) { $("#sc-sales-status").textContent = "실제 결제금액과 결제일을 입력해 주세요."; return; }
      var button = this; button.disabled = true;
      api("/api/admin/reservations", { method: "POST", body: { sourceCode: r.code, amount: amount, paid_at: paid } }).then(function (j) {
        RES[j.item.code] = j.item; reloadCurrent(); openDetail(j.item.code); refreshCounts();
        toast(j.already ? "이미 등록된 매출입니다. 기존 내역을 표시합니다." : "스페이스클라우드 매출을 등록했습니다.");
      }).catch(function (e) { button.disabled = false; if (!guard(e)) $("#sc-sales-status").textContent = e.message; });
    });
  }
  function renderDetail(r) {
    var tel = String(r.phone || "").replace(/[^0-9+]/g, ""), room = ROOMS[r.space], c = ROOM_KEYS.indexOf(r.space) >= 0 ? calcPrice(r.space, r.date, r.start_min, r.end_min) : null;
    var rule = refundRule(r), sug = r.pay_status === "unpaid" ? 0 : Math.round(r.amount * rule.rate / 100 / 100) * 100;
    var h = '<div class="dt-top">' + resStTag(r) + pstTag(r) + '<span class="mono small muted">' + esc(r.code) + "</span></div>"
      + '<div class="dt-when">' + esc(kdateY(r.date)) + " " + esc(timeText(r)) + "<small>" + esc(spaceName(r)) + (room ? " · 최대 " + room.max + "명" : "") + " · " + esc(dur(r.end_min - r.start_min)) + (r.end_min > 1440 ? " · " + esc(kdate(addDays(r.date, 1))) + "까지" : "") + "</small></div>"
      + '<div class="dt-acts"><button class="btn btn-primary btn-sm" type="button" id="dt-edit">수정</button><button class="btn btn-light btn-sm" type="button" id="dt-copy">고객 안내문 복사</button>'
      + (tel ? '<a class="btn btn-light btn-sm" href="tel:' + esc(tel) + '">전화</a><a class="btn btn-light btn-sm" href="sms:' + esc(tel) + '">문자</a>' : "") + "</div>"
      + '<div class="sec"><h3>예약자</h3>' + kv("이름 · 단체", esc(r.customer_name)) + kv("연락처", esc(r.phone || "")) + kv("인원", r.people != null ? esc(r.people + "명") + (room && r.people > room.max ? ' <span class="st bad">최대 ' + room.max + "명 초과</span>" : "") : "")
      + kv("모임 목적", esc(r.purpose || "")) + kv("예약 경로", esc(CHL[r.channel] || "")) + kv("연결 문의", esc(r.inquiry_ref || "")) + "</div>"
      + '<div class="sec"><h3>결제</h3>' + kv("결제 금액", "<b>" + won(r.amount) + "</b>" + (r.list_amount != null && r.list_amount !== r.amount ? ' <small class="muted">요금표 ' + won(r.list_amount) + "</small>" : ""))
      + kv("금액 메모", esc(r.amount_note || "")) + kv("결제수단", pmTag(r.pay_method)) + kv("결제 상태", pstTag(r) + (r.paid_at ? ' <small class="muted">' + esc(kdateY(r.paid_at)) + " 결제</small>" : ""))
      + (r.refund_amount ? kv("환불", won(r.refund_amount) + (r.refunded_at ? ' <small class="muted">' + esc(kdateY(r.refunded_at)) + "</small>" : "")) + kv("매출로 남는 금액", won(net(r))) : "")
      + (c && r.list_amount == null ? kv("요금표 금액", won(c.total)) : "")
      + (r.status === "confirmed" && r.pay_status === "unpaid" ? '<div class="sub-form"><b>결제 완료 처리</b><div class="row"><select class="select" id="dt-pm">' + PAY.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === r.pay_method ? " selected" : "") + ">" + esc(p[1]) + "</option>"; }).join("") + '</select><input class="input" type="date" id="dt-pdate" value="' + todayIso() + '" aria-label="결제일"><button class="btn btn-ok btn-sm" type="button" id="dt-pay">결제 완료로 바꾸기</button></div></div>' : "")
      + (r.pay_status === "paid" && r.status === "confirmed" ? '<div><button type="button" class="linkish small" id="dt-unpay">결제 전(입금 대기)으로 되돌리기</button></div>' : "")
      + "</div>"
      + (r.memo ? '<div class="sec"><h3>메모</h3><div class="memo-box">' + esc(r.memo) + "</div></div>" : "");
    if (r.status === "confirmed") {
      h += '<div class="sec"><h3>취소 · 환불</h3><div class="sub-form danger">'
        + (r.pay_status === "unpaid" ? '<p class="policy">아직 결제 전인 예약이라 환불할 금액이 없습니다. 취소하면 매출 · 미수금에서 빠집니다.</p>'
          : '<p class="policy">환불 규정: ' + esc(PR.cancel || "") + "<br>지금 취소하면 <b>" + esc(rule.why) + " · " + rule.rate + "%</b> → 환불 " + won(sug) + "</p>"
            + '<div class="row"><label class="small" for="dt-refund">환불 금액</label><input class="input" type="number" min="0" max="' + r.amount + '" step="100" id="dt-refund" value="' + sug + '"></div>')
        + '<div class="row"><input class="input" id="dt-reason" maxlength="200" placeholder="취소 사유 (예: 고객 요청, 일정 변경)"></div>'
        + '<div class="row"><button class="btn btn-danger btn-sm" type="button" id="dt-cancel">예약 취소</button><span class="tiny muted">환불은 실제로 돌려준 뒤 기록해 주세요. 남은 금액은 매출로 남습니다.</span></div></div></div>';
    } else {
      h += '<div class="sec"><h3>취소</h3>' + kv("취소한 날", esc(String(r.cancelled_at || "").slice(0, 16))) + kv("사유", esc(r.cancel_reason || "")) + kv("환불", r.refund_amount ? won(r.refund_amount) : "없음")
        + '<div><button class="btn btn-light btn-sm" type="button" id="dt-restore">예약 복원</button> <span class="tiny muted">' + (r.refund_amount ? "환불 기록도 함께 지우고 결제 완료로 되돌립니다." : "취소 전 상태로 되돌립니다.") + "</span></div></div>";
    }
    h += '<div class="sec"><h3>기록</h3>' + kv("등록", esc(String(r.created_at || "").slice(0, 16))) + kv("마지막 수정", esc(String(r.updated_at || "").slice(0, 16)))
      + '<div class="mt-s"><button class="btn btn-danger btn-xs" type="button" id="dt-del">이 예약 삭제</button> <span class="tiny muted">잘못 등록한 예약만 지워 주세요. 삭제하면 매출에서도 빠지고 되돌릴 수 없습니다.</span></div></div>';
    $("#dt-body").innerHTML = h;
    $("#dt-title").textContent = "예약 " + r.code;
    var act = function (body, ok) {
      body.code = r.code;
      return api("/api/admin/reservations", { method: "PATCH", body: body }).then(function (j) { RES[r.code] = j.item; renderDetail(j.item); toast(ok); reloadCurrent(); });
    };
    var onErr = function (e) { if (guard(e)) return; if (e.code === "conflict") { if (confirm("같은 시간에 다른 예약이 있습니다: " + (e.data.conflicts || []).map(function (c) { return c.name + " " + c.time; }).join(", ") + "\n그래도 복원할까요?")) act({ action: "restore", force: true }, "예약을 복원했습니다.").catch(onErr); return; } toast(e.message); };
    $("#dt-edit").addEventListener("click", function () { closeDrawer($("#dr-detail")); openForm(null, r); });
    $("#dt-copy").addEventListener("click", function () { copyText(guideText(r)).then(function () { toast("고객 안내문을 복사했습니다. 카카오톡 · 문자에 붙여 넣으세요."); }, function () { toast("복사하지 못했습니다."); }); });
    var pay = $("#dt-pay"); if (pay) pay.addEventListener("click", function () { pay.disabled = true; act({ action: "pay", pay_method: $("#dt-pm").value, paid_at: $("#dt-pdate").value }, "결제 완료로 바꿨습니다.").catch(function (e) { pay.disabled = false; onErr(e); }); });
    var unpay = $("#dt-unpay"); if (unpay) unpay.addEventListener("click", function () { if (confirm("결제 전(입금 대기)으로 되돌릴까요? 매출에서 빠지고 미수금으로 셉니다.")) act({ action: "unpay" }, "결제 전으로 바꿨습니다.").catch(onErr); });
    var cancel = $("#dt-cancel"); if (cancel) cancel.addEventListener("click", function () {
      var rf0 = $("#dt-refund"), refund = rf0 ? Math.max(0, Math.min(r.amount, +rf0.value || 0)) : 0;
      if (!confirm("이 예약을 취소할까요?" + (rf0 ? "\n환불 금액: " + won(refund) + " · 매출로 남는 금액: " + won(r.amount - refund) : ""))) return;
      cancel.disabled = true; act({ action: "cancel", refund_amount: refund, cancel_reason: $("#dt-reason").value.trim() }, "예약을 취소했습니다.").catch(function (e) { cancel.disabled = false; onErr(e); });
    });
    var restore = $("#dt-restore"); if (restore) restore.addEventListener("click", function () { if (confirm("이 예약을 다시 확정 상태로 되돌릴까요?")) act({ action: "restore" }, "예약을 복원했습니다.").catch(onErr); });
    $("#dt-del").addEventListener("click", function () {
      if (!confirm("예약 " + r.code + " (" + r.customer_name + ")을(를) 완전히 삭제할까요?\n취소와 달리 기록이 남지 않고 매출에서도 빠집니다. 되돌릴 수 없습니다.")) return;
      api("/api/admin/reservations", { method: "DELETE", body: { code: r.code } }).then(function () { delete RES[r.code]; closeDrawer($("#dr-detail")); toast("예약을 삭제했습니다."); reloadCurrent(); }).catch(onErr);
    });
  }
  function guideText(r) {
    var room = ROOMS[r.space], L = [];
    L.push("[" + (CFG.branch || "소셜팩토리 건대") + " 예약 안내] 예약번호 " + r.code);
    L.push(r.customer_name + " 님, 예약이 확정되었습니다.");
    L.push("");
    L.push("· 공간: " + spaceName(r) + (room ? " (최대 " + room.max + "명)" : ""));
    L.push("· 일시: " + kdateY(r.date) + " " + timeText(r) + " (" + dur(r.end_min - r.start_min) + ")");
    if (r.people) L.push("· 인원: " + r.people + "명");
    L.push("· 금액: " + won(r.amount) + " (부가세 포함)" + (r.pay_status === "unpaid" ? " · 입금을 확인하면 다시 알려 드립니다." : " · 결제 완료"));
    if (CFG.address) L.push("· 장소: " + CFG.address);
    L.push("");
    L.push("준비와 정리 시간까지 포함해 예약 시간 안에 이용해 주세요.");
    L.push("건물이 교육환경보호구역 안에 있어 주류는 반입할 수 없습니다.");
    if (PR.cancel) L.push("취소 · 환불: " + PR.cancel);
    if (kakaoChat) L.push("문의: " + kakaoChat);
    return L.join("\n");
  }

  function loadSpacecloudSettings() {
    api("/api/admin/spacecloud").then(function (j) {
      renderSpacecloudStatus(j.spacecloud);
      $$("[data-sc-room]").forEach(function (el) { el.textContent = (j.rooms || []).indexOf(el.dataset.scRoom) >= 0 ? "연결됨 · 새 주소를 넣으면 교체" : "미연결"; });
    }).catch(function (e) { if (!guard(e)) toast(e.message); });
  }
  $("#sc-settings").addEventListener("submit", function (event) {
    event.preventDefault();
    var button = $("#sc-save"), msg = $("#sc-settings-msg"), feeds = {};
    ROOM_KEYS.forEach(function (key) { feeds[key] = $("#sc-feed-" + key).value.trim(); });
    button.disabled = true; msg.hidden = true;
    api("/api/admin/spacecloud", { method: "POST", body: { action: "configure", feeds: feeds } }).then(function (j) {
      ROOM_KEYS.forEach(function (key) { $("#sc-feed-" + key).value = ""; });
      renderSpacecloudStatus(j.spacecloud); loadSpacecloudSettings();
      var partial = (j.spacecloud.rooms || []).some(function (r) { return r.error; });
      note(msg, partial ? "연결은 저장했지만 일부 룸을 불러오지 못했습니다. 주소를 확인하고 다시 불러와 주세요." : "연결을 저장하고 일정을 불러왔습니다. 예약 현황에서 확인하세요.", !partial);
    }).catch(function (e) { if (!guard(e)) note(msg, esc(e.message), false); }).then(function () { button.disabled = false; });
  });
  function renderSpacecloudStatus(info) {
    var targets = $$("[data-sc-status]");
    if (!info) return;
    var rooms = info.rooms || [], failures = rooms.filter(function (r) { return r.error || r.stale; });
    var times = rooms.map(function (r) { return r.updated_at; }).filter(Boolean);
    var last = times.length ? Math.min.apply(Math, times) : 0;
    var text = info.error || (!info.configured ? "스페이스클라우드 캘린더가 아직 연결되지 않았습니다." :
      "스페이스클라우드 " + rooms.length + "개 룸 연결 · " + rooms.reduce(function (a, r) { return a + r.count; }, 0) + "개 일정 · "
      + (last ? new Date(last).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) + " 확인" : "확인 대기")
      + (failures.length ? " · " + failures.map(function (r) { return SPL[r.space] + (r.error ? " (" + r.error + ")" : " 재확인 필요"); }).join(", ") : " · 열려 있는 동안 5분마다 확인")
      + " · 외부 일정은 매출 제외");
    targets.forEach(function (el) { el.textContent = text; el.classList.toggle("sc-warning", !!info.error || failures.length > 0); });
  }
  document.addEventListener("click", function (event) {
    var button = event.target.closest("[data-sc-refresh]"); if (!button) return;
    button.disabled = true;
    api("/api/admin/spacecloud", { method: "POST", body: {} }).then(function (j) {
      renderSpacecloudStatus(j.spacecloud); reloadCurrent();
      toast((j.spacecloud.rooms || []).some(function (r) { return r.error; }) ? "일부 룸을 확인하지 못했습니다. 이전 일정을 유지합니다." : "스페이스클라우드 일정을 새로 확인했습니다.");
    }).catch(function (e) { if (!guard(e)) toast(e.message); }).then(function () { button.disabled = false; });
  });
  setInterval(function () {
    if (!app.hidden && !document.hidden && ["dash", "board", "list"].indexOf(CUR) >= 0) reloadCurrent();
  }, 5 * 60 * 1000);

  /* =================== 예약 현황 (일간 시간표 · 월간 달력) =================== */
  var BD = { mode: "day", date: null, items: [] };
  function bdSyncUi() {
    if (!BD.date) BD.date = todayIso();
    $$("#bd-mode [data-mode]").forEach(function (b) { b.classList.toggle("on", b.dataset.mode === BD.mode); });
    $("#bd-date").value = BD.date;
    $("#bd-title").textContent = BD.mode === "day" ? kdateY(BD.date) + (BD.date === todayIso() ? " · 오늘" : "") : BD.date.slice(0, 4) + "년 " + (+BD.date.slice(5, 7)) + "월";
    $("#bd-day").hidden = BD.mode !== "day"; $("#bd-month").hidden = BD.mode !== "month";
  }
  function loadBoard() {
    bdSyncUi();
    var from, to;
    if (BD.mode === "day") { from = addDays(BD.date, -1); to = BD.date; }
    else { from = addDays(BD.date.slice(0, 8) + "01", -1); var d = parseIso(BD.date.slice(0, 8) + "01"); d.setMonth(d.getMonth() + 1); d.setDate(0); to = isoOf(d); }
    var box = BD.mode === "day" ? $("#bd-day") : $("#bd-month"), key = BD.mode + BD.date;
    if (!box.innerHTML) box.innerHTML = emptyMsg("불러오는 중…");
    api("/api/admin/reservations?from=" + from + "&to=" + to).then(function (j) {
      if (key !== BD.mode + BD.date) return;
      BD.items = remember(j.results);
      renderSpacecloudStatus(j.spacecloud);
      if (BD.mode === "day") drawDay(); else drawMonth();
    }).catch(fail(box));
  }
  function drawDay() {
    var D = BD.date, show = $("#bd-cancel").checked;
    var rel = function (r) { var o = diffDays(D, r.date) * 1440; return { s: o + r.start_min, e: o + r.end_min }; };
    var vis = BD.items.filter(function (r) { var x = rel(r); return x.e > 0 && x.s < 1440 && (show || r.status !== "cancelled"); });
    var rows = ROOM_KEYS.slice();
    vis.forEach(function (r) { if (rows.indexOf(r.space) < 0) rows.push(r.space); });
    var hours = ""; for (var h = 0; h < 24; h += 1) hours += '<span style="left:' + (h / 24 * 100) + '%">' + h + "시</span>";
    var isToday = D === todayIso(), nm = nowMin();
    var html = '<div class="tl-scroll"><div class="tl"><div class="tl-head"><div></div><div class="tl-hours">' + hours + "</div></div>";
    rows.forEach(function (sp) {
      var p = ROOMS[sp], blocks = vis.filter(function (r) { return r.space === sp; }).sort(function (a, b) { return rel(a).s - rel(b).s; });
      html += '<div class="tl-row"><div class="tl-room"><b>' + esc(SPL[sp] || sp) + "</b><small>" + (p ? "최대 " + p.max + "명" : "인원 · 금액 직접") + "</small></div>"
        + '<div class="tl-track" data-space="' + esc(sp) + '"><div class="tl-ghost"></div>'
        + blocks.map(function (r) {
          var x = rel(r), s = Math.max(0, x.s), e = Math.min(1440, x.e);
          var cls = "blk" + (r.external ? " sc-external" : "") + (r.status === "cancelled" ? " cancelled" : r.pay_status === "unpaid" ? " unpaid" : "") + (x.s < 0 ? " cont-l" : "") + (x.e > 1440 ? " cont-r" : "");
          return '<button type="button" class="' + cls + '" data-blk="' + esc(r.code) + '" style="left:' + (s / 1440 * 100).toFixed(3) + "%;width:" + ((e - s) / 1440 * 100).toFixed(3) + '%" title="' + esc(r.customer_name + " · " + timeText(r) + " · " + (r.external ? "외부 일정 · 금액 미제공" : won(r.amount)) + " · " + (PAYL[r.pay_method] || "") + " · " + (PST[r.pay_status] || [""])[0]) + '">'
            + "<b>" + esc(r.customer_name) + (r.people ? " · " + r.people + "명" : "") + "</b><span>" + esc((x.s < 0 ? "← " : "") + timeText(r) + (x.e > 1440 ? " →" : "")) + "</span><span>" + esc((r.external ? "금액 미제공" : won(r.amount)) + " · " + (r.pay_status === "unpaid" ? "결제 전" : PAYL[r.pay_method] || "")) + "</span></button>";
        }).join("")
        + (isToday ? '<div class="tl-now" style="left:' + (nm / 1440 * 100).toFixed(3) + '%"></div>' : "") + "</div></div>";
    });
    html += "</div></div>";
    $("#bd-day").innerHTML = html;
    // 화면이 좁아 가로로 밀어야 할 때는 오전 8시 부근부터 보여 줍니다 (그 전에 시작하는 예약이 없을 때)
    var sc = $("#bd-day .tl-scroll");
    if (sc && sc.scrollWidth > sc.clientWidth + 4) {
      var early = vis.some(function (r) { return rel(r).s < 480 && rel(r).e > 0; });
      var trackW = $("#bd-day .tl-track").getBoundingClientRect().width;
      sc.scrollLeft = early ? 0 : Math.round(trackW * 8 / 24);
    }
    var list = vis.slice().sort(function (a, b) { return rel(a).s - rel(b).s || (a.space < b.space ? -1 : 1); });
    var act = list.filter(function (r) { return r.status !== "cancelled" && r.date === D; });   // 전날 밤 예약은 그날 매출로 셉니다
    $("#bd-sum-title").textContent = kdate(D) + " 예약";
    $("#bd-sum").textContent = "예약 " + act.length + "건 · 매출 " + won(act.reduce(function (a, r) { return a + net(r); }, 0)) + " · 결제 전 " + won(act.filter(function (r) { return r.pay_status === "unpaid"; }).reduce(function (a, r) { return a + r.amount; }, 0));
    $("#bd-list").innerHTML = list.length ? list.map(function (r) { return resRow(r, { day: D, payBtn: true }); }).join("") : emptyMsg("이 날 예약이 없습니다. 위 시간표의 빈 칸을 눌러 바로 등록할 수 있습니다.");
    $("#bd-sum-card").hidden = false;
  }
  function drawMonth() {
    var ym = BD.date.slice(0, 7), first = parseIso(ym + "-01"), days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(), padN = first.getDay(), t = todayIso(), show = $("#bd-cancel").checked;
    var by = {};
    BD.items.forEach(function (r) { if (r.date.slice(0, 7) !== ym || (!show && r.status === "cancelled")) return; (by[r.date] = by[r.date] || []).push(r); });
    var h = DOW.map(function (d, i) { return '<div class="dw' + (i === 0 ? " sun" : i === 6 ? " sat" : "") + '">' + d + "</div>"; }).join("");
    for (var i = 0; i < padN; i++) h += '<div class="dc empty"></div>';
    var mSum = 0, mN = 0;
    for (var d = 1; d <= days; d++) {
      var iso = ym + "-" + pad(d), w = (padN + d - 1) % 7, list = (by[iso] || []).sort(function (a, b) { return a.start_min - b.start_min; });
      var act = list.filter(function (r) { return r.status !== "cancelled"; }), sum = act.reduce(function (a, r) { return a + net(r); }, 0);
      mSum += sum; mN += act.length;
      h += '<div class="dc' + (iso === t ? " today" : "") + (iso < t ? " past" : "") + (isOff(iso) && w !== 6 ? " off" : "") + (w === 6 ? " sat" : "") + '" data-day="' + iso + '"><div class="dn"><b>' + d + "</b>" + (act.length ? "<small>" + act.length + "건 · " + manwon(sum) + "</small>" : (HOL[iso] ? "<small>공휴일</small>" : "")) + "</div>"
        + list.slice(0, 4).map(function (r) { return '<i class="ev' + (r.external ? ' sc-external' : '') + (r.status === "cancelled" ? " cancelled" : r.pay_status === "unpaid" ? " unpaid" : "") + '" data-ev="' + esc(r.code) + '">' + esc(hm(r.start_min)) + " " + esc((SPL[r.space] || "").replace("번룸", "룸")) + ' <span class="nm">' + esc(r.customer_name) + "</span></i>"; }).join("")
        + (list.length > 4 ? '<span class="more">+' + (list.length - 4) + "건 더</span>" : "") + "</div>";
    }
    $("#bd-month").innerHTML = '<div class="cal">' + h + "</div>";
    $("#bd-sum-title").textContent = (+ym.slice(5, 7)) + "월 예약";
    $("#bd-sum").textContent = "예약 " + mN + "건 · 매출 " + won(mSum) + " (이용일 기준)";
    $("#bd-list").innerHTML = '<p class="small muted">날짜를 누르면 그날 시간표가 열리고, 예약을 누르면 상세 내용이 열립니다.</p>';
  }
  $("#bd-mode").addEventListener("click", function (e) { var b = e.target.closest("[data-mode]"); if (!b) return; BD.mode = b.dataset.mode; $("#bd-day").innerHTML = ""; $("#bd-month").innerHTML = ""; loadBoard(); });
  $("#bd-prev").addEventListener("click", function () { if (BD.mode === "day") BD.date = addDays(BD.date, -1); else { var d = parseIso(BD.date.slice(0, 8) + "01"); d.setMonth(d.getMonth() - 1); BD.date = isoOf(d); } loadBoard(); });
  $("#bd-next").addEventListener("click", function () { if (BD.mode === "day") BD.date = addDays(BD.date, 1); else { var d = parseIso(BD.date.slice(0, 8) + "01"); d.setMonth(d.getMonth() + 1); BD.date = isoOf(d); } loadBoard(); });
  $("#bd-today").addEventListener("click", function () { BD.date = todayIso(); loadBoard(); });
  $("#bd-date").addEventListener("change", function () { if (this.value) { BD.date = this.value; loadBoard(); } });
  $("#bd-cancel").addEventListener("change", function () { if (BD.mode === "day") drawDay(); else drawMonth(); });
  $("#bd-day").addEventListener("click", function (e) {
    var b = e.target.closest("[data-blk]"); if (b) { openDetail(b.dataset.blk); return; }
    var tr = e.target.closest(".tl-track"); if (!tr) return;
    var rc = tr.getBoundingClientRect(), m = Math.floor(((e.clientX - rc.left) / rc.width * 1440) / 30) * 30;
    m = Math.max(0, Math.min(1410, m));
    openForm({ space: tr.dataset.space, date: BD.date, start_min: m, end_min: m + 120 });
  });
  $("#bd-day").addEventListener("mousemove", function (e) {
    var tr = e.target.closest(".tl-track"); if (!tr || e.target.closest(".blk")) { $$(".tl-ghost").forEach(function (g) { g.style.display = ""; }); return; }
    var rc = tr.getBoundingClientRect(), m = Math.floor(((e.clientX - rc.left) / rc.width * 1440) / 30) * 30, g = $(".tl-ghost", tr);
    m = Math.max(0, Math.min(1410, m));
    g.style.left = (m / 1440 * 100) + "%"; g.style.width = (Math.min(120, 1440 - m) / 1440 * 100) + "%"; g.style.display = "block";
  });
  $("#bd-day").addEventListener("mouseleave", function () { $$(".tl-ghost").forEach(function (g) { g.style.display = ""; }); });
  $("#bd-month").addEventListener("click", function (e) {
    var ev = e.target.closest("[data-ev]"); if (ev) { openDetail(ev.dataset.ev); return; }
    var c = e.target.closest("[data-day]"); if (!c) return; BD.date = c.dataset.day; BD.mode = "day"; $("#bd-day").innerHTML = ""; loadBoard();
  });

  /* =================== 일자별 예약 =================== */
  var LS = { range: "upcoming", items: [] };
  $("#ls-space").innerHTML += SPACE_LIST.map(function (s) { return '<option value="' + s[0] + '">' + esc(s[1]) + "</option>"; }).join("");
  $("#ls-pay").innerHTML += PAY.map(function (p) { return '<option value="' + p[0] + '">' + esc(p[1]) + "</option>"; }).join("");
  function rangeOf(k) {
    var t = todayIso(), d = parseIso(t), y = d.getFullYear(), m = d.getMonth();
    if (k === "week") { var w = (d.getDay() + 6) % 7, mon = addDays(t, -w); return [mon, addDays(mon, 6)]; }
    if (k === "month") return [isoOf(new Date(y, m, 1, 12)), isoOf(new Date(y, m + 1, 0, 12))];
    if (k === "next") return [isoOf(new Date(y, m + 1, 1, 12)), isoOf(new Date(y, m + 2, 0, 12))];
    if (k === "past") return ["", addDays(t, -1)];
    if (k === "all") return ["", ""];
    return [t, ""];
  }
  function setRange(k) { LS.range = k; var r = rangeOf(k); $("#ls-from").value = r[0]; $("#ls-to").value = r[1]; $$("#ls-range [data-range]").forEach(function (b) { b.classList.toggle("on", b.dataset.range === k); }); }
  setRange("upcoming");
  function loadList() {
    var box = $("#ls-list"); box.innerHTML = emptyMsg("불러오는 중…");
    api("/api/admin/reservations?from=" + encodeURIComponent($("#ls-from").value) + "&to=" + encodeURIComponent($("#ls-to").value)).then(function (j) { LS.items = remember(j.results); renderSpacecloudStatus(j.spacecloud); drawList(); }).catch(fail(box));
  }
  function listFiltered() {
    var st = $("#ls-status").value, sp = $("#ls-space").value, pm = $("#ls-pay").value, ps = $("#ls-pstatus").value, q = $("#ls-q").value.trim().toLowerCase().replace(/-/g, "");
    var list = LS.items.filter(function (r) {
      if (st === "active" && r.status === "cancelled") return false;
      if (st === "cancelled" && r.status !== "cancelled") return false;
      if (sp && r.space !== sp) return false;
      if (pm && r.pay_method !== pm) return false;
      if (ps && r.pay_status !== ps) return false;
      if (q && [r.customer_name, r.phone, r.code, r.memo, r.inquiry_ref, r.space_note].join(" ").toLowerCase().replace(/-/g, "").indexOf(q) < 0) return false;
      return true;
    });
    if (LS.range === "past") list = list.slice().reverse();
    return list;
  }
  function drawList() {
    var list = listFiltered(), box = $("#ls-list"), t = todayIso();
    var act = list.filter(function (r) { return r.status !== "cancelled"; });
    var sales = list.reduce(function (a, r) { return a + net(r); }, 0), mins = act.reduce(function (a, r) { return a + r.end_min - r.start_min; }, 0);
    var unpaid = act.filter(function (r) { return r.pay_status === "unpaid"; }), unpaidSum = unpaid.reduce(function (a, r) { return a + r.amount; }, 0);
    $("#ls-kpis").innerHTML = '<div class="kpi"><small>예약</small><b>' + num(act.length) + "<em>건</em></b><span>" + (list.length - act.length ? "취소 " + (list.length - act.length) + "건 별도" : "취소 제외") + "</span></div>"
      + '<div class="kpi"><small>이용 시간 합계</small><b>' + esc(dur(mins)) + "</b></div>"
      + '<div class="kpi accent"><small>매출 (결제 완료)</small><b>' + num(sales) + "<em>원</em></b></div>"
      + '<div class="kpi' + (unpaid.length ? " warn" : "") + '"><small>결제 전 (미수금)</small><b>' + num(unpaidSum) + "<em>원</em></b><span>" + unpaid.length + "건</span></div>";
    if (!list.length) { box.innerHTML = emptyMsg("조건에 맞는 예약이 없습니다."); return; }
    var months = {}, order = [];
    list.forEach(function (r) { var mk = r.date.slice(0, 7); if (!months[mk]) { months[mk] = { days: {}, order: [] }; order.push(mk); } var mo = months[mk]; if (!mo.days[r.date]) { mo.days[r.date] = []; mo.order.push(r.date); } mo.days[r.date].push(r); });
    var head = '<colgroup><col style="width:14%"><col style="width:8%"><col style="width:16%"><col style="width:6%"><col style="width:11%"><col style="width:16%"><col style="width:8%"><col style="width:11%"><col style="width:10%"></colgroup><thead><tr><th>시간</th><th>공간</th><th>예약자</th><th>인원</th><th class="r">금액</th><th>결제</th><th>경로</th><th>예약번호</th><th></th></tr></thead>';
    box.innerHTML = order.map(function (mk) {
      var mo = months[mk], all = []; mo.order.forEach(function (dk) { all = all.concat(mo.days[dk]); });
      var ma = all.filter(function (r) { return r.status !== "cancelled"; });
      return '<div class="mgroup"><div class="mhead"><b>' + mk.slice(0, 4) + "년 " + (+mk.slice(5, 7)) + "월</b><span>예약 " + ma.length + "건 · 매출 " + won(all.reduce(function (a, r) { return a + net(r); }, 0)) + (ma.some(function (r) { return r.pay_status === "unpaid"; }) ? " · 결제 전 " + won(ma.filter(function (r) { return r.pay_status === "unpaid"; }).reduce(function (a, r) { return a + r.amount; }, 0)) : "") + "</span></div>"
        + mo.order.map(function (dk) {
          var rows = mo.days[dk].slice().sort(function (a, b) { return a.start_min - b.start_min || (a.space < b.space ? -1 : 1); }), n = diffDays(t, dk), w = dow(dk);
          var da = rows.filter(function (r) { return r.status !== "cancelled"; });
          var dd = n === 0 ? '<em class="dd">오늘</em>' : n === 1 ? '<em class="dd soon">내일</em>' : (n > 1 && n <= 7 ? '<em class="dd soon">D-' + n + "</em>" : "");
          return '<div class="day' + (n === 0 ? " today" : "") + '"><div class="dhead"><span class="dt' + (isOff(dk) && w !== 6 ? " off" : "") + (w === 6 ? " sat" : "") + '">' + (+dk.slice(5, 7)) + "." + (+dk.slice(8, 10)) + " (" + DOW[w] + ")" + (HOL[dk] ? " 공휴일" : "") + "</span>" + dd
            + '<span class="dsum">예약 <b>' + da.length + "</b>건 · <b>" + won(rows.reduce(function (a, r) { return a + net(r); }, 0)) + "</b>" + (da.some(function (r) { return r.pay_status === "unpaid"; }) ? " · 결제 전 " + won(da.filter(function (r) { return r.pay_status === "unpaid"; }).reduce(function (a, r) { return a + r.amount; }, 0)) : "") + "</span></div>"
            + '<div class="tbl-wrap"><table class="tbl ls-table">' + head + "<tbody>" + rows.map(function (r) {
              var tel = String(r.phone || "").replace(/[^0-9+]/g, "");
              return '<tr class="click' + (r.status === "cancelled" ? " cancelled" : "") + '" data-code="' + esc(r.code) + '">'
                + "<td>" + esc(timeText(r)) + "<small>" + esc(dur(r.end_min - r.start_min)) + "</small></td>"
                + "<td>" + esc(spaceName(r)) + "</td>"
                + '<td><b class="nm">' + esc(r.customer_name) + "</b><small>" + esc([r.phone, r.purpose].filter(Boolean).join(" · ")) + "</small></td>"
                + "<td>" + (r.people != null ? esc(r.people) + "명" : "—") + "</td>"
                + '<td class="r"><b>' + (r.external ? '금액 미제공' : won(r.amount)) + "</b>" + (r.refund_amount ? "<small>환불 " + won(r.refund_amount) + "</small>" : "") + "</td>"
                + "<td>" + pmTag(r.pay_method) + "<br>" + pstTag(r) + (r.status === "cancelled" ? ' <span class="st bad">취소</span>' : "") + "</td>"
                + "<td>" + esc(CHL[r.channel] || "—") + "</td>"
                + '<td class="mono nw">' + esc(r.code) + (r.inquiry_ref ? "<small>" + esc(r.inquiry_ref) + "</small>" : "") + "</td>"
                + '<td class="nw">' + (r.pay_status === "unpaid" && r.status === "confirmed" ? '<button class="btn btn-ok btn-xs" type="button" data-pay-now="' + esc(r.code) + '">결제 확인</button> ' : "") + (tel ? '<a class="btn btn-light btn-xs" href="tel:' + esc(tel) + '">전화</a>' : "") + "</td></tr>"
                + (r.memo ? '<tr class="memo' + (r.status === "cancelled" ? " cancelled" : "") + '" data-code="' + esc(r.code) + '"><td colspan="9">' + esc(r.memo) + "</td></tr>" : "");
            }).join("") + "</tbody></table></div></div>";
        }).join("") + "</div>";
    }).join("");
  }
  $("#ls-range").addEventListener("click", function (e) { var b = e.target.closest("[data-range]"); if (!b) return; setRange(b.dataset.range); loadList(); });
  ["#ls-from", "#ls-to"].forEach(function (s) { $(s).addEventListener("change", function () { LS.range = "custom"; $$("#ls-range [data-range]").forEach(function (b) { b.classList.remove("on"); }); loadList(); }); });
  ["#ls-status", "#ls-space", "#ls-pay", "#ls-pstatus"].forEach(function (s) { $(s).addEventListener("change", drawList); });
  $("#ls-q").addEventListener("input", drawList);
  $("#ls-reload").addEventListener("click", loadList);
  $("#ls-print").addEventListener("click", function () { var v = $("#view-list"); v.classList.add("printing"); window.print(); setTimeout(function () { v.classList.remove("printing"); }, 800); });
  $("#ls-csv").addEventListener("click", function () {
    var list = listFiltered(); if (!list.length) { toast("내려받을 예약이 없습니다."); return; }
    var cols = ["이용일", "요일", "시작", "종료", "이용 시간(분)", "공간", "예약자", "연락처", "인원", "모임 목적", "예약 경로", "요금표 금액", "결제 금액", "환불 금액", "매출", "결제수단", "결제 상태", "결제일", "예약 상태", "예약번호", "문의번호", "금액 메모", "메모", "등록 일시"];
    csvDownload("소셜팩토리_예약_" + ($("#ls-from").value || "처음") + "_" + ($("#ls-to").value || "이후") + ".csv", cols, list.map(function (r) {
      return [r.date, DOW[dow(r.date)], hm(r.start_min), hm(r.end_min), r.end_min - r.start_min, spaceName(r), r.external && /^[=+@\-\t\r]/.test(r.customer_name) ? "'" + r.customer_name : r.customer_name, r.phone, r.people == null ? "" : r.people, r.purpose, CHL[r.channel] || "", r.list_amount == null ? "" : r.list_amount, r.external ? "" : r.amount, r.external ? "" : r.refund_amount || 0, r.external ? "" : net(r), PAYL[r.pay_method] || r.pay_method, (r.external ? "금액 미제공" : (PST[r.pay_status] || [r.pay_status])[0]), r.paid_at || "", r.status === "cancelled" ? "취소" : "예약 확정", r.code, r.inquiry_ref || "", r.amount_note || "", r.memo || "", r.created_at];
    }));
  });

  /* =================== 매출 =================== */
  var SL = { year: null, basis: "use", data: null };
  function loadSales() {
    if (!SL.year) SL.year = todayIso().slice(0, 4);
    $$("#sl-basis [data-basis]").forEach(function (b) { b.classList.toggle("on", b.dataset.basis === SL.basis); });
    api("/api/admin/sales?year=" + SL.year + "&basis=" + SL.basis + "&orders=" + ($("#sl-orders").checked ? 1 : 0)).then(function (d) { SL.data = d; drawSales(); }).catch(fail($("#sl-methods")));
  }
  function bars(items, total) {
    var max = Math.max.apply(null, items.map(function (x) { return x.v; }).concat([1]));
    return items.map(function (x) {
      return '<div class="bar" style="--c:' + (x.c || "var(--blue)") + '"><span class="k"><span>' + esc(x.k) + '</span></span><span class="tr"><i style="width:' + (x.v ? Math.max(2, x.v / max * 100) : 0).toFixed(1) + '%"></i></span><span class="v"><b>' + won(x.v) + "</b><small>" + esc(x.s || "") + (total ? (x.s ? " · " : "") + (x.v / total * 100).toFixed(1) + "%" : "") + "</small></span></div>";
    }).join("") || emptyMsg("자료가 없습니다.");
  }
  function drawSales() {
    var d = SL.data, ms = d.methods || [], cur = todayIso().slice(0, 7);
    $("#sl-year").innerHTML = (d.years || [d.year]).map(function (y) { return '<option value="' + y + '"' + (y === d.year ? " selected" : "") + ">" + y + "년</option>"; }).join("");
    $("#sl-year-label").textContent = d.year + "년 · " + (d.basis === "paid" ? "결제일" : "이용일") + " 기준";
    $("#sl-kpis").innerHTML = '<div class="kpi accent"><small>누적 총매출</small><b>' + num(d.allTime.total) + "<em>원</em></b><span>전체 기간 " + num(d.allTime.n) + "건</span></div>"
      + '<div class="kpi"><small>' + esc(d.year) + "년 매출</small><b>" + num(d.total) + "<em>원</em></b><span>" + num(d.n) + "건" + (d.refunds ? " · 환불 " + won(d.refunds) + " 차감" : "") + "</span></div>"
      + '<div class="kpi"><small>이번 달 (' + (+d.thisMonth.ym.slice(5, 7)) + "월)</small><b>" + num(d.thisMonth.total) + "<em>원</em></b><span>" + num(d.thisMonth.n) + "건</span></div>"
      + '<div class="kpi"><small>지난달 (' + (+d.lastMonth.ym.slice(5, 7)) + "월)</small><b>" + num(d.lastMonth.total) + "<em>원</em></b><span>" + num(d.lastMonth.n) + "건" + (d.lastMonth.total ? " · 이번 달 " + (d.thisMonth.total >= d.lastMonth.total ? "+" : "") + Math.round((d.thisMonth.total - d.lastMonth.total) / d.lastMonth.total * 100) + "%" : "") + "</span></div>"
      + '<button type="button" class="kpi' + (d.unpaid.n ? " warn" : "") + '" data-go-unpaid><small>미수금 (결제 전)</small><b>' + num(d.unpaid.amount) + "<em>원</em></b><span>" + num(d.unpaid.n) + "건 · 누르면 목록</span></button>";
    $("#sl-methods").innerHTML = bars(ms.map(function (m) { return { k: m.label, v: d.byMethod[m.key] || 0, s: num(d.countBy[m.key] || 0) + "건", c: "var(--m-" + m.key + ")" }; }), d.total);
    var mx = Math.max.apply(null, d.months.map(function (m) { return m.total; }).concat([1]));
    $("#sl-chart").innerHTML = d.months.map(function (m) {
      var hgt = m.total / mx * 100;
      return '<div class="col' + (m.ym === cur ? " now" : "") + '" data-ym="' + m.ym + '" title="' + esc(+m.ym.slice(5, 7) + "월 " + won(m.total)) + '"><span class="val" style="bottom:calc(' + hgt.toFixed(1) + '% + 3px)">' + (m.total ? manwon(m.total) : "") + '</span><div class="stk" style="height:' + hgt.toFixed(1) + '%">'
        + ms.map(function (k) { var v = m.byMethod[k.key] || 0; return v ? '<i style="--c:var(--m-' + k.key + ");height:" + (v / (m.total || 1) * 100).toFixed(2) + '%"></i>' : ""; }).join("") + '</div><span class="lab">' + (+m.ym.slice(5, 7)) + "월</span></div>";
    }).join("");
    $("#sl-chart-legend").innerHTML = ms.map(function (m) { return '<span style="--c:var(--m-' + m.key + ')">' + esc(m.label) + "</span>"; }).join("");
    var th = "<thead><tr><th>월</th>" + ms.map(function (m) { return "<th>" + esc(m.label) + "</th>"; }).join("") + '<th class="sum">합계</th><th>건수</th><th>환불 차감</th><th>미수금</th></tr></thead>';
    var cell = function (v) { return v ? num(v) : '<span class="zero">0</span>'; };
    var tb = "<tbody>" + d.months.map(function (m) {
      return '<tr data-ym="' + m.ym + '"' + (m.ym === cur ? ' class="now"' : "") + "><td>" + (+m.ym.slice(5, 7)) + "월</td>" + ms.map(function (k) { return "<td" + (m.byMethod[k.key] ? "" : ' class="zero"') + ">" + cell(m.byMethod[k.key]) + "</td>"; }).join("") + '<td class="sum">' + num(m.total) + "</td><td>" + num(m.n) + "</td><td" + (m.refunds ? "" : ' class="zero"') + ">" + cell(m.refunds) + "</td><td" + (m.unpaid ? "" : ' class="zero"') + ">" + cell(m.unpaid) + "</td></tr>";
    }).join("") + "</tbody>";
    var tf = "<tfoot><tr><td>" + esc(d.year) + "년 합계</td>" + ms.map(function (k) { return "<td>" + num(d.byMethod[k.key]) + "</td>"; }).join("") + '<td class="sum">' + num(d.total) + "</td><td>" + num(d.n) + "</td><td>" + num(d.refunds) + "</td><td>" + num(d.months.reduce(function (a, m) { return a + m.unpaid; }, 0)) + "</td></tr></tfoot>";
    $("#sl-table").innerHTML = th + tb + tf;
    var resTotal = d.total - (d.byMethod.orders || 0);
    $("#sl-spaces").innerHTML = bars(SPACE_LIST.filter(function (s) { return (d.bySpace[s[0]] || {}).n; }).map(function (s) { var x = d.bySpace[s[0]]; return { k: s[1], v: x.amount, s: x.n + "건 · " + dur(x.minutes) }; }), resTotal);
    var chs = Object.keys(d.byChannel || {}).map(function (k) { var x = d.byChannel[k]; return { k: x.label, v: x.amount, s: x.n + "건", c: "var(--navy-80)" }; }).sort(function (a, b) { return b.v - a.v; });
    $("#sl-channels").innerHTML = bars(chs, d.channelTotal == null ? d.total : d.channelTotal);
    $("#sl-channel-details").innerHTML = '<table class="tbl"><thead><tr><th>채널</th><th>결제 건수</th><th>매출액</th><th>총매출 비중</th></tr></thead><tbody>' + chs.map(function (x) {
      return '<tr><td>' + esc(x.k) + '</td><td>' + esc(x.s) + '</td><td>' + won(x.v) + '</td><td>' + (d.total ? x.v / d.total * 100 : 0).toFixed(1) + '%</td></tr>';
    }).join('') + '</tbody><tfoot><tr><th>합계</th><td>' + num(d.n) + '건</td><td>' + won(d.total) + '</td><td>' + (d.total ? '100%' : '0%') + '</td></tr></tfoot></table>';
    $("#sl-channel-note").textContent = '채널별 비중은 선택한 연도 총매출 기준입니다. 홈페이지 이용권 포함 여부도 동일하게 적용합니다. 스페이스클라우드 금액 미등록 일정 ' + num(d.unrecordedSpacecloud || 0) + '건은 합계에서 제외됩니다. 캘린더는 결제금액을 제공하지 않습니다. 정산 엑셀 일괄 가져오기 또는 예약 상세에서 금액을 등록해 주세요.';
  }
  $("#sl-year").addEventListener("change", function () { SL.year = this.value; loadSales(); });
  $("#sl-basis").addEventListener("click", function (e) { var b = e.target.closest("[data-basis]"); if (!b) return; SL.basis = b.dataset.basis; loadSales(); });
  $("#sl-orders").addEventListener("change", loadSales);
  function openMonth(ym) { var d = parseIso(ym + "-01"); setRange("custom"); $("#ls-from").value = ym + "-01"; $("#ls-to").value = isoOf(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12)); LS.range = "custom"; $("#ls-status").value = ""; $("#ls-pstatus").value = ""; go("list"); }
  $("#sl-table").addEventListener("click", function (e) { var tr = e.target.closest("tr[data-ym]"); if (tr) openMonth(tr.dataset.ym); });
  $("#sl-chart").addEventListener("click", function (e) { var c = e.target.closest("[data-ym]"); if (c) openMonth(c.dataset.ym); });
  $("#sl-csv").addEventListener("click", function () {
    var d = SL.data; if (!d) return; var ms = d.methods;
    var rows = d.months.map(function (m) { return [m.ym].concat(ms.map(function (k) { return m.byMethod[k.key] || 0; })).concat([m.total, m.n, m.refunds, m.unpaid]); });
    rows.push([d.year + " 합계"].concat(ms.map(function (k) { return d.byMethod[k.key] || 0; })).concat([d.total, d.n, d.refunds, d.months.reduce(function (a, m) { return a + m.unpaid; }, 0)]));
    csvDownload("소셜팩토리_매출_" + d.year + "_" + (d.basis === "paid" ? "결제일기준" : "이용일기준") + ".csv", ["월"].concat(ms.map(function (k) { return k.label; })).concat(["합계", "건수", "환불 차감", "미수금"]), rows);
  });

  /* =================== 문의 =================== */
  var INQ = [], IST = { new: ["새 문의", "blue"], in_progress: ["진행 중", "warn"], done: ["처리 완료", "ok"] };
  function loadInq() {
    $("#inq-count").textContent = "불러오는 중…";
    var f = $("#inq-filter").value;
    api("/api/inquiry?limit=300" + (f ? "&status=" + f : "")).then(function (j) {
      INQ = j.results || []; INQ.forEach(function (q) { INQ_CACHE[q.id] = q; });
      $("#inq-count").textContent = INQ.length + "건";
      $("#inq-rows").innerHTML = INQ.length ? INQ.map(function (r) {
        var tel = String(r.phone || "").replace(/[^0-9+]/g, ""), n = r.notify_status || "";
        return "<tr><td><b class=\"mono\">" + esc(r.receipt) + "</b>" + (r.member_id ? '<br><span class="st blue">회원 #' + esc(r.member_id) + "</span>" : "") + (n && !/^sent/.test(n) ? '<br><span class="st ' + (/^failed/.test(n) ? "bad" : "gray") + '" title="운영자 알림">' + esc(n.slice(0, 20)) + "</span>" : "") + "</td>"
          + '<td class="nw">' + esc(String(r.created_at || "").slice(0, 16)) + "<small>" + esc(ago(r.created_at)) + "</small></td>"
          + '<td><select class="select select-sm" data-inq-st="' + r.id + '">' + Object.keys(IST).map(function (k) { return '<option value="' + k + '"' + (r.status === k ? " selected" : "") + ">" + IST[k][0] + "</option>"; }).join("") + "</select></td>"
          + "<td>" + esc(INQP[r.purpose] || r.purpose) + '<br><span class="st">' + esc(INQS[r.space] || r.space || "-") + "</span></td>"
          + "<td><b>" + esc(r.name) + "</b>" + (r.company ? "<small>" + esc(r.company) + "</small>" : "") + (tel ? '<small><a href="tel:' + esc(tel) + '">' + esc(r.phone) + "</a></small>" : "") + (r.email ? '<small><a href="mailto:' + esc(r.email) + '">' + esc(r.email) + "</a></small>" : "") + "</td>"
          + "<td>" + esc(r.when_text || "-") + "<small>" + esc(r.people || "") + "</small>" + (r.schedule ? "<small>" + esc(r.schedule) + "</small>" : "") + (r.consent ? "" : '<br><span class="st bad">동의 없음</span>') + "</td>"
          + '<td class="msgcell">' + esc(r.message) + "</td>"
          + '<td class="nw"><button class="btn btn-light btn-xs" type="button" data-inq-res="' + r.id + '">예약 등록</button></td></tr>';
      }).join("") : '<tr><td colspan="8">' + emptyMsg("문의가 없습니다.") + "</td></tr>";
    }).catch(function (e) { if (!guard(e)) $("#inq-count").textContent = e.message; });
  }
  $("#inq-rows").addEventListener("change", function (e) {
    var s = e.target.closest("[data-inq-st]"); if (!s) return;
    api("/api/inquiry", { method: "PATCH", body: { id: +s.dataset.inqSt, status: s.value } }).then(function () { toast("문의 상태를 '" + IST[s.value][0] + "'(으)로 바꿨습니다."); refreshCounts(); }).catch(function (x) { if (!guard(x)) toast(x.message); });
  });
  $("#inq-reload").addEventListener("click", loadInq); $("#inq-filter").addEventListener("change", loadInq);
  $("#inq-csv").addEventListener("click", function () {
    var cols = ["receipt", "created_at", "status", "purpose", "space", "name", "phone", "email", "company", "when_text", "people", "schedule", "message", "consent", "notice_version", "notify_status"];
    csvDownload("소셜팩토리_문의.csv", cols, INQ.map(function (r) { return cols.map(function (k) { return r[k]; }); }));
  });

  /* =================== 주문 · 결제 =================== */
  var ORD = [];
  var OST = { pending: ["결제 대기", ""], paid: ["결제 완료", "ok"], used: ["이용 완료", "blue"], cancelled: ["취소", "gray"], refund_requested: ["환불 요청", "warn"], refunded: ["환불 완료", "gray"], failed: ["결제 실패", "bad"] };
  var PGM = { Card: "카드", DirectBank: "계좌이체", VBank: "가상계좌", HPP: "휴대폰", Kakaopay: "카카오페이", NaverPay: "네이버페이", Samsungpay: "삼성페이", Payco: "페이코", "0": "카드", "1": "계좌이체", "2": "가상계좌", "3": "휴대폰" };
  function loadOrd() {
    $("#ord-count").textContent = "불러오는 중…";
    api("/api/admin/orders?status=" + encodeURIComponent($("#ord-filter").value) + "&q=" + encodeURIComponent($("#ord-q").value.trim())).then(function (j) {
      ORD = j.results || []; drawOrd(); $("#ord-count").textContent = "전체 주문 " + num(j.total) + "건 · 누적 매출 " + won(j.sales) + " (테스트 제외)";
    }).catch(function (e) { if (!guard(e)) $("#ord-count").textContent = e.code === "no-table" ? "주문 표(orders)가 아직 없습니다. 설정 상태를 확인해 주세요." : e.message; });
  }
  function drawOrd() {
    var list = ORD.filter(function (o) { return $("#ord-test").checked || !o.test_mode; });
    $("#ord-rows").innerHTML = list.length ? list.map(function (o) {
      var opts = ["paid", "used", "refund_requested", "refunded", "cancelled"];
      var sel = (o.status === "pending" || o.status === "failed") ? '<span class="st ' + OST[o.status][1] + '">' + OST[o.status][0] + "</span>" + (o.fail_msg ? "<small>" + esc(o.fail_msg) + "</small>" : "")
        : '<select class="select select-sm" data-ord-st="' + o.id + '">' + opts.map(function (k) { return '<option value="' + k + '"' + (o.status === k ? " selected" : "") + ">" + OST[k][0] + "</option>"; }).join("") + "</select>";
      var tel = String(o.buyer_phone || "").replace(/[^0-9+]/g, "");
      return '<tr><td><b class="mono">' + esc(o.oid) + "</b><small>" + esc(o.created_at) + "</small>" + (o.test_mode ? '<span class="st test">테스트</span> ' : "") + (o.member_id ? '<span class="st blue">회원 #' + esc(o.member_id) + "</span>" : "") + "</td>"
        + "<td>" + sel + "</td>"
        + "<td>" + esc(o.product_name) + "<small>" + esc(o.product_id) + " · " + esc(o.qty) + "개</small></td>"
        + '<td class="nw"><b>' + won(o.amount) + "</b></td>"
        + "<td>" + esc(o.buyer_name) + (tel ? '<small><a href="tel:' + esc(tel) + '">' + esc(o.buyer_phone) + "</a></small>" : "") + (o.buyer_email ? "<small>" + esc(o.buyer_email) + "</small>" : "") + "</td>"
        + "<td>" + esc(PGM[o.pg_method] || (o.pay_method === "bank" ? "계좌이체" : "카드")) + (o.card_name ? " · " + esc(o.card_name) : "") + (o.card_num ? "<small>" + esc(o.card_num) + "</small>" : "") + (o.paid_at ? "<small>" + esc(o.paid_at) + "</small>" : "") + (o.tid ? '<small class="mono">TID ' + esc(o.tid) + "</small>" : "") + "<small>" + (o.device === "mobile" ? "모바일" : "PC") + "</small></td>"
        + "<td>" + (o.start_date ? "<b>" + esc(o.start_date) + "</b>" : "-") + (o.memo ? "<small>" + esc(o.memo) + "</small>" : "") + "</td>"
        + '<td><textarea class="memo" data-ord-memo="' + o.id + '" placeholder="메모 (예: 11/8 입실, 환불 4,000원 취소 완료)">' + esc(o.admin_memo || "") + "</textarea></td></tr>";
    }).join("") : '<tr><td colspan="8">' + emptyMsg("주문이 없습니다.") + "</td></tr>";
  }
  $("#ord-rows").addEventListener("change", function (e) {
    var s = e.target.closest("[data-ord-st]");
    if (s) {
      if (s.value === "refunded" && !confirm("KG이니시스 가맹점관리자에서 결제 취소를 마쳤나요? 여기서는 상태만 기록됩니다.")) { loadOrd(); return; }
      api("/api/admin/orders", { method: "PATCH", body: { id: +s.dataset.ordSt, status: s.value } }).then(function () { toast("주문 상태를 바꿨습니다."); refreshCounts(); }).catch(function (x) { if (!guard(x)) toast(x.message); });
      return;
    }
    var m = e.target.closest("[data-ord-memo]");
    if (m) api("/api/admin/orders", { method: "PATCH", body: { id: +m.dataset.ordMemo, memo: m.value } }).then(function () { m.style.borderColor = "#1D8A4E"; setTimeout(function () { m.style.borderColor = ""; }, 1200); }).catch(function (x) { if (!guard(x)) toast(x.message); });
  });
  $("#ord-reload").addEventListener("click", loadOrd); $("#ord-filter").addEventListener("change", loadOrd); $("#ord-test").addEventListener("change", drawOrd);
  $("#ord-q").addEventListener("keydown", function (e) { if (e.key === "Enter") loadOrd(); });
  $("#ord-csv").addEventListener("click", function () {
    var cols = ["oid", "created_at", "status", "product_id", "product_name", "qty", "amount", "buyer_name", "buyer_phone", "buyer_email", "start_date", "memo", "admin_memo", "pay_method", "pg_method", "card_name", "card_num", "tid", "paid_at", "device", "member_id", "test_mode"];
    csvDownload("소셜팩토리_주문.csv", cols, ORD.map(function (o) { return cols.map(function (k) { return o[k]; }); }));
  });

  /* =================== 회원 =================== */
  var MEM = [];
  function loadMem() {
    $("#mem-count").textContent = "불러오는 중…";
    api("/api/admin/members?q=" + encodeURIComponent($("#mem-q").value.trim()) + ($("#mem-mk").checked ? "&marketing=1" : "")).then(function (j) {
      MEM = j.results || [];
      $("#mem-count").textContent = "전체 " + num(j.total) + "명 · 소식 수신 동의 " + num(j.marketing) + "명 · 표시 " + MEM.length + "명";
      $("#mem-rows").innerHTML = MEM.length ? MEM.map(function (m) {
        return "<tr><td>" + esc(m.id) + '</td><td class="nw">' + esc(m.created_at) + "</td><td><b>" + esc(m.name) + "</b><small>" + esc(m.phone) + "</small>" + (m.email ? "<small>" + esc(m.email) + "</small>" : "") + (m.must_change_pw ? '<span class="st warn">임시 비밀번호</span>' : "") + "</td>"
          + "<td>" + (m.marketing ? '<span class="st ok">동의</span><small>' + esc(m.marketing_at || "") + "</small>" : '<span class="st">-</span>') + "</td>"
          + "<td>" + (m.status === "active" ? '<span class="st ok">정상</span>' : '<span class="st bad">정지</span>') + "</td>"
          + "<td>" + esc(m.inquiries == null ? "-" : m.inquiries) + '</td><td class="nw">' + esc(m.last_login_at || "-") + "</td>"
          + '<td><div class="row-actions"><button class="btn btn-light btn-xs" type="button" data-mem="reset" data-id="' + m.id + '">임시 비밀번호</button><button class="btn btn-light btn-xs" type="button" data-mem="' + (m.status === "active" ? "block" : "unblock") + '" data-id="' + m.id + '">' + (m.status === "active" ? "이용 정지" : "정지 해제") + '</button><button class="btn btn-danger btn-xs" type="button" data-mem="delete" data-id="' + m.id + '">삭제</button></div></td></tr>';
      }).join("") : '<tr><td colspan="8">' + emptyMsg("회원이 없습니다.") + "</td></tr>";
    }).catch(function (e) { if (!guard(e)) $("#mem-count").textContent = e.message; });
  }
  $("#mem-rows").addEventListener("click", function (e) {
    var b = e.target.closest("[data-mem]"); if (!b) return;
    var id = +b.dataset.id, act = b.dataset.mem, m = MEM.filter(function (x) { return x.id === id; })[0] || {};
    var ask = { reset: m.name + "님에게 임시 비밀번호를 새로 발급할까요? 지금 로그인된 기기는 모두 로그아웃됩니다.", block: m.name + "님의 이용을 정지할까요?", unblock: m.name + "님의 이용 정지를 풀까요?", "delete": m.name + "님의 회원 정보를 삭제할까요? 되돌릴 수 없습니다." }[act];
    if (!confirm(ask)) return;
    api("/api/admin/members", { method: act === "delete" ? "DELETE" : "PATCH", body: act === "delete" ? { id: id } : { id: id, action: act } }).then(function (j) {
      if (act === "reset") { var t = $("#mem-temp"); t.hidden = false; t.innerHTML = esc(m.name) + "님 임시 비밀번호: <b>" + esc(j.tempPassword) + "</b> — 이 화면을 닫으면 다시 볼 수 없으니 회원에게 바로 전달해 주세요."; }
      loadMem();
    }).catch(function (x) { if (!guard(x)) toast(x.message); });
  });
  $("#mem-reload").addEventListener("click", loadMem); $("#mem-mk").addEventListener("change", loadMem);
  $("#mem-q").addEventListener("keydown", function (e) { if (e.key === "Enter") loadMem(); });
  $("#mem-csv").addEventListener("click", function () {
    var cols = ["id", "created_at", "name", "phone", "email", "marketing", "marketing_at", "status", "last_login_at"];
    csvDownload("소셜팩토리_회원.csv", cols, MEM.map(function (m) { return cols.map(function (k) { return m[k]; }); }));
  });

  /* =================== 상품 · 설정 상태 =================== */
  function loadStats() {
    if (CUR === "set") loadSpacecloudSettings();
    api("/api/admin/stats").then(function (s) {
      $("#prod").innerHTML = (s.products || []).map(function (p) { return '<div class="p"><small>' + esc(p.category) + "</small><b>" + esc(p.name) + '</b><div class="pr">' + won(p.price) + '</div><div class="so">누적 판매 ' + num(p.sold) + " · " + won(p.sales) + '</div><a href="/product/' + esc(p.id) + '" target="_blank" rel="noopener">상품 페이지 보기 →</a></div>'; }).join("") || emptyMsg("상품이 없습니다.");
      var st = s.setup || {}, t = st.tables || {};
      var li = function (ok, title, desc, opt) { return '<li><span class="s ' + (ok ? "ok" : (opt ? "opt" : "no")) + '">' + (ok ? "✓" : (opt ? "–" : "!")) + "</span><div><b>" + title + "</b><small>" + desc + "</small></div></li>"; };
      $("#set-req").innerHTML =
        li(st.db, "D1 데이터베이스 연결 (<code>DB</code>)", st.db ? "연결되어 있습니다." : "Pages → Settings → Bindings 에서 D1 을 DB 이름으로 연결해 주세요.")
        + li(st.adminKey, "관리자 비밀번호 (<code>ADMIN_KEY</code>)", "이 화면에 로그인할 때 쓰는 값입니다. 바꾸면 모든 기기에서 로그아웃됩니다.")
        + li(st.sessionSecret, "세션 비밀값 (<code>SESSION_SECRET</code>)", st.sessionSecret ? "설정되어 있습니다." : "회원 로그인 쿠키 서명에 씁니다. 긴 무작위 문자열을 넣어 주세요.")
        + li(t.reservations && t.admin_sessions, "예약 · 관리자 로그인 표 (reservations · admin_sessions)", t.reservations ? "준비되어 있습니다. (관리자 로그인 때 자동으로 만들어집니다)" : "관리자 화면에 로그인하면 자동으로 만들어집니다. 그래도 없으면 schema-upgrade-reservations.sql 을 실행해 주세요.")
        + li(t.inquiries, "문의 표 (inquiries)", t.inquiries ? "준비되어 있습니다." : "schema.sql 을 D1 콘솔에서 실행해 주세요.")
        + li(t.members && t.sessions, "회원 표 (members · sessions)", t.members ? "준비되어 있습니다." : "schema.sql 또는 schema-upgrade-members.sql 을 실행해 주세요.")
        + li(t.orders, "주문 표 (orders)", t.orders ? "준비되어 있습니다." : "schema-upgrade-orders.sql 을 D1 콘솔에서 실행해 주세요.");
      $("#set-pay").innerHTML =
        li(st.inicis, "상점 아이디 · Sign Key (<code>INICIS_MID</code> · <code>INICIS_SIGN_KEY</code>)", st.inicis ? "설정되어 있습니다 (MID " + esc(st.inicisMid) + "). " + (st.inicisTest ? "지금은 테스트 결제 상태입니다 — 실제 돈이 오가지 않습니다." : "운영 결제 상태입니다.") : "없으면 상품은 보이되 '결제 준비 중'으로 표시됩니다.")
        + li(st.inicisMobile, "모바일 Hash Key (<code>INICIS_MOBILE_HASH_KEY</code>)", st.inicisMobile ? "휴대폰에서는 이니시스 모바일 결제 페이지를 씁니다." : "없으면 휴대폰에서도 PC 결제창을 씁니다 (동작에는 문제 없음).", true)
        + li(!st.inicisTest || !st.inicis, "운영 전환 (<code>INICIS_TEST</code> 지우기)", st.inicis && st.inicisTest ? "심사가 끝나고 실제 MID 를 받으면 INICIS_MID · INICIS_SIGN_KEY 를 실제 값으로 바꾸고 INICIS_TEST 를 지워 주세요." : "테스트 표시가 꺼져 있습니다.", true);
      $("#set-opt").innerHTML =
        li(st.ipSalt, "IP 해시 소금값 (<code>IP_SALT</code>)", "접속 IP 를 그대로 저장하지 않기 위한 값입니다. 없어도 동작합니다.", true)
        + li(st.webhook, "알림 웹훅 (<code>NOTIFY_WEBHOOK</code>)", st.webhook ? "새 문의 · 결제 완료가 웹훅으로 전달됩니다." : "슬랙 · 디스코드 웹훅 주소를 넣으면 새 문의와 결제 완료를 바로 받을 수 있습니다.", true);
    }).catch(fail($("#prod")));
  }

  /* =================== 시작 =================== */
  LOAD.dash = loadDash; LOAD.board = loadBoard; LOAD.list = loadList; LOAD.sales = loadSales;
  LOAD.inq = loadInq; LOAD.ord = loadOrd; LOAD.mem = loadMem; LOAD.prod = loadStats; LOAD.set = loadStats;
  api("/api/admin/session").then(showApp).catch(function (e) { showLogin(e.status === 401 && e.code === "ADMIN_LOGIN" ? "" : loginErr(e)); });
})();
