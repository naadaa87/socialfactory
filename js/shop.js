/* 소셜팩토리 — 이용권 구매 (상품 · 주문서 · 주문 완료)
   결제는 설정된 결제사(페이앱 · KG이니시스)를 쓰고, 금액 계산과 승인은 모두 서버(functions/api/orders, functions/api/pay)에서 합니다. */
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
    "pay-rejected": "결제창을 준비하지 못했습니다. 잠시 후 다시 시도하거나 카카오톡으로 문의해 주세요.",
    "rate-limit": "결제 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
    "request-conflict": "주문 내용이 바뀌었습니다. 페이지를 새로 고친 뒤 다시 시도해 주세요.",
    "pay-off": "온라인 결제를 준비하고 있습니다. 카카오톡 문의채널이나 문의 폼으로 신청해 주세요.",
    "no-db": "온라인 결제를 준비하고 있습니다. 카카오톡 문의채널이나 문의 폼으로 신청해 주세요.",
    "no-table": "주문 저장소가 아직 준비되지 않았습니다. 관리자에게 알려 주세요.",
    "origin": "다른 사이트에서 보낸 요청은 받지 않습니다. 페이지를 새로 고친 뒤 다시 시도해 주세요.",
    "network": "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    "default": "주문을 만들지 못했습니다. 잠시 후 다시 시도해 주세요."
  };
  var FIELD = { datetime: "이용 시작 날짜와 시간을 정확히 선택해 주세요.", pastTime: "현재 이후의 시작 시각을 선택해 주세요.", farTime: "현재부터 90일 안의 시작 시각을 선택해 주세요.", required: "필수 항목입니다.", phone: "연락 가능한 휴대폰 번호를 적어 주세요.", email: "이메일 주소를 확인해 주세요.", past: "오늘 이후 날짜로 골라 주세요.", far: "오늘부터 30일 안에서 골라 주세요." };

  // 결제 준비 상태 → 안내 문구 표시 (상품 · 목록 · 주문서 공통)
  var payState = api("GET", "/api/shop/products").then(function (res) {
    var pay = (res.j && res.j.pay) || {};
    var ready = res.status === 200 && !!pay.ready;
    $$("[data-pay-off]").forEach(function (el) { el.hidden = ready; });
    $$("[data-pay-test]").forEach(function (el) { el.hidden = !(ready && pay.test); });
    return { ready: ready, test: !!pay.test, mobile: !!pay.mobile, provider:pay.provider };
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
      var total = function (q) { if (product.start === "datetime") updateSchedule(q); t("[data-od-sum-qty]", q); t("[data-od-total]", won(product.price * q)); t("[data-od-total-btn]", won(product.price * q)); };
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

      if (product.start === "datetime") {
        $("[data-od-start-at]").hidden = false;
        elStart().required = true;
        $("[data-od-schedule]").hidden = false;
        updateStartBounds();
        elStart().addEventListener("input", function () { updateSchedule(st.get()); });
        elStart().addEventListener("focus", updateStartBounds);
        updateSchedule(st.get());
      }
      function elStart() { return form.elements.startAt; }
      function localKst(ms) { return new Date(ms + 9 * 3600e3).toISOString().slice(0, 16); }
      function updateStartBounds() { elStart().min = localKst(Math.ceil((Date.now()+60000)/60000)*60000); elStart().max = localKst(Date.now()+90*864e5); }
      function updateSchedule(q) {
        var value = elStart().value, stamp = Date.parse(value+":00+09:00");
        var period = $("[data-od-period]"), note = $("[data-od-schedule-note]");
        note.textContent = "선택한 시각에 자동 시작합니다. 늦게 입실해도 종료 시각은 바뀌지 않습니다.";
        if (!value || !isFinite(stamp)) { period.textContent = "시작 날짜·시간을 선택해 주세요."; return; }
        var end = product.id === "cowork-day" ? Date.parse(value.slice(0,10)+"T00:00:00+09:00")+q*864e5 : stamp+q*2*3600e3;
        period.textContent = value.replace("T", " ") + " ~ " + localKst(end).replace("T", " ") + " (한국 시간)";
        if(q>1)note.textContent += " 수량 " + q + "매는 한 분의 연속 이용 기간으로 적용됩니다.";
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
      ["name", "phone", "email", "startDate", "startAt"].forEach(function (k) { var i = form.elements[k]; if (i) i.addEventListener("input", function () { showErr(k, ""); }); });
      reqs.forEach(function (c) { c.addEventListener("change", function () { if (reqs.every(function (x) { return x.checked; })) showErr("agree", ""); }); });
      var msgBox = $("[data-od-msg]");
      var notice = function (m) { msgBox.textContent = m || ""; msgBox.hidden = !m; };
      var submitBtn = $("[data-od-submit]");
      var busy = function (on) { submitBtn.disabled = on; submitBtn.classList.toggle("is-busy", on); $("[data-od-total-btn]").parentNode.lastChild.textContent = on ? " 결제창을 여는 중…" : "원 결제하기"; };

      var paymentProvider = "", currentAttempt;
      payState.then(function (ps) {
        paymentProvider = ps.provider;
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
        if (product.start === "datetime") {
          var chosen=el.startAt.value, when=Date.parse(chosen+":00+09:00");
          var problem=!chosen || !isFinite(when) || localKst(when)!==chosen ? FIELD.datetime : when<=Date.now() ? FIELD.pastTime : when>Date.now()+90*864e5 ? FIELD.farTime : "";
          if(problem){showErr("startAt",problem);ok=false;}
        }
        if (!reqs.every(function (c) { return c.checked; })) { showErr("agree", "필수 항목에 모두 동의해 주세요."); ok = false; }
        if (!ok) { var first = $("[aria-invalid], [data-err]:not([hidden])", form); if (first) first.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
        busy(true);
        var payload = {
          productId: product.id, qty: st.get(), name: el.name.value.trim(), phone: el.phone.value.trim(), email: el.email.value.trim(),
          startDate: product.start === "date" ? el.startDate.value : "", startAt: product.start === "datetime" ? el.startAt.value : "", memo: el.memo.value.trim(), payMethod: el.payMethod.value,
          device: isMobile ? "mobile" : "pc", agreeTerms: el.agreeTerms.checked, agreePrivacy: el.agreePrivacy.checked, agreeRefund: el.agreeRefund.checked, website: el.website.value
        };
        if (paymentProvider === "payapp") {
          var fingerprint = JSON.stringify(payload), attempt=currentAttempt;
          try { attempt=JSON.parse(sessionStorage.getItem("sf_payapp_attempt") || "null") || currentAttempt; } catch (err) {}
          if (!attempt || attempt.fingerprint !== fingerprint) attempt={fingerprint:fingerprint,id:crypto.randomUUID()};
          currentAttempt=attempt; payload.requestId=attempt.id;
          try { sessionStorage.setItem("sf_payapp_attempt",JSON.stringify(attempt)); } catch (err) {}
        }
        api("POST", "/api/orders", payload).then(function (res) {
          var j = res.j || {};
          if (!j.ok) {
            busy(false);
            if (j.error === "pay-rejected") { currentAttempt=null; try { sessionStorage.removeItem("sf_payapp_attempt"); } catch (err) {} }
            if (j.error === "invalid" && j.fields) {
              Object.keys(j.fields).forEach(function (k) { showErr(k, k === "agree" ? "필수 항목에 모두 동의해 주세요." : (FIELD[j.fields[k]] || FIELD.required)); });
              if (j.fields.productId) notice("상품 정보가 바뀌었습니다. 이용권 목록에서 다시 골라 주세요.");
            } else notice(MSG[j.error] || MSG["default"]);
            return;
          }
          try { sessionStorage.setItem("sf_last_order", JSON.stringify({ oid: j.oid, t: j.token })); } catch (err) { /* 저장 못 해도 진행 */ }
          if (j.pay.mode === "payapp") {
            try {
              var dest = new URL(j.pay.url);
              var payappHost = dest.hostname === "payapp.kr" || /\.payapp\.kr$/.test(dest.hostname);
              if (dest.protocol !== "https:" || dest.username || dest.password || dest.port || !(payappHost || (dest.origin === location.origin && dest.pathname === "/order-complete"))) throw new Error("payment-url");
              location.assign(dest.href);
            } catch (err) { busy(false); notice("결제창 주소를 확인하지 못했습니다. 카카오톡으로 문의해 주세요."); }
          } else if (j.pay.mode === "mobile") openMobile(j.pay); else openPc(j.pay, j);
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
    var attempts=0, timer, lastOrder;
    var hide=function(sel){ var el=$(sel); if(el) el.hidden=true; };
    var pending=function(o){
      hide("[data-oc-fail]"); hide("[data-oc-done]"); show("[data-oc-pending]");
      set("[data-oc-title]","결제 결과를 확인하고 있습니다");
      set("[data-oc-lead]","승인 결과가 도착하면 자동으로 표시됩니다. 같은 주문을 다시 결제하지 마세요.");
      var resume=$("[data-oc-resume]"); resume.hidden=true;
      if (o && o.payurl) { try { var u=new URL(o.payurl); if(u.protocol==="https:" && !u.username && !u.password && !u.port && (u.hostname==="payapp.kr" || /\.payapp\.kr$/.test(u.hostname))) {resume.href=u.href;resume.hidden=false;} } catch(e) {} }
      set("[data-oc-pending-note]", attempts<15 ? "잠시만 기다려 주세요…" : "아직 승인 결과를 받지 못했습니다. 결제를 마쳤다면 재결제하지 말고 주문번호와 함께 문의해 주세요.");
    };
    var refresh=$("[data-oc-refresh]");
    if(refresh) refresh.addEventListener("click",function(){clearTimeout(timer);attempts=0;checkOrder();});
    var changeForm=$("[data-oc-change-form]"), changeAttempt;
    var changeMessage=function(text,bad){var box=$("[data-oc-change-message]");if(!box)return;box.textContent=text||"";box.hidden=!text;box.className="auth-notice mt-16"+(bad?" err":"");};
    var changeKst=function(ms){return new Date(ms+9*3600e3).toISOString().slice(0,16);};
    function changePeriod(){
      if(!changeForm || !lastOrder)return;
      var value=changeForm.elements.startAt.value,ms=Date.parse(value+":00+09:00");
      if(!value || !isFinite(ms)){set("[data-oc-change-period]","새 시작 시각을 선택해 주세요.");return;}
      var end=lastOrder.productId==="cowork-day" ? Date.parse(value.slice(0,10)+"T00:00:00+09:00")+lastOrder.qty*864e5 : ms+lastOrder.qty*2*3600e3;
      set("[data-oc-change-period]",value.replace("T"," ")+" ~ "+changeKst(end).replace("T"," ")+" (한국 시간)");
    }
    function renderChange(o){
      var schedule=o.schedule;
      if(!changeForm || !schedule || !schedule.supported || o.status==="pending"){hide("[data-oc-change]");return;}
      show("[data-oc-change]");changeForm.hidden=!schedule.allowed;
      set("[data-oc-change-unavailable]",schedule.message||"");
      $("[data-oc-change-unavailable]").hidden=!!schedule.allowed;
      if(schedule.allowed){
        changeForm.elements.startAt.min=changeKst(Date.now()+60000);
        changeForm.elements.startAt.max=schedule.maxStart.slice(0,16).replace(" ","T");
        changeForm.elements.startAt.value=o.startDate.slice(0,16).replace(" ","T");changePeriod();
      }
    }
    if(changeForm){
      changeForm.elements.startAt.addEventListener("input",changePeriod);
      changeForm.addEventListener("submit",function(e){
        e.preventDefault();changeMessage("");
        if(!lastOrder || !lastOrder.schedule || !lastOrder.schedule.allowed)return;
        var value=changeForm.elements.startAt.value,ms=Date.parse(value+":00+09:00"),problem;
        if(!value || !isFinite(ms) || changeKst(ms)!==value)problem=FIELD.datetime;
        else if(ms<=Date.now())problem=FIELD.pastTime;
        else if(value.replace("T"," ")+":00">lastOrder.schedule.maxStart)problem="원래 구매일로부터 90일 안의 시각을 선택해 주세요.";
        if(problem){changeMessage(problem,true);return;}
        var body={oid:oid,token:tok,startAt:value,expectedStart:lastOrder.startDate};
        var fingerprint=JSON.stringify(body);
        if(!changeAttempt || changeAttempt.fingerprint!==fingerprint)changeAttempt={fingerprint:fingerprint,id:crypto.randomUUID()};
        body.requestId=changeAttempt.id;
        var save=$("[data-oc-change-save]");save.disabled=true;save.textContent="변경 저장 중…";
        api("POST","/api/orders/reschedule",body).then(function(res){
          save.disabled=false;save.textContent="이용 시간 변경 저장";
          if(res.j.ok){changeAttempt=null;changeMessage("이용 시간이 변경되었습니다. 종료 시각과 아직 발송하지 않은 알림 예약도 함께 갱신했습니다.");clearTimeout(timer);checkOrder();return;}
          var fields={originalLimit:"원래 구매일로부터 90일 안의 시각을 선택해 주세요.",datetime:FIELD.datetime,pastTime:FIELD.pastTime,farTime:FIELD.farTime};
          changeMessage(fields[res.j.field] || res.j.message || (res.status===403 ? "주문을 변경할 권한이 없습니다. 구매한 계정으로 로그인하거나 주문 완료 페이지 주소를 확인해 주세요." : "저장 결과를 확인하지 못했습니다. 새로 결제하지 말고 같은 내용으로 다시 시도해 주세요."),true);
          if(res.status===409)checkOrder();
        });
      });
    }
    var STATUS_CLASS = { paid: "done", used: "done", pending: "ing", refund_requested: "ing", refunded: "", cancelled: "", failed: "" };
    if (!oid) {
      finish(); show("[data-oc-notfound]"); set("[data-oc-title]", "주문을 찾을 수 없습니다"); set("[data-oc-lead]", "주문번호가 없는 주소입니다.");
    } else {
      checkOrder();
    }
    function checkOrder() {
      attempts++;
      api("GET", "/api/orders/status?oid=" + encodeURIComponent(oid) + "&t=" + encodeURIComponent(tok)).then(function (res) {
        finish();
        var o = res.j && res.j.order;
        if (!o && (!res.status || res.status>=500)) {
          pending(lastOrder); set("[data-oc-lead]","서버 연결이 원활하지 않습니다. 재결제하지 말고 잠시 후 결과를 다시 확인해 주세요.");
          if(attempts<15) timer=setTimeout(checkOrder,2000); return;
        }
        if (!o) { hide("[data-oc-pending]"); show("[data-oc-notfound]"); set("[data-oc-title]", "주문을 찾을 수 없습니다"); set("[data-oc-lead]", "주소를 다시 확인해 주세요."); return; }
        if(o.parking){location.replace("/parking-order?oid="+encodeURIComponent(oid)+(tok?"&t="+encodeURIComponent(tok):""));return;}
        lastOrder=o; renderChange(o); hide("[data-oc-pending]"); hide("[data-oc-notfound]"); hide("[data-oc-fail]"); hide("[data-oc-done]");
        var paid = o.status === "paid" || o.status === "used";
        if (paid) show("[data-oc-use-guide]"); else hide("[data-oc-use-guide]");
        if (paid) {
          show("[data-oc-done]"); set("[data-oc-oid]", o.oid); set("[data-oc-title]", "결제가 완료되었습니다"); set("[data-oc-lead]", o.productName + " 주문이 접수되었습니다. 주문번호를 꼭 보관해 주세요.");
          if (o.test) show("[data-oc-test]");
          var linked=o.passes||[];
          if(o.scheduledStart)set("[data-oc-lead]",o.productName+" 구매가 완료되었습니다. 선택한 시작 시각부터 자동으로 적용됩니다. 아래 이용 시간을 확인해 주세요.");
          if(linked.some(function(p){return p.status==="ready";}))set("[data-oc-lead]",o.productName+" 구매가 완료되어 입실 대기로 등록되었습니다. 실제 입실 시 이용을 시작합니다. 주문번호를 보관해 주세요.");
        } else if (o.status === "pending" && o.provider === "payapp") {
          pending(o); if(attempts<15) timer=setTimeout(checkOrder,2000);
        } else {
          show("[data-oc-fail]"); set("[data-oc-eyebrow]", "Payment failed"); set("[data-oc-title]", o.status === "pending" ? "결제가 완료되지 않았습니다" : o.statusLabel);
          set("[data-oc-lead]", o.status === "pending" ? "결제창이 닫혔거나 결제가 끝나지 않았습니다. 다시 시도해 주세요." : "이 주문은 " + o.statusLabel + " 상태입니다.");
          if (params.fail || o.failMsg) set("[data-oc-fail-msg]", (params.fail || o.failMsg) + " — 출금 또는 카드 승인이 확인되면 다시 결제하지 말고 주문번호 " + o.oid + " 와 함께 알려 주세요.");
          $("[data-oc-retry]").href = "/order?p=" + encodeURIComponent(o.productId) + "&qty=" + (o.qty || 1);
        }
        show("[data-oc-detail]");
        set("[data-oc-d-oid]", o.oid); set("[data-oc-d-product]", o.productName); set("[data-oc-d-amount]", won(o.amount)); set("[data-oc-d-pay]", o.payMethod + (o.cardName ? " · " + o.cardName : ""));
        if (o.startDate) { show("[data-oc-d-start-row]"); set("[data-oc-d-start-label]", o.startLabel || "이용 시작일"); set("[data-oc-d-start]", o.startDate); }
        var activeLinked=(o.passes||[]).filter(function(p){return p.status==="active";});
        set("[data-oc-d-validity]", o.scheduledStart && activeLinked.length ? activeLinked[0].starts_at.slice(0,16)+" ~ "+activeLinked[activeLinked.length-1].ends_at.slice(0,16)+" (한국 시간)" : o.validity || "—"); set("[data-oc-d-buyer]", o.buyerName + " · " + o.buyerPhone + (o.buyerEmail ? " · " + o.buyerEmail : ""));
        if(o.refundedAmount) {show("[data-oc-refund-row]");set("[data-oc-refund]",won(o.refundedAmount)+"원");}
        set("[data-oc-d-paid]", o.paidAt || "—");
        var stEl = $("[data-oc-d-status]"); stEl.textContent = o.statusLabel; stEl.className = "mi-st " + (STATUS_CLASS[o.status] || "");
        try { if (paid) {sessionStorage.removeItem("sf_last_order");sessionStorage.removeItem("sf_payapp_attempt");} } catch (e) { /* 없음 */ }
      });
    }
  }
})();
