/* 관리자 — 커뮤니티 (모임 소개 · 자유게시판)
   게시글 · 댓글 · 신고 · 회원(글쓰기 제한) · 설정 · 운영자 글(공지 · 추천 모임 · 예약 발행)
   서버: /api/admin/community/* (functions/_lib/community-admin.js) */
(function () {
  "use strict";
  var A = window.SF_ADMIN;
  if (!A) return;
  var $ = A.$, $$ = A.$$, esc = A.esc, api = A.api;
  var META = null, TAB = "posts", PAGE = { p: 1, c: 1 }, PHOTOS = [], CUR = null, MEMBER = 0, META_CACHE = {};
  var num = function (v) { return (+v || 0).toLocaleString("ko-KR"); };
  var day = function (s) { return s ? s.slice(2, 10).replace(/-/g, ".") + " " + s.slice(11, 16) : ""; };
  var STATUS_CLS = { published: "ok", scheduled: "blue", draft: "gray", hidden: "bad", deleted: "gray" };
  var stTag = function (s, name) { return '<span class="st ' + (STATUS_CLS[s] || "") + '">' + esc(name || s) + "</span>"; };
  var meta = function () { if (!META) META = api("/api/admin/community/meta").catch(function (e) { META = null; throw e; }); return META; };

  /* ---------- 신고 수 표시 (왼쪽 메뉴) ---------- */
  function badge(n) {
    $$('[data-count="community"]').forEach(function (em) { em.textContent = n > 99 ? "99+" : String(n); em.hidden = !n; });
    var t = $("#cmm-rep-n"); if (t) { t.textContent = n; t.hidden = !n; }
  }
  function summary() {
    return api("/api/admin/community/summary").then(function (d) {
      var s = d.summary; badge(s.reportedTargets);
      $("#cmm-tiles").innerHTML = [
        ["모임 소개", num(s.groups) + "개", "공개 중"], ["자유게시판", num(s.free) + "개", "공개 중"], ["오늘 새 글 · 댓글", num(s.todayPosts) + " · " + num(s.todayComments), "오늘 올라온 것"],
        ["처리할 신고", num(s.reportedTargets) + "건", s.openReports ? "신고 " + num(s.openReports) + "개" : "없음", s.reportedTargets ? "warn" : ""],
        ["예약 · 임시 · 숨김", num(s.scheduled) + " · " + num(s.drafts) + " · " + num(s.hidden), "공개 전 · 숨긴 글"], ["커뮤니티 회원", num(s.members) + "명", s.banned ? "글쓰기 제한 " + s.banned + "명" : "닉네임을 정한 회원"]
      ].map(function (t) { return '<button type="button" class="cmm-tile ' + (t[3] || "") + '"' + (t[0] === "처리할 신고" ? ' data-cmm-goto="reports"' : "") + "><span>" + esc(t[0]) + "</span><b>" + esc(t[1]) + "</b><small>" + esc(t[2]) + "</small></button>"; }).join("");
      var mb = s.imageBytes / 1048576;
      $("#cmm-s-images").textContent = "사진 " + num(s.imageCount) + "장 · " + (mb >= 10 ? Math.round(mb) : mb.toFixed(1)) + "MB 사용 중";
    }).catch(function (e) { if (!A.guard(e)) $("#cmm-tiles").innerHTML = A.emptyMsg(e.message); });
  }
  // 로그인 직후 한 번 신고 수를 불러옵니다.
  var app = $("#app");
  if (app) {
    var once = function () { if (!app.hidden) { api("/api/admin/community/summary").then(function (d) { badge(d.summary.reportedTargets); }).catch(function () {}); return true; } return false; };
    if (!once()) { var mo = new MutationObserver(function () { if (once()) mo.disconnect(); }); mo.observe(app, { attributes: true, attributeFilter: ["hidden"] }); }
  }

  /* ---------- 탭 ---------- */
  function tab(t) {
    TAB = t;
    $$("#cmm-tabs [data-cmm-tab]").forEach(function (b) { b.classList.toggle("on", b.dataset.cmmTab === t); });
    $$(".cmm-pane").forEach(function (p) { p.hidden = p.id !== "cmm-pane-" + t; });
    ({ posts: loadPosts, comments: loadComments, reports: loadReports, members: loadMembers, settings: loadSettings })[t]();
  }
  $("#cmm-tabs").addEventListener("click", function (e) { var b = e.target.closest("[data-cmm-tab]"); if (b) tab(b.dataset.cmmTab); });
  $("#view-community").addEventListener("click", function (e) { var g = e.target.closest("[data-cmm-goto]"); if (g) tab(g.dataset.cmmGoto); });
  function pager(box, cur, pages, key, fn) {
    if (pages <= 1) { box.innerHTML = ""; return; }
    var h = "";
    for (var i = Math.max(1, cur - 4); i <= Math.min(pages, cur + 4); i++) h += '<button type="button" class="btn btn-sm ' + (i === cur ? "btn-primary" : "btn-light") + '" data-pg="' + i + '">' + i + "</button>";
    box.innerHTML = h;
    box.onclick = function (e) { var b = e.target.closest("[data-pg]"); if (b) { PAGE[key] = +b.dataset.pg; fn(); } };
  }

  /* ---------- 게시글 ---------- */
  function loadPosts() {
    var q = new URLSearchParams({ board: $("#cmm-p-board").value, status: $("#cmm-p-status").value, q: $("#cmm-p-q").value.trim(), page: PAGE.p });
    if ($("#cmm-p-reported").checked) q.set("reported", "1");
    if ($("#cmm-p-pinned").checked) q.set("pinned", "1");
    if (MEMBER) { q.set("member", MEMBER); q.set("status", "all"); }
    var rows = $("#cmm-p-rows");
    rows.innerHTML = '<tr><td colspan="8">' + A.emptyMsg("불러오는 중…") + "</td></tr>";
    return api("/api/admin/community/posts?" + q.toString()).then(function (d) {
      $("#cmm-p-count").innerHTML = (MEMBER ? "회원 #" + MEMBER + "이 쓴 글만 보는 중 · " : "") + "모두 " + num(d.total) + "개" + (MEMBER ? ' <button class="btn btn-light btn-xs" type="button" data-cmm-act="m-clear" data-id="0">전체 글 보기</button>' : "");
      rows.innerHTML = d.posts.length ? d.posts.map(function (p) {
        var flags = (p.pinned ? '<span class="st blue">고정</span> ' : "") + (p.featured ? '<span class="st blue">추천</span> ' : "");
        var toggle = p.status === "hidden" ? '<button class="btn btn-ok btn-xs" type="button" data-cmm-act="publish" data-id="' + p.id + '">다시 공개</button>'
          : (p.status === "published" || p.status === "scheduled") ? '<button class="btn btn-danger btn-xs" type="button" data-cmm-act="hide" data-id="' + p.id + '">숨기기</button>' : "";
        return '<tr class="click" data-cmm-open="' + p.id + '"><td>' + p.id + "</td><td>" + esc(p.boardName) + "<small>" + esc(p.categoryName) + "</small></td>"
          + "<td><b>" + esc(p.title) + "</b><small>" + (p.authorKind === "admin" ? "운영자 · " : "") + esc(p.author.name) + (p.memberId ? " (회원 #" + p.memberId + ")" : "") + "</small></td>"
          + "<td>" + stTag(p.status, p.statusName) + " " + flags + (p.status === "scheduled" ? "<small>" + esc(day(p.publishAt)) + " 공개</small>" : "") + (p.hiddenReason && p.status === "hidden" ? "<small>" + esc(p.hiddenReason) + "</small>" : "") + "</td>"
          + '<td class="r">' + num(p.views) + " · " + num(p.likes) + " · " + num(p.comments) + '</td><td class="r">' + (p.reports ? '<span class="st warn">' + p.reports + "</span>" : "—") + "</td>"
          + "<td>" + esc(day(p.createdAt)) + '</td><td class="cmm-acts">' + toggle + ' <button class="btn btn-light btn-xs" type="button" data-cmm-act="edit" data-id="' + p.id + '">편집</button></td></tr>';
      }).join("") : '<tr><td colspan="8">' + A.emptyMsg("조건에 맞는 글이 없습니다.") + "</td></tr>";
      pager($("#cmm-p-pager"), d.page, d.pages, "p", loadPosts);
    }).catch(function (e) { if (!A.guard(e)) rows.innerHTML = '<tr><td colspan="8">' + A.emptyMsg(e.message) + "</td></tr>"; });
  }
  $("#cmm-p-go").addEventListener("click", function () { PAGE.p = 1; loadPosts(); });
  $("#cmm-p-q").addEventListener("keydown", function (e) { if (e.key === "Enter") { PAGE.p = 1; loadPosts(); } });
  ["#cmm-p-board", "#cmm-p-status", "#cmm-p-reported", "#cmm-p-pinned"].forEach(function (s) { $(s).addEventListener("change", function () { PAGE.p = 1; loadPosts(); }); });

  function patchPost(id, body, okMsg) {
    return api("/api/admin/community/posts/" + id, { method: "PATCH", body: body }).then(function (d) {
      A.toast(okMsg || "저장했습니다."); summary(); if (TAB === "posts") loadPosts(); if (TAB === "reports") loadReports();
      if (!$("#dr-cmm-view").hidden && CUR && CUR.post.id === id) renderView(d);
      return d;
    }).catch(function (e) { if (!A.guard(e)) A.toast(e.message); });
  }
  function hidePost(id) {
    var reason = window.prompt("숨기는 이유 (작성자에게 보입니다)", "운영 원칙에 맞지 않아 숨겼습니다");
    if (reason === null) return;
    patchPost(id, { status: "hidden", hiddenReason: reason }, "숨겼습니다.");
  }
  $("#view-community").addEventListener("click", function (e) {
    var a = e.target.closest("[data-cmm-act]");
    if (a) {
      e.stopPropagation();
      var id = +a.dataset.id, act = a.dataset.cmmAct;
      if (act === "hide") hidePost(id);
      else if (act === "publish") patchPost(id, { status: "published" }, "다시 공개했습니다.");
      else if (act === "edit") openForm(id);
      else if (act === "pin") patchPost(id, { pinned: a.dataset.on !== "1" });
      else if (act === "feature") patchPost(id, { featured: a.dataset.on !== "1" });
      else if (act === "purge") {
        if (!window.confirm("이 글을 완전히 지울까요? 댓글 · 사진 · 신고 기록도 함께 지워지고 되돌릴 수 없습니다.")) return;
        api("/api/admin/community/posts/" + id, { method: "DELETE" }).then(function () { A.toast("완전히 지웠습니다."); A.closeDrawer($("#dr-cmm-view")); summary(); tab(TAB); }).catch(function (er) { if (!A.guard(er)) A.toast(er.message); });
      } else if (act === "c-hide" || act === "c-show") {
        var reason = act === "c-hide" ? window.prompt("숨기는 이유", "운영 원칙에 맞지 않아 숨겼습니다") : "";
        if (reason === null) return;
        api("/api/admin/community/comments/" + id, { method: "PATCH", body: { status: act === "c-hide" ? "hidden" : "published", hiddenReason: reason } }).then(function () {
          A.toast(act === "c-hide" ? "댓글을 숨겼습니다." : "댓글을 다시 공개했습니다."); afterComment();
        }).catch(function (er) { if (!A.guard(er)) A.toast(er.message); });
      } else if (act === "c-del") {
        if (!window.confirm("댓글을 완전히 지울까요?")) return;
        api("/api/admin/community/comments/" + id, { method: "DELETE" }).then(function () { A.toast("댓글을 지웠습니다."); afterComment(); }).catch(function (er) { if (!A.guard(er)) A.toast(er.message); });
      } else if (act === "r-hide" || act === "r-dismiss") {
        api("/api/admin/community/reports/resolve", { method: "POST", body: { type: a.dataset.type, id: id, action: act === "r-hide" ? "hide" : "dismiss" } }).then(function () {
          A.toast(act === "r-hide" ? "숨기고 신고를 처리했습니다." : "문제 없음으로 넘겼습니다."); summary(); loadReports();
        }).catch(function (er) { if (!A.guard(er)) A.toast(er.message); });
      } else if (act === "ban" || act === "unban") {
        var why = act === "ban" ? window.prompt("글쓰기를 제한하는 이유 (관리용)", "광고 · 도배") : "";
        if (why === null) return;
        api("/api/admin/community/members/" + id, { method: "PATCH", body: { banned: act === "ban", banReason: why } }).then(function () { A.toast(act === "ban" ? "글쓰기를 제한했습니다." : "제한을 풀었습니다."); loadMembers(); summary(); }).catch(function (er) { if (!A.guard(er)) A.toast(er.message); });
      } else if (act === "m-posts" || act === "m-clear") {
        MEMBER = act === "m-posts" ? id : 0; PAGE.p = 1; tab("posts");
      }
      return;
    }
    var row = e.target.closest("[data-cmm-open]");
    if (row && !e.target.closest("a, button, input, select")) openView(+row.dataset.cmmOpen);
  });
  function afterComment() { summary(); if (TAB === "comments") loadComments(); if (TAB === "reports") loadReports(); if (!$("#dr-cmm-view").hidden && CUR) openView(CUR.post.id); }

  /* ---------- 글 보기 (패널) ---------- */
  function openView(id) {
    var body = $("#cmm-v-body"); body.innerHTML = A.emptyMsg("불러오는 중…"); A.openDrawer("#dr-cmm-view");
    api("/api/admin/community/posts/" + id).then(renderView).catch(function (e) { if (!A.guard(e)) body.innerHTML = A.emptyMsg(e.message); });
  }
  function linkify(t) { return esc(t).replace(/https?:\/\/[^\s<]+/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + "</a>"; }); }
  function renderView(d) {
    CUR = d; var p = d.post, i = p.info || {}, m = d.member;
    $("#cmm-v-title").textContent = "#" + p.id + " " + p.title;
    var info = p.board === "groups" ? [["한 줄 소개", p.summary], ["모집 상태", p.recruitName], ["정기 일정", i.schedule], ["다음 모임", i.nextDate], ["장소", (META_CACHE.rooms || {})[i.room] || ""], ["대상 · 인원", i.audience], ["참가비", i.fee],
      ["참여 링크", i.joinUrl], ["문의 링크", i.contactUrl], ["문의 연락처", i.contactText], ["SNS", i.snsUrl]].filter(function (r) { return r[1]; }) : [];
    var toggle = p.status === "hidden" || p.status === "draft" ? '<button class="btn btn-ok btn-sm" type="button" data-cmm-act="publish" data-id="' + p.id + '">공개하기</button>'
      : '<button class="btn btn-danger btn-sm" type="button" data-cmm-act="hide" data-id="' + p.id + '">숨기기</button>';
    var body = $("#cmm-v-body");
    body.innerHTML = '<div class="cmm-v-top">' + stTag(p.status, p.statusName) + ' <span class="st">' + esc(p.boardName) + " · " + esc(p.categoryName) + "</span>" + (p.pinned ? ' <span class="st blue">고정</span>' : "") + (p.featured ? ' <span class="st blue">추천</span>' : "")
      + (p.status === "hidden" && p.hiddenReason ? '<p class="small muted">숨긴 이유: ' + esc(p.hiddenReason) + "</p>" : "") + (p.status === "scheduled" ? '<p class="small muted">' + esc(day(p.publishAt)) + " 에 공개됩니다.</p>" : "") + "</div>"
      + '<div class="acts">' + toggle + '<button class="btn btn-light btn-sm" type="button" data-cmm-act="edit" data-id="' + p.id + '">편집</button>'
      + (p.board === "free" ? '<button class="btn btn-light btn-sm" type="button" data-cmm-act="pin" data-on="' + (p.pinned ? 1 : 0) + '" data-id="' + p.id + '">' + (p.pinned ? "고정 풀기" : "맨 위 고정") + "</button>" : "")
      + (p.board === "groups" ? '<button class="btn btn-light btn-sm" type="button" data-cmm-act="feature" data-on="' + (p.featured ? 1 : 0) + '" data-id="' + p.id + '">' + (p.featured ? "추천 빼기" : "추천 모임") + "</button>" : "")
      + '<a class="btn btn-light btn-sm" href="' + esc(p.url) + '" target="_blank" rel="noopener">홈페이지에서 보기 ↗</a><button class="btn btn-danger btn-sm" type="button" data-cmm-act="purge" data-id="' + p.id + '">완전 삭제</button></div>'
      + '<div class="card cmm-v-meta"><div><span>작성자</span><b>' + esc(p.author.name) + "</b>" + (m ? "<small>" + esc(m.name) + " · " + esc(m.email || "") + " · " + esc(m.phone || "") + (m.banned ? ' · <b class="cmm-red">글쓰기 제한</b>' : "") + "</small>" : (p.authorKind === "admin" ? "<small>운영자 글</small>" : "<small>탈퇴한 회원</small>")) + "</div>"
      + "<div><span>올린 때</span><b>" + esc(day(p.createdAt)) + "</b>" + (p.updatedAt ? "<small>수정 " + esc(day(p.updatedAt)) + "</small>" : "") + "</div><div><span>조회 · 관심 · 댓글</span><b>" + num(p.views) + " · " + num(p.likes) + " · " + num(p.comments) + "</b></div></div>"
      + (info.length ? '<table class="tbl cmm-info">' + info.map(function (r) { return "<tr><th>" + esc(r[0]) + "</th><td>" + linkify(r[1]) + "</td></tr>"; }).join("") + "</table>" : "")
      + '<div class="cmm-v-text">' + linkify(p.body) + "</div>"
      + (p.images.length ? '<div class="cmm-v-imgs">' + p.images.map(function (im) { return '<a href="' + esc(im.url) + '" target="_blank" rel="noopener"><img src="' + esc(im.url) + '" alt=""></a>'; }).join("") + "</div>" : "")
      + '<div class="f"><label for="cmm-v-memo">운영 메모 (관리자만 봄)</label><div class="cmm-row"><input class="input" id="cmm-v-memo" maxlength="500" value="' + esc(p.adminMemo) + '"><button class="btn btn-light btn-sm" type="button" id="cmm-v-memo-save">메모 저장</button></div></div>'
      + (d.reports.length ? '<h3 class="cmm-h">신고 ' + d.reports.length + '건</h3><ul class="cmm-rlist">' + d.reports.map(function (r) { return "<li><b>" + esc(r.reasonName) + "</b> · " + esc(r.reporter) + " · " + esc(day(r.createdAt)) + ' <span class="st ' + (r.status === "open" ? "warn" : "gray") + '">' + (r.status === "open" ? "처리 전" : r.status === "resolved" ? "숨김 처리" : "문제 없음") + "</span>" + (r.detail ? "<p>" + esc(r.detail) + "</p>" : "") + "</li>"; }).join("") + "</ul>" : "")
      + '<h3 class="cmm-h">댓글 ' + d.comments.length + "개</h3>"
      + (d.comments.length ? '<ul class="cmm-clist">' + d.comments.map(function (c) {
        return '<li class="' + (c.status !== "published" ? "off" : "") + '"><div><b>' + esc(c.author) + "</b>" + (c.staff ? ' <span class="st blue">운영팀</span>' : "") + ' <small>' + esc(day(c.createdAt)) + "</small> " + (c.status !== "published" ? stTag(c.status === "hidden" ? "hidden" : "deleted", c.status === "hidden" ? "숨김" : "작성자가 삭제") : "") + (c.reports ? ' <span class="st warn">신고 ' + c.reports + "</span>" : "")
          + '<span class="cmm-c-acts">' + (c.status === "published" ? '<button class="btn btn-light btn-xs" type="button" data-cmm-act="c-hide" data-id="' + c.id + '">숨기기</button>' : c.status === "hidden" ? '<button class="btn btn-light btn-xs" type="button" data-cmm-act="c-show" data-id="' + c.id + '">다시 공개</button>' : "")
          + ' <button class="btn btn-danger btn-xs" type="button" data-cmm-act="c-del" data-id="' + c.id + '">삭제</button></span></div><p>' + linkify(c.body) + "</p></li>";
      }).join("") + "</ul>" : '<p class="small muted">아직 댓글이 없습니다.</p>')
      + '<form class="cmm-reply" id="cmm-reply"><label for="cmm-reply-t" class="lbl">운영팀 댓글 남기기</label><textarea class="textarea" id="cmm-reply-t" maxlength="500" rows="3" placeholder="예) 소개 감사합니다. 정기대관은 카카오톡 문의채널로 상담해 드려요."></textarea><div class="acts"><button class="btn btn-primary btn-sm" type="submit">소셜팩토리 이름으로 남기기</button></div></form>';
    $("#cmm-v-memo-save").onclick = function () { patchPost(p.id, { adminMemo: $("#cmm-v-memo").value }, "메모를 저장했습니다."); };
    $("#cmm-reply").onsubmit = function (e) {
      e.preventDefault(); var t = $("#cmm-reply-t").value.trim(); if (!t) return;
      api("/api/admin/community/posts/" + p.id + "/comments", { method: "POST", body: { body: t } }).then(function (dd) { A.toast("댓글을 남겼습니다."); renderView(dd); summary(); }).catch(function (er) { if (!A.guard(er)) A.toast(er.message); });
    };
  }

  /* ---------- 운영자 글 쓰기 · 편집 ---------- */
  function fillSelect(sel, obj, cur, skipEmpty) {
    sel.innerHTML = (skipEmpty ? "" : '<option value="">선택 안 함</option>') + Object.keys(obj).map(function (k) { return '<option value="' + k + '">' + esc(obj[k]) + "</option>"; }).join("");
    if (cur !== undefined) sel.value = cur;
  }
  function boardChanged() {
    var b = $("#cmm-f-board").value;
    fillSelect($("#cmm-f-category"), META_CACHE.categories[b], $("#cmm-f-category").value, true);
    $$("[data-cmm-for]").forEach(function (el) { el.hidden = el.dataset.cmmFor !== b; });
  }
  $("#cmm-f-board").addEventListener("change", boardChanged);
  $("#cmm-f-status").addEventListener("change", function () { $("#cmm-f-at-wrap").hidden = this.value !== "scheduled"; });
  function kstInput(s) { return s ? s.slice(0, 16).replace(" ", "T") : ""; }
  function openForm(id) {
    meta().then(function (m) {
      META_CACHE = m;
      var f = $("#cmm-f"); f.reset(); $("#cmm-f-msg").hidden = true; $("#cmm-f-id").value = id || "";
      fillSelect($("#cmm-f-recruit"), m.recruit, "open", true); fillSelect($("#cmm-f-room"), m.rooms, "");
      $("#cmm-f-board").disabled = !!id; PHOTOS = [];
      var show = function (p) {
        $("#cmm-f-head").textContent = id ? "글 편집 #" + id : "운영자 글 쓰기";
        $("#cmm-f-board").value = p ? p.board : "free"; boardChanged();
        if (p) {
          var i = p.info || {};
          $("#cmm-f-category").value = p.category; $("#cmm-f-title").value = p.title; $("#cmm-f-body").value = p.body;
          $("#cmm-f-summary").value = p.summary || ""; $("#cmm-f-recruit").value = p.recruit || "open"; $("#cmm-f-room").value = i.room || "";
          ["schedule", "nextDate", "audience", "fee", "joinUrl", "contactUrl", "contactText", "snsUrl"].forEach(function (k) { $("#cmm-f-" + k).value = i[k] || ""; });
          $("#cmm-f-status").value = p.status === "deleted" ? "hidden" : p.status; $("#cmm-f-at").value = kstInput(p.publishAt);
          $("#cmm-f-pinned").checked = p.pinned; $("#cmm-f-featured").checked = p.featured; $("#cmm-f-memo").value = p.adminMemo || "";
          $("#cmm-f-author").value = p.authorKind === "admin" ? p.author.name : ""; $("#cmm-f-author-wrap").hidden = p.authorKind !== "admin";
          PHOTOS = p.images.map(function (im) { return { id: im.id, url: im.url }; });
        } else { $("#cmm-f-status").value = "published"; $("#cmm-f-author-wrap").hidden = false; }
        $("#cmm-f-at-wrap").hidden = $("#cmm-f-status").value !== "scheduled";
        renderPhotos(); A.openDrawer("#dr-cmm-form");
      };
      if (!id) { show(null); $("#cmm-f-title").focus(); return; }
      api("/api/admin/community/posts/" + id).then(function (d) { show(d.post); }).catch(function (e) { if (!A.guard(e)) A.toast(e.message); });
    }).catch(function (e) { if (!A.guard(e)) A.toast(e.message); });
  }
  $("#cmm-new").addEventListener("click", function () { openForm(0); });
  function renderPhotos() {
    var box = $("#cmm-f-photos");
    box.innerHTML = PHOTOS.map(function (ph, i) {
      return '<div class="cmm-ph' + (ph.busy ? " busy" : "") + '">' + (ph.preview || ph.url ? '<img src="' + esc(ph.preview || ph.url) + '" alt="">' : "") + (i === 0 ? "<em>대표</em>" : "")
        + (ph.busy ? "" : '<span>' + (i ? '<button type="button" data-ph-left="' + i + '" aria-label="앞으로">‹</button>' : "") + '<button type="button" data-ph-del="' + i + '" aria-label="빼기">×</button></span>') + "</div>";
    }).join("") + (PHOTOS.length < 6 ? '<label class="cmm-ph-add">+ 사진<input type="file" accept="image/*" multiple id="cmm-ph-input"></label>' : "");
  }
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        var go = function (scale, q) {
          var c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
          var x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
          var data = c.toDataURL("image/jpeg", q), b64 = data.slice(data.indexOf(",") + 1);
          if (b64.length * 0.75 > 560000 && (q > 0.62 || scale > 0.35)) return go(q > 0.62 ? scale : scale * 0.8, q > 0.62 ? q - 0.08 : q);
          resolve({ base64: b64, preview: data });
        };
        go(Math.min(1, 1440 / Math.max(w, h)), 0.84);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("사진을 읽지 못했습니다.")); };
      img.src = url;
    });
  }
  $("#cmm-f-photos").addEventListener("change", function (e) {
    if (e.target.id !== "cmm-ph-input") return;
    Array.prototype.slice.call(e.target.files, 0, 6 - PHOTOS.length).forEach(function (file) {
      var ph = { busy: true }; PHOTOS.push(ph); renderPhotos();
      shrink(file).then(function (o) {
        ph.preview = o.preview; renderPhotos();
        return api("/api/admin/community/images", { method: "POST", body: { base64: o.base64 } }).then(function (r) { ph.id = r.id; ph.url = r.url; ph.busy = false; renderPhotos(); });
      }).catch(function (er) { PHOTOS.splice(PHOTOS.indexOf(ph), 1); renderPhotos(); A.toast(er.message); });
    });
  });
  $("#cmm-f-photos").addEventListener("click", function (e) {
    var t = e.target.closest("[data-ph-del]"), l = e.target.closest("[data-ph-left]");
    if (t) { PHOTOS.splice(+t.dataset.phDel, 1); renderPhotos(); }
    if (l) { var i = +l.dataset.phLeft, x = PHOTOS[i]; PHOTOS[i] = PHOTOS[i - 1]; PHOTOS[i - 1] = x; renderPhotos(); }
  });
  $("#cmm-f").addEventListener("submit", function (e) {
    e.preventDefault();
    var id = +$("#cmm-f-id").value, msg = $("#cmm-f-msg"), board = $("#cmm-f-board").value, st = $("#cmm-f-status").value;
    if (PHOTOS.some(function (p) { return p.busy; })) { A.note(msg, "사진을 올리는 중입니다. 잠시 뒤 다시 눌러 주세요."); return; }
    var b = { board: board, category: $("#cmm-f-category").value, title: $("#cmm-f-title").value, body: $("#cmm-f-body").value, images: PHOTOS.map(function (p) { return p.id; }).filter(Boolean),
      status: st, publishAt: $("#cmm-f-at").value, pinned: $("#cmm-f-pinned").checked, featured: $("#cmm-f-featured").checked, adminMemo: $("#cmm-f-memo").value };
    if (!$("#cmm-f-author-wrap").hidden) b.authorName = $("#cmm-f-author").value;
    if (board === "groups") {
      b.summary = $("#cmm-f-summary").value; b.recruit = $("#cmm-f-recruit").value;
      b.info = { room: $("#cmm-f-room").value };
      ["schedule", "nextDate", "audience", "fee", "joinUrl", "contactUrl", "contactText", "snsUrl"].forEach(function (k) { b.info[k] = $("#cmm-f-" + k).value; });
    }
    if (st === "hidden") b.hiddenReason = "운영자가 숨겼습니다";
    var btn = $("#cmm-f-save"); btn.disabled = true;
    api(id ? "/api/admin/community/posts/" + id : "/api/admin/community/posts", { method: id ? "PATCH" : "POST", body: b }).then(function (d) {
      btn.disabled = false; A.closeDrawer($("#dr-cmm-form")); A.toast(id ? "고친 내용을 저장했습니다." : "글을 올렸습니다."); summary(); tab("posts");
      if (id && !$("#dr-cmm-view").hidden) renderView(d);
    }).catch(function (er) { btn.disabled = false; if (!A.guard(er)) A.note(msg, esc(er.message)); });
  });

  /* ---------- 댓글 ---------- */
  function loadComments() {
    var q = new URLSearchParams({ status: $("#cmm-c-status").value, q: $("#cmm-c-q").value.trim(), page: PAGE.c });
    if ($("#cmm-c-reported").checked) q.set("reported", "1");
    var rows = $("#cmm-c-rows");
    rows.innerHTML = '<tr><td colspan="7">' + A.emptyMsg("불러오는 중…") + "</td></tr>";
    api("/api/admin/community/comments?" + q.toString()).then(function (d) {
      rows.innerHTML = d.comments.length ? d.comments.map(function (c) {
        var st = c.status === "published" ? stTag("published", "공개") : c.status === "hidden" ? stTag("hidden", "숨김") : stTag("deleted", "작성자가 삭제");
        return '<tr class="click" data-cmm-open="' + c.postId + '"><td>' + c.id + '</td><td class="cmm-cbody">' + esc(c.body) + "<small>글 #" + c.postId + " " + esc(c.postTitle) + "</small></td><td>" + esc(c.author) + (c.staff ? ' <span class="st blue">운영팀</span>' : "") + "</td><td>" + st + '</td><td class="r">' + (c.reports ? '<span class="st warn">' + c.reports + "</span>" : "—") + "</td><td>" + esc(day(c.createdAt)) + '</td><td class="cmm-acts">'
          + (c.status === "published" ? '<button class="btn btn-danger btn-xs" type="button" data-cmm-act="c-hide" data-id="' + c.id + '">숨기기</button>' : c.status === "hidden" ? '<button class="btn btn-ok btn-xs" type="button" data-cmm-act="c-show" data-id="' + c.id + '">다시 공개</button>' : "")
          + ' <button class="btn btn-light btn-xs" type="button" data-cmm-act="c-del" data-id="' + c.id + '">삭제</button></td></tr>';
      }).join("") : '<tr><td colspan="7">' + A.emptyMsg("댓글이 없습니다.") + "</td></tr>";
      pager($("#cmm-c-pager"), d.page, d.pages, "c", loadComments);
    }).catch(function (e) { if (!A.guard(e)) rows.innerHTML = '<tr><td colspan="7">' + A.emptyMsg(e.message) + "</td></tr>"; });
  }
  $("#cmm-c-go").addEventListener("click", function () { PAGE.c = 1; loadComments(); });
  $("#cmm-c-q").addEventListener("keydown", function (e) { if (e.key === "Enter") { PAGE.c = 1; loadComments(); } });
  ["#cmm-c-status", "#cmm-c-reported"].forEach(function (s) { $(s).addEventListener("change", function () { PAGE.c = 1; loadComments(); }); });

  /* ---------- 신고 ---------- */
  function loadReports() {
    var box = $("#cmm-r-list"), status = $("#cmm-r-status").value;
    box.innerHTML = A.emptyMsg("불러오는 중…");
    api("/api/admin/community/reports?status=" + status).then(function (d) {
      box.innerHTML = d.groups.length ? d.groups.map(function (g) {
        var t = g.target, open = g.reports.some(function (r) { return r.status === "open"; });
        return '<div class="card cmm-report"><div class="cmm-report-head"><span class="st ' + (open ? "warn" : "gray") + '">' + (g.type === "post" ? "글" : "댓글") + " 신고 " + g.reports.length + "건</span>"
          + (t ? " <b>" + esc(g.type === "post" ? t.title : "글 #" + t.postId + " " + t.title + "의 댓글") + "</b> <small>" + esc(t.author) + " · " + (t.status === "published" ? "공개 중" : t.status === "hidden" ? "숨김" : esc(t.status)) + "</small>" : " <b>이미 지워진 대상</b>") + "</div>"
          + (t ? '<p class="cmm-report-ex">' + esc(t.excerpt) + "</p>" : "")
          + '<ul class="cmm-rlist">' + g.reports.map(function (r) { return "<li><b>" + esc(r.reasonName) + "</b> · " + esc(r.reporter) + " · " + esc(day(r.createdAt)) + (r.detail ? "<p>" + esc(r.detail) + "</p>" : "") + "</li>"; }).join("") + "</ul>"
          + '<div class="acts">' + (open && t ? (t.status === "published" ? '<button class="btn btn-danger btn-sm" type="button" data-cmm-act="r-hide" data-type="' + g.type + '" data-id="' + g.targetId + '">숨기기</button>' : "")
            + '<button class="btn btn-light btn-sm" type="button" data-cmm-act="r-dismiss" data-type="' + g.type + '" data-id="' + g.targetId + '">문제 없음</button>' : "")
          + (t ? '<button class="btn btn-light btn-sm" type="button" data-cmm-open="' + (g.type === "post" ? t.id : t.postId) + '">글 자세히</button><a class="btn btn-light btn-sm" href="' + esc(t.url) + '" target="_blank" rel="noopener">홈페이지에서 보기 ↗</a>' : "") + "</div></div>";
      }).join("") : A.emptyMsg(status === "open" ? "처리할 신고가 없습니다." : "신고 기록이 없습니다.");
    }).catch(function (e) { if (!A.guard(e)) box.innerHTML = A.emptyMsg(e.message); });
  }
  $("#cmm-r-status").addEventListener("change", loadReports);

  /* ---------- 회원 ---------- */
  function loadMembers() {
    var q = new URLSearchParams({ q: $("#cmm-m-q").value.trim() }); if ($("#cmm-m-banned").checked) q.set("banned", "1");
    var rows = $("#cmm-m-rows");
    rows.innerHTML = '<tr><td colspan="7">' + A.emptyMsg("불러오는 중…") + "</td></tr>";
    api("/api/admin/community/members?" + q.toString()).then(function (d) {
      rows.innerHTML = d.members.length ? d.members.map(function (m) {
        return "<tr><td><b>" + esc(m.nickname) + "</b><small>회원 #" + m.memberId + "</small></td><td>" + esc(m.name) + "<small>" + esc(m.email) + (m.phone ? " · " + esc(m.phone) : "") + "</small></td>"
          + '<td class="r">' + num(m.posts) + '</td><td class="r">' + num(m.comments) + '</td><td class="r">' + (m.reported ? '<span class="st warn">' + m.reported + "</span>" : "—") + "</td>"
          + "<td>" + (m.banned ? stTag("hidden", "글쓰기 제한") + (m.banReason ? "<small>" + esc(m.banReason) + "</small>" : "") : stTag("published", "정상")) + '</td><td class="cmm-acts">'
          + (m.posts ? '<button class="btn btn-light btn-xs" type="button" data-cmm-act="m-posts" data-id="' + m.memberId + '">글 보기</button> ' : "")
          + (m.banned ? '<button class="btn btn-light btn-xs" type="button" data-cmm-act="unban" data-id="' + m.memberId + '">제한 풀기</button>' : '<button class="btn btn-danger btn-xs" type="button" data-cmm-act="ban" data-id="' + m.memberId + '">글쓰기 제한</button>') + "</td></tr>";
      }).join("") : '<tr><td colspan="7">' + A.emptyMsg("커뮤니티에 참여한 회원이 아직 없습니다.") + "</td></tr>";
    }).catch(function (e) { if (!A.guard(e)) rows.innerHTML = '<tr><td colspan="7">' + A.emptyMsg(e.message) + "</td></tr>"; });
  }
  $("#cmm-m-go").addEventListener("click", loadMembers);
  $("#cmm-m-q").addEventListener("keydown", function (e) { if (e.key === "Enter") loadMembers(); });
  $("#cmm-m-banned").addEventListener("change", loadMembers);

  /* ---------- 설정 ---------- */
  function loadSettings() {
    api("/api/admin/community/settings").then(function (d) {
      var s = d.settings;
      $("#cmm-s-groups").checked = s.groupsOpen; $("#cmm-s-free").checked = s.freeOpen; $("#cmm-s-comments").checked = s.commentsOpen;
      $("#cmm-s-notice").value = s.notice || ""; $("#cmm-s-words").value = (s.bannedWords || []).join(", "); $("#cmm-s-auto").value = String(s.autoHide || 0);
      if (!$("#cmm-s-auto").value) $("#cmm-s-auto").value = "0";
    }).catch(function (e) { if (!A.guard(e)) A.toast(e.message); });
  }
  $("#cmm-s-form").addEventListener("submit", function (e) {
    e.preventDefault();
    api("/api/admin/community/settings", { method: "PUT", body: { groupsOpen: $("#cmm-s-groups").checked, freeOpen: $("#cmm-s-free").checked, commentsOpen: $("#cmm-s-comments").checked,
      notice: $("#cmm-s-notice").value, bannedWords: $("#cmm-s-words").value, autoHide: +$("#cmm-s-auto").value } }).then(function () {
      A.note($("#cmm-s-msg"), "설정을 저장했습니다. 홈페이지에 바로 적용됩니다.", true);
    }).catch(function (er) { if (!A.guard(er)) A.note($("#cmm-s-msg"), esc(er.message)); });
  });

  $("#cmm-reload").addEventListener("click", function () { summary(); tab(TAB); });
  A.LOAD.community = function () { meta().then(function (m) { META_CACHE = m; }).catch(function () {}); summary(); tab(TAB); };
})();
