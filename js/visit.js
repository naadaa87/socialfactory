/* 소셜팩토리 — 홈페이지 방문 통계 (관리자 KPI용)
   - 쿠키를 쓰지 않습니다. 탭을 닫으면 사라지는 sessionStorage 에 임의 세션 번호만 둡니다(30분 동안 움직임이 없으면 새 세션).
   - 이름 · 연락처 같은 입력 내용은 보내지 않습니다. 주소의 ? 뒤(토큰 등)도 보내지 않고, 광고 표시(utm)만 따로 보냅니다.
   - 관리자 화면을 연 브라우저(localStorage sf-notrack=1)와 자동 접속 도구는 세지 않습니다. */
(function () {
  "use strict";
  if (window.__sfVisit) return;
  window.__sfVisit = true;
  var nav = window.navigator || {}, loc = window.location, doc = document;
  try { if (window.localStorage.getItem("sf-notrack") === "1") return; } catch (e) { /* 저장소를 못 쓰면 그냥 셉니다 */ }
  if (nav.webdriver || /bot|crawl|spider|headless|lighthouse/i.test(nav.userAgent || "")) return;
  if (/^\/(admin|reservation-board|kiosk|board)/i.test(loc.pathname) || loc.protocol === "file:") return;
  if (!window.JSON || !(window.crypto && window.crypto.getRandomValues)) return;

  var URL_ = "/api/visit", IDLE = 30 * 60000;
  var rid = function () {
    var a = new Uint8Array(12), s = "";
    window.crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += (a[i] % 36).toString(36);
    return s;
  };
  var send = function (data) {
    var body = JSON.stringify(data);
    try {
      if (nav.sendBeacon && nav.sendBeacon(URL_, new Blob([body], { type: "text/plain" }))) return;
    } catch (e) { /* 아래 방법으로 */ }
    try { window.fetch(URL_, { method: "POST", body: body, headers: { "Content-Type": "text/plain" }, keepalive: true, credentials: "same-origin" }).catch(function () {}); } catch (e) { /* 무시 */ }
  };

  /* 세션 */
  var sid = "", first = false, now = Date.now();
  try {
    var saved = JSON.parse(window.sessionStorage.getItem("sf-visit") || "null");
    if (saved && saved.id && now - saved.t < IDLE) sid = saved.id;
  } catch (e) { /* 새로 */ }
  if (!sid) { sid = rid(); first = true; }
  var touch = function () { try { window.sessionStorage.setItem("sf-visit", JSON.stringify({ id: sid, t: Date.now() })); } catch (e) { /* 무시 */ } };
  touch();

  var pvid = rid(), path = loc.pathname, q = {};
  try { q = new URLSearchParams(loc.search); } catch (e) { q = { get: function () { return ""; } }; }
  var ref = "";
  try { ref = doc.referrer ? new URL(doc.referrer).origin + new URL(doc.referrer).pathname : ""; } catch (e) { ref = ""; }
  send({ t: "pv", sid: sid, pvid: pvid, path: path, title: (doc.title || "").split("|")[0].trim().slice(0, 80), ref: ref, entry: first ? 1 : 0,
    us: q.get("utm_source") || "", um: q.get("utm_medium") || "", uc: q.get("utm_campaign") || "" });

  /* 실제로 화면을 보고 있던 시간 · 스크롤 */
  var active = 0, since = doc.visibilityState === "hidden" ? 0 : Date.now(), scroll = 0;
  var measure = function () {
    var el = doc.documentElement, h = Math.max(el.scrollHeight - window.innerHeight, 1);
    var pct = Math.round(Math.min(1, (window.scrollY || el.scrollTop || 0) / h) * 100);
    if (el.scrollHeight <= window.innerHeight + 4) pct = 100;
    if (pct > scroll) scroll = pct;
  };
  var leave = function () {
    if (since) { active += Date.now() - since; since = 0; }
    measure(); touch();
    send({ t: "leave", sid: sid, pvid: pvid, ms: active, scroll: scroll });
  };
  doc.addEventListener("visibilitychange", function () {
    if (doc.visibilityState === "hidden") leave();
    else { since = Date.now(); touch(); }
  });
  window.addEventListener("pagehide", leave);
  var scrollT = 0;
  window.addEventListener("scroll", function () { if (!scrollT) scrollT = setTimeout(function () { scrollT = 0; measure(); }, 400); }, { passive: true });
  setTimeout(measure, 1500);

  /* 링크 · 주요 버튼 */
  var family = /(megaspot\.kr|hellomingle\.kr|ssople\.com|playtion\.kr|vacancy\.co\.kr|coremood\.kr|orbis-estate\.com|choisijun\.com|yeodeol\.kr)$/i;
  var kindOf = function (el) {
    if (el.hasAttribute("data-quote-download")) return ["quote", ""];
    if (el.tagName !== "A") {
      if (el.hasAttribute("data-submit") || (el.type === "submit" && el.closest("[data-booking-form]"))) return ["booking_submit", ""];
      if (el.type === "submit" && el.closest("form") && /inquiry|contact/i.test((el.closest("form").id || "") + " " + (el.closest("form").className || ""))) return ["inquiry_submit", ""];
      if (el.hasAttribute("data-track")) return ["button", el.getAttribute("data-track")];
      return null;
    }
    var href = el.getAttribute("href") || "";
    if (!href || href.charAt(0) === "#" || /^javascript:/i.test(href)) return null;
    if (/^tel:/i.test(href)) return ["tel", "tel"];
    if (/^mailto:/i.test(href)) return ["mail", "mail"];
    var u; try { u = new URL(href, loc.href); } catch (e) { return null; }
    var host = u.hostname.replace(/^www\./, ""), target = u.hostname === loc.hostname ? u.pathname : host + u.pathname;
    target = target.replace(/\.html$/, "").slice(0, 120);
    if (el.closest("[data-cm-post], [data-cm-comments]") && u.hostname !== loc.hostname) return ["community", target];
    if (el.getAttribute("data-channel") === "kakao" || /(^|\.)kakao\.com$/.test(host)) return ["kakao", target];
    if (/map\.naver\.com|naver\.me|map\.kakao\.com|kko\.to|maps\.google|google\.[a-z.]+\/maps/i.test(u.hostname + u.pathname)) return ["map", target];
    if (/\.(pdf|zip|pptx?|xlsx?|docx?)$/i.test(u.pathname)) return ["download", target];
    if (u.hostname !== loc.hostname) return [family.test(host) ? "family" : "external", target];
    if (/^\/booking(\.html)?$|^\/reserve/.test(u.pathname)) return ["booking", target];
    if (/^\/contact/.test(u.pathname)) return ["inquiry", target];
    if (/^\/(shop|product|order|parking)/.test(u.pathname)) return ["shop", target];
    return ["internal", target];
  };
  doc.addEventListener("click", function (event) {
    var el = event.target && event.target.closest ? event.target.closest("a[href], button, [data-track]") : null;
    if (!el) return;
    var k = kindOf(el);
    if (!k) return;
    var label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    touch();
    send({ t: "click", sid: sid, pvid: pvid, path: path, kind: k[0], label: label, target: k[1] });
  }, true);
})();
