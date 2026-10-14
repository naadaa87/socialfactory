/* 소셜팩토리 — 이용권 구매 (상품 · 주문서 · 주문 완료)
   결제는 KG이니시스 표준결제(PC 결제창 · 모바일 결제)를 쓰고, 금액 계산과 승인은 모두 서버(functions/api/orders, functions/api/pay)에서 합니다. */
(function () {
  "use strict";
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var won = function (n) { return Number(n || 0).toLocaleString("ko-KR"); };
  var params = {};
  location.search.replace(/^\?/, "").split("&").forEach(function (kv) { if (kv) { var p = kv.split("="); params[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || "").replace(/\+/g, " ")); } });
  var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  var api = function (method, url, body) {
    return fetch(url, { method: method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j || {} }; }, function () { return { status: r.status, j: {} }; }); })
      .catch(function () { return { status: 0, j: { error: "network" } }; });
  };
  var MSG = {
    "pay-off": "온라인 결제를 준비하고 있습니다. 카카오톡 문의채널이나 문의 폼으로 신청해 주세요.",
    "no-db": "온라인 결제를 준비하고 있습니다. 카카오톡 문의채널이나 문의 폼으로 신청해 주세요.",
    "no-table": "주문 저장소가 아직 준비되지 않았습니다. 관리자에게 알려 주세요.",
    "origin": "다른 사이트에서 보낸 요청은 받지 않습니다. 페이지를 새로 고친 뒤 다시 시도해 주세요.",
    "network": "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    "default": "주문을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."
  };
  var FIELD = { required: "필수 항목입니다.", phone: "연락 가능한 휴대폰 번호를 적어 주세요.", email: "이메일 주소를 확인해 주세요.", past: "오늘 이후 날짜로 골라 주세요.", far: "오늘부터 30일 안에서 골라 주세요." };

  // 결제 준비 상태 → 안내 문구 표시 (상품 · 목록 · 주문서 공통)
  var payState = api("GET", "/api/shop/products").then(function (res) {
    var pay = (res.j && res.j.pay) || {};
    var ready = res.status === 200 && !!pay.ready;
    $$("[data-pay-off]").forEach(function (el) { el.hidden = ready; });
    $$("[data-pay-test]").forEach(function (el) { el.hidden = !(ready && pay.test); });
    return { ready: ready, test: !!pay.test, mobile: !!pay.mobile };
  });

  /* ---------------- 수량 스테퍼 ---------------- */
  var stepper = function (box, onChange) {
    var input = $("input", box);
    var clamp = function () { var v = parseInt(input.value, 10); if (!(v >= 1)) v = 1; if (v > 10) v = 10; input.value = v; return v; };
    $$("[data-step]", box).forEach(function (b) { b.addEventListener("click", function () { input.value = (parseInt(input.value, 10) || 1) + parseInt(b.getAttribute("data-step"), 10); onChange(clamp()); }); });
    input.addEventListener("change", function () { onChange(clamp()); });
    input.addEventListener("input", function () { var v = parseInt(input.value, 10); if (v >= 1 && v <= 10) onChange(v); });
    return { get: clamp, set: function (v) { input.value = v; onChange(clamp()); } };
  };

  /* ---------------- 상품 상세 페이지 ---------------- */
  var buy = $("[data-buy]");
  if (buy) {
    var pid = buy.getAttribute("data-product");
    var unit = parseInt(($("[data-total]", buy).textContent || "0").replace(/[^0-9]/g, ""), 10) || 0;
    var btn = $("[data-buy-btn]", buy);
    var upd = function (q) { $("[data-total]", buy).textContent = won(unit * q); btn.href = "/order?p=" + encodeURIComponent(pid) + "&qty=" + q; };
    stepper($("[data-stepper]", buy), upd);
    payState.then(function (st) { if (!st.ready) { btn.hidden = true; $(".pd-qty", buy).hidden = true; $(".pd-total", buy).hidden = true; var ask = $(".pd-ask", buy); if (ask) ask.hidden = true; } });
  }

  /* ---------------- 주문서 ---------------- */
  var orderPage = $("[data-shop-page=\"order\"]");
  if (orderPage) {
    var data = {}; try { data = JSON.parse($("#sf-products").textContent); } catch (e) { data = { products: [] }; }
    var product = (data.products || []).filter(function (p) { return p.id === params.p; })[0];
    var loading = $("[data-od-loading]");
    var form = $("[data-order-form]");
    var qty = Math.max(1, Math.min(10, parseInt(params.qty, 10) || 1));
    if (!product) {
      loading.hidden = true; $("[data-od-none]").hidden = false;
    } else {
      var t = function (sel, v) { $$(sel).forEach(function (el) { el.textContent = v; }); };
      var img = $("[data-od-img]"); img.src = product.image + "-sm.webp"; img.alt = product.imageAlt || product.name;
      t("[data-od-cat]", product.category); t("[data-od-name]", product.name); t("[data-od-short]", product.short);
      t("[data-od-price]", won(product.price)); t("[data-od-unit]", product.unit); t("[data-od-validity]", product.validity);
      t("[data-od-sum-name]", product.name); t("[data-od-sum-each]", won(product.price));
      var total = function (q) { t("[data-od-sum-qty]", q); t("[data-od-total]", won(product.price * q)); t("[data-od-total-btn]", won(product.price * q)); };
      var st = stepper($("[data-stepper]", form), total);
      form.elements.qty.value = qty; total(qty);
      document.title = product.name + " 주문서 | 소셜팩토리 건대";

      // 이용 시작일이 필요한 상품만 날짜 입력을 보인다 (오늘 ~ 30일 뒤)
      var startBox = $("[data-od-start]");
      if (product.start === "date") {
        startBox.hidden = false;
        $("[data-od-start-label]").innerHTML = esc(product.startLabel || "이용 시작일") + " <em>*</em>";
        var kst = function (d) { return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10); };
        var today = new Date();
        form.elements.startDate.min = kst(today);
        form.elements.startDate.max = kst(new Date(today.getTime() + 30 * 86400000));
        form.elements.startDate.value = kst(today);
      }

      // 로그인한 회원이면 이름 · 연락처를 채운다
      api("GET", "/api/auth/me").then(function (res) {
        if (res.j && res.j.ok && res.j.member) {
          var m = res.j.member;
          if (!form.elements.name.value) form.elements.name.value = m.name || "";
          if (!form.elements.phone.value) form.elements.phone.value = m.phone || "";
          if (!form.elements.email.value) form.elements.email.value = m.email || "";
        } else if (res.status === 401) {
          var note = $("[data-od-login]"); note.hidden = false;
          $("[data-od-login-link]").href = "/login?next=" + encodeURIComponent("/order?p=" + product.id + "&qty=" + st.get());
        }
      });

      // 전체 동의
      var all = $("[data-agree-all]", form);
      var reqs = ["agreeTerms", "agreePrivacy", "agreeRefund"].map(function (n) { return form.elements[n]; });
      all.addEventListener("change", function () { reqs.forEach(function (c) { c.checked = all.checked; }); });
      reqs.forEach(function (c) { c.addEventListener("change", function () { all.checked = reqs.every(function (x) { return x.checked; }); }); });

      var showErr = function (key, msg) {
        var e = $("[data-err=\"" + key + "\"]", form); if (!e) return;
        e.textContent = msg || ""; e.hidden = !msg;
        var input = form.elements[key]; if (input && input.setAttribute) { if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid"); }
      };
      var clearErrs = function () { $$("[data-err]", form).forEach(function (e) { e.hidden = true; e.textContent = ""; }); $$("[aria-invalid]", form).forEach(function (i) { i.removeAttribute("aria-invalid"); }); };
      ["name", "phone", "email", "startDate"].forEach(function (k) { var i = form.elements[k]; if (i) i.addEventListener("input", function () { showErr(k, ""); }); });
      reqs.forEach(function (c) { c.addEventListener("change", function () { if (reqs.every(function (x) { return x.checked; })) showErr("agree", ""); }); });
      var msgBox = $("[data-od-msg]");
      var notice = function (m) { msgBox.textContent = m || ""; msgBox.hidden = !m; };
      var submitBtn = $("[data-od-submit]");
      var busy = function (on) { submitBtn.disabled = on; submitBtn.classList.toggle("is-busy", on); $("[data-od-total-btn]").parentNode.lastChild.textContent = on ? " 결제창을 여는 중…" : "원 결제하기"; };

      payState.then(function (ps) {
        loading.hidden = true;
        if (!ps.ready) { $("[data-pay-off]", orderPage).hidden = false; return; }
        $("[data-od-main]").hidden = false;
      });

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        clearErrs(); notice("");
        var el = form.elements;
        var ok = true;
        if (!el.name.value.trim()) { showErr("name", FIELD.required); ok = false; }
        var digits = el.phone.value.replace(/[^0-9]/g, "");
        if (digits.length < 9 || digits.length > 15) { showErr("phone", FIELD.phone); ok = false; }
        if (el.email.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.email.value.trim())) { showErr("email", FIELD.email); ok = false; }
        if (product.start === "date" && !el.startDate.value) { showErr("startDate", FIELD.required); ok = false; }
        if (!reqs.every(function (c) { return c.checked; })) { showErr("agree", "필수 항목에 모두 동의해 주세요."); ok = false; }
        if (!ok) { var first = $("[aria-invalid], [data-err]:not([hidden])", form); if (first) first.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
        busy(true);
        api("POST", "/api/orders", {
          productId: product.id, qty: st.get(), name: el.name.value.trim(), phone: el.phone.value.trim(), email: el.email.value.trim(),
          startDate: product.start === "date" ? el.startDate.value : "", memo: el.memo.value.trim(), payMethod: el.payMethod.value,
          device: isMobile ? "mobile" : "pc", agreeTerms: el.agreeTerms.checked, agreePrivacy: el.agreePrivacy.checked, agreeRefund: el.agreeRefund.checked, website: el.website.value
        }).then(function (res) {
          var j = res.j || {};
          if (!j.ok) {
            busy(false);
            if (j.error === "invalid" && j.fields) {
              Object.keys(j.fields).forEach(function (k) { showErr(k, k === "agree" ? "필수 항목에 모두 동의해 주세요." : (FIELD[j.fields[k]] || FIELD.required)); });
              if (j.fields.productId) notice("상품 정보가 바뀌었습니다. 이용권 목록에서 다시 골라 주세요.");
            } else notice(MSG[j.error] || MSG["default"]);
            return;
          }
          try { sessionStorage.setItem("sf_last_order", JSON.stringify({ oid: j.oid, t: j.token })); } catch (err) { /* 저장 못 해도 진행 */ }
          if (j.pay.mode === "mobile") openMobile(j.pay); else openPc(j.pay, j);
        });
      });

      // PC: KG이니시스 결제창(INIStdPay) — 서버가 돌려준 값으로 폼을 채우고 결제창을 연다
      var openPc = function (pay, j) {
        var f = $("#inicisForm");
        f.innerHTML = "";
        Object.keys(pay.fields).forEach(function (k) { var i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = pay.fields[k]; f.appendChild(i); });
        var go = function () {
          if (!window.INIStdPay) { busy(false); notice("결제창을 불러오지 못했습니다. 광고 차단 기능을 잠시 끄거나 다른 브라우저로 시도해 주세요."); return; }
          try { window.INIStdPay.pay("inicisForm"); busy(false); }
          catch (err) { busy(false); notice("결제창을 열지 못했습니다. 잠시 후 다시 시도해 주세요."); }
        };
        if (window.INIStdPay) { go(); return; }
        var s = document.createElement("script"); s.src = pay.js; s.charset = "UTF-8";
        s.onload = go; s.onerror = function () { busy(false); notice("결제창 스크립트를 불러오지 못했습니다. 네트워크 상태를 확인하고 다시 시도해 주세요."); };
        document.head.appendChild(s);
      };
      // 모바일: 이니시스 모바일 결제 페이지로 폼 전송 (결제 뒤 P_NEXT_URL 로 돌아온다)
      var openMobile = function (pay) {
        var f = document.createElement("form"); f.method = "post"; f.action = pay.action; f.acceptCharset = "UTF-8"; f.hidden = true;
        Object.keys(pay.fields).forEach(function (k) { var i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = pay.fields[k]; f.appendChild(i); });
        document.body.appendChild(f); f.submit();
      };
    }
  }

  /* ---------------- 주문 완료 ---------------- */
  var done = $("[data-shop-page=\"complete\"]");
  if (done) {
    var oid = params.oid || "", tok = params.t || "";
    if (!oid) { try { var last = JSON.parse(sessionStorage.getItem("sf_last_order") || "null"); if (last) { oid = last.oid; tok = last.t; } } catch (e) { /* 없음 */ } }
    var set = function (sel, v) { var el = $(sel); if (el) el.textContent = v; };
    var show = function (sel) { var el = $(sel); if (el) el.hidden = false; };
    var finish = function () { $("[data-oc-loading]").hidden = true; };
    var STATUS_CLASS = { paid: "done", used: "done", pending: "ing", refund_requested: "ing", refunded: "", cancelled: "", failed: "" };
    if (!oid) {
      finish(); show("[data-oc-notfound]"); set("[data-oc-title]", "주문을 찾을 수 없습니다"); set("[data-oc-lead]", "주문번호가 없는 주소입니다.");
    } else {
      api("GET", "/api/orders/status?oid=" + encodeURIComponent(oid) + "&t=" + encodeURIComponent(tok)).then(function (res) {
        finish();
        var o = res.j && res.j.order;
        if (!o) { show("[data-oc-notfound]"); set("[data-oc-title]", "주문을 찾을 수 없습니다"); set("[data-oc-lead]", "주소를 다시 확인해 주세요."); return; }
        var paid = o.status === "paid" || o.status === "used";
        if (paid) {
          show("[data-oc-done]"); set("[data-oc-oid]", o.oid); set("[data-oc-title]", "결제가 완료되었습니다"); set("[data-oc-lead]", o.productName + " 주문이 접수되었습니다. 주문번호를 꼭 보관해 주세요.");
          if (o.test) show("[data-oc-test]");
        } else {
          show("[data-oc-fail]"); set("[data-oc-eyebrow]", "Payment failed"); set("[data-oc-title]", o.status === "pending" ? "결제가 완료되지 않았습니다" : o.statusLabel);
          set("[data-oc-lead]", o.status === "pending" ? "결제창이 닫혔거나 결제가 끝나지 않았습니다. 다시 시도해 주세요." : "이 주문은 " + o.statusLabel + " 상태입니다.");
          if (params.fail || o.failMsg) set("[data-oc-fail-msg]", (params.fail || o.failMsg) + " — 돈이 빠져나갔다면 자동으로 취소되니 걱정하지 않으셔도 됩니다. 그래도 걱정되면 주문번호 " + o.oid + " 와 함께 알려 주세요.");
          $("[data-oc-retry]").href = "/order?p=" + encodeURIComponent(o.productId) + "&qty=" + (o.qty || 1);
        }
        show("[data-oc-detail]");
        set("[data-oc-d-oid]", o.oid); set("[data-oc-d-product]", o.productName); set("[data-oc-d-amount]", won(o.amount)); set("[data-oc-d-pay]", o.payMethod + (o.cardName ? " · " + o.cardName : ""));
        if (o.startDate) { show("[data-oc-d-start-row]"); set("[data-oc-d-start-label]", o.startLabel || "이용 시작일"); set("[data-oc-d-start]", o.startDate); }
        set("[data-oc-d-validity]", o.validity || "—"); set("[data-oc-d-buyer]", o.buyerName + " · " + o.buyerPhone + (o.buyerEmail ? " · " + o.buyerEmail : ""));
        set("[data-oc-d-paid]", o.paidAt || "—");
        var stEl = $("[data-oc-d-status]"); stEl.textContent = o.statusLabel; stEl.className = "mi-st " + (STATUS_CLASS[o.status] || "");
        try { if (paid) sessionStorage.removeItem("sf_last_order"); } catch (e) { /* 없음 */ }
      });
    }
  }
})();
