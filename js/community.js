/* 소셜팩토리 커뮤니티 — 모임 소개 · 자유게시판
   - /community (목록) · /community/123 (글 보기) · /community-write (글쓰기 · 고치기) · 메인 페이지 '모임' 칸
   - 서버: /api/community/* (functions/_lib/community.js). 읽기는 누구나, 쓰기 · 댓글 · 관심 · 신고는 로그인한 회원만 합니다. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var num = function (v) { return (+v || 0).toLocaleString("ko-KR"); };
  var page = document.querySelector("[data-community-page]");
  var home = document.querySelector("[data-community-home]");
  if (!page && !home) return;

  var ICON = {
    heart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3l-1.2-1.1C6.1 15 3 12.2 3 8.8 3 6.1 5.1 4 7.8 4c1.5 0 3 .7 4.2 1.9C13.2 4.7 14.7 4 16.2 4 18.9 4 21 6.1 21 8.8c0 3.4-3.1 6.2-7.8 10.4L12 20.3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 4v-14z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    photo: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5L19 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="6" cy="12" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="18.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1" stroke="currentColor" stroke-width="1.8"/></svg>',
    flag: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 21V4.5M5.5 4.5h11l-2 4 2 4h-11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
  };

  /* ---------- 공통 ---------- */
  function api(method, url, body) {
    return fetch(url, { method: method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j || {} }; }, function () { return { status: r.status, j: {} }; }); })
      .catch(function () { return { status: 0, j: { message: "서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요." } }; });
  }
  var errMsg = function (res) { return (res.j && res.j.message) || "처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요."; };
  var toastT;
  function toast(msg) {
    var t = $(".cm-toast");
    if (!t) { t = document.createElement("div"); t.className = "cm-toast"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite"); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 3200);
  }
  var here = function () { return location.pathname + location.search; };
  var loginUrl = function (next) { return "/login?next=" + encodeURIComponent(next || here()); };
  var signupUrl = function (next) { return "/signup?next=" + encodeURIComponent(next || here()); };
  function askLogin(what) {
    if (window.confirm((what || "이 기능") + "은 로그인한 회원만 쓸 수 있습니다. 로그인 화면으로 이동할까요?")) location.href = loginUrl();
  }
  function kdate(s, withTime) {
    if (!s) return "";
    var d = new Date(String(s).replace(" ", "T") + "+09:00"), diff = (Date.now() - d.getTime()) / 1000;
    if (!isFinite(diff)) return s;
    if (!withTime && diff >= 0 && diff < 60) return "방금 전";
    if (!withTime && diff >= 0 && diff < 3600) return Math.floor(diff / 60) + "분 전";
    if (!withTime && diff >= 0 && diff < 86400) return Math.floor(diff / 3600) + "시간 전";
    var y = s.slice(0, 4), md = s.slice(5, 7) + "." + s.slice(8, 10), now = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 4);
    return (y === now ? md : y + "." + md) + (withTime ? " " + s.slice(11, 16) : "");
  }
  var dateDot = function (s) { return s ? s.slice(0, 10).replace(/-/g, ".") : ""; };
  function linkify(text) {
    return esc(text).replace(/https?:\/\/[^\s<]+/g, function (u) {
      var tail = (/[.,)!?\]]+$/.exec(u) || [""])[0]; u = u.slice(0, u.length - tail.length);
      return '<a href="' + u + '" target="_blank" rel="noopener nofollow ugc">' + u + "</a>" + tail;
    });
  }
  var CFG = null;
  function config() { if (!CFG) CFG = api("GET", "/api/community/config").then(function (r) { if (r.status !== 200) throw new Error(errMsg(r)); return r.j; }); return CFG; }
  var placeholder = function (p) { var c = (p.id % 3) + 1; return '<div class="cm-ph c' + c + '"><b>' + esc(p.categoryName) + "</b></div>"; };

  /* ---------- 모임 카드 · 자유게시판 줄 ---------- */
  function groupCard(p) {
    var facts = [];
    if (p.info && p.info.schedule) facts.push(["일정", p.info.schedule]);
    if (p.info && p.info.nextDate) facts.push(["다음", dateDot(p.info.nextDate)]);
    if (p.info && p.info.roomName) facts.push(["장소", p.info.roomName.replace("소셜팩토리 건대 ", "")]);
    return '<article class="cm-card"><a href="' + esc(p.url) + '">'
      + '<div class="cm-cover">' + (p.cover ? '<img src="' + esc(p.cover) + '" alt="" loading="lazy" decoding="async">' : placeholder(p)) + "</div>"
      + '<div class="cm-card-body"><div class="cm-tags">' + (p.featured ? '<span class="cm-tag pick">추천</span>' : "")
      + '<span class="cm-tag">' + esc(p.categoryName) + "</span>" + (p.recruit ? '<span class="cm-state' + (p.recruit === "closed" ? " closed" : "") + '">' + esc(p.recruitName) + "</span>" : "") + "</div>"
      + "<h3>" + esc(p.title) + '</h3><p class="cm-sum">' + esc(p.summary || p.excerpt) + "</p>"
      + (facts.length ? '<ul class="cm-facts">' + facts.slice(0, 2).map(function (f) { return "<li><b>" + f[0] + "</b><span>" + esc(f[1]) + "</span></li>"; }).join("") + "</ul>" : "")
      + '<div class="cm-meta"><span>' + ICON.heart + num(p.likes) + "</span><span>" + ICON.chat + num(p.comments) + "</span><span>" + ICON.eye + num(p.views) + '</span><span class="by">' + esc(p.author.name) + "</span></div>"
      + "</div></a></article>";
  }
  function freeRow(p) {
    return '<li class="cm-row' + (p.pinned ? " pin" : "") + '"><a href="' + esc(p.url) + '">'
      + '<span class="cm-row-cat">' + esc(p.pinned ? "공지" : p.categoryName) + "</span>"
      + '<span class="cm-row-title">' + esc(p.title) + (p.comments ? "<em>[" + num(p.comments) + "]</em>" : "") + (p.imageCount ? ICON.photo : "") + "</span>"
      + '<span class="cm-row-meta"><span class="' + (p.author.staff ? "staff" : "") + '">' + esc(p.author.name) + "</span><span>" + esc(kdate(p.publishedAt)) + "</span><span>조회 " + num(p.views) + "</span>" + (p.likes ? "<span>관심 " + num(p.likes) + "</span>" : "") + "</span></a></li>";
  }

  /* ========================= 메인 페이지 '모임' 칸 ========================= */
  if (home) {
    api("GET", "/api/community/posts?board=groups&sort=home&size=3").then(function (r) {
      var box = $("[data-cm-home-list]", home);
      if (r.status !== 200 || !r.j.posts || !r.j.posts.length || !box) return;
      box.innerHTML = '<div class="cm-grid">' + r.j.posts.map(groupCard).join("") + "</div>";
      box.hidden = false;
      $$("[data-cm-home-empty]", home).forEach(function (el) { el.hidden = true; });
    });
  }
  if (!page) return;
  var kind = page.getAttribute("data-community-page");
  if (kind !== "list") $$('.nav-links a[href="/community"]').forEach(function (a) { a.setAttribute("aria-current", "page"); });

  /* ========================= 목록 ========================= */
  if (kind === "list") {
    var qs = new URLSearchParams(location.search);
    var st = { board: qs.get("board") === "free" ? "free" : "groups", cat: qs.get("cat") || "", q: qs.get("q") || "", sort: qs.get("sort") === "popular" ? "popular" : "new",
      recruit: qs.get("recruit") === "1", page: Math.max(1, parseInt(qs.get("page"), 10) || 1), mine: qs.get("mine") === "1" };
    var listEl = $("[data-cm-list]"), featEl = $("[data-cm-featured]"), pager = $("[data-cm-pager]"), serial = 0;
    var syncUrl = function () {
      var p = new URLSearchParams();
      if (st.board !== "groups") p.set("board", st.board);
      if (st.cat) p.set("cat", st.cat); if (st.q) p.set("q", st.q); if (st.sort !== "new") p.set("sort", st.sort);
      if (st.recruit && st.board === "groups") p.set("recruit", "1"); if (st.page > 1) p.set("page", st.page); if (st.mine) p.set("mine", "1");
      try { history.replaceState(null, "", location.pathname + (p.toString() ? "?" + p.toString() : "")); } catch (e) { /* 무시 */ }
    };
    var renderTools = function (cfg) {
      $$("[data-board]", page).forEach(function (b) { b.setAttribute("aria-selected", b.getAttribute("data-board") === st.board ? "true" : "false"); });
      var cats = cfg.categories[st.board] || {};
      $("[data-cm-cats]").innerHTML = '<button type="button" class="cm-chip" data-cat="" aria-pressed="' + (!st.cat) + '">전체</button>'
        + Object.keys(cats).map(function (k) { return '<button type="button" class="cm-chip" data-cat="' + k + '" aria-pressed="' + (st.cat === k) + '">' + esc(cats[k]) + "</button>"; }).join("");
      $$("[data-only='groups']", page).forEach(function (el) { el.hidden = st.board !== "groups"; });
      $("[data-cm-recruit]").checked = st.recruit;
      $("[data-cm-sort]").value = st.sort;
      $("[data-cm-search] input").value = st.q;
      $("[data-cm-search] input").placeholder = st.board === "groups" ? "모임 이름 · 소개 검색" : "제목 · 내용 · 닉네임 검색";
      var me = cfg.me || {}, box = $("[data-cm-me]");
      if (me.loggedIn) {
        box.innerHTML = (me.nickname ? "<span><b>" + esc(me.nickname) + "</b> 님으로 참여하고 있습니다.</span>" : "<span>로그인했습니다. 첫 글을 쓸 때 커뮤니티에서 쓸 닉네임을 정합니다.</span>")
          + (me.banned ? '<span class="cm-status err">커뮤니티 글쓰기가 제한된 계정입니다.</span>' : "")
          + '<span class="cm-me-acts"><button type="button" class="btn btn-outline" data-mine>' + (st.mine ? "전체 글 보기" : "내 글 보기") + "</button></span>";
      } else {
        box.innerHTML = "<span>글을 올리거나 댓글을 남기려면 회원 로그인이 필요합니다. 읽기는 누구나 할 수 있습니다.</span>"
          + '<span class="cm-me-acts"><a class="btn btn-primary" href="' + esc(loginUrl()) + '">로그인</a><a class="btn btn-outline" href="' + esc(signupUrl()) + '">회원가입</a></span>';
      }
      $$("[data-cm-write]").forEach(function (a) {
        var b = a.getAttribute("data-cm-write"), open = b === "groups" ? cfg.settings.groupsOpen : cfg.settings.freeOpen, to = "/community-write?board=" + b;
        a.href = me.loggedIn ? to : loginUrl(to);
        a.hidden = !open;
      });
      var notice = $("[data-cm-notice]");
      notice.textContent = cfg.settings.notice || ""; notice.hidden = !cfg.settings.notice;
    };
    var renderPager = function (pages) {
      if (pages <= 1) { pager.innerHTML = ""; return; }
      var from = Math.max(1, Math.min(st.page - 3, pages - 6)), to = Math.min(pages, from + 6), h = '<button type="button" data-page="' + (st.page - 1) + '"' + (st.page <= 1 ? " disabled" : "") + ' aria-label="이전 페이지">‹</button>';
      for (var i = from; i <= to; i++) h += '<button type="button" data-page="' + i + '"' + (i === st.page ? ' aria-current="page"' : "") + ">" + i + "</button>";
      pager.innerHTML = h + '<button type="button" data-page="' + (st.page + 1) + '"' + (st.page >= pages ? " disabled" : "") + ' aria-label="다음 페이지">›</button>';
    };
    var load = function () {
      var my = ++serial;
      syncUrl();
      config().then(function (cfg) {
        renderTools(cfg);
        listEl.innerHTML = '<p class="cm-loading">불러오는 중입니다…</p>';
        var p = new URLSearchParams({ board: st.board, page: st.page, sort: st.sort });
        if (st.cat) p.set("cat", st.cat); if (st.q) p.set("q", st.q); if (st.recruit && st.board === "groups") p.set("recruit", "open"); if (st.mine) p.set("mine", "1");
        var showFeat = st.board === "groups" && st.page === 1 && !st.cat && !st.q && !st.mine && !st.recruit;
        featEl.hidden = true;
        if (showFeat) api("GET", "/api/community/posts?board=groups&featured=1&size=3").then(function (r) {
          if (my !== serial || r.status !== 200 || !r.j.posts.length) return;
          featEl.innerHTML = '<div class="cm-sub"><h2>소셜팩토리가 추천하는 모임</h2><p>운영팀이 고른 모임입니다</p></div><div class="cm-grid">' + r.j.posts.map(groupCard).join("") + '</div><div class="cm-sub mt-48"><h2>모든 모임</h2></div>';
          featEl.hidden = false;
        });
        return api("GET", "/api/community/posts?" + p.toString()).then(function (r) {
          if (my !== serial) return;
          if (r.status !== 200) { listEl.innerHTML = '<div class="cm-empty"><h3>목록을 불러오지 못했습니다</h3><p>' + esc(errMsg(r)) + "</p></div>"; pager.innerHTML = ""; return; }
          var posts = r.j.posts || [];
          if (!posts.length) {
            var filtered = st.cat || st.q || st.recruit || st.mine;
            listEl.innerHTML = '<div class="cm-empty">' + (filtered ? "<h3>조건에 맞는 글이 없습니다</h3><p>분류나 검색어를 바꿔 보세요.</p>"
              : st.board === "groups" ? '<h3>아직 소개된 모임이 없습니다</h3><p>소셜팩토리에서 모이고 있다면 첫 번째로 모임을 소개해 주세요.<br>함께할 사람을 찾는 데 도움이 됩니다.</p><div class="actions"><a class="btn btn-primary" href="' + esc(cfg.me.loggedIn ? "/community-write?board=groups" : loginUrl("/community-write?board=groups")) + '">모임 소개 올리기</a></div>'
              : '<h3>아직 글이 없습니다</h3><p>모임 공간 이야기, 질문, 이용 후기 무엇이든 남겨 주세요.</p><div class="actions"><a class="btn btn-primary" href="' + esc(cfg.me.loggedIn ? "/community-write?board=free" : loginUrl("/community-write?board=free")) + '">첫 글 쓰기</a></div>') + "</div>";
          } else if (st.board === "groups") {
            listEl.innerHTML = '<div class="cm-grid">' + posts.map(groupCard).join("") + "</div>";
          } else {
            listEl.innerHTML = '<ul class="cm-list">' + posts.map(freeRow).join("") + "</ul>";
          }
          renderPager(r.j.pages || 1);
        });
      }).catch(function (e) { listEl.innerHTML = '<div class="cm-empty"><h3>커뮤니티를 준비하고 있습니다</h3><p>' + esc(e.message) + "</p></div>"; });
    };
    page.addEventListener("click", function (e) {
      var t = e.target.closest("[data-board]");
      if (t) { st.board = t.getAttribute("data-board"); st.cat = ""; st.q = ""; st.page = 1; st.recruit = false; load(); return; }
      var c = e.target.closest("[data-cat]");
      if (c) { st.cat = c.getAttribute("data-cat"); st.page = 1; load(); return; }
      var pg = e.target.closest("[data-page]");
      if (pg && !pg.disabled) { st.page = +pg.getAttribute("data-page"); load(); var top = $(".cm-tabs"); if (top) top.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      if (e.target.closest("[data-mine]")) { st.mine = !st.mine; st.page = 1; load(); }
    });
    $("[data-cm-recruit]").addEventListener("change", function (e) { st.recruit = e.target.checked; st.page = 1; load(); });
    $("[data-cm-sort]").addEventListener("change", function (e) { st.sort = e.target.value; st.page = 1; load(); });
    $("[data-cm-search]").addEventListener("submit", function (e) { e.preventDefault(); st.q = $("input", e.target).value.trim(); st.page = 1; load(); });
    load();
    return;
  }

  /* ========================= 신고 창 ========================= */
  function openReport(type, id) {
    config().then(function (cfg) {
      if (!cfg.me.loggedIn) { askLogin("신고"); return; }
      var m = $(".cm-modal");
      if (!m) {
        m = document.createElement("div"); m.className = "cm-modal"; m.hidden = true;
        m.innerHTML = '<div class="cm-modal-bg" data-close></div><div class="cm-modal-panel" role="dialog" aria-modal="true" aria-labelledby="cm-rp-t"><h2 id="cm-rp-t">신고하기</h2><p>신고 내용은 운영팀만 봅니다. 확인 뒤 운영 원칙에 맞지 않으면 숨기거나 지웁니다.</p>'
          + '<form data-report-form><div class="cm-reasons">' + Object.keys(cfg.reasons).map(function (k, i) { return '<label><input type="radio" name="reason" value="' + k + '"' + (i ? "" : " checked") + "> " + esc(cfg.reasons[k]) + "</label>"; }).join("") + "</div>"
          + '<textarea name="detail" maxlength="300" placeholder="자세한 내용이 있으면 적어 주세요 (선택)"></textarea><p class="cm-status" data-report-msg role="status"></p>'
          + '<div class="actions"><button type="button" class="btn btn-outline" data-close>취소</button><button type="submit" class="btn btn-primary">신고하기</button></div></form></div>';
        document.body.appendChild(m);
        m.addEventListener("click", function (e) { if (e.target.closest("[data-close]")) m.hidden = true; });
        document.addEventListener("keydown", function (e) { if (e.key === "Escape") m.hidden = true; });
        $("[data-report-form]", m).addEventListener("submit", function (e) {
          e.preventDefault();
          var f = e.target, btn = $("[type=submit]", f); btn.disabled = true;
          api("POST", "/api/community/report", { type: m.dataset.type, id: +m.dataset.id, reason: f.reason.value, detail: f.detail.value }).then(function (r) {
            btn.disabled = false;
            if (r.status === 200) { m.hidden = true; toast(r.j.already ? "이미 신고한 내용입니다. 운영팀이 확인하고 있습니다." : "신고를 받았습니다. 운영팀이 확인하겠습니다."); return; }
            var msg = $("[data-report-msg]", m); msg.textContent = errMsg(r); msg.className = "cm-status err";
          });
        });
      }
      m.dataset.type = type; m.dataset.id = id;
      $("[data-report-form]", m).reset(); $("[data-report-msg]", m).textContent = "";
      m.hidden = false; var first = $("input", m); if (first) first.focus();
    });
  }

  /* ========================= 글 보기 ========================= */
  if (kind === "post") {
    var idm = /^\/community\/(\d+)/.exec(location.pathname), pid = idm ? +idm[1] : +(new URLSearchParams(location.search).get("id") || 0);
    var box = $("[data-cm-post]"), cwrap = $("[data-cm-comments]"), POST = null;
    var shareUrl = function () { return location.origin + "/community/" + pid; };
    var renderComments = function (list, cfg) {
      var me = cfg.me || {};
      cwrap.hidden = false;
      var h = '<h2>댓글<span>' + num(list.length) + "</span></h2>";
      h += list.length ? '<ol class="cm-clist">' + list.map(function (c) {
        return '<li class="' + (c.author.staff ? "staff-c" : "") + '"><div class="cm-c-head"><b>' + esc(c.author.name) + "</b>" + (c.author.staff ? '<span class="cm-tag staff">운영팀</span>' : "")
          + '<time datetime="' + esc(c.createdAt) + '">' + esc(kdate(c.createdAt, true)) + '</time><span class="cm-c-acts">'
          + (c.mine ? '<button type="button" data-del-comment="' + c.id + '">삭제</button>' : (c.author.staff ? "" : '<button type="button" data-report-comment="' + c.id + '">신고</button>')) + "</span></div><p>" + linkify(c.body) + "</p></li>";
      }).join("") + "</ol>" : '<p class="muted mt-16">아직 댓글이 없습니다. 궁금한 점이나 응원의 말을 남겨 주세요.</p>';
      if (!cfg.settings.commentsOpen) h += '<p class="cm-gate"><span>지금은 댓글을 받지 않습니다.</span></p>';
      else if (!me.loggedIn) h += '<div class="cm-gate"><p>댓글은 로그인한 회원만 남길 수 있습니다.</p><div class="actions"><a class="btn btn-primary" href="' + esc(loginUrl()) + '">로그인</a><a class="btn btn-outline" href="' + esc(signupUrl()) + '">회원가입</a></div></div>';
      else if (me.banned) h += '<p class="cm-gate"><span>커뮤니티 글쓰기가 제한된 계정입니다.</span></p>';
      else h += '<form class="cm-cform" data-cform>' + (me.nickname ? "" : '<input name="nickname" maxlength="12" placeholder="커뮤니티에서 쓸 닉네임 (2~12자)" aria-label="닉네임" required>')
        + '<textarea name="body" maxlength="' + cfg.limits.comment + '" placeholder="댓글을 남겨 주세요. 연락처 같은 개인정보는 적지 않는 것이 안전합니다." aria-label="댓글" required></textarea>'
        + '<div class="row"><span class="count" data-ccount>0 / ' + cfg.limits.comment + '</span><button class="btn btn-primary btn-sm" type="submit">댓글 남기기</button></div><p class="cm-status" data-cmsg role="status"></p></form>';
      cwrap.innerHTML = h;
    };
    var render = function (d, cfg) {
      var p = d.post; POST = p;
      document.title = p.title + (p.board === "groups" ? " — " + p.categoryName + " 모임" : "") + " | 소셜팩토리 커뮤니티";
      var crumb = $("[data-crumb]"); if (crumb) crumb.innerHTML = '<a href="/community' + (p.board === "free" ? "?board=free" : "") + '">' + esc(p.boardName) + "</a>";
      var alert = p.status === "hidden" ? '<div class="cm-alert">운영팀이 숨긴 글입니다' + (p.hiddenReason ? " (" + esc(p.hiddenReason) + ")" : "") + ". 지금은 작성자에게만 보입니다. 궁금한 점은 카카오톡 문의채널로 알려 주세요.</div>" : "";
      var likeBtn = '<button type="button" class="cm-act' + (p.liked ? " on" : "") + '" data-like aria-pressed="' + (!!p.liked) + '">' + ICON.heart + "관심 <b data-like-n>" + num(p.likes) + "</b></button>";
      var acts = likeBtn + '<button type="button" class="cm-act" data-share>' + ICON.share + '공유</button><span class="spacer"></span>'
        + (p.mine ? '<a class="cm-act" href="/community-write?id=' + p.id + '">수정</a><button type="button" class="cm-act danger" data-del-post>삭제</button>'
          : (p.author.staff ? "" : '<button type="button" class="cm-act" data-report-post>' + ICON.flag + "신고</button>"));
      var byline = '<p class="cm-byline">' + (p.board === "groups" ? "등록 " : "") + '<span class="' + (p.author.staff ? "staff" : "") + '">' + esc(p.author.name) + "</span> · " + esc(dateDot(p.publishedAt))
        + (p.updatedAt ? " (수정 " + esc(dateDot(p.updatedAt)) + ")" : "") + " · 조회 " + num(p.views) + "</p>";
      var gallery = function (imgs) {
        if (!imgs.length) return "";
        return '<div class="cm-gallery' + (imgs.length === 1 ? " one" : "") + '">' + imgs.map(function (im, i) { return '<a href="' + esc(im.url) + '" target="_blank" rel="noopener"><img src="' + esc(im.url) + '" alt="' + esc(p.title) + " 사진 " + (i + 1) + '" loading="lazy" decoding="async"></a>'; }).join("") + "</div>";
      };
      var h;
      if (p.board === "groups") {
        var i = p.info || {}, rows = [["정기 일정", i.schedule], ["다음 모임", i.nextDate ? dateDot(i.nextDate) : ""], ["모임 장소", i.roomName], ["대상 · 인원", i.audience], ["참가비", i.fee]].filter(function (r) { return r[1]; });
        var cta = "";
        if (i.joinUrl) cta += '<a class="btn btn-primary" href="' + esc(i.joinUrl) + '" target="_blank" rel="noopener nofollow ugc" data-track="community-join">' + (p.recruit === "closed" ? "모임 둘러보기" : "모임 참여하기") + " ↗</a>";
        if (i.contactUrl) cta += '<a class="btn btn-outline" href="' + esc(i.contactUrl) + '" target="_blank" rel="noopener nofollow ugc" data-track="community-contact">문의하기 ↗</a>';
        if (i.snsUrl) cta += '<a class="btn btn-outline" href="' + esc(i.snsUrl) + '" target="_blank" rel="noopener nofollow ugc">SNS · 홈페이지 ↗</a>';
        h = alert + '<article class="cm-detail is-group"><div class="cm-g-head"><div class="cm-g-media">' + (p.images && p.images.length ? '<img src="' + esc(p.images[0].url) + '" alt="' + esc(p.title) + ' 대표 사진">' : placeholder(p)) + "</div>"
          + '<div class="cm-g-side"><div class="cm-tags">' + (p.featured ? '<span class="cm-tag pick">추천 모임</span>' : "") + '<span class="cm-tag">' + esc(p.categoryName) + "</span>" + (p.recruit ? '<span class="cm-state' + (p.recruit === "closed" ? " closed" : "") + '">' + esc(p.recruitName) + "</span>" : "") + "</div>"
          + "<h1>" + esc(p.title) + '</h1><p class="cm-summary">' + esc(p.summary) + "</p>"
          + (rows.length ? '<dl class="cm-info">' + rows.map(function (r) { return "<div><dt>" + r[0] + "</dt><dd>" + esc(r[1]) + "</dd></div>"; }).join("") + "</dl>" : "")
          + (cta ? '<div class="cm-cta">' + cta + "</div>" : "")
          + (i.contactText ? '<div class="cm-contact"><b>문의 연락처</b><span>' + esc(i.contactText) + '</span><button type="button" class="cm-mini" data-copy="' + esc(i.contactText) + '">복사</button></div>' : "")
          + '<div class="cm-actions">' + acts + "</div>" + byline + "</div></div>"
          + '<div class="cm-body-wrap"><h2>모임 소개</h2><div class="cm-text">' + linkify(p.body) + "</div>" + gallery((p.images || []).slice(1)) + "</div></article>";
      } else {
        h = alert + '<article class="cm-detail is-free"><header class="cm-f-head"><div class="cm-tags">' + (p.pinned ? '<span class="cm-tag staff">공지</span>' : "") + '<span class="cm-tag">' + esc(p.categoryName) + "</span></div><h1>" + esc(p.title) + "</h1>" + byline + "</header>"
          + '<div class="cm-text">' + linkify(p.body) + "</div>" + gallery(p.images || []) + '<div class="cm-actions">' + acts + "</div></article>";
      }
      box.innerHTML = h;
      renderComments(d.comments || [], cfg);
    };
    var notFound = function (msg) {
      box.innerHTML = '<div class="cm-empty"><h3>글을 찾을 수 없습니다</h3><p>' + esc(msg || "삭제되었거나 비공개로 바뀐 글입니다.") + '</p><div class="actions"><a class="btn btn-primary" href="/community">커뮤니티로 돌아가기</a></div></div>';
    };
    if (!pid) notFound();
    else Promise.all([config(), api("GET", "/api/community/posts/" + pid)]).then(function (res) {
      var cfg = res[0], r = res[1];
      if (r.status !== 200) { notFound(r.status === 404 ? "" : errMsg(r)); return; }
      render(r.j, cfg);
      try { var key = "sfc-v-" + pid; if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, "1"); api("POST", "/api/community/posts/" + pid + "/view"); } } catch (e) { api("POST", "/api/community/posts/" + pid + "/view"); }
    }).catch(function (e) { notFound(e.message); });

    document.addEventListener("click", function (e) {
      var t;
      if ((t = e.target.closest("[data-like]"))) {
        config().then(function (cfg) {
          if (!cfg.me.loggedIn) { askLogin("관심 표시"); return; }
          t.disabled = true;
          api("POST", "/api/community/posts/" + pid + "/like").then(function (r) {
            t.disabled = false;
            if (r.status !== 200) { toast(errMsg(r)); return; }
            t.classList.toggle("on", r.j.liked); t.setAttribute("aria-pressed", r.j.liked ? "true" : "false"); $("[data-like-n]", t).textContent = num(r.j.likes);
            if (r.j.liked) toast("관심 모임 · 글로 표시했습니다.");
          });
        });
      } else if (e.target.closest("[data-share]")) {
        var url = shareUrl();
        if (navigator.share) navigator.share({ title: POST ? POST.title : document.title, url: url }).catch(function () {});
        else copy(url, "링크를 복사했습니다. 카카오톡이나 SNS에 붙여 넣어 알려 주세요.");
      } else if ((t = e.target.closest("[data-copy]"))) {
        copy(t.getAttribute("data-copy"), "연락처를 복사했습니다.");
      } else if (e.target.closest("[data-report-post]")) {
        openReport("post", pid);
      } else if ((t = e.target.closest("[data-report-comment]"))) {
        openReport("comment", +t.getAttribute("data-report-comment"));
      } else if (e.target.closest("[data-del-post]")) {
        if (!window.confirm("이 글을 지울까요? 지운 글은 되돌릴 수 없습니다.")) return;
        api("DELETE", "/api/community/posts/" + pid).then(function (r) {
          if (r.status !== 200) { toast(errMsg(r)); return; }
          location.href = "/community" + (POST && POST.board === "free" ? "?board=free" : "");
        });
      } else if ((t = e.target.closest("[data-del-comment]"))) {
        if (!window.confirm("댓글을 지울까요?")) return;
        api("DELETE", "/api/community/comments/" + t.getAttribute("data-del-comment")).then(function (r) {
          if (r.status !== 200) { toast(errMsg(r)); return; }
          config().then(function (cfg) { renderComments(r.j.comments, cfg); });
        });
      }
    });
    document.addEventListener("input", function (e) {
      if (e.target.matches("[data-cform] textarea")) { var c = $("[data-ccount]"); if (c) c.textContent = e.target.value.length + " / " + e.target.maxLength; }
    });
    document.addEventListener("submit", function (e) {
      var f = e.target.closest("[data-cform]"); if (!f) return;
      e.preventDefault();
      var btn = $("[type=submit]", f), msg = $("[data-cmsg]", f), body = f.body.value.trim();
      if (!body) { msg.textContent = "댓글 내용을 적어 주세요."; msg.className = "cm-status err"; return; }
      btn.disabled = true;
      api("POST", "/api/community/posts/" + pid + "/comments", { body: body, nickname: f.nickname ? f.nickname.value.trim() : undefined }).then(function (r) {
        btn.disabled = false;
        if (r.status !== 200) { msg.textContent = errMsg(r); msg.className = "cm-status err"; return; }
        if (f.nickname) { CFG = null; }
        config().then(function (cfg) { renderComments(r.j.comments, cfg); toast("댓글을 남겼습니다."); });
      });
    });
    return;
  }
  function copy(text, done) {
    var ok = function () { toast(done); };
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(ok, fallback); return; }
    fallback();
    function fallback() {
      var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); ok(); } catch (e) { window.prompt("아래 내용을 복사해 주세요.", text); } ta.remove();
    }
  }

  /* ========================= 글쓰기 · 고치기 ========================= */
  if (kind === "write") {
    var wq = new URLSearchParams(location.search), editId = +(wq.get("id") || 0), board = wq.get("board") === "free" ? "free" : "groups";
    var form = $("[data-cm-form]"), gate = $("[data-cm-gate]"), photos = [], dirty = false, saving = false, CF = null;
    var fieldErr = function (name, msg) {
      var el = $('[data-err="' + name + '"]', form), input = form.elements[name] || $('[name="' + name + '"]', form);
      if (el) { el.textContent = msg || ""; el.hidden = !msg; }
      if (input && input.setAttribute) { if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid"); }
    };
    var clearErrs = function () { $$("[data-err]", form).forEach(function (el) { el.hidden = true; el.textContent = ""; }); $$("[aria-invalid]", form).forEach(function (i) { i.removeAttribute("aria-invalid"); }); };
    var setBoard = function (b) {
      board = b;
      $$("[name=board]", form).forEach(function (r) { r.checked = r.value === b; });
      $$("[data-for]", form).forEach(function (el) { el.hidden = el.getAttribute("data-for") !== b; $$("input, select, textarea", el).forEach(function (i) { i.disabled = el.hidden; }); });
      var cats = CF.categories[b] || {}, admin = (CF.adminOnly || {})[b] || [], sel = form.elements.category, cur = sel.value;
      sel.innerHTML = '<option value="">분류를 골라 주세요</option>' + Object.keys(cats).filter(function (k) { return admin.indexOf(k) < 0; }).map(function (k) { return '<option value="' + k + '">' + esc(cats[k]) + "</option>"; }).join("");
      if (cats[cur]) sel.value = cur;
      $("[data-title-label]").textContent = b === "groups" ? "모임 이름" : "제목";
      form.elements.title.maxLength = CF.limits.title[b];
      form.elements.title.placeholder = b === "groups" ? "예) 건대 토요일 아침 독서모임" : "제목을 적어 주세요";
      form.elements.body.placeholder = b === "groups" ? "어떤 모임인지, 모여서 무엇을 하는지, 어떤 분과 함께하고 싶은지 적어 주세요. 진행 순서나 준비물, 처음 오는 분을 위한 안내를 적으면 참여 신청이 늘어납니다." : "내용을 적어 주세요.";
      $("[data-body-label]").textContent = b === "groups" ? "소개 글" : "내용";
      var h1 = $("[data-write-title]"); if (h1) h1.textContent = editId ? "글 고치기" : (b === "groups" ? "모임 소개 올리기" : "자유게시판 글쓰기");
      counters();
    };
    var counters = function () {
      $$("[data-count-for]", form).forEach(function (c) { var i = form.elements[c.getAttribute("data-count-for")]; if (i) c.textContent = i.value.length + " / " + i.maxLength; });
    };
    var renderPhotos = function () {
      var max = CF.limits.images, wrap = $("[data-photos]");
      wrap.innerHTML = photos.map(function (ph, i) {
        return '<div class="cm-photo' + (ph.busy ? " busy" : "") + '">' + (ph.preview || ph.url ? '<img src="' + esc(ph.preview || ph.url) + '" alt="올린 사진 ' + (i + 1) + '">' : "")
          + (i === 0 ? '<span class="badge">대표</span>' : "") + '<span class="ops">' + (i > 0 && !ph.busy ? '<button type="button" data-photo-left="' + i + '" aria-label="앞으로">‹</button>' : "")
          + (!ph.busy ? '<button type="button" data-photo-del="' + i + '" aria-label="사진 빼기">×</button>' : "") + "</span></div>";
      }).join("") + (photos.length < max ? '<label class="cm-photo-add"><b>+</b>사진 추가<small>' + photos.length + " / " + max + '</small><input type="file" accept="image/*" multiple data-photo-input></label>' : "");
    };
    var shrink = function (file) {
      return new Promise(function (resolve, reject) {
        if (file.type && !/^image\//.test(file.type)) return reject(new Error("사진 파일만 올릴 수 있습니다."));
        if (file.size > 30 * 1024 * 1024) return reject(new Error("30MB 이하 사진을 골라 주세요."));
        var url = URL.createObjectURL(file), img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          var w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) return reject(new Error("사진을 읽지 못했습니다."));
          var go = function (scale, q) {
            var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale)), c = document.createElement("canvas");
            c.width = cw; c.height = ch;
            var x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, cw, ch); x.drawImage(img, 0, 0, cw, ch);
            var data = c.toDataURL("image/jpeg", q), b64 = data.slice(data.indexOf(",") + 1), bytes = Math.floor(b64.length * 3 / 4);
            if (bytes > 560000 && (q > 0.62 || scale > 0.35)) return go(q > 0.62 ? scale : scale * 0.8, q > 0.62 ? q - 0.08 : q);
            resolve({ base64: b64, preview: data });
          };
          go(Math.min(1, 1440 / Math.max(w, h)), 0.84);
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("이 사진은 읽을 수 없습니다. JPG · PNG 사진으로 골라 주세요.")); };
        img.src = url;
      });
    };
    var addFiles = function (files) {
      var room = CF.limits.images - photos.length, list = Array.prototype.slice.call(files, 0, Math.max(0, room));
      if (files.length > room) toast("사진은 " + CF.limits.images + "장까지 올릴 수 있습니다.");
      list.forEach(function (file) {
        var ph = { busy: true }; photos.push(ph); renderPhotos(); dirty = true;
        shrink(file).then(function (out) {
          ph.preview = out.preview; renderPhotos();
          return api("POST", "/api/community/images", { base64: out.base64 }).then(function (r) {
            if (r.status !== 200) throw new Error(errMsg(r));
            ph.id = r.j.id; ph.url = r.j.url; ph.busy = false; renderPhotos();
          });
        }).catch(function (e) { photos.splice(photos.indexOf(ph), 1); renderPhotos(); toast(e.message); });
      });
    };
    var fill = function (p) {
      var f = form.elements;
      setBoard(p.board);
      f.category.value = p.category; f.title.value = p.title; f.body.value = p.body;
      if (p.board === "groups") {
        var i = p.info || {};
        f.summary.value = p.summary || ""; f.recruit.value = p.recruit || "open";
        f.schedule.value = i.schedule || ""; f.nextDate.value = i.nextDate || ""; f.room.value = i.room || ""; f.audience.value = i.audience || ""; f.fee.value = i.fee || "";
        f.joinUrl.value = i.joinUrl || ""; f.contactUrl.value = i.contactUrl || ""; f.contactText.value = i.contactText || ""; f.snsUrl.value = i.snsUrl || "";
      }
      photos = (p.images || []).map(function (im) { return { id: im.id, url: im.url }; });
      renderPhotos(); counters();
    };
    var start = function () {
      config().then(function (cfg) {
        CF = cfg;
        if (!cfg.me.loggedIn) {
          gate.hidden = false;
          $("[data-gate-login]").href = loginUrl(); $("[data-gate-signup]").href = signupUrl();
          return;
        }
        if (cfg.me.banned) { gate.hidden = false; gate.innerHTML = '<p class="cm-status err">커뮤니티 글쓰기가 제한된 계정입니다. 카카오톡 문의채널로 문의해 주세요.</p>'; return; }
        form.elements.room.innerHTML = '<option value="">선택 안 함</option>' + Object.keys(cfg.rooms).map(function (k) { return '<option value="' + k + '">' + esc(cfg.rooms[k]) + "</option>"; }).join("");
        form.elements.recruit.innerHTML = Object.keys(cfg.recruit).map(function (k) { return '<option value="' + k + '">' + esc(cfg.recruit[k]) + "</option>"; }).join("");
        form.elements.body.maxLength = cfg.limits.body; form.elements.summary.maxLength = cfg.limits.summary;
        var nick = $("[data-nick-field]");
        nick.hidden = !!cfg.me.nickname; form.elements.nickname.disabled = !!cfg.me.nickname;
        if (editId) {
          $$("[name=board]", form).forEach(function (r) { r.disabled = true; });
          $("[data-agree]").hidden = true; form.elements.agree.disabled = true;
          return api("GET", "/api/community/posts/" + editId).then(function (r) {
            if (r.status !== 200 || !r.j.post.mine) { gate.hidden = false; gate.innerHTML = '<p class="cm-status err">내가 쓴 글만 고칠 수 있습니다.</p><div class="actions"><a class="btn btn-outline" href="/community">커뮤니티로</a></div>'; return; }
            form.hidden = false; fill(r.j.post);
            $("[data-submit]").textContent = "고친 내용 저장";
          });
        }
        var open = board === "groups" ? cfg.settings.groupsOpen : cfg.settings.freeOpen;
        form.hidden = false; setBoard(board); renderPhotos();
        if (!open) toast("지금은 " + cfg.boards[board] + "에 새 글을 받지 않습니다.");
      }).catch(function (e) { gate.hidden = false; gate.innerHTML = '<p class="cm-status err">' + esc(e.message) + "</p>"; });
    };
    form.addEventListener("change", function (e) { if (e.target.name === "board") setBoard(e.target.value); dirty = true; });
    form.addEventListener("input", function () { dirty = true; counters(); });
    form.addEventListener("change", function (e) { if (e.target.matches("[data-photo-input]")) { addFiles(e.target.files); e.target.value = ""; } });
    form.addEventListener("click", function (e) {
      var t;
      if ((t = e.target.closest("[data-photo-del]"))) { photos.splice(+t.getAttribute("data-photo-del"), 1); renderPhotos(); dirty = true; }
      else if ((t = e.target.closest("[data-photo-left]"))) { var i = +t.getAttribute("data-photo-left"), x = photos[i]; photos[i] = photos[i - 1]; photos[i - 1] = x; renderPhotos(); dirty = true; }
    });
    window.addEventListener("beforeunload", function (e) { if (dirty && !saving) { e.preventDefault(); e.returnValue = ""; } });
    form.addEventListener("submit", function (e) {
      e.preventDefault(); clearErrs();
      var f = form.elements, msg = $("[data-form-msg]");
      if (photos.some(function (p) { return p.busy; })) { msg.textContent = "사진을 올리는 중입니다. 잠시 뒤 다시 눌러 주세요."; msg.className = "cm-status err"; return; }
      if (!editId && !f.agree.checked) { fieldErr("agree", "커뮤니티 이용 원칙을 확인해 주세요."); msg.textContent = "커뮤니티 이용 원칙을 확인해 주세요."; msg.className = "cm-status err"; return; }
      var body = { board: board, category: f.category.value, title: f.title.value, body: f.body.value, images: photos.map(function (p) { return p.id; }).filter(Boolean) };
      if (!f.nickname.disabled) body.nickname = f.nickname.value.trim();
      if (board === "groups") {
        body.summary = f.summary.value; body.recruit = f.recruit.value;
        body.info = { schedule: f.schedule.value, nextDate: f.nextDate.value, room: f.room.value, audience: f.audience.value, fee: f.fee.value,
          joinUrl: f.joinUrl.value, contactUrl: f.contactUrl.value, contactText: f.contactText.value, snsUrl: f.snsUrl.value };
      }
      var btn = $("[data-submit]"); btn.disabled = true; saving = true; msg.textContent = "저장하고 있습니다…"; msg.className = "cm-status";
      api(editId ? "PATCH" : "POST", editId ? "/api/community/posts/" + editId : "/api/community/posts", body).then(function (r) {
        btn.disabled = false;
        if (r.status === 200) { dirty = false; msg.textContent = "저장했습니다."; msg.className = "cm-status ok"; location.href = r.j.url; return; }
        saving = false;
        if (r.status === 401) { askLogin("글쓰기"); return; }
        var fields = r.j.fields || {};
        Object.keys(fields).forEach(function (k) { fieldErr(k, fields[k]); });
        msg.textContent = errMsg(r); msg.className = "cm-status err";
        var bad = $("[aria-invalid=true]", form); if (bad && bad.focus) bad.focus();
      });
    });
    start();
  }
})();
