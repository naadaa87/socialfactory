/* 관리자 — 초대장 · 룸 가이드
   모임 초대장 목록과 참석 응답, 다른 채널(스페이스클라우드 · 전화) 예약용 초대장 만들기,
   방마다 붙이는 룸 가이드 QR 인쇄 · 주소 바꾸기, 와이파이 정보 관리
   서버: /api/admin/meet/* (functions/_lib/meet-admin.js) */
(function () {
  "use strict";
  var A = window.SF_ADMIN;
  if (!A || !document.getElementById("view-meet")) return;
  var $ = A.$, $$ = A.$$, esc = A.esc, api = A.api;
  var TAB = "invites", CUR = null, ROOMS = [], WIFI = null, SPACES = [];
  var THEMES = { meet: "모임", study: "스터디", book: "독서모임", "class": "클래스 · 강의", seminar: "세미나 · 강연", workshop: "워크숍", meeting: "회의", party: "친목 · 파티" };
  var ROOM_NAMES = { r1: "1번룸", r2: "2번룸", r3: "3번룸", r4: "4번룸", r5: "5번룸" };
  var PHASE = { upcoming: ["예정", "blue"], today: ["오늘", "ok"], live: ["진행 중", "ok"], ended: ["끝남", "gray"], closed: ["닫힘", "bad"] };
  var DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  var num = function (v) { return (+v || 0).toLocaleString("ko-KR"); };
  function hm(min) { var m = +min, d = m >= 1440, x = m % 1440; return (d ? "다음 날 " : "") + ("0" + Math.floor(x / 60)).slice(-2) + ":" + ("0" + (x % 60)).slice(-2); }
  function dlabel(date) { var d = new Date(date + "T00:00:00Z"); return date.slice(5).replace("-", ".") + "(" + DAYS[d.getUTCDay()] + ")"; }
  function copy(text, msg) {
    var done = function () { A.toast(msg || "복사했습니다."); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function () { window.prompt("복사해 주세요.", text); });
    else window.prompt("복사해 주세요.", text);
  }
  function qrSvg(text) {
    if (typeof window.qrcode !== "function") return '<span class="muted small">QR 그림을 불러오지 못했습니다</span>';
    var q = window.qrcode(0, "M"); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
  function qrPng(text, size) {
    var q = window.qrcode(0, "M"); q.addData(text); q.make();
    var n = q.getModuleCount(), cell = Math.floor(size / (n + 6)), pad = Math.floor((size - cell * n) / 2);
    var c = document.createElement("canvas"); c.width = size; c.height = size;
    var x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, size, size); x.fillStyle = "#18233A";
    for (var r = 0; r < n; r++) for (var col = 0; col < n; col++) if (q.isDark(r, col)) x.fillRect(pad + col * cell, pad + r * cell, cell, cell);
    return c.toDataURL("image/png");
  }

  /* ---------- 요약 ---------- */
  function summary() {
    return api("/api/admin/meet/summary").then(function (d) {
      var s = d.summary;
      $("#mk-tiles").innerHTML = [["오늘 이후 초대장", num(s.upcoming) + "개", "닫힌 것 제외"], ["오늘 모임", num(s.today) + "개", "오늘 날짜"], ["참석 응답", num(s.yes) + "명", "오늘 이후 모임 · 응답 " + num(s.responses) + "개"], ["전체 초대장", num(s.total) + "개", "모임일 30일 뒤 자동 삭제"]]
        .map(function (t) { return '<div class="cmm-tile"><span>' + esc(t[0]) + "</span><b>" + esc(t[1]) + "</b><small>" + esc(t[2]) + "</small></div>"; }).join("");
    }).catch(function (e) { if (!A.guard(e)) $("#mk-tiles").innerHTML = A.emptyMsg(e.message); });
  }

  /* ---------- 탭 ---------- */
  function tab(t) {
    TAB = t;
    $$("#mk-tabs [data-mk-tab]").forEach(function (b) { b.classList.toggle("on", b.dataset.mkTab === t); });
    $$(".mk-pane").forEach(function (p) { p.hidden = p.id !== "mk-pane-" + t; });
    ({ invites: loadInvites, rooms: loadRooms, wifi: loadWifi })[t]();
  }
  $("#mk-tabs").addEventListener("click", function (e) { var b = e.target.closest("[data-mk-tab]"); if (b) tab(b.dataset.mkTab); });

  /* ---------- 초대장 목록 ---------- */
  function loadInvites() {
    var rows = $("#mk-rows");
    rows.innerHTML = '<tr><td colspan="8">' + A.emptyMsg("불러오는 중…") + "</td></tr>";
    var q = new URLSearchParams({ scope: $("#mk-scope").value, q: $("#mk-q").value.trim() });
    api("/api/admin/meet/invites?" + q).then(function (d) {
      var list = d.invites || [];
      $("#mk-count").textContent = list.length ? "초대장 " + list.length + "개" : "";
      if (!list.length) { rows.innerHTML = '<tr><td colspan="8">' + A.emptyMsg($("#mk-q").value.trim() ? "찾는 초대장이 없습니다." : "아직 초대장이 없습니다. 예약자가 예약 상세 화면에서 만들거나, 위의 '+ 초대장 만들기'로 직접 만들 수 있습니다.") + "</td></tr>"; return; }
      rows.innerHTML = list.map(function (v) {
        var ph = PHASE[v.phase] || [v.phase, ""];
        return '<tr class="mk-row" data-mk-id="' + v.id + '" tabindex="0"><td><b>' + esc(dlabel(v.date)) + "</b><small>" + esc(hm(v.startMin)) + " ~ " + esc(hm(v.endMin)) + "</small></td>"
          + "<td><b>" + esc(v.title) + "</b><small>" + esc(v.host || "모임장 이름 없음") + (v.memo ? " · " + esc(v.memo) : "") + "</small></td>"
          + "<td>" + esc(v.spaceName) + "</td>"
          + "<td>" + (v.source === "booking" ? '<span class="st blue">홈페이지 예약</span><small>' + esc(v.bookingCode) + "</small>" : '<span class="st">관리자</span>') + "</td>"
          + '<td class="r"><b>' + num(v.yes) + '</b> · <span class="muted">' + num(v.no) + "</span></td>"
          + '<td class="r">' + num(v.views) + "</td>"
          + '<td><span class="st ' + ph[1] + '">' + esc(ph[0]) + "</span>" + (v.bookingClosed ? '<small class="bad">예약 확정 아님</small>' : "") + "</td>"
          + '<td class="mk-acts"><button type="button" class="btn btn-light btn-sm" data-mk-open="' + v.id + '">보기</button><button type="button" class="btn btn-light btn-sm" data-mk-copy="' + esc(v.url) + '">링크</button></td></tr>';
      }).join("");
    }).catch(function (e) { if (!A.guard(e)) rows.innerHTML = '<tr><td colspan="8">' + A.emptyMsg(e.message) + "</td></tr>"; });
  }
  $("#mk-go").addEventListener("click", loadInvites);
  $("#mk-scope").addEventListener("change", loadInvites);
  $("#mk-q").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); loadInvites(); } });
  $("#mk-rows").addEventListener("click", function (e) {
    var c = e.target.closest("[data-mk-copy]"); if (c) { copy(c.dataset.mkCopy, "초대장 링크를 복사했습니다."); return; }
    var r = e.target.closest("[data-mk-open]") || e.target.closest(".mk-row"); if (r) openInvite(+(r.dataset.mkOpen || r.dataset.mkId));
  });
  $("#mk-rows").addEventListener("keydown", function (e) { var r = e.target.closest(".mk-row"); if (r && e.key === "Enter" && !e.target.closest("button")) openInvite(+r.dataset.mkId); });

  /* ---------- 초대장 보기 · 고치기 ---------- */
  function themeSelect(id, cur) { return '<select class="select" id="' + id + '">' + Object.keys(THEMES).map(function (k) { return '<option value="' + k + '"' + (k === cur ? " selected" : "") + ">" + esc(THEMES[k]) + "</option>"; }).join("") + "</select>"; }
  function timeOptions(cur, from, to) { var h = ""; for (var m = from; m <= to; m += 30) h += '<option value="' + m + '"' + (m === +cur ? " selected" : "") + ">" + hm(m) + "</option>"; return h; }
  function inviteFields(v, prefix, withSlot) {
    var p = prefix;
    return (withSlot ? '<div class="frow"><div class="f"><label for="' + p + '-space">방</label><select class="select" id="' + p + '-space">' + Object.keys(ROOM_NAMES).map(function (k) { return '<option value="' + k + '"' + (k === v.space ? " selected" : "") + ">" + ROOM_NAMES[k] + "</option>"; }).join("") + "</select></div>"
        + '<div class="f"><label for="' + p + '-date">날짜</label><input class="input" type="date" id="' + p + '-date" value="' + esc(v.date || "") + '"></div></div>'
        + '<div class="frow"><div class="f"><label for="' + p + '-start">시작</label><select class="select" id="' + p + '-start">' + timeOptions(v.startMin == null ? 1140 : v.startMin, 0, 1410) + "</select></div>"
        + '<div class="f"><label for="' + p + '-end">끝</label><select class="select" id="' + p + '-end">' + timeOptions(v.endMin == null ? 1320 : v.endMin, 30, 1800) + "</select></div></div>" : "")
      + '<div class="frow"><div class="f"><label for="' + p + '-title">모임 이름</label><input class="input" id="' + p + '-title" maxlength="40" value="' + esc(v.title || "") + '" required></div>'
      + '<div class="f"><label for="' + p + '-host">초대하는 사람</label><input class="input" id="' + p + '-host" maxlength="20" value="' + esc(v.hostName || "") + '"></div></div>'
      + '<div class="f"><label for="' + p + '-theme">모임 유형</label>' + themeSelect(p + "-theme", v.theme || "meet") + "</div>"
      + '<div class="f"><label for="' + p + '-message">안내 글</label><textarea class="textarea" id="' + p + '-message" rows="5" maxlength="600">' + esc(v.message || "") + "</textarea></div>"
      + '<div class="f"><label for="' + p + '-entry">출입 안내 (모임 직전에만 초대장에 보임)</label><textarea class="textarea" id="' + p + '-entry" rows="3" maxlength="300">' + esc(v.entryNote || "") + "</textarea></div>"
      + '<div class="frow"><div class="f"><label for="' + p + '-hours">출입 안내를 보여 줄 때</label><select class="select" id="' + p + '-hours">' + [1, 2, 3, 6, 12, 24].map(function (h) { return '<option value="' + h + '"' + (+(v.entryHours || 3) === h ? " selected" : "") + ">모임 시작 " + h + "시간 전부터</option>"; }).join("") + "</select></div>"
      + '<div class="f"><label class="lbl">설정</label><label class="chk small"><input type="checkbox" id="' + p + '-names"' + (v.showNamesSetting ? " checked" : "") + "> 참석자 이름을 초대장에 보여 주기</label><label class=\"chk small\"><input type=\"checkbox\" id=\"" + p + '-rsvp"' + (v.rsvpSetting !== false ? " checked" : "") + "> 참석 응답 받기</label></div></div>"
      + '<div class="f"><label for="' + p + '-memo">운영 메모 (관리자만 봄)</label><input class="input" id="' + p + '-memo" maxlength="100" value="' + esc(v.memo || "") + '" placeholder="예) 스페이스클라우드 예약 · 김OO"></div>';
  }
  function readFields(p, withSlot) {
    var b = { title: $("#" + p + "-title").value.trim(), hostName: $("#" + p + "-host").value.trim(), theme: $("#" + p + "-theme").value, message: $("#" + p + "-message").value,
      entryNote: $("#" + p + "-entry").value, entryHours: +$("#" + p + "-hours").value, showNames: $("#" + p + "-names").checked, rsvpOpen: $("#" + p + "-rsvp").checked, memo: $("#" + p + "-memo").value.trim() };
    if (withSlot) { b.space = $("#" + p + "-space").value; b.date = $("#" + p + "-date").value; b.startMin = +$("#" + p + "-start").value; b.endMin = +$("#" + p + "-end").value; }
    return b;
  }
  function openInvite(id) {
    var body = $("#mk-v-body"); body.innerHTML = A.emptyMsg("불러오는 중…"); A.openDrawer("#dr-mk-view");
    api("/api/admin/meet/invites/" + id).then(function (d) { CUR = d.invite; renderInvite(); }).catch(function (e) { if (!A.guard(e)) body.innerHTML = A.emptyMsg(e.message); });
  }
  function renderInvite() {
    var v = CUR, c = v.counts || {}, ph = PHASE[v.phase] || [v.phase, ""], admin = v.source === "admin";
    $("#mk-v-title").textContent = v.title;
    var h = '<div class="mk-head"><div><span class="st ' + ph[1] + '">' + esc(ph[0]) + "</span> " + (admin ? '<span class="st">관리자가 만듦</span>' : '<span class="st blue">홈페이지 예약 ' + esc(v.bookingCode) + "</span>") + "</div>"
      + "<p><b>" + esc(dlabel(v.date)) + " " + esc(hm(v.startMin)) + " ~ " + esc(hm(v.endMin)) + "</b> · " + esc(v.spaceName) + (v.people ? " · 예약 인원 " + v.people + "명" : "") + "</p>"
      + (v.bookingClosed ? '<p class="bad small">연결된 예약이 확정 상태가 아니어서 일행에게는 닫힌 초대장으로 보입니다.</p>' : "") + "</div>";
    h += '<div class="mk-links"><div class="mk-qr">' + qrSvg(v.url) + '</div><div class="mk-link-list">'
      + '<div><span class="lbl">초대장 (일행에게 보내는 링크)</span><div class="mk-copyrow"><input class="input" readonly value="' + esc(v.url) + '"><button type="button" class="btn btn-light btn-sm" data-mk-c="' + esc(v.url) + '">복사</button><a class="btn btn-light btn-sm" href="' + esc(v.url) + '" target="_blank" rel="noopener">열기 ↗</a></div></div>'
      + '<div><span class="lbl">관리 링크 (모임장에게만 전달)</span><div class="mk-copyrow"><input class="input" readonly value="' + esc(v.manageUrl) + '"><button type="button" class="btn btn-light btn-sm" data-mk-c="' + esc(v.manageUrl) + '">복사</button></div><p class="note small">' + (admin ? "다른 채널로 예약한 손님에게 이 링크를 보내면, 손님이 직접 초대장을 고치고 참석 응답을 볼 수 있습니다." : "예약자는 예약 상세 화면에서 같은 관리 화면으로 들어갑니다.") + "</p></div></div></div>";
    h += '<div class="cmm-tiles mk-tiles4"><div class="cmm-tile"><span>참석</span><b>' + num(c.yes) + '명</b></div><div class="cmm-tile"><span>불참</span><b>' + num(c.no) + '명</b></div><div class="cmm-tile"><span>차량</span><b>' + num(c.cars) + '대</b></div><div class="cmm-tile"><span>열람</span><b>' + num(v.views) + "회</b></div></div>";
    if (v.capacity && c.yes > v.capacity) h += '<p class="bad small">참석 응답(' + c.yes + "명)이 " + esc(v.spaceName) + " 최대 인원(" + v.capacity + "명)을 넘었습니다.</p>";
    h += (v.responses && v.responses.length) ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>이름</th><th>응답</th><th>한마디</th><th>차량</th><th>남긴 때</th></tr></thead><tbody>' + v.responses.map(function (r) {
      return "<tr><td><b>" + esc(r.name) + '</b></td><td><span class="st ' + (r.answer === "yes" ? "ok" : "gray") + '">' + (r.answer === "yes" ? "참석" : "불참") + "</span></td><td>" + esc(r.note || "") + "</td><td>" + (r.car ? "차량" : "") + "</td><td><small>" + esc(String(r.at || "").slice(5, 16)) + "</small></td></tr>";
    }).join("") + "</tbody></table></div>" : '<p class="muted small">아직 참석 응답이 없습니다.</p>';
    h += '<form class="form mk-edit" id="mk-e" novalidate><h3>초대장 고치기</h3>' + inviteFields(v, "mk-e", admin)
      + '<p class="form-note" id="mk-e-msg" role="status" hidden></p><div class="drawer-actions"><button class="btn btn-primary" type="submit">저장</button>'
      + '<button class="btn btn-light" type="button" data-mk-status="' + (v.status === "closed" ? "active" : "closed") + '">' + (v.status === "closed" ? "다시 열기" : "초대장 닫기") + "</button>"
      + '<button class="btn btn-light bad" type="button" data-mk-del>지우기</button></div></form>';
    $("#mk-v-body").innerHTML = h;
  }
  $("#dr-mk-view").addEventListener("click", function (e) {
    var c = e.target.closest("[data-mk-c]"); if (c) { copy(c.dataset.mkC, "복사했습니다."); return; }
    var st = e.target.closest("[data-mk-status]");
    if (st && CUR) {
      api("/api/admin/meet/invites/" + CUR.id, { method: "PATCH", body: { status: st.dataset.mkStatus } }).then(function (d) { CUR = d.invite; renderInvite(); A.toast(st.dataset.mkStatus === "closed" ? "초대장을 닫았습니다." : "초대장을 다시 열었습니다."); loadInvites(); summary(); })
        .catch(function (er) { if (!A.guard(er)) A.toast(er.message); });
      return;
    }
    if (e.target.closest("[data-mk-del]") && CUR) {
      if (!window.confirm("'" + CUR.title + "' 초대장과 참석 응답 " + ((CUR.counts && (CUR.counts.yes + CUR.counts.no)) || 0) + "개를 지울까요? 되돌릴 수 없습니다.")) return;
      api("/api/admin/meet/invites/" + CUR.id, { method: "DELETE" }).then(function () { A.toast("초대장을 지웠습니다."); A.closeDrawer($("#dr-mk-view")); CUR = null; loadInvites(); summary(); })
        .catch(function (er) { if (!A.guard(er)) A.toast(er.message); });
    }
  });
  $("#dr-mk-view").addEventListener("submit", function (e) {
    if (e.target.id !== "mk-e" || !CUR) return;
    e.preventDefault();
    var admin = CUR.source === "admin", b = readFields("mk-e", admin), msg = $("#mk-e-msg");
    if (!b.title) { msg.hidden = false; msg.textContent = "모임 이름을 적어 주세요."; return; }
    api("/api/admin/meet/invites/" + CUR.id, { method: "PATCH", body: b }).then(function (d) { CUR = d.invite; renderInvite(); A.toast("초대장을 고쳤습니다."); loadInvites(); })
      .catch(function (er) { if (A.guard(er)) return; msg.hidden = false; msg.textContent = er.message; });
  });

  /* ---------- 초대장 직접 만들기 ---------- */
  $("#mk-new").addEventListener("click", function () {
    var today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    $("#mk-f-body").innerHTML = '<p class="note small">스페이스클라우드 · 전화 등 다른 채널로 예약한 모임에 초대장을 만들어 줄 때 씁니다. 홈페이지 예약은 예약자가 예약 상세 화면에서 직접 만듭니다.</p>'
      + inviteFields({ space: "r3", date: today, theme: "meet", rsvpSetting: true }, "mk-f", true)
      + '<p class="form-note" id="mk-f-msg" role="status" hidden></p><div class="drawer-actions"><button class="btn btn-primary" type="submit">만들기</button><button class="btn btn-light" type="button" data-close>취소</button></div>';
    A.openDrawer("#dr-mk-form");
    $("#mk-f-title").focus();
  });
  $("#mk-f").addEventListener("submit", function (e) {
    e.preventDefault();
    var b = readFields("mk-f", true), msg = $("#mk-f-msg");
    if (!b.title) { msg.hidden = false; msg.textContent = "모임 이름을 적어 주세요."; return; }
    if (!b.date) { msg.hidden = false; msg.textContent = "날짜를 골라 주세요."; return; }
    if (b.endMin <= b.startMin) { msg.hidden = false; msg.textContent = "끝나는 시각이 시작보다 늦어야 합니다."; return; }
    var btn = $("[type=submit]", e.target); btn.disabled = true;
    api("/api/admin/meet/invites", { method: "POST", body: b }).then(function (d) {
      btn.disabled = false; A.closeDrawer($("#dr-mk-form")); A.toast("초대장을 만들었습니다. 링크를 손님에게 보내 주세요.");
      summary(); if (TAB === "invites") loadInvites(); openInvite(d.id);
    }).catch(function (er) { btn.disabled = false; if (A.guard(er)) return; msg.hidden = false; msg.textContent = er.message; });
  });

  /* ---------- 룸 QR ---------- */
  function loadRooms() {
    var box = $("#mk-rooms"); box.innerHTML = A.emptyMsg("불러오는 중…");
    api("/api/admin/meet/rooms").then(function (d) {
      ROOMS = d.rooms || [];
      box.innerHTML = ROOMS.map(function (r) {
        return '<div class="mk-room"><div class="mk-qr">' + qrSvg(r.url) + "</div><div><b>" + esc(r.name) + "</b><small>" + esc(r.sub) + '</small><div class="mk-room-acts"><a class="btn btn-light btn-sm" href="' + esc(r.url) + '" target="_blank" rel="noopener">열어 보기 ↗</a><button type="button" class="btn btn-light btn-sm" data-mk-print="' + r.id + '">인쇄</button><button type="button" class="btn btn-light btn-sm" data-mk-rotate="' + r.id + '">주소 바꾸기</button></div></div></div>';
      }).join("");
    }).catch(function (e) { if (!A.guard(e)) box.innerHTML = A.emptyMsg(e.message); });
  }
  function printRooms(list) {
    if (typeof window.qrcode !== "function") { A.toast("QR 그림을 불러오지 못했습니다. 새로고침 뒤 다시 시도해 주세요."); return; }
    var w = window.open("", "_blank");
    if (!w) { A.toast("팝업이 막혀 있습니다. 이 사이트의 팝업을 허용해 주세요."); return; }
    var cards = list.map(function (r) {
      var lines = r.kind === "room" ? "와이파이 · 화면 연결 · 연장 문의 · 퇴실 전 확인" : r.kind === "coworking" ? "와이파이 · 이용권 · 이용 원칙" : "와이파이 · 이용 안내";
      return '<section class="card"><p class="brand">SOCIAL FACTORY · 건대</p><h1>' + esc(r.name) + '</h1><p class="sub">' + esc(r.sub) + '</p><img src="' + qrPng(r.url, 900) + '" alt=""><h2>휴대폰 카메라로 찍어 주세요</h2><p class="what">' + lines + '</p><p class="foot">모임 타이머 · 팀 나누기 · 게임은 socialfactory.co.kr/play</p></section>';
    }).join("");
    w.document.write('<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>룸 가이드 QR 인쇄</title><style>'
      + '@page{size:A5;margin:0}*{box-sizing:border-box}body{margin:0;font-family:"Pretendard Variable",Pretendard,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#18233A}'
      + '.card{width:148mm;height:210mm;padding:16mm 14mm;display:flex;flex-direction:column;align-items:center;text-align:center;page-break-after:always;border-top:6mm solid #2855E8}'
      + '.brand{font-weight:800;letter-spacing:.2em;font-size:10pt;color:#2855E8;margin:0}h1{font-size:34pt;margin:6mm 0 0;letter-spacing:-.03em}.sub{margin:1mm 0 0;color:#5B6578;font-size:12pt}'
      + 'img{width:92mm;height:92mm;margin:9mm 0 6mm}h2{font-size:17pt;margin:0}.what{font-size:12pt;color:#2E3A55;margin:3mm 0 0}.foot{margin-top:auto;font-size:9.5pt;color:#5B6578}'
      + '@media screen{body{background:#EEF1F5}.card{background:#fff;margin:10mm auto;box-shadow:0 6px 24px rgba(24,35,58,.12)}}'
      + '</style></head><body>' + cards + '<script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body></html>');
    w.document.close();
  }
  $("#mk-rooms").addEventListener("click", function (e) {
    var p = e.target.closest("[data-mk-print]");
    if (p) { printRooms(ROOMS.filter(function (r) { return r.id === p.dataset.mkPrint; })); return; }
    var r = e.target.closest("[data-mk-rotate]");
    if (r) rotate(r.dataset.mkRotate);
  });
  function rotate(space) {
    var label = space === "all" ? "모든 공간" : (ROOMS.filter(function (x) { return x.id === space; })[0] || {}).name;
    if (!window.confirm(label + "의 QR 주소를 바꿀까요?\n바꾸면 지금 붙어 있는 QR로는 와이파이가 보이지 않습니다. 새 QR을 인쇄해 바꿔 붙여 주세요.")) return;
    api("/api/admin/meet/rooms/rotate", { method: "POST", body: { space: space } }).then(function (d) { ROOMS = d.rooms || []; loadRooms(); A.toast("QR 주소를 바꿨습니다. 새로 인쇄해 붙여 주세요."); })
      .catch(function (er) { if (!A.guard(er)) A.toast(er.message); });
  }
  $("#mk-print-all").addEventListener("click", function () { if (ROOMS.length) printRooms(ROOMS); });
  $("#mk-rotate-all").addEventListener("click", function () { rotate("all"); });

  /* ---------- 와이파이 ---------- */
  function netHtml(n, i) {
    return '<fieldset class="mk-net" data-net><legend>와이파이 ' + (i + 1) + '</legend>'
      + '<div class="frow"><div class="f"><label>와이파이 이름 (쉼표로 여러 개)</label><input class="input" data-ssids maxlength="200" value="' + esc((n.ssids || []).join(", ")) + '" placeholder="예) SocialFactory_2.4G, SocialFactory_5G"></div>'
      + '<div class="f"><label>비밀번호</label><input class="input" data-pw maxlength="64" value="' + esc(n.password || "") + '" autocomplete="off"></div></div>'
      + '<div class="f"><label class="lbl">이 와이파이가 잡히는 공간</label><div class="mk-spaces">' + SPACES.map(function (s) { return '<label class="chk small"><input type="checkbox" data-sp value="' + s.id + '"' + ((n.spaces || []).indexOf(s.id) >= 0 ? " checked" : "") + "> " + esc(s.name) + "</label>"; }).join("") + "</div></div>"
      + '<button type="button" class="btn btn-light btn-sm" data-net-del>이 와이파이 빼기</button></fieldset>';
  }
  function paintWifi(w) { $("#mk-nets").innerHTML = (w.networks || []).map(netHtml).join(""); }
  function readWifi() {
    return { networks: $$("#mk-nets [data-net]").map(function (f) {
      return { ssids: $("[data-ssids]", f).value.split(/[,\n]/).map(function (s) { return s.trim(); }).filter(Boolean), password: $("[data-pw]", f).value.trim(), spaces: $$("[data-sp]:checked", f).map(function (c) { return c.value; }) };
    }) };
  }
  function loadWifi() {
    $("#mk-nets").innerHTML = A.emptyMsg("불러오는 중…");
    api("/api/admin/meet/wifi").then(function (d) { WIFI = d; SPACES = d.spaces || []; paintWifi(d.wifi); })
      .catch(function (e) { if (!A.guard(e)) $("#mk-nets").innerHTML = A.emptyMsg(e.message); });
  }
  $("#mk-nets").addEventListener("click", function (e) { var d = e.target.closest("[data-net-del]"); if (d) { d.closest("[data-net]").remove(); $$("#mk-nets legend").forEach(function (l, i) { l.textContent = "와이파이 " + (i + 1); }); } });
  $("#mk-net-add").addEventListener("click", function () { if ($$("#mk-nets [data-net]").length >= 6) { A.toast("와이파이는 6개까지 넣을 수 있습니다."); return; } $("#mk-nets").insertAdjacentHTML("beforeend", netHtml({ ssids: [], password: "", spaces: [] }, $$("#mk-nets [data-net]").length)); });
  $("#mk-net-reset").addEventListener("click", function () { if (WIFI && window.confirm("처음 넣어 둔 와이파이 정보로 되돌릴까요? 저장을 눌러야 반영됩니다.")) paintWifi(WIFI.defaults); });
  $("#mk-wifi").addEventListener("submit", function (e) {
    e.preventDefault();
    var msg = $("#mk-w-msg"), body = readWifi();
    api("/api/admin/meet/wifi", { method: "PUT", body: body }).then(function (d) { msg.hidden = true; WIFI.wifi = d.wifi; paintWifi(d.wifi); A.toast("와이파이 정보를 저장했습니다. 룸 가이드와 당일 초대장에 바로 반영됩니다."); })
      .catch(function (er) { if (A.guard(er)) return; msg.hidden = false; msg.textContent = er.message; });
  });

  $("#mk-reload").addEventListener("click", function () { summary(); tab(TAB); });
  A.LOAD.meet = function () { summary(); tab(TAB); };
})();
