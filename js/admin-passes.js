/* 소셜팩토리 관리자 — 고객 · 이용권 (토스프론트) 화면
   이용권 · 고객 · 결제 · 알림톡 · 단말기. 공통 도구는 js/admin.js 의 window.SF_ADMIN 을 씁니다. */
(function () {
  "use strict";
  var A = window.SF_ADMIN; if (!A) return;
  var $ = A.$, $$ = A.$$, esc = A.esc, num = A.num, won = A.won, api = A.api, toast = A.toast, guard = A.guard, emptyMsg = A.emptyMsg;
  var onErr = function (e) { if (!guard(e)) toast(e.message); };

  /* ---------- 표시 ---------- */
  var PAYM = { CARD: "카드", CASH: "현금", BARCODE: "간편결제", card_offline: "카드(POS · 현장)", bank_other: "계좌이체", cash: "현금", free: "무료 · 보상" };
  var CHAN = { toss_front: "토스프론트", admin: "관리자 등록" };
  var PPST = { pending: ["결제 대기", ""], paid: ["결제 완료", "ok"], canceled: ["고객 취소", "gray"], timeout: ["시간 초과", "gray"], failed: ["실패", "bad"], refunded: ["환불", "warn"] };
  var JST = { queued: ["보낼 예정", "blue"], sending: ["보내는 중", "blue"], sent: ["발송 접수", "ok"], logged: ["기록만", "gray"], failed: ["실패", "bad"], cancelled: ["취소", "gray"] };
  var JKIND = { purchase: "구매 완료", expire_soon: "만료 예정", renewal: "연장 완료", refund: "취소·환불 완료" };
  var toMs = function (s) { return Date.parse(String(s || "").replace(" ", "T") + "+09:00"); };
  var short = function (s) { return s ? (+s.slice(5, 7)) + "/" + (+s.slice(8, 10)) + " " + s.slice(11, 16) : ""; };
  function leftText(ends) {
    var m = Math.round((toMs(ends) - Date.now()) / 6e4);
    if (m <= 0) return "만료";
    if (m < 60) return m + "분 남음";
    if (m < 1440) return Math.floor(m / 60) + "시간 " + (m % 60 ? (m % 60) + "분 " : "") + "남음";
    return Math.floor(m / 1440) + "일 " + (Math.floor(m % 1440 / 60) ? Math.floor(m % 1440 / 60) + "시간 " : "") + "남음";
  }
  function passState(p) {
    if (p.status === "cancelled") return '<span class="st gray">취소</span>';
    var now = Date.now(), s = toMs(p.starts_at), e = toMs(p.ends_at);
    if (e <= now) return '<span class="st gray">만료</span>';
    if (s > now) return '<span class="st">시작 전</span>';
    return '<span class="st ' + (e - now < 3 * 864e5 ? "warn" : "ok") + '">이용 중</span>';
  }
  function bar(p) {
    var s = toMs(p.starts_at), e = toMs(p.ends_at), n = Date.now();
    if (p.status === "cancelled" || n >= e || n < s) return "";
    var pct = Math.max(2, Math.min(100, (e - n) / (e - s) * 100));
    return '<span class="left-bar' + (e - n < 3 * 864e5 ? " soon" : "") + '"><i style="width:' + pct.toFixed(1) + '%"></i></span>';
  }
  var tel = function (c) { var t = String(c || "").replace(/[^0-9]/g, ""); return t ? '<a href="tel:' + esc(t) + '">' + esc(c) + "</a>" : ""; };
  var custCell = function (r) { return '<button class="linkbtn" type="button" data-cust="' + esc(r.customer_id) + '"><b>' + esc(r.phone_fmt || "") + "</b></button>" + (r.customer_name ? "<small>" + esc(r.customer_name) + "</small>" : ""); };

  /* ---------- 탭 ---------- */
  var TAB = new URLSearchParams(location.search).get("front-ui") === "1" ? "ui" : "passes";
  function setTab(t) {
    TAB = t;
    $$("#ps-tabs [data-tab]").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === t); });
    $$("#view-pass .ps-pane").forEach(function (p) { p.hidden = p.dataset.pane !== t; });
    ({ passes: loadPasses, customers: loadCustomers, payments: loadPayments, jobs: loadJobs, devices: loadDevices, logs: loadLogs, ui: A.loadKioskUi })[t]();
  }
  $("#ps-tabs").addEventListener("click", function (e) { var b = e.target.closest("[data-tab]"); if (b) setTab(b.dataset.tab); });
  A.LOAD.pass = function () { setTab(TAB); };

  function loadLogs() {
    var box = $("#pl-rows"), key = $("#pl-key").value.trim();
    api("/api/admin/kiosk-logs" + (key ? "?paymentKey=" + encodeURIComponent(key) : "")).then(function (j) {
      box.innerHTML = (j.results || []).length ? j.results.map(function (r) {
        return "<tr><td>" + esc(r.created_at) + "</td><td>" + esc(r.device_name || "") +
          "</td><td class=\"mono\">" + esc(r.payment_key) + "</td><td>" + esc(r.kind) +
          "</td><td>" + esc(r.code) + (r.http_status ? " · HTTP " + esc(r.http_status) : "") + "</td></tr>";
      }).join("") : '<tr><td colspan="5">' + emptyMsg("기록된 오류가 없습니다.") + "</td></tr>";
    }).catch(function (e) { if (!guard(e)) box.innerHTML = '<tr><td colspan="5">' + emptyMsg(e.message) + "</td></tr>"; });
  }
  $("#pl-reload").addEventListener("click", loadLogs);
  $("#pl-key").addEventListener("keydown", function (e) { if (e.key === "Enter") loadLogs(); });

  /* ---------- 이용권 ---------- */
  var PS = { items: [], products: [], payMethods: {} };
  A.invalidatePassProducts = function () { PS.products = []; };
  function loadPasses() {
    var box = $("#ps-rows");
    api("/api/admin/passes?state=" + encodeURIComponent($("#ps-state").value) + "&q=" + encodeURIComponent($("#ps-q").value.trim())).then(function (j) {
      PS.items = j.results || []; PS.products = j.products || []; PS.payMethods = j.payMethods || {};
      var s = j.summary || {};
      $("#ps-kpis").innerHTML =
        '<button type="button" class="kpi" data-ps-state="active"><small>지금 이용 중</small><b>' + num(s.inUse) + "<em>명</em></b></button>"
        + '<button type="button" class="kpi' + (s.endsToday ? " warn" : "") + '" data-ps-state="expiring"><small>오늘 만료</small><b>' + num(s.endsToday) + "<em>명</em></b></button>"
        + '<button type="button" class="kpi" data-ps-state="expiring"><small>3일 안에 만료</small><b>' + num(s.ends3d) + "<em>명</em></b></button>"
        + '<button type="button" class="kpi" data-ps-tab="customers"><small>전체 고객</small><b>' + num(s.customers) + "<em>명</em></b></button>";
      box.innerHTML = PS.items.length ? PS.items.map(function (p) {
        return "<tr><td><b>" + esc(p.product_name) + '</b><small class="mono">' + esc(p.code) + "</small>" + (p.test_mode ? '<span class="st test">테스트</span>' : "") + (p.memo ? "<small>" + esc(p.memo) + "</small>" : "") + "</td>"
          + "<td>" + custCell(p) + "</td>"
          + '<td class="nw">' + passState(p) + " <small>" + esc(short(p.starts_at)) + " ~ <b>" + esc(short(p.ends_at)) + "</b></small>" + (p.status === "active" && toMs(p.ends_at) > Date.now() ? "<small>" + esc(leftText(p.ends_at)) + "</small>" : "") + bar(p) + "</td>"
          + '<td class="nw"><b>' + won(p.amount) + "</b><small>" + esc(CHAN[p.channel] || p.channel || "") + " · " + esc(PAYM[p.pay_method] || p.pay_method || "") + "</small>" + (p.refund_amount ? '<small class="bad">환불 ' + won(p.refund_amount) + "</small>" : "") + "</td>"
          + '<td><div class="row-actions">' + (p.status === "active" ? '<button class="btn btn-light btn-xs" type="button" data-pa="adjust" data-id="' + p.id + '">만료 변경</button><button class="btn btn-light btn-xs" type="button" data-pa="move" data-id="' + p.id + '">번호 옮기기</button><button class="btn btn-danger btn-xs" type="button" data-pa="cancel" data-id="' + p.id + '">취소</button>' : "") + (p.status === "cancelled" && p.refund_amount > 0 ? '<button class="btn btn-light btn-xs" type="button" data-pa="refund-notify" data-id="' + p.id + '">환불 완료 알림</button>' : "") + '<button class="btn btn-light btn-xs" type="button" data-pa="memo" data-id="' + p.id + '">메모</button></div></td></tr>';
      }).join("") : '<tr><td colspan="5">' + emptyMsg("해당하는 이용권이 없습니다.") + "</td></tr>";
    }).catch(function (e) { if (!guard(e)) box.innerHTML = '<tr><td colspan="5">' + emptyMsg(e.message) + "</td></tr>"; });
  }
  $("#ps-state").addEventListener("change", loadPasses);
  $("#ps-reload").addEventListener("click", loadPasses);
  $("#ps-q").addEventListener("keydown", function (e) { if (e.key === "Enter") loadPasses(); });
  $("#ps-kpis").addEventListener("click", function (e) {
    var k = e.target.closest("[data-ps-state]"); if (k) { $("#ps-state").value = k.dataset.psState; loadPasses(); return; }
    var t = e.target.closest("[data-ps-tab]"); if (t) setTab(t.dataset.psTab);
  });
  $("#ps-csv").addEventListener("click", function () {
    if (!PS.items.length) { toast("내려받을 이용권이 없습니다."); return; }
    A.csvDownload("소셜팩토리_이용권.csv", ["이용권 번호", "상품", "전화번호", "이름", "시작", "만료", "상태", "금액", "환불", "경로", "결제수단", "메모"], PS.items.map(function (p) {
      return [p.code, p.product_name, p.phone_fmt, p.customer_name || "", p.starts_at, p.ends_at, p.status, p.amount, p.refund_amount || 0, CHAN[p.channel] || p.channel, PAYM[p.pay_method] || p.pay_method || "", p.memo || ""];
    }));
  });

  // 이용권 관리 (만료 변경 · 번호 옮기기 · 취소 · 메모)
  function passAction(id, act, after) {
    var p = PS.items.filter(function (x) { return x.id === id; })[0] || (CUST && (CUST.passes || []).filter(function (x) { return x.id === id; })[0]);
    if (!p) return;
    var body = { id: id, action: act };
    if (act === "adjust") {
      var v = prompt(p.product_name + " · " + p.phone_fmt + "\n새 만료 시각을 'YYYY-MM-DD HH:MM' 형식으로 적어 주세요.\n(연장 · 단축 모두 가능, 뒤에 이어 붙은 이용권은 그대로입니다)", String(p.ends_at).slice(0, 16));
      if (!v) return; body.endsAt = v.trim();
    } else if (act === "move") {
      var ph = prompt(p.product_name + " 이용권을 옮길 휴대폰 번호를 적어 주세요.\n(고객이 번호를 잘못 누른 경우)", "");
      if (!ph) return; body.phone = ph.trim();
    } else if (act === "cancel") {
      var started = toMs(p.starts_at) <= Date.now();
      var rf = prompt(p.product_name + " · " + p.phone_fmt + " 이용권을 취소합니다.\n\n환불한 금액(원)을 적어 주세요. 환불하지 않았으면 0.\n※ 카드 환불은 토스 단말기에서 먼저 취소해야 합니다. 여기는 기록만 합니다." + (started ? "\n※ 이미 이용을 시작한 이용권입니다. 규정에 맞게 차감해 주세요." : ""), started ? "0" : String(p.amount || 0));
      if (rf === null) return;
      body.refundAmount = parseInt(String(rf).replace(/[^0-9]/g, ""), 10) || 0;
      body.rechain = true;
      if (!confirm("이용권을 취소할까요? 뒤에 이어 붙은 이용권이 있으면 앞당겨집니다." + (body.refundAmount ? "\n환불 " + won(body.refundAmount) + " 기록" : ""))) return;
      if (body.refundAmount > 0) body.refundConfirmed = confirm("실제 환불 처리를 완료하셨나요?\n\n확인: 취소·환불 완료 알림도 대기열에 등록합니다.\n취소: 금액만 기록하고 완료 알림은 등록하지 않습니다.");
    } else if (act === "refund-notify") {
      if (!confirm("실제 환불 처리가 완료됐음을 확인하고 취소·환불 완료 알림을 등록할까요?\n같은 결제의 알림이 이미 있으면 중복 등록하지 않습니다.")) return;
      body.refundConfirmed = true;
    } else if (act === "memo") {
      var m = prompt("이용권 메모", p.memo || ""); if (m === null) return; body.memo = m;
    }
    api("/api/admin/passes", { method: "PATCH", body: body }).then(function () { toast("처리했습니다."); loadPasses(); if (after) after(); A.refreshCounts(); }).catch(onErr);
  }
  $("#ps-rows").addEventListener("click", function (e) { var b = e.target.closest("[data-pa]"); if (b) passAction(+b.dataset.id, b.dataset.pa); });

  /* ---------- 이용권 직접 발급 ---------- */
  function openIssue(pre) {
    pre = pre || {};
    var go = function () {
      $("#pf").reset(); $("#pf-msg").hidden = true;
      $("#pf-product").innerHTML = PS.products.map(function (p) { return '<option value="' + esc(p.id) + '" data-price="' + p.price + '">' + esc(p.name) + " · " + won(p.price) + "</option>"; }).join("");
      $("#pf-pay").innerHTML = Object.keys(PS.payMethods).map(function (k) { return '<option value="' + k + '">' + esc(PS.payMethods[k]) + "</option>"; }).join("");
      $("#pf-amount").value = PS.products.length ? PS.products[0].price : "";
      if (pre.phone) $("#pf-phone").value = pre.phone;
      if (pre.name) $("#pf-name").value = pre.name;
      A.openDrawer("#dr-pass"); setTimeout(function () { $(pre.phone ? "#pf-product" : "#pf-phone").focus(); }, 50);
    };
    if (PS.products.length) go(); else api("/api/admin/passes?state=active&q=__none__").then(function (j) { PS.products = j.products || []; PS.payMethods = j.payMethods || {}; go(); }).catch(onErr);
  }
  $("#ps-new").addEventListener("click", function () { openIssue(); });
  $("#pf-product").addEventListener("change", function () { var o = this.selectedOptions[0]; if (o) $("#pf-amount").value = o.dataset.price; });
  $("#pf").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var st = $("#pf-start").value, body = {
      phone: $("#pf-phone").value, name: $("#pf-name").value, productId: $("#pf-product").value, amount: $("#pf-amount").value,
      payMethod: $("#pf-pay").value, startsAt: st ? st.replace("T", " ") : "", notify: $("#pf-notify").checked, memo: $("#pf-memo").value
    };
    var b = $("#pf-submit"); b.disabled = true;
    api("/api/admin/passes", { method: "POST", body: body }).then(function (j) {
      A.closeDrawer($("#dr-pass")); toast("발급했습니다 · " + j.pass.code + " · " + short(j.pass.starts_at) + " ~ " + short(j.pass.ends_at));
      loadPasses(); if (CUST && !$("#dr-cust").hidden) openCustomer(CUST.customer.id);
    }).catch(function (e) { if (!guard(e)) A.note($("#pf-msg"), esc(e.message)); }).then(function () { b.disabled = false; });
  });

  /* ---------- 고객 ---------- */
  var CL = [];
  function loadCustomers() {
    var box = $("#pc-rows");
    api("/api/admin/customers?q=" + encodeURIComponent($("#pc-q").value.trim())).then(function (j) {
      CL = j.results || [];
      box.innerHTML = CL.length ? CL.map(function (c) {
        var active = c.active_until && toMs(c.active_until) > Date.now();
        return "<tr><td>" + custCell({ customer_id: c.id, phone_fmt: c.phone_fmt, customer_name: c.name }) + (c.memo ? "<small>" + esc(c.memo) + "</small>" : "") + "</td>"
          + '<td class="nw">' + (active ? '<span class="st ok">이용 중</span> <b>' + esc(short(c.active_until)) + "</b><small>" + esc(leftText(c.active_until)) + "</small>" : '<span class="st gray">없음</span>') + "</td>"
          + "<td>" + num(c.pass_count) + "장</td><td class=\"nw\">" + won(c.paid_total) + '</td><td class="nw">' + esc(c.last_paid ? short(c.last_paid) : "-") + "</td>"
          + '<td><button class="btn btn-light btn-xs" type="button" data-cust="' + c.id + '">상세</button></td></tr>';
      }).join("") : '<tr><td colspan="6">' + emptyMsg("고객이 없습니다.") + "</td></tr>";
    }).catch(function (e) { if (!guard(e)) box.innerHTML = '<tr><td colspan="6">' + emptyMsg(e.message) + "</td></tr>"; });
  }
  $("#pc-reload").addEventListener("click", loadCustomers);
  $("#pc-q").addEventListener("keydown", function (e) { if (e.key === "Enter") loadCustomers(); });
  $("#pc-csv").addEventListener("click", function () {
    if (!CL.length) { toast("내려받을 고객이 없습니다."); return; }
    A.csvDownload("소셜팩토리_이용권고객.csv", ["전화번호", "이름", "메모", "이용 만료", "이용권 수", "누적 결제", "최근 결제", "등록"], CL.map(function (c) { return [c.phone_fmt, c.name || "", c.memo || "", c.active_until || "", c.pass_count, c.paid_total, c.last_paid || "", c.created_at]; }));
  });

  var CUST = null;
  function openCustomer(id) {
    A.openDrawer("#dr-cust"); $("#pc-body").innerHTML = emptyMsg("불러오는 중…");
    api("/api/admin/customers?id=" + id).then(function (d) {
      CUST = d; var c = d.customer;
      $("#pc-title").textContent = c.phone_fmt + (c.name ? " · " + c.name : "");
      var line = function (l, r) { return '<div class="pc-line"><div>' + l + "</div><div class=\"r\">" + r + "</div></div>"; };
      var passes = (d.passes || []).map(function (p) {
        return line("<b>" + esc(p.product_name) + "</b> " + passState(p) + "<small>" + esc(short(p.starts_at)) + " ~ " + esc(short(p.ends_at)) + " · " + esc(p.code) + "</small>" + bar(p),
          won(p.amount) + "<small>" + esc(CHAN[p.channel] || "") + "</small>" + (p.status === "active" ? '<div class="row-actions"><button class="btn btn-light btn-xs" type="button" data-pca="adjust" data-id="' + p.id + '">만료 변경</button><button class="btn btn-danger btn-xs" type="button" data-pca="cancel" data-id="' + p.id + '">취소</button></div>' : ""));
      }).join("") || emptyMsg("이용권이 없습니다.");
      var pays = (d.payments || []).map(function (p) { var s = PPST[p.status] || [p.status, ""]; return line(esc(p.product_name) + ' <span class="st ' + s[1] + '">' + esc(s[0]) + "</span><small>" + esc(p.paid_at || p.created_at) + (p.approval_number ? " · 승인 " + esc(p.approval_number) : "") + (p.card_issuer ? " · " + esc(p.card_issuer) : "") + "</small>", won(p.amount) + (p.refund_amount ? '<small class="bad">환불 ' + won(p.refund_amount) + "</small>" : "")); }).join("") || emptyMsg("결제가 없습니다.");
      var jobs = (d.jobs || []).map(function (j) { var s = JST[j.status] || [j.status, ""]; return line(esc(JKIND[j.kind] || j.kind) + ' <span class="st ' + s[1] + '">' + esc(s[0]) + "</span><small>" + esc(short(j.sent_at || j.send_after)) + (j.last_error ? " · " + esc(j.last_error) : "") + "</small>", ""); }).join("") || emptyMsg("알림이 없습니다.");
      var res = (d.reservations || []).map(function (r) { return line(esc(r.date) + " · " + esc(r.space) + "<small>" + esc(r.code) + (r.status === "cancelled" ? " · 취소" : "") + "</small>", won(r.amount)); }).join("");
      var ords = (d.orders || []).map(function (o) { return line(esc(o.product_name) + "<small>" + esc(o.oid) + " · " + esc(o.created_at) + "</small>", won(o.amount)); }).join("");
      $("#pc-body").innerHTML =
        '<div class="frow"><div class="f"><label for="pc-name">이름</label><input class="input" id="pc-name" maxlength="40" value="' + esc(c.name || "") + '"></div><div class="f"><label for="pc-memo">메모</label><input class="input" id="pc-memo" maxlength="500" value="' + esc(c.memo || "") + '"></div></div>'
        + '<label class="chk"><input type="checkbox" id="pc-notify-off"' + (c.notify_off ? " checked" : "") + '> <span>알림톡 받지 않음 <small class="muted">(고객이 거부를 요청한 경우)</small></span></label>'
        + '<div class="row-actions"><button class="btn btn-light btn-sm" type="button" id="pc-save">저장</button><button class="btn btn-primary btn-sm" type="button" id="pc-issue">+ 이 고객에게 이용권 발급</button>' + tel(c.phone_fmt).replace("<a ", '<a class="btn btn-light btn-sm" ') + "</div>"
        + '<p class="tiny muted">등록 ' + esc(c.created_at) + (c.privacy_agreed_at ? " · 개인정보 안내 동의 " + esc(c.privacy_agreed_at) : "") + "</p>"
        + '<div class="pc-sec"><h3>이용권</h3>' + passes + "</div>"
        + '<div class="pc-sec"><h3>결제</h3>' + pays + "</div>"
        + '<div class="pc-sec"><h3>알림톡</h3>' + jobs + "</div>"
        + (res ? '<div class="pc-sec"><h3>같은 번호의 룸 예약</h3>' + res + "</div>" : "")
        + (ords ? '<div class="pc-sec"><h3>같은 번호의 홈페이지 주문</h3>' + ords + "</div>" : "");
    }).catch(function (e) { if (!guard(e)) $("#pc-body").innerHTML = emptyMsg(e.message); });
  }
  document.addEventListener("click", function (e) {
    var c = e.target.closest("[data-cust]"); if (c && c.closest("#view-pass")) { openCustomer(+c.dataset.cust); return; }
    var a = e.target.closest("[data-pca]"); if (a) { passAction(+a.dataset.id, a.dataset.pca, function () { openCustomer(CUST.customer.id); }); return; }
    if (e.target.closest("#pc-save")) {
      api("/api/admin/customers", { method: "PATCH", body: { id: CUST.customer.id, name: $("#pc-name").value, memo: $("#pc-memo").value, notifyOff: $("#pc-notify-off").checked } }).then(function () { toast("저장했습니다."); if (TAB === "customers") loadCustomers(); else loadPasses(); }).catch(onErr);
      return;
    }
    if (e.target.closest("#pc-issue")) { openIssue({ phone: CUST.customer.phone_fmt, name: CUST.customer.name }); }
  });

  /* ---------- 결제 ---------- */
  var PL = [];
  function loadPayments() {
    var box = $("#pp-rows");
    api("/api/admin/passes?view=payments&status=" + encodeURIComponent($("#pp-status").value) + "&q=" + encodeURIComponent($("#pp-q").value.trim())).then(function (j) {
      PL = j.results || [];
      box.innerHTML = PL.length ? PL.map(function (p) {
        var s = PPST[p.status] || [p.status, ""];
        return '<tr><td class="nw">' + esc(p.paid_at || p.created_at) + '<small class="mono">' + esc(p.payment_key) + "</small>" + (p.test_mode ? '<span class="st test">테스트</span>' : "") + "</td>"
          + '<td><span class="st ' + s[1] + '">' + esc(s[0]) + "</span>" + (p.fail_reason ? "<small>" + esc(p.fail_reason) + "</small>" : "") + "<small>" + esc(CHAN[p.channel] || p.channel) + (p.device_name ? " · " + esc(p.device_name) : "") + "</small></td>"
          + "<td>" + custCell(p) + "</td>"
          + "<td>" + esc(p.product_name) + "<small><b>" + won(p.amount) + "</b>" + (p.refund_amount ? " · 환불 " + won(p.refund_amount) : "") + "</small></td>"
          + "<td>" + esc(PAYM[p.pay_method] || p.pay_method || "-") + (p.card_issuer ? " · " + esc(p.card_issuer) : "") + (p.approval_number ? '<small class="mono">승인 ' + esc(p.approval_number) + "</small>" : "") + (p.masked_card ? '<small class="mono">' + esc(p.masked_card) + "</small>" : "") + "</td>"
          + '<td class="mono">' + esc(p.pass_code || "-") + "</td></tr>";
      }).join("") : '<tr><td colspan="6">' + emptyMsg("결제가 없습니다.") + "</td></tr>";
    }).catch(function (e) { if (!guard(e)) box.innerHTML = '<tr><td colspan="6">' + emptyMsg(e.message) + "</td></tr>"; });
  }
  $("#pp-status").addEventListener("change", loadPayments);
  $("#pp-reload").addEventListener("click", loadPayments);
  $("#pp-q").addEventListener("keydown", function (e) { if (e.key === "Enter") loadPayments(); });
  $("#pp-csv").addEventListener("click", function () {
    if (!PL.length) { toast("내려받을 결제가 없습니다."); return; }
    var cols = ["payment_key", "created_at", "paid_at", "status", "channel", "device_name", "phone_fmt", "customer_name", "product_name", "amount", "refund_amount", "pay_method", "card_issuer", "approval_number", "approved_ts", "masked_card", "pass_code", "test_mode", "fail_reason"];
    A.csvDownload("소셜팩토리_이용권결제.csv", cols, PL.map(function (p) { return cols.map(function (k) { return p[k]; }); }));
  });

  /* ---------- 알림톡 ---------- */
  function loadJobs() {
    var box = $("#pj-rows");
    api("/api/admin/passes?view=jobs&status=" + encodeURIComponent($("#pj-filter").value)).then(function (j) {
      var c = j.counts || {};
      $("#pj-status").innerHTML = (j.provider === "log"
        ? "<b>실제 발송 꺼짐</b> — 문구만 기록합니다. 검수 승인 후 발송 설정과 템플릿을 확인하고 실제 발송을 켜 주세요."
        : "발송 방식: <b>" + esc(j.provider) + "</b>")
        + (j.cron ? "" : " · 5분마다 도는 발송기(<code>CRON_KEY</code> · workers/notify-cron)가 아직 없어 만료 알림은 이 화면의 '지금 보내기'로만 나갑니다.")
        + "<br><small>보낼 예정 " + num(c.queued) + " · 발송 접수 " + num(c.sent) + " · 기록만 " + num(c.logged) + " · 실패 " + num(c.failed) + " · 실제 도착 여부는 발송 업체 전송내역에서 확인해 주세요.</small>";
      var list = j.results || [];
      box.innerHTML = list.length ? list.map(function (x) {
        var s = JST[x.status] || [x.status, ""];
        var btn = x.status === "queued" ? '<button class="btn btn-light btn-xs" type="button" data-job="job-cancel" data-id="' + x.id + '">보내지 않기</button>'
          : (x.status === "failed" || x.status === "logged" || (x.status === "cancelled" && x.kind === "purchase")) ? '<button class="btn btn-light btn-xs" type="button" data-job="job-retry" data-id="' + x.id + '">다시 보내기</button>' : "";
        return '<tr><td class="nw">' + esc(short(x.send_after)) + (x.sent_at ? "<small>보냄 " + esc(short(x.sent_at)) + "</small>" : "") + "</td>"
          + "<td>" + esc(JKIND[x.kind] || x.kind) + ' <span class="st ' + s[1] + '">' + esc(s[0]) + "</span>" + (x.attempts ? "<small>시도 " + x.attempts + "번</small>" : "") + (x.last_error ? '<small class="bad">' + esc(x.last_error) + "</small>" : "") + "</td>"
          + "<td>" + custCell(x) + "</td>"
          + '<td><div class="msgpre">' + esc(x.rendered || "(보낼 때 문구가 만들어집니다)") + "</div></td><td>" + btn + "</td></tr>";
      }).join("") : '<tr><td colspan="5">' + emptyMsg("알림이 없습니다.") + "</td></tr>";
    }).catch(function (e) { if (!guard(e)) box.innerHTML = '<tr><td colspan="5">' + emptyMsg(e.message) + "</td></tr>"; });
  }
  $("#pj-filter").addEventListener("change", loadJobs);
  $("#pj-reload").addEventListener("click", loadJobs);
  $("#pj-run").addEventListener("click", function () {
    var b = this; b.disabled = true;
    api("/api/notify/run", { method: "POST", body: {} }).then(function (r) { toast("처리 " + r.picked + "건 · 보냄 " + r.sent + " · 기록만 " + r.logged + " · 재시도 " + r.retry + " · 실패 " + r.failed); loadJobs(); A.refreshCounts(); }).catch(onErr).then(function () { b.disabled = false; });
  });
  $("#pj-test").addEventListener("click", function () {
    var b = this, status = $("#pj-test-status"); b.disabled = true;
    status.textContent = "알리고 테스트 모드로 연결 확인 중…";
    fetch("/api/admin/alimtalk-test", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (result) {
        if (response.status === 401) { guard({ status: 401 }); return; }
        if (!response.ok || result.ok === false) {
          status.textContent = "연결 시험 실패 (HTTP " + response.status + "): " + (result.error || "서버 응답을 확인해 주세요.");
          return;
        }
        status.textContent = result.test && result.accepted ? "알리고 API가 테스트 요청을 받았습니다. 실제 알림톡은 발송되지 않았습니다." : "테스트 결과를 확인해 주세요.";
      });
    }).catch(function () { status.textContent = "연결 시험 실패: 서버에 연결하지 못했습니다."; }).then(function () { b.disabled = false; });
  });
  $("#pj-rows").addEventListener("click", function (e) {
    var b = e.target.closest("[data-job]"); if (!b) return;
    api("/api/admin/passes", { method: "PATCH", body: { jobId: +b.dataset.id, action: b.dataset.job } }).then(function () { toast(b.dataset.job === "job-retry" ? "다시 보낼 목록에 넣었습니다." : "보내지 않기로 했습니다."); loadJobs(); }).catch(onErr);
  });

  /* ---------- 단말기 ---------- */
  var DST = { pairing: ["연결 코드 대기", "warn"], active: ["연결됨", "ok"], revoked: ["연결 해제", "gray"] };
  function loadDevices() {
    var box = $("#pd-rows");
    api("/api/admin/kiosk-devices").then(function (j) {
      var list = j.results || [];
      box.innerHTML = list.length ? list.map(function (d) {
        var s = DST[d.status] || [d.status, ""];
        return "<tr><td><b>" + esc(d.name) + "</b><small>#" + d.id + "</small></td>"
          + '<td><span class="st ' + s[1] + '">' + esc(s[0]) + "</span>" + (d.status === "pairing" && d.pair_expires_at ? "<small>코드 유효 ~" + esc(short(d.pair_expires_at)) + "</small>" : "") + "</td>"
          + '<td class="mono">' + esc(d.serial || "-") + "</td>"
          + '<td class="nw">' + esc(d.paired_at ? short(d.paired_at) : "-") + "<small>최근 " + esc(d.last_seen_at ? A.ago(d.last_seen_at) : "-") + "</small></td>"
          + '<td><div class="row-actions"><button class="btn btn-light btn-xs" type="button" data-dev="code" data-id="' + d.id + '">새 연결 코드</button><button class="btn btn-light btn-xs" type="button" data-dev="rename" data-id="' + d.id + '">이름</button>' + (d.status !== "revoked" ? '<button class="btn btn-danger btn-xs" type="button" data-dev="revoke" data-id="' + d.id + '">연결 해제</button>' : "") + "</div></td></tr>";
      }).join("") : '<tr><td colspan="5">' + emptyMsg("연결한 단말기가 없습니다. '+ 단말기 연결 코드 만들기'로 시작하세요.") + "</td></tr>";
    }).catch(function (e) { if (!guard(e)) box.innerHTML = '<tr><td colspan="5">' + emptyMsg(e.message) + "</td></tr>"; });
  }
  function showCode(code) { var t = $("#pd-code"); t.hidden = false; t.innerHTML = "연결 코드: <b class=\"mono\" style=\"font-size:20px;letter-spacing:2px\">" + esc(code) + "</b> — 30분 안에 토스프론트의 '단말기 연결' 화면에 입력해 주세요. 이 코드는 다시 볼 수 없습니다."; }
  $("#pd-new").addEventListener("click", function () {
    var name = prompt("단말기 이름 (예: 입구 토스프론트)", "토스프론트"); if (name === null) return;
    api("/api/admin/kiosk-devices", { method: "POST", body: { name: name } }).then(function (j) { showCode(j.code); loadDevices(); }).catch(onErr);
  });
  $("#pd-reload").addEventListener("click", loadDevices);
  $("#pd-rows").addEventListener("click", function (e) {
    var b = e.target.closest("[data-dev]"); if (!b) return;
    var id = +b.dataset.id, act = b.dataset.dev, body = { id: id, action: act };
    if (act === "code" && !confirm("새 연결 코드를 만들면 지금 연결은 끊기고, 단말기에서 코드를 다시 입력해야 합니다. 계속할까요?")) return;
    if (act === "revoke" && !confirm("이 단말기의 연결을 해제할까요? 해제하면 그 단말기에서는 결제할 수 없습니다.")) return;
    if (act === "rename") { var n = prompt("단말기 이름"); if (!n) return; body.name = n; }
    api("/api/admin/kiosk-devices", { method: "PATCH", body: body }).then(function (j) { if (j.code) showCode(j.code); else toast("처리했습니다."); loadDevices(); }).catch(onErr);
  });
})();
