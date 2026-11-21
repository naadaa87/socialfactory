/* 소셜팩토리 모임 지원 — 모임 초대장 · 초대장 관리 · 룸 가이드 · 예약 상세의 초대장 칸
   - /i/abc123 (data-meet-page="invite"), /meet-manage (data-meet-page="manage"), /room?s=r3&k=… (data-meet-page="room")
   - /booking-status 의 [data-meet-booking] 칸
   서버: /api/meet/* (functions/_lib/meet.js) */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var CFG = window.SF_CONFIG || {};
  var KAKAO = ((CFG.contact && CFG.contact.kakao) || "https://pf.kakao.com/_uTiFX").replace(/\/chat$/, "") + "/chat";
  var DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  var ICON = {
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6.1-6.5-11A6.5 6.5 0 0 1 18.5 10c0 4.9-6.5 11-6.5 11z" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="10" r="2.4" fill="currentColor"/></svg>',
    car: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16.5V12l1.8-4.6A2 2 0 0 1 8.7 6h6.6a2 2 0 0 1 1.9 1.4L19 12v4.5M5 12h14M5 16.5h14v2H5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="8" cy="14.3" r="1" fill="currentColor"/><circle cx="16" cy="14.3" r="1" fill="currentColor"/></svg>',
    cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" stroke="currentColor" stroke-width="1.8"/></svg>',
    wifi: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9.5a13 13 0 0 1 18 0M6.2 12.8a8.5 8.5 0 0 1 11.6 0M9.4 16a4 4 0 0 1 5.2 0" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/></svg>',
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h9l4 4v12H6z M14.5 4v4.5H19M9 12h7M9 15.5h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5.5M12 7.6v.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    users: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.5" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5M15.5 5.6a3 3 0 0 1 0 5.8M17 14.3c1.9.5 3 2.1 3.5 4.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    screen: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9 20h6M12 16v4" stroke="currentColor" stroke-width="1.8"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    help: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 4v-14z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.5" cy="7.5" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="16.5" cy="7.5" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="7.5" cy="16.5" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="16.5" cy="16.5" r="3" fill="currentColor"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="6" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="18.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1" stroke="currentColor" stroke-width="1.8"/></svg>'
  };
  var THEMES = { meet: "모임", study: "스터디", book: "독서모임", "class": "클래스 · 강의", seminar: "세미나 · 강연", workshop: "워크숍", meeting: "회의", party: "친목 · 파티" };

  /* ---------- 공통 ---------- */
  function api(method, url, body, headers) {
    var h = {}; if (body) h["Content-Type"] = "application/json";
    if (headers) Object.keys(headers).forEach(function (k) { h[k] = headers[k]; });
    return fetch(url, { method: method, credentials: "same-origin", cache: "no-store", headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j || {} }; }, function () { return { status: r.status, j: {} }; }); })
      .catch(function () { return { status: 0, j: { message: "서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요." } }; });
  }
  var errMsg = function (r) { return (r.j && r.j.message) || "처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요."; };
  var toastT;
  function toast(msg) {
    var t = $(".mt-toast");
    if (!t) { t = document.createElement("div"); t.className = "mt-toast"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite"); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 3000);
  }
  function copy(text, done) {
    var ok = function () { toast(done || "복사했습니다."); };
    var fallback = function () {
      var ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); ok(); } catch (e) { window.prompt("아래 내용을 복사해 주세요.", text); } ta.remove();
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
  }
  function store(key, val) { try { if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null"); localStorage.setItem(key, JSON.stringify(val)); } catch (e) { return null; } return val; }
  function deviceId() {
    var id = store("sf-meet-device");
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      var a = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(a);
      id = Array.prototype.map.call(a, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
      store("sf-meet-device", id);
    }
    return id;
  }
  function rememberKey(slug, key) { var all = store("sf-meet-keys") || {}; all[slug] = key; store("sf-meet-keys", all); }
  function knownKey(slug) { var all = store("sf-meet-keys") || {}; return all[slug] || ""; }
  function linkify(text) {
    return esc(text).replace(/https?:\/\/[^\s<]+/g, function (u) {
      var tail = (/[.,)!?\]]+$/.exec(u) || [""])[0]; u = u.slice(0, u.length - tail.length);
      return '<a href="' + u + '" target="_blank" rel="noopener nofollow ugc">' + u + "</a>" + tail;
    });
  }
  function timeLabel(min) {
    var m = ((min % 1440) + 1440) % 1440, h = Math.floor(m / 60), mm = m % 60;
    return (h < 12 ? "오전 " : "오후 ") + ((h % 12) || 12) + (mm ? ":" + ("0" + mm).slice(-2) : "시");
  }
  function dateLabel(date) { var d = new Date(date + "T00:00:00Z"); return (d.getUTCMonth() + 1) + "월 " + d.getUTCDate() + "일(" + DAYS[d.getUTCDay()] + ")"; }
  function rangeLabel(inv) {
    var end = inv.endMin >= 1440 ? "다음 날 " + timeLabel(inv.endMin) : timeLabel(inv.endMin);
    return dateLabel(inv.date) + " " + timeLabel(inv.startMin) + " ~ " + end;
  }
  function dday(inv) {
    if (inv.phase === "closed") return { text: "닫힌 초대장", cls: "grey" };
    if (inv.phase === "ended") return { text: "끝난 모임", cls: "grey" };
    if (inv.phase === "live") return { text: "지금 모이는 중", cls: "blue" };
    var today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    var diff = Math.round((Date.parse(inv.date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400e3);
    if (diff <= 0) return { text: "오늘", cls: "blue" };
    if (diff === 1) return { text: "내일", cls: "blue" };
    return { text: "D-" + diff, cls: "light" };
  }
  var mapLinks = function (place) {
    var q = encodeURIComponent(place.road + " 한아름건물");
    return '<div class="mt-maps"><a class="btn btn-outline" href="https://map.kakao.com/?q=' + q + '" target="_blank" rel="noopener">카카오맵</a>'
      + '<a class="btn btn-outline" href="https://map.naver.com/p/search/' + q + '" target="_blank" rel="noopener">네이버 지도</a>'
      + '<a class="btn btn-outline" href="https://www.google.com/maps/search/?api=1&amp;query=' + q + '" target="_blank" rel="noopener">구글 지도</a>'
      + '<button type="button" class="btn btn-outline" data-copy="' + esc(place.road + " " + place.building) + '" data-copy-done="주소를 복사했습니다.">주소 복사</button></div>';
  };
  function wifiBlock(list, opts) {
    opts = opts || {};
    if (!list || !list.length) return "";
    return '<div class="mt-wifi">' + list.map(function (n) {
      return '<div class="mt-net"><div class="mt-net-ssids">' + n.ssids.map(function (s) { return "<span>" + esc(s) + "</span>"; }).join("") + "</div>"
        + (n.password ? '<div class="mt-net-pw"><span>비밀번호</span><code>' + esc(n.password) + '</code><button type="button" class="mt-mini" data-copy="' + esc(n.password) + '" data-copy-done="와이파이 비밀번호를 복사했습니다.">복사</button></div>' : '<div class="mt-net-pw"><span>비밀번호 없이 연결됩니다</span></div>')
        + "</div>";
    }).join("") + "</div>"
      + '<p class="mt-tip">' + (list.length > 1 ? "이 공간에서는 두 와이파이를 모두 쓸 수 있습니다. 신호가 더 잘 잡히는 쪽에 연결하세요. " : "")
      + "이름 끝의 5G는 빠르고, 2.4G는 벽 너머에서도 잘 잡힙니다. 6G는 최신 기기에서만 보입니다." + (opts.extra || "") + "</p>";
  }
  document.addEventListener("click", function (e) {
    var c = e.target.closest("[data-copy]");
    if (c) { e.preventDefault(); copy(c.getAttribute("data-copy"), c.getAttribute("data-copy-done")); }
  });
  function shareLink(url, title, text) {
    if (navigator.share) { navigator.share({ title: title, text: text, url: url }).catch(function () {}); return; }
    copy(url, "링크를 복사했습니다. 단체방에 붙여 넣어 주세요.");
  }
  function qrInto(box, text) {
    if (!box) return;
    if (typeof window.qrcode !== "function") { box.innerHTML = '<span class="note">QR을 불러오지 못했습니다</span>'; return; }
    var q = window.qrcode(0, "M"); q.addData(text); q.make();
    box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    var svg = $("svg", box); if (svg) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "초대장 QR 코드"); }
  }
  function qrPng(text, size) {
    var q = window.qrcode(0, "M"); q.addData(text); q.make();
    var n = q.getModuleCount(), cell = Math.floor(size / (n + 8)), pad = Math.floor((size - cell * n) / 2);
    var c = document.createElement("canvas"); c.width = size; c.height = size;
    var x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, size, size); x.fillStyle = "#18233A";
    for (var r = 0; r < n; r++) for (var col = 0; col < n; col++) if (q.isDark(r, col)) x.fillRect(pad + col * cell, pad + r * cell, cell, cell);
    return c.toDataURL("image/png");
  }
  window.SF_MEET = { qrInto: qrInto, qrPng: qrPng, copy: copy, esc: esc };

  var invitePage = document.querySelector('[data-meet-page="invite"]');
  var managePage = document.querySelector('[data-meet-page="manage"]');
  var roomPage = document.querySelector('[data-meet-page="room"]');
  var bookingBox = document.querySelector("[data-meet-booking]");

  /* =================================================================
     모임 초대장 (/i/abc123)
     ================================================================= */
  if (invitePage) (function () {
    var root = $("[data-mt-root]"), slugM = /^\/i\/([a-z0-9]{6,16})/.exec(location.pathname);
    var slug = slugM ? slugM[1] : (new URLSearchParams(location.search).get("c") || "");
    var device = deviceId(), INV = null, editing = false, answerPick = "";
    var notFound = function (msg) {
      root.innerHTML = '<div class="mt-card mt-end"><h2>초대장을 찾을 수 없습니다</h2><p class="mt-sub">' + esc(msg || "주소가 바뀌었거나 지난 모임의 초대장입니다. 모임장에게 새 초대장을 받아 주세요.") + '</p><div class="actions" style="justify-content:center"><a class="btn btn-primary" href="/">소셜팩토리 홈</a><a class="btn btn-outline" href="/guide#location">오시는 길</a></div></div>';
    };
    function rsvpCard(inv) {
      var c = inv.counts || {}, cap = inv.capacity, over = cap && c.yes > cap;
      var h = '<section class="mt-card" id="rsvp"><h2><span class="mt-ico">' + ICON.users + "</span>참석 여부</h2>";
      var mine = inv.mine;
      if (!inv.rsvpOpen) {
        h += '<p class="mt-sub">' + (inv.phase === "ended" ? "끝난 모임입니다." : inv.phase === "closed" ? "초대장이 닫혀 참석 응답을 받지 않습니다." : "지금은 참석 응답을 받지 않습니다. 모임장에게 직접 알려 주세요.") + "</p>";
        if (mine) h += '<div class="mt-mine' + (mine.answer === "no" ? " no" : "") + '"><span><b>' + esc(mine.name) + "</b> 님은 " + (mine.answer === "yes" ? "참석" : "불참") + "으로 답했습니다.</span></div>";
      } else if (mine && !editing) {
        h += '<div class="mt-mine' + (mine.answer === "no" ? " no" : "") + '"><span><b>' + esc(mine.name) + "</b> 님은 <b>" + (mine.answer === "yes" ? "참석" : "불참") + "</b>으로 답했습니다." + (mine.note ? " (" + esc(mine.note) + ")" : "") + (mine.car ? " · 차량 이용" : "") + '</span><span class="mt-mine-acts"><button type="button" class="mt-mini" data-rsvp-edit>고치기</button><button type="button" class="mt-mini" data-rsvp-del>응답 지우기</button></span></div>';
      } else {
        var pick = answerPick || (mine ? mine.answer : "");
        h += '<p class="mt-sub">가입하지 않아도 됩니다. 모임장이 알아볼 수 있는 이름이나 별명만 적어 주세요.</p>'
          + '<form data-rsvp-form novalidate><div class="mt-rsvp-row">'
          + '<button type="button" class="mt-answer" data-answer="yes" aria-pressed="' + (pick === "yes") + '">참석할게요<small>갈 수 있어요</small></button>'
          + '<button type="button" class="mt-answer no" data-answer="no" aria-pressed="' + (pick === "no") + '">이번엔 어려워요<small>다음에 만나요</small></button></div>'
          + '<div class="mt-field"><label for="mt-name">이름 · 별명</label><input id="mt-name" name="name" maxlength="20" autocomplete="nickname" value="' + esc(mine ? mine.name : (store("sf-meet-name") || "")) + '" placeholder="예) 김민지, 책벌레"></div>'
          + '<div class="mt-field"><label for="mt-note">한마디 <span class="hint">(선택)</span></label><input id="mt-note" name="note" maxlength="60" value="' + esc(mine ? mine.note : "") + '" placeholder="예) 10분 정도 늦어요"></div>'
          + '<label class="mt-check" data-car-row' + (pick === "no" ? " hidden" : "") + '><input type="checkbox" name="car"' + (mine && mine.car ? " checked" : "") + "> 차를 가져가요 (주차 안내를 확인할게요)</label>"
          + '<div class="actions"><button type="submit" class="btn btn-primary">응답 보내기</button>' + (mine ? '<button type="button" class="btn btn-outline" data-rsvp-cancel>취소</button>' : "") + "</div>"
          + '<p class="mt-status" data-rsvp-msg role="status"></p></form>';
      }
      h += '<div class="mt-count"><b>참석 ' + (c.yes || 0) + "명</b>" + (cap ? '<div class="mt-meter' + (over ? " over" : "") + '"><i style="width:' + Math.min(100, Math.round((c.yes || 0) / cap * 100)) + '%"></i></div><span>최대 ' + cap + "명</span>" : "") + "</div>";
      if (over) h += '<p class="mt-status err">참석 인원이 이 방의 최대 인원을 넘었습니다. 모임장에게 알려 주세요.</p>';
      if (inv.showNames && inv.names && inv.names.length) h += '<div class="mt-names">' + inv.names.map(function (n) { return "<span>" + esc(n) + "</span>"; }).join("") + "</div>";
      return h + "</section>";
    }
    function render(inv) {
      INV = inv;
      document.title = inv.title + " · " + dateLabel(inv.date) + " | 소셜팩토리 건대";
      var d = dday(inv), p = inv.place || {};
      var h = '<div class="mt-stack">';
      h += '<header class="mt-cover t-' + esc(inv.theme) + '"><div class="mt-cover-top"><span class="mt-chip">' + esc(inv.themeName) + '</span><span class="mt-chip ' + d.cls + '">' + d.text + "</span></div>"
        + "<h1>" + esc(inv.title) + "</h1>" + (inv.host ? '<p class="mt-host"><b>' + esc(inv.host) + "</b> 님이 초대했어요</p>" : "")
        + '<div class="mt-when"><b>' + esc(rangeLabel(inv)) + "</b><span>소셜팩토리 건대 " + esc(inv.spaceName) + (inv.spaceSub ? " · " + esc(inv.spaceSub) : "") + "</span></div></header>";
      if (inv.phase === "closed") h += '<section class="mt-card"><h2><span class="mt-ico">' + ICON.info + '</span>닫힌 초대장입니다</h2><p class="mt-sub">예약이 바뀌었거나 모임장이 초대장을 닫았습니다. 일정은 모임장에게 직접 확인해 주세요.</p></section>';
      if (inv.entry || (inv.wifi && inv.wifi.length)) {
        h += '<section class="mt-card mt-today" id="today"><h2><span class="mt-ico">' + ICON.clock + "</span>오늘의 안내</h2>";
        if (inv.entry) h += '<p class="mt-sub">모임장이 남긴 출입 안내입니다.</p><div class="mt-entry">' + linkify(inv.entry) + "</div>";
        if (inv.wifi && inv.wifi.length) h += '<p class="mt-sub" style="margin-top:16px"><b>와이파이</b> · ' + esc(inv.spaceName) + "</p>" + wifiBlock(inv.wifi);
        h += "</section>";
      }
      if (inv.phase !== "closed") h += rsvpCard(inv);
      if (inv.message) h += '<section class="mt-card"><h2><span class="mt-ico">' + ICON.note + "</span>모임장 안내</h2><div class=\"mt-text\">" + linkify(inv.message) + "</div></section>";
      h += '<section class="mt-card" id="place"><h2><span class="mt-ico">' + ICON.pin + "</span>장소와 찾아오는 길</h2>"
        + '<dl class="mt-dl"><div><dt>장소</dt><dd>소셜팩토리 건대 ' + esc(inv.spaceName) + "<small>" + esc(inv.spaceSub || "") + (inv.capacity ? " · 최대 " + inv.capacity + "명" : "") + (inv.gear ? " · " + esc(inv.gear) : "") + "</small></dd></div>"
        + "<div><dt>주소</dt><dd>" + esc(p.road) + " " + esc(p.building) + "<small>지번 " + esc(p.address) + "</small></dd></div></dl>"
        + mapLinks(p)
        + '<ol class="mt-steps"><li><span><b>지하철</b> 2 · 7호선 건대입구역에서 걸어올 수 있습니다. 지도 앱의 길찾기로 한아름건물을 찾아오세요.</span></li>'
        + "<li><span><b>건물</b> 한아름건물로 들어와 4층으로 올라옵니다. 층별 안내판의 '4F 소셜팩토리' 표시를 따라오세요.</span></li>"
        + "<li><span><b>" + esc(inv.spaceName) + "</b> " + esc(inv.way || "4층 안내도에서 방 위치를 확인하세요.") + "</span></li>"
        + "<li><span><b>먼저 왔다면</b> 예약 시간 전에는 방에 들어갈 수 없습니다. 출입구 옆 휴게 · 대기 공간에서 기다려 주세요.</span></li></ol></section>";
      h += '<section class="mt-card" id="parking"><h2><span class="mt-ico">' + ICON.car + "</span>차로 오시나요</h2>"
        + '<p class="mt-sub">한아름건물 주차장을 쓸 수 있습니다. 주차권 요금과 사는 방법은 주차 안내에서 확인해 주세요. 근처 공영주차장 안내도 함께 있습니다.</p>'
        + '<div class="actions"><a class="btn btn-primary" href="/parking">주차 안내 · 주차권</a></div></section>';
      h += '<section class="mt-card"><h2><span class="mt-ico">' + ICON.cal + '</span>일정 저장</h2><p class="mt-sub">휴대폰 캘린더에 넣어 두면 모임 한 시간 전에 알려 줍니다.</p>'
        + '<div class="mt-cal"><a class="btn btn-primary" href="/api/meet/invite/' + esc(inv.slug) + '/calendar.ics">캘린더에 추가</a><a class="btn btn-outline" href="' + esc(googleCal(inv)) + '" target="_blank" rel="noopener">구글 캘린더</a></div></section>';
      h += '<section class="mt-card"><h2><span class="mt-ico">' + ICON.info + "</span>알아 두세요</h2><ul class=\"mt-list\">"
        + "<li>준비와 정리 시간까지 <b>예약한 시간 안에서</b> 이용합니다. 시간이 모자라면 모임장에게 알려 주세요.</li>"
        + "<li>음료와 다과는 가져와도 됩니다. 건물이 교육환경보호구역 안에 있어 <b>주류는 반입할 수 없습니다.</b></li>"
        + "<li>22시 이후에는 앰프를 쓸 수 없고, 23시 이후에는 조용히 이용해 주세요.</li>"
        + "<li>방 안의 QR을 찍으면 와이파이와 장비 사용법, 퇴실 전 확인 목록을 볼 수 있습니다.</li></ul></section>";
      h += '<section class="mt-card"><h2><span class="mt-ico">' + ICON.share + '</span>초대장 함께 보기</h2><p class="mt-sub">아직 초대장을 못 받은 일행이 있다면 이 링크를 보내 주세요.</p>'
        + '<div class="mt-share"><input readonly value="' + esc(inv.url) + '" aria-label="초대장 주소"><button type="button" class="btn btn-primary" data-share-invite>공유</button></div></section>';
      h += '<section class="mt-card mt-cta"><div><h2>모임에서 쓸 도구가 필요하다면</h2><p>타이머, 팀 나누기, 대화 카드, 라이어 게임까지. 방의 화면에 띄워 함께 쓸 수 있습니다.</p></div><div class="actions"><a class="btn btn-primary" href="/play">모임 도구 · 게임</a><a class="btn btn-outline" href="/space">나도 여기서 모임 열기</a></div></section>';
      var key = knownKey(inv.slug);
      if (key) h += '<p class="mt-host-more"><a href="/meet-manage?c=' + esc(inv.slug) + "#k=" + esc(key) + '">초대장 관리 (모임장 전용) →</a></p>';
      h += "</div>";
      root.innerHTML = h;
    }
    function googleCal(inv) {
      var z = function (ms) { return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); };
      var p = inv.place || {};
      return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(inv.title) + "&dates=" + z(inv.startAt) + "/" + z(inv.endAt)
        + "&location=" + encodeURIComponent("소셜팩토리 건대 " + inv.spaceName + ", " + p.road + " " + p.building) + "&details=" + encodeURIComponent("초대장: " + inv.url);
    }
    function load() {
      if (!/^[a-z0-9]{6,16}$/.test(slug)) { notFound(); return; }
      api("GET", "/api/meet/invite/" + slug, null, { "X-Device": device }).then(function (r) {
        if (r.status !== 200) { notFound(r.status === 404 ? "" : errMsg(r)); return; }
        render(r.j.invite);
        try { var k = "sf-meet-v-" + slug; if (!sessionStorage.getItem(k)) { sessionStorage.setItem(k, "1"); api("POST", "/api/meet/invite/" + slug + "/view"); } } catch (e) { /* 무시 */ }
      });
    }
    root.addEventListener("click", function (e) {
      var t;
      if ((t = e.target.closest("[data-answer]"))) {
        answerPick = t.getAttribute("data-answer");
        $$("[data-answer]", root).forEach(function (b) { b.setAttribute("aria-pressed", b === t ? "true" : "false"); });
        var car = $("[data-car-row]", root); if (car) car.hidden = answerPick === "no";
        var nm = $("#mt-name"); if (nm && !nm.value) nm.focus();
      } else if (e.target.closest("[data-rsvp-edit]")) { editing = true; answerPick = INV.mine ? INV.mine.answer : ""; render(INV); var n = $("#mt-name"); if (n) n.focus(); }
      else if (e.target.closest("[data-rsvp-cancel]")) { editing = false; answerPick = ""; render(INV); }
      else if (e.target.closest("[data-rsvp-del]")) {
        if (!window.confirm("참석 응답을 지울까요?")) return;
        api("DELETE", "/api/meet/invite/" + slug + "/rsvp", { device: device }).then(function (r) {
          if (r.status !== 200) { toast(errMsg(r)); return; }
          editing = false; answerPick = ""; render(r.j.invite); toast("응답을 지웠습니다.");
        });
      } else if (e.target.closest("[data-share-invite]")) shareLink(INV.url, INV.title, INV.title + " · " + rangeLabel(INV));
    });
    root.addEventListener("submit", function (e) {
      var f = e.target.closest("[data-rsvp-form]"); if (!f) return;
      e.preventDefault();
      var msg = $("[data-rsvp-msg]", f), name = f.name.value.trim();
      if (!answerPick) { msg.textContent = "참석할지 먼저 골라 주세요."; msg.className = "mt-status err"; return; }
      if (!name) { msg.textContent = "이름이나 별명을 적어 주세요."; msg.className = "mt-status err"; f.name.focus(); return; }
      var btn = $("[type=submit]", f); btn.disabled = true; msg.textContent = "보내는 중…"; msg.className = "mt-status";
      api("POST", "/api/meet/invite/" + slug + "/rsvp", { device: device, name: name, answer: answerPick, note: f.note.value.trim(), car: f.car && f.car.checked && answerPick === "yes" }).then(function (r) {
        btn.disabled = false;
        if (r.status !== 200) { msg.textContent = errMsg(r); msg.className = "mt-status err"; return; }
        store("sf-meet-name", name); editing = false; answerPick = "";
        render(r.j.invite);
        toast(r.j.invite.mine && r.j.invite.mine.answer === "yes" ? "참석으로 답했습니다. 캘린더에도 넣어 두세요." : "응답을 보냈습니다.");
        var card = $("#rsvp"); if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    load();
  })();

  /* =================================================================
     초대장 만들기 · 관리 (/meet-manage)
     ================================================================= */
  if (managePage) (function () {
    var root = $("[data-mt-root]"), qs = new URLSearchParams(location.search);
    var hashKey = (/[#&]k=([A-Za-z0-9_-]{16,80})/.exec(location.hash) || [])[1] || "";
    var slug = qs.get("c") || "", bcode = qs.get("b") || "", btoken = qs.get("t") || "";
    var key = hashKey || (slug ? knownKey(slug) : "");
    var DATA = null, JUST_MADE = /[#&]new=1/.test(location.hash);
    var fail = function (title, msg) {
      root.innerHTML = '<div class="mt-card mt-end"><h2>' + esc(title) + '</h2><p class="mt-sub">' + esc(msg) + '</p><div class="actions" style="justify-content:center"><a class="btn btn-primary" href="/guest-orders">예약 조회</a><a class="btn btn-outline" href="' + KAKAO + '" target="_blank" rel="noopener">카카오톡 문의</a></div></div>';
    };
    function themeRadios(cur) {
      return '<div class="mt-themes" role="radiogroup" aria-label="모임 유형">' + Object.keys(THEMES).map(function (k) {
        return '<label><input type="radio" name="theme" value="' + k + '"' + (k === cur ? " checked" : "") + "><span>" + esc(THEMES[k]) + "</span></label>";
      }).join("") + "</div>";
    }
    function formFields(v, create) {
      return '<div class="mt-form-grid">'
        + '<div class="mt-field full"><label for="f-title">모임 이름 <span style="color:var(--blue)">*</span></label><input id="f-title" name="title" maxlength="40" required value="' + esc(v.title || "") + '" placeholder="예) 화요 저녁 독서모임 3회차"></div>'
        + '<div class="mt-field"><label for="f-host">초대하는 사람</label><input id="f-host" name="hostName" maxlength="20" value="' + esc(v.hostName || "") + '" placeholder="예) 민지"><span class="hint">초대장에 \'○○ 님이 초대했어요\'로 보입니다.</span></div>'
        + '<div class="mt-field"><label>모임 유형</label>' + themeRadios(v.theme || "meet") + "</div>"
        + '<div class="mt-field full"><label for="f-msg">안내 글</label><textarea id="f-msg" name="message" maxlength="600" placeholder="준비물, 진행 순서, 회비, 단체방 링크처럼 일행이 알아야 할 내용을 적어 주세요.">' + esc(v.message || "") + "</textarea></div>"
        + '<label class="mt-check full"><input type="checkbox" name="showNames"' + (v.showNames ? " checked" : "") + "> 참석한다고 답한 사람의 이름을 초대장에 보여 주기</label>"
        + (create ? "" : '<label class="mt-check full"><input type="checkbox" name="rsvpOpen"' + (v.rsvpOpen !== false ? " checked" : "") + "> 참석 응답 받기</label>")
        + '<div class="mt-field full" style="margin-top:18px"><label for="f-entry">출입 안내 <span class="hint">(선택)</span></label><textarea id="f-entry" name="entryNote" maxlength="300" style="min-height:90px" placeholder="담당자에게 받은 출입 방법을 일행에게 알려야 한다면 적어 주세요.">' + esc(v.entryNote || "") + "</textarea>"
        + '<span class="hint">아래에서 고른 시각부터 모임이 끝날 때까지만 초대장에 보입니다.</span></div>'
        + '<div class="mt-field"><label for="f-hours">출입 안내를 보여 줄 때</label><select id="f-hours" name="entryHours">' + [1, 2, 3, 6, 12, 24].map(function (h) { return '<option value="' + h + '"' + (Number(v.entryHours || 3) === h ? " selected" : "") + ">모임 시작 " + h + "시간 전부터</option>"; }).join("") + "</select></div>"
        + "</div>";
    }
    function readForm(f) {
      var theme = $("input[name=theme]:checked", f);
      var out = { title: f.title.value.trim(), hostName: f.hostName.value.trim(), theme: theme ? theme.value : "meet", message: f.message.value, showNames: f.showNames.checked, entryNote: f.entryNote.value, entryHours: +f.entryHours.value };
      if (f.rsvpOpen) out.rsvpOpen = f.rsvpOpen.checked;
      return out;
    }
    function createView(b) {
      var name = store("sf-meet-name") || "";
      root.innerHTML = '<div class="mt-stack"><div class="mt-manage-head"><div><span class="eyebrow">Meeting invitation</span><h1>모임 초대장 만들기</h1><p>일시, 장소, 찾아오는 길, 주차 안내는 예약에서 자동으로 채워집니다. 모임 이름만 적어도 됩니다.</p></div></div>'
        + '<section class="mt-card"><h2><span class="mt-ico">' + ICON.cal + '</span>예약한 일정</h2><div class="mt-summary-box"><b>' + esc(rangeLabel(b)) + "</b><span>소셜팩토리 건대 " + esc(b.spaceName) + " · " + esc(b.spaceSub) + (b.people ? " · 예약 인원 " + b.people + "명" : "") + "</span></div></section>"
        + '<form class="mt-card" data-create novalidate><h2><span class="mt-ico">' + ICON.note + "</span>초대장 내용</h2>" + formFields({ title: "", hostName: name, theme: b.suggestedTheme || "meet" }, true)
        + '<div class="actions"><button type="submit" class="btn btn-primary btn-lg">초대장 만들기</button></div><p class="mt-status" data-msg role="status"></p>'
        + '<p class="mt-keynote">참석 응답은 이름이나 별명만 받습니다. 초대장과 응답은 모임일로부터 30일 뒤에 지워집니다.</p></form></div>';
      $("[data-create]").addEventListener("submit", function (e) {
        e.preventDefault();
        var f = e.target, msg = $("[data-msg]", f), body = readForm(f);
        if (!body.title) { msg.textContent = "모임 이름을 적어 주세요."; msg.className = "mt-status err"; f.title.focus(); return; }
        body.code = bcode; body.t = btoken;
        var btn = $("[type=submit]", f); btn.disabled = true; msg.textContent = "만드는 중…"; msg.className = "mt-status";
        api("POST", "/api/meet/booking/invite", body).then(function (r) {
          btn.disabled = false;
          if (r.status !== 200) { msg.textContent = errMsg(r); msg.className = "mt-status err"; return; }
          if (body.hostName) store("sf-meet-name", body.hostName);
          rememberKey(r.j.slug, r.j.key);
          location.replace("/meet-manage?c=" + r.j.slug + "#k=" + r.j.key + "&new=1");
        });
      });
    }
    function inviteText(d) {
      return d.title + "\n" + rangeLabel(d) + "\n소셜팩토리 건대 " + d.spaceName + "\n\n오는 길과 주차 안내를 확인하고 참석 여부를 알려 주세요.\n" + d.url;
    }
    function manageView(d) {
      DATA = d;
      document.title = "초대장 관리 · " + d.title + " | 소셜팩토리 건대";
      var c = d.counts || {}, cap = d.capacity, isNew = JUST_MADE;
      var h = '<div class="mt-stack"><div class="mt-manage-head"><div><span class="eyebrow">Invitation manager</span><h1>' + esc(d.title) + "</h1><p>" + esc(rangeLabel(d)) + " · " + esc(d.spaceName) + "</p></div>"
        + '<a class="btn btn-outline btn-sm" href="' + esc(d.url) + '" target="_blank" rel="noopener">초대장 보기 ↗</a></div>';
      if (isNew) h += '<div class="mt-card" style="border-color:var(--blue)"><h2><span class="mt-ico">' + ICON.check + '</span>초대장을 만들었습니다</h2><p class="mt-sub">아래 링크를 모임 단체방에 보내 주세요. 이 관리 화면은 이 휴대폰에 기억해 두었고, 초대장 맨 아래의 \'초대장 관리\'로 다시 들어올 수 있습니다.</p></div>';
      if (d.status === "closed" || d.bookingClosed) h += '<div class="mt-warn">' + (d.bookingClosed ? "예약이 취소되었거나 확정 상태가 아니라 초대장이 닫혀 있습니다." : "닫힌 초대장입니다. 일행이 열면 '닫힌 초대장'으로 보입니다.") + "</div>";
      h += '<section class="mt-card"><h2><span class="mt-ico">' + ICON.share + '</span>일행에게 보내기</h2><p class="mt-sub">카카오톡 단체방에 링크를 붙여 넣으면 초대장 카드가 보입니다.</p>'
        + '<div class="mt-share"><input readonly value="' + esc(d.url) + '" aria-label="초대장 주소"><button type="button" class="btn btn-primary" data-act="share">공유</button></div>'
        + '<div class="mt-copytext" data-invite-text>' + esc(inviteText(d)) + '</div><div class="actions"><button type="button" class="btn btn-outline" data-act="copytext">안내 문구 복사</button><button type="button" class="btn btn-outline" data-act="copyurl">링크만 복사</button></div>'
        + '<div class="mt-qr"><div class="mt-qr-box" data-qr></div><p>모임 공지 화면이나 인쇄물에 넣을 QR입니다. 찍으면 초대장이 열립니다.<br><button type="button" class="mt-mini" data-act="qrsave" style="margin-top:8px">QR 이미지 저장</button></p></div></section>';
      h += '<section class="mt-card"><h2><span class="mt-ico">' + ICON.users + "</span>참석 응답</h2>"
        + '<div class="mt-tiles"><div class="mt-tile"><span>참석</span><b>' + (c.yes || 0) + '명</b></div><div class="mt-tile"><span>불참</span><b>' + (c.no || 0) + '명</b></div><div class="mt-tile"><span>차량</span><b>' + (c.cars || 0) + '대</b></div><div class="mt-tile"><span>초대장 열람</span><b>' + (d.views || 0) + "회</b></div></div>";
      if (cap && c.yes > cap) h += '<div class="mt-warn">참석 인원(' + c.yes + "명)이 " + esc(d.spaceName) + "의 최대 인원(" + cap + '명)을 넘었습니다. 최대 인원을 넘기면 이용이 중단될 수 있으니 <a href="' + KAKAO + '" target="_blank" rel="noopener">카카오톡</a>으로 더 큰 방을 문의해 주세요.</div>';
      else if (d.people && c.yes > d.people) h += '<div class="mt-warn">참석 인원(' + c.yes + "명)이 예약할 때 적은 인원(" + d.people + "명)보다 많습니다. 방의 최대 인원은 " + cap + "명입니다.</div>";
      if (c.cars) h += '<p class="mt-sub" style="margin-top:12px">차를 가져온다는 일행이 ' + c.cars + '명 있습니다. 미리 <a href="/parking" style="color:var(--blue);font-weight:700">주차 안내</a>를 함께 보내 주세요.</p>';
      h += d.responses && d.responses.length ? '<table class="mt-table"><thead><tr><th>이름</th><th>응답</th><th>남긴 때</th><th></th></tr></thead><tbody>' + d.responses.map(function (r) {
        return "<tr><td><b>" + esc(r.name) + "</b>" + (r.note ? "<small>" + esc(r.note) + "</small>" : "") + (r.car ? "<small>차량 이용</small>" : "") + '</td><td><span class="mt-ans' + (r.answer === "no" ? " no" : "") + '">' + (r.answer === "yes" ? "참석" : "불참") + "</span></td><td><small>" + esc(String(r.at || "").slice(5, 16).replace("-", ".")) + '</small></td><td style="text-align:right"><button type="button" class="mt-mini" data-del-rsvp="' + r.id + '">지우기</button></td></tr>';
      }).join("") + "</tbody></table>" : '<p class="mt-sub" style="margin-top:14px">아직 응답이 없습니다. 초대장을 보내면 여기에 모입니다.</p>';
      h += "</section>";
      h += '<form class="mt-card" data-edit novalidate><h2><span class="mt-ico">' + ICON.note + "</span>초대장 고치기</h2>" + formFields({ title: d.title, hostName: d.hostName, theme: d.theme, message: d.message, showNames: d.showNamesSetting, rsvpOpen: d.rsvpSetting, entryNote: d.entryNote, entryHours: d.entryHours })
        + '<div class="actions"><button type="submit" class="btn btn-primary">저장</button></div><p class="mt-status" data-msg role="status"></p></form>';
      h += '<section class="mt-card"><h2><span class="mt-ico">' + ICON.play + '</span>모임 준비에 쓰세요</h2><ul class="mt-list">'
        + '<li><a href="/parking" style="color:var(--blue);font-weight:700">주차 안내</a> · 건물 주차권 요금과 근처 공영주차장을 확인할 수 있습니다.</li>'
        + '<li><a href="/play" style="color:var(--blue);font-weight:700">모임 도구 · 게임</a> · 타이머, 팀 나누기, 대화 카드, 라이어 게임을 방의 화면에 띄워 쓰세요.</li>'
        + "<li>방 안의 QR을 찍으면 와이파이, 화면 연결, 퇴실 전 확인 목록이 나옵니다.</li></ul></section>";
      h += '<section class="mt-card"><h2>초대장 ' + (d.status === "closed" ? "다시 열기" : "닫기") + '</h2><p class="mt-sub">' + (d.status === "closed" ? "다시 열면 일행이 초대장을 보고 응답할 수 있습니다." : "모임이 취소되었다면 초대장을 닫아 주세요. 일행에게는 '닫힌 초대장'으로 보입니다.") + '</p><div class="actions"><button type="button" class="btn btn-outline' + (d.status === "closed" ? "" : " mt-danger") + '" data-act="toggle">' + (d.status === "closed" ? "다시 열기" : "초대장 닫기") + "</button></div>"
        + '<p class="mt-keynote">이 관리 화면의 주소를 아는 사람은 초대장을 고칠 수 있습니다. 단체방에는 위의 초대장 링크만 보내 주세요.</p></section></div>';
      root.innerHTML = h;
      qrInto($("[data-qr]", root), d.url);
    }
    function load() {
      api("GET", "/api/meet/manage/" + slug, null, { "X-Invite-Key": key }).then(function (r) {
        if (r.status !== 200) { fail("관리 링크를 확인해 주세요", r.status === 404 ? "초대장을 만들 때 받은 관리 링크로 다시 열어 주세요. 예약 상세 화면의 '초대장 관리'로도 들어올 수 있습니다." : errMsg(r)); return; }
        rememberKey(slug, key);
        manageView(r.j.invite);
      });
    }
    function patch(body, okMsg) {
      return api("PATCH", "/api/meet/manage/" + slug, body, { "X-Invite-Key": key }).then(function (r) {
        if (r.status !== 200) { toast(errMsg(r)); return false; }
        manageView(r.j.invite); toast(okMsg || "저장했습니다."); return true;
      });
    }
    root.addEventListener("click", function (e) {
      var t = e.target.closest("[data-act]"), d = DATA;
      if (t && d) {
        var act = t.getAttribute("data-act");
        if (act === "share") shareLink(d.url, d.title, inviteText(d).replace("\n" + d.url, ""));
        else if (act === "copytext") copy(inviteText(d), "안내 문구를 복사했습니다. 단체방에 붙여 넣어 주세요.");
        else if (act === "copyurl") copy(d.url, "초대장 링크를 복사했습니다.");
        else if (act === "qrsave") { if (typeof window.qrcode !== "function") { toast("QR을 만들지 못했습니다."); return; } var a = document.createElement("a"); a.href = qrPng(d.url, 720); a.download = "socialfactory-invite-qr.png"; document.body.appendChild(a); a.click(); a.remove(); }
        else if (act === "toggle") { if (d.status !== "closed" && !window.confirm("초대장을 닫을까요? 일행은 더 이상 응답할 수 없습니다.")) return; patch({ status: d.status === "closed" ? "active" : "closed" }, d.status === "closed" ? "초대장을 다시 열었습니다." : "초대장을 닫았습니다."); }
        return;
      }
      var del = e.target.closest("[data-del-rsvp]");
      if (del) {
        if (!window.confirm("이 응답을 지울까요?")) return;
        api("DELETE", "/api/meet/manage/" + slug + "/rsvp/" + del.getAttribute("data-del-rsvp"), null, { "X-Invite-Key": key }).then(function (r) {
          if (r.status !== 200) { toast(errMsg(r)); return; }
          manageView(r.j.invite); toast("응답을 지웠습니다.");
        });
      }
    });
    root.addEventListener("submit", function (e) {
      var f = e.target.closest("[data-edit]"); if (!f) return;
      e.preventDefault();
      var body = readForm(f), msg = $("[data-msg]", f);
      if (!body.title) { msg.textContent = "모임 이름을 적어 주세요."; msg.className = "mt-status err"; return; }
      var btn = $("[type=submit]", f); btn.disabled = true;
      patch(body, "초대장을 고쳤습니다.").then(function () { btn.disabled = false; });
    });
    if (slug && key) { if (hashKey) history.replaceState(null, "", location.pathname + location.search + "#k=" + key); load(); }
    else if (bcode && btoken) {
      api("POST", "/api/meet/booking", { code: bcode, t: btoken }).then(function (r) {
        if (r.status !== 200) { fail("예약을 확인하지 못했습니다", errMsg(r)); return; }
        var j = r.j;
        if (j.invite) { var m = /c=([a-z0-9]+)#k=([A-Za-z0-9_-]+)/.exec(j.invite.manageUrl); if (m) { rememberKey(m[1], m[2]); location.replace("/meet-manage?c=" + m[1] + "#k=" + m[2]); return; } }
        if (j.ended) { fail("이미 끝난 예약입니다", "끝난 예약에는 초대장을 만들 수 없습니다."); return; }
        if (!j.eligible) { fail("예약이 확정된 뒤에 만들 수 있습니다", "결제와 최종 일정 확인이 끝나 예약이 확정되면 초대장을 만들 수 있습니다."); return; }
        createView(j.booking);
      });
    } else fail("관리 링크가 필요합니다", "초대장을 만들 때 받은 관리 링크나 예약 상세 화면의 '모임 초대장' 버튼으로 들어와 주세요.");
  })();

  /* =================================================================
     예약 상세(booking-status)의 초대장 칸
     ================================================================= */
  if (bookingBox) (function () {
    var qs = new URLSearchParams(location.search), code = qs.get("code") || "", t = qs.get("t") || "", busy = false, last = "";
    if (!code || !t) return;
    function show(j) {
      var b = j.booking, inv = j.invite;
      if (inv) {
        bookingBox.innerHTML = '<span class="eyebrow">Meeting invitation</span><h2>모임 초대장</h2><p><b>' + esc(inv.title) + '</b> 초대장이 있습니다. 참석 응답을 확인하거나 내용을 고칠 수 있습니다.</p><div class="actions"><a class="btn btn-primary" href="' + esc(inv.manageUrl.replace("https://socialfactory.co.kr", "")) + '">초대장 관리</a><a class="btn btn-outline" href="' + esc(inv.url.replace("https://socialfactory.co.kr", "")) + '" target="_blank" rel="noopener">초대장 보기</a><a class="btn btn-outline" href="/play">모임 도구 · 게임</a></div>';
        var m = /c=([a-z0-9]+)#k=([A-Za-z0-9_-]+)/.exec(inv.manageUrl); if (m) rememberKey(m[1], m[2]);
      } else if (j.eligible) {
        bookingBox.innerHTML = '<span class="eyebrow">Meeting invitation</span><h2>일행에게 보낼 모임 초대장을 만들어 보세요</h2><p>일시와 장소, 찾아오는 길과 주차 안내가 담긴 초대장을 만들어 단체방에 보내면, 일행은 가입 없이 열어 보고 참석 여부를 남길 수 있습니다.</p>'
          + "<ul><li>" + esc(dateLabel(b.date)) + " " + esc(timeLabel(b.startMin)) + " · " + esc(b.spaceName) + "</li><li>모임 당일에는 방 와이파이도 초대장에 보입니다</li></ul>"
          + '<div class="actions"><a class="btn btn-primary" href="/meet-manage?b=' + encodeURIComponent(code) + "&amp;t=" + encodeURIComponent(t) + '">모임 초대장 만들기</a><a class="btn btn-outline" href="/play">모임 도구 · 게임</a></div>';
      } else { bookingBox.hidden = true; return; }
      bookingBox.hidden = false;
    }
    function check() {
      if (busy) return; busy = true;
      api("POST", "/api/meet/booking", { code: code, t: t }).then(function (r) { busy = false; if (r.status === 200) show(r.j); });
    }
    var title = document.getElementById("payment-title");
    if (title && window.MutationObserver) new MutationObserver(function () { var now = title.textContent; if (now !== last) { last = now; if (/확정/.test(now)) check(); } }).observe(title, { childList: true, characterData: true, subtree: true });
    check();
  })();

  /* =================================================================
     룸 가이드 (/room?s=r3&k=…)
     ================================================================= */
  if (roomPage) (function () {
    var qs = new URLSearchParams(location.search), space = qs.get("s") || "", key = qs.get("k") || "";
    var head = $("[data-rg-head]"), body = $("[data-rg-body]");
    var SP = {
      r1: { name: "1번룸", sub: "강의실1", kind: "room", max: 36, gear: ["대형 모니터", "칠판", "와이파이", "냉난방"], screen: "monitor" },
      r2: { name: "2번룸", sub: "강의실2", kind: "room", max: 40, gear: ["빔프로젝터", "칠판", "와이파이", "냉난방"], screen: "projector" },
      r3: { name: "3번룸", sub: "강의실3", kind: "room", max: 16, gear: ["대형 모니터", "칠판", "화이트보드", "와이파이", "냉난방"], screen: "monitor" },
      r4: { name: "4번룸", sub: "강의실4", kind: "room", max: 48, gear: ["빔프로젝터", "칠판", "와이파이", "냉난방"], screen: "projector" },
      r5: { name: "5번룸", sub: "강의실5", kind: "room", max: 30, gear: ["빔프로젝터", "칠판", "와이파이", "냉난방"], screen: "projector" },
      coworking: { name: "코워킹 · 스터디카페", sub: "24시간 좌석", kind: "coworking", gear: ["1인 좌석", "공용 테이블", "와이파이", "냉난방"] },
      lounge: { name: "휴게 · 대기 공간", sub: "출입구 옆", kind: "lounge", gear: ["와이파이"] },
      office: { name: "독립사무실", sub: "A · B · C · D호", kind: "office", gear: ["책상 · 의자", "와이파이", "냉난방", "개별 도어락"] }
    };
    var s = SP[space];
    if (!s) {
      head.innerHTML = '<div class="container mt-narrow"><div class="crumbs">Room guide</div><h1>룸 가이드</h1><p>방 안에 붙은 QR을 찍으면 그 공간의 와이파이와 사용법이 나옵니다.</p></div>';
      body.innerHTML = '<div class="container mt-narrow"><div class="mt-stack"><section class="mt-card"><h2>공간을 골라 주세요</h2><div class="mt-maps">' + Object.keys(SP).map(function (k) { return '<a class="btn btn-outline" href="/room?s=' + k + '">' + esc(SP[k].name) + "</a>"; }).join("") + '</div><p class="mt-tip">와이파이 비밀번호는 방 안의 QR로 열었을 때만 보입니다.</p></section></div></div>';
      return;
    }
    document.title = s.name + " 가이드 | 소셜팩토리 건대";
    var P = CFG.policy || {};
    var card = function (id, icon, title, inner) { return '<section class="mt-card" id="' + id + '"><h2><span class="mt-ico">' + icon + "</span>" + title + "</h2>" + inner + "</section>"; };
    var jump = [["wifi", "와이파이"]];
    var sections = [];
    sections.push(card("wifi", ICON.wifi, "와이파이", '<div data-wifi><p class="mt-sub">와이파이 정보를 불러오고 있습니다…</p></div>'));
    if (s.kind === "room") {
      jump.push(["screen", "화면 연결"], ["time", "시간 · 연장"], ["checkout", "퇴실 전 확인"], ["rules", "이용 원칙"], ["help", "도움 요청"]);
      var scr = s.screen === "projector"
        ? '<ol class="mt-steps"><li><span>빔프로젝터 리모컨으로 전원을 켭니다. 화면이 밝아질 때까지 30초쯤 기다려 주세요.</span></li><li><span>노트북을 HDMI 케이블로 연결하고, 리모컨의 <b>입력(INPUT · SOURCE)</b>에서 HDMI를 고릅니다.</span></li><li><span>화면이 안 나오면 노트북에서 <b>Windows + P</b>(맥은 디스플레이 설정)로 \'복제\'를 고르세요.</span></li><li><span>끝나면 프로젝터 전원을 끄고 리모컨은 처음 자리에 두세요.</span></li></ol>'
        : '<ol class="mt-steps"><li><span>모니터 리모컨으로 전원을 켭니다.</span></li><li><span>노트북을 HDMI 케이블로 연결하고, 리모컨의 <b>입력(INPUT · SOURCE)</b>에서 HDMI를 고릅니다.</span></li><li><span>화면이 안 나오면 노트북에서 <b>Windows + P</b>(맥은 디스플레이 설정)로 \'복제\'를 고르세요.</span></li><li><span>끝나면 모니터 전원을 끄고 리모컨은 처음 자리에 두세요.</span></li></ol>';
      sections.push(card("screen", ICON.screen, (s.screen === "projector" ? "빔프로젝터" : "대형 모니터") + "에 화면 띄우기", scr + '<p class="mt-tip">USB-C 단자만 있는 노트북은 변환 젠더가 필요할 수 있습니다. 노트북 대여(유료)는 예약할 때 미리 신청해 주세요.</p>'));
      sections.push(card("time", ICON.clock, "이용 시간과 연장", '<ul class="mt-list"><li>준비와 정리 시간까지 <b>예약한 시간 안에서</b> 이용합니다. 다음 팀이 예약 시각에 바로 들어옵니다.</li><li>연장은 다음 예약이 없을 때만 할 수 있고, 그 시간대 요금이 붙습니다. 연장이 필요하면 끝나기 전에 카카오톡으로 먼저 물어봐 주세요.</li></ul><div class="actions"><a class="btn btn-primary" href="' + KAKAO + '" target="_blank" rel="noopener">카카오톡으로 연장 문의</a></div>'));
      var items = ["책상과 의자를 처음 배치로 돌려놓았어요", "쓰레기와 남은 음식을 정리했어요", "칠판 · 화이트보드를 지웠어요", (s.screen === "projector" ? "빔프로젝터" : "모니터") + " 전원을 끄고 리모컨을 제자리에 두었어요", "냉난방과 조명을 껐어요", "두고 가는 물건이 없는지 확인했어요"];
      sections.push(card("checkout", ICON.check, "퇴실 전 확인", '<p class="mt-sub">다음 팀이 기분 좋게 쓸 수 있도록 하나씩 확인해 주세요.</p><div class="rg-check" data-checklist>' + items.map(function (t, i) { return '<label><input type="checkbox" data-ck="' + i + '"> ' + esc(t) + "</label>"; }).join("") + '</div><p class="rg-progress" data-ck-progress></p>'));
      sections.push(card("rules", ICON.info, "이용 원칙", '<ul class="mt-list"><li>이 방은 최대 <b>' + s.max + "명</b>까지 이용할 수 있습니다. 인원이 넘으면 이용이 중단될 수 있습니다.</li><li>음료와 다과는 괜찮지만 <b>주류는 반입할 수 없습니다.</b> 건물이 교육환경보호구역 안에 있습니다.</li><li>" + esc(P.noise || "22시 이후에는 앰프를 쓸 수 없고, 23시 이후에는 조용한 이용만 가능합니다.") + "</li><li>복도와 옆 방을 배려해 쉬는 시간 대화는 휴게 · 대기 공간에서 나눠 주세요.</li><li>장비가 고장 나거나 파손이 생기면 바로 알려 주세요.</li></ul>"));
    } else if (s.kind === "coworking") {
      jump.push(["use", "이용 방법"], ["rules", "이용 원칙"], ["help", "도움 요청"]);
      var passes = ((CFG.pricing && CFG.pricing.coworkingPasses) || []).map(function (p) { return "<li><b>" + esc(p.name) + "</b> " + Number(p.price).toLocaleString("ko-KR") + "원</li>"; }).join("");
      sections.push(card("use", ICON.clock, "이용 방법", '<ul class="mt-list">' + (passes || "<li>이용권 종류와 요금은 이용권 구매 화면에서 확인해 주세요.</li>") + '</ul><div class="actions"><a class="btn btn-primary" href="/shop">이용권 사기 · 연장</a></div>'));
      sections.push(card("rules", ICON.info, "이용 원칙", '<ul class="mt-list"><li>함께 집중하는 공간입니다. 통화와 대화는 휴게 · 대기 공간에서 해 주세요.</li><li>자리를 오래 비울 때는 짐을 정리해 다른 분이 쓸 수 있게 해 주세요.</li><li>음료는 괜찮지만 냄새가 강한 음식은 삼가 주세요. 주류는 반입할 수 없습니다.</li></ul>'));
    } else if (s.kind === "lounge") {
      jump.push(["wait", "기다릴 때"], ["help", "도움 요청"]);
      sections.push(card("wait", ICON.clock, "기다릴 때", '<ul class="mt-list"><li>예약 시간 전에 도착했다면 이곳에서 기다려 주세요. 예약 시각이 되면 방에 들어갈 수 있습니다.</li><li>쉬는 시간 대화나 통화는 이곳에서 나눠 주세요.</li><li>같은 건물에 24시간 무인디저트카페 <a href="https://hellomingle.kr" target="_blank" rel="noopener" style="color:var(--blue);font-weight:700">밍글</a>이 있습니다. 모임 전후에 들르기 좋습니다.</li></ul>'));
    } else if (s.kind === "office") {
      jump.push(["use", "이용 안내"], ["help", "도움 요청"]);
      sections.push(card("use", ICON.info, "이용 안내", '<ul class="mt-list"><li>' + esc(P.address || "독립사무실은 임대차가 아닌 공간 이용권입니다.") + "</li><li>복도와 공용 공간에서는 다른 이용자를 배려해 조용히 이동해 주세요.</li><li>이용 기간 연장과 호실 변경은 카카오톡으로 문의해 주세요.</li></ul>"));
    }
    sections.push(card("help", ICON.help, "도움이 필요할 때", '<p class="mt-sub">상주 직원 없이 운영하는 공간입니다. 장비 고장, 냉난방, 분실물, 연장 문의는 카카오톡으로 알려 주시면 바로 확인합니다.</p><div class="actions"><a class="btn btn-primary" href="' + KAKAO + '" target="_blank" rel="noopener">카카오톡 문의</a><a class="btn btn-outline" href="/guide">이용 안내</a><a class="btn btn-outline" href="/parking">주차 안내</a></div>'));
    if (s.kind === "room" || s.kind === "lounge") sections.push('<section class="mt-card mt-cta"><div><h2>모임 도구 · 게임</h2><p>타이머, 팀 나누기, 대화 카드, 라이어 게임을 이 방의 화면에 띄워 쓰세요.</p></div><div class="actions"><a class="btn btn-primary" href="/play">모임 도구 열기</a></div></section>');
    head.innerHTML = '<div class="container mt-narrow"><div class="crumbs">Room guide · 소셜팩토리 건대 4F</div><h1>' + esc(s.name) + ' 가이드</h1><p>' + esc(s.sub) + (s.max ? " · 최대 " + s.max + "명" : "") + '</p><div class="rg-gear">' + s.gear.map(function (g) { return "<span>" + esc(g) + "</span>"; }).join("") + '</div><nav class="rg-jump" aria-label="가이드 바로가기">' + jump.map(function (j) { return '<a href="#' + j[0] + '">' + j[1] + "</a>"; }).join("") + "</nav></div>";
    body.innerHTML = '<div class="container mt-narrow"><div class="mt-stack">' + sections.join("") + "</div></div>";
    var ckKey = "sf-room-ck-" + space + "-" + new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    var saved = store(ckKey) || [];
    var progress = function () {
      var all = $$("[data-ck]"), done = all.filter(function (c) { return c.checked; }).length, p = $("[data-ck-progress]");
      if (p) p.textContent = done === all.length ? "모두 확인했습니다. 이용해 주셔서 고맙습니다!" : all.length + "개 중 " + done + "개 확인";
    };
    $$("[data-ck]").forEach(function (c) { c.checked = saved.indexOf(+c.getAttribute("data-ck")) >= 0; c.addEventListener("change", function () { store(ckKey, $$("[data-ck]").filter(function (x) { return x.checked; }).map(function (x) { return +x.getAttribute("data-ck"); })); progress(); }); });
    progress();
    api("GET", "/api/meet/room/" + encodeURIComponent(space) + (key ? "?k=" + encodeURIComponent(key) : "")).then(function (r) {
      var box = $("[data-wifi]"); if (!box) return;
      if (r.status !== 200) { box.innerHTML = '<p class="mt-sub">' + esc(errMsg(r)) + "</p>"; return; }
      if (!r.j.keyValid) { box.innerHTML = '<div class="rg-nokey">와이파이 이름과 비밀번호는 <b>방 안에 붙은 QR</b>을 찍어 열었을 때 보입니다. QR을 다시 찍어 주세요.</div>'; return; }
      box.innerHTML = r.j.wifi.length ? wifiBlock(r.j.wifi) : '<p class="mt-sub">이 공간의 와이파이 정보가 아직 없습니다. 카카오톡으로 문의해 주세요.</p>';
      if (key) try { history.replaceState(null, "", location.pathname + "?s=" + space + "&k=" + key + location.hash); } catch (e) { /* 무시 */ }
    });
  })();
})();
