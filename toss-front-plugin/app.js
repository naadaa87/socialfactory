/* 소셜팩토리 토스프론트 플러그인 — 이용권 선택 → 휴대폰 번호 → 개인정보 안내 동의 → 금액 확인 → 카드 결제 → 완료
   화면은 모두 토스 SDK Template API(renderIdlePage · renderSelectPage · renderInputPage · renderAgreementPage · renderOrderPage · renderResultPage)로 그립니다.
   결제는 sdk.payment.requestPayment, 응답 유실 복구는 sdk.payment.getPayment, 단말기 토큰 · 진행 중 결제는 sdk.storage 를 씁니다.
   직원용 카드 결제 취소는 sdk.payment.requestPaymentCancel · getPaymentCancel 을 씁니다 (이용권 고르기 화면의 '관리').

   결제 순서
   1) 서버(/api/kiosk/intents)가 고객을 찾고 금액 · 부가세 · 결제 식별자(paymentKey)를 정해 줍니다.
   2) paymentKey 를 단말기 저장소에 적어 둔 뒤 requestPayment 를 부릅니다.
   3) 결과를 서버(/api/kiosk/result)에 보고합니다. 서버가 이용권을 1장만 발급합니다 (같은 보고가 여러 번 가도 안전).
   4) 보고가 실패하면 저장소에 남겨 두고, 대기 화면으로 돌아올 때마다 getPayment 로 다시 확인해 보고합니다. */
(function () {
  "use strict";
  var sdk = window.TossFrontSDK;
  var CFG = window.SF_PLUGIN || {};
  var UI = window.SF_KIOSK_UI;
  var API = String(CFG.apiBase || "").replace(/\/+$/, "");
  var K_TOKEN = "sf_kiosk_token", K_PENDING = "sf_kiosk_pending", K_CANCEL = "sf_kiosk_pending_cancel", K_LOGS = "sf_kiosk_error_logs";
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  // 이 PC 브라우저에서 시험할 때만: 토스 예제(sdk.js)와 같은 방식으로 단말기 · 매장 정보를 흉내 냅니다.
  if (isLocal && sdk && typeof sdk.overrides === "function") {
    sdk.overrides({ serialNumber: "000000000000000", merchant: { id: 0, name: "테스트 매장", businessNumber: "0000000000" } });
  }

  var won = function (n) { return Number(n || 0).toLocaleString("ko-KR") + "원"; };
  var digits = function (v) { return String(v || "").replace(/[^0-9]/g, ""); };
  var imageUrl = function (name) { return name ? new URL("images/" + name, location.href).href : undefined; };
  var toast = function (message, icon) { try { sdk.template.openToast(icon ? { message: message, icon: icon } : { message: message }); } catch (e) { console.log(message); } };

  /* ---------- 터치 피드백 ---------- */
  var touchFeedbackReady = false, idleTapAction = null, idleTapTimer = null;
  function finishIdleTap() {
    var action = idleTapAction;
    idleTapAction = null; clearTimeout(idleTapTimer); idleTapTimer = null;
    if (action) action();
  }
  function afterIdleTap(action, fallbackMs) {
    return function () {
      if (!touchFeedbackReady) return action();
      if (idleTapAction) return;
      // 대기 화면은 pointerup에서 콜백을 부릅니다. 뒤따르는 click이 끝난 뒤
      // 화면을 바꿔 같은 터치가 새 전화번호 키패드의 0으로 이어지지 않게 합니다.
      idleTapAction = action;
      idleTapTimer = setTimeout(finishIdleTap, fallbackMs || 400);
    };
  }
  function installTouchFeedback() {
    if (typeof document === "undefined" || !document.addEventListener) return;
    var app = document.getElementById("app"), lastControl = null, lastSoundAt = 0;
    if (!app) return;
    touchFeedbackReady = true;
    document.addEventListener("click", function (event) {
      var target = event.target && (event.target.closest ? event.target : event.target.parentElement);
      if (!target || !app.contains(target)) return;
      if (idleTapAction) {
        clearTimeout(idleTapTimer);
        idleTapTimer = setTimeout(finishIdleTap, 0);
      }
      var control = target.closest("button, [role='button'], [role='checkbox'], input[type='checkbox']");
      if (!control || control.disabled || control.getAttribute("aria-disabled") === "true") return;
      // 기본 전화번호·숫자 키패드는 숫자 키에서 이미 SDK 터치음을 냅니다.
      // 지우기·화면 이동·선택·확인 등 소리가 없는 버튼만 보완합니다.
      if (control.tagName === "TD" && /^\d$/.test(control.getAttribute("aria-label") || "")) return;
      var now = Date.now();
      if (control === lastControl && now - lastSoundAt < 30) return;
      lastControl = control; lastSoundAt = now;
      if (sdk.app && typeof sdk.app.playTouchSound === "function") {
        try { Promise.resolve(sdk.app.playTouchSound()).catch(function () {}); } catch (_) {}
      }
    }, true);
  }

  /* ---------- 저장소 (sdk.storage: 문자열만 저장) ---------- */
  function sget(key) { return sdk.storage.get({ key: key }).then(function (r) { return r && r.value != null ? r.value : null; }).catch(function () { return null; }); }
  function sset(key, value) { return sdk.storage.set({ key: key, value: value }).catch(function (e) { console.error("storage.set", e); }); }
  function sdel(key) { return sdk.storage.remove({ key: key }).catch(function () {}); }

  /* ---------- 서버 ---------- */
  var token = null;
  function api(path, body, opt) {
    opt = opt || {};
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, opt.timeoutMs || 15000) : null;
    var headers = { "Content-Type": "application/json" };
    if (token && !opt.noAuth) headers.Authorization = "Bearer " + token;
    return fetch(API + path, { method: body === undefined ? "GET" : "POST", headers: headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok && j.ok !== false) return j;
          var e = new Error(j.message || j.error || ("HTTP " + r.status)); e.status = r.status; e.code = j.code || j.error || ""; throw e;
        });
      }, function () { var e = new Error("서버에 연결하지 못했어요"); e.code = "NETWORK"; throw e; })
      .finally(function () { if (t) clearTimeout(t); });
  }
  // 장애 기록에는 전화번호·SDK 응답·PIN·토큰을 넣지 않습니다. paymentKey는 결제 대조를 위해 원문 보관합니다.
  var logSending = false;
  function errorCode(e) {
    var code = String(e && e.code || (e && e.status ? "HTTP_" + e.status : "UNKNOWN")).toUpperCase();
    return /^[A-Z0-9_-]{1,40}$/.test(code) ? code : "SDK_ERROR";
  }
  function flushLogs() {
    if (logSending || !token) return Promise.resolve();
    logSending = true;
    return sget(K_LOGS).then(function (raw) {
      var queue; try { queue = JSON.parse(raw || "[]"); } catch (_) { queue = []; }
      if (!Array.isArray(queue) || !queue.length) return;
      var batch = queue.slice(0, 10), ids = batch.map(function (x) { return x.eventId; });
      return api("/api/kiosk/logs", { events: batch }).then(function () {
        return sget(K_LOGS).then(function (latest) {
          var all; try { all = JSON.parse(latest || "[]"); } catch (_) { all = []; }
          return sset(K_LOGS, JSON.stringify(all.filter(function (x) { return ids.indexOf(x.eventId) < 0; })));
        });
      }).catch(function () { /* 서버 장애 중에는 단말기 저장소에 남겨 다음 접속 때 전송 */ });
    }).finally(function () { logSending = false; });
  }
  function logFailure(kind, paymentKey, e) {
    if (!paymentKey || !token) return Promise.resolve();
    var item = {
      eventId: "K" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12),
      kind: kind, paymentKey: paymentKey, code: errorCode(e),
      httpStatus: Number(e && e.status) || 0
    };
    return sget(K_LOGS).then(function (raw) {
      var queue; try { queue = JSON.parse(raw || "[]"); } catch (_) { queue = []; }
      if (!Array.isArray(queue)) queue = [];
      queue.push(item);
      return sset(K_LOGS, JSON.stringify(queue.slice(-50))).then(flushLogs);
    });
  }
  // 결제 결과 보고는 네트워크가 잠깐 끊겨도 몇 번 더 시도합니다.
  function report(paymentKey, result) {
    var body = { paymentKey: paymentKey, type: result.type };
    if (result.type === "SUCCESS") body.response = result.response;
    if (result.message) body.message = String(result.message).slice(0, 200);
    var tries = 0;
    function once() {
      tries++;
      return api("/api/kiosk/result", body).catch(function (e) {
        if (tries < 4 && (e.code === "NETWORK" || e.status >= 500)) return new Promise(function (res) { setTimeout(res, 800 * tries); }).then(once);
        throw e;
      });
    }
    return once();
  }
  function onAuthError(e) {
    if (e && (e.status === 401 || e.code === "DEVICE_AUTH")) { token = null; sdel(K_TOKEN); toast("단말기 연결이 해제됐어요. 다시 연결해 주세요.", "error"); renderPair(); return true; }
    return false;
  }

  /* ---------- 단말기 연결 (처음 한 번) ---------- */
  function renderPair() {
    sdk.template.renderOnboardingPage({
      title: "단말기를 연결해 주세요",
      inputs: { code: { label: "연결 코드 (8자리)", type: "text", placeholder: "관리자에서 만든 연결 코드" } },
      onSubmit: function (values) {
        var code = String((values && values.code) || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
        if (code.length !== 8) { toast("연결 코드 8자리를 확인해 주세요.", "error"); return; }
        return sdk.app.getSerialNumber().catch(function () { return {}; }).then(function (sn) {
          return api("/api/kiosk/pair", { code: code, serialNumber: (sn && sn.serialNumber) || "" }, { noAuth: true });
        }).then(function (j) {
          token = j.token; return sset(K_TOKEN, j.token).then(function () { toast("단말기를 연결했어요.", "success"); renderIdle(); });
        }).catch(function (e) {
          toast(e.code === "bad-code" ? "연결 코드가 맞지 않거나 시간이 지났어요." : e.code === "too-many" ? "잠시 뒤 다시 시도해 주세요." : (e.message || "연결하지 못했어요."), "error");
        });
      }
    });
  }

  /* ---------- 대기 화면 ---------- */
  function renderIdle() {
    purchaseScreenVersion++;
    flushLogs();
    sdk.template.renderIdlePage({
      type: "twoButton",
      title: { text1: CFG.storeName || "소셜팩토리", text2: "오늘도, 편하게" },
      description: { text: "24시간 코워킹 · 스터디 라운지", subText: "첫 이용권은 바로 시작해요" },
      primaryButton: { text: "이용권 구매", onClick: afterIdleTap(startPurchase, 40) },
      secondaryButton: { text: "내 이용권 확인", onClick: afterIdleTap(startLookup) }
    });
    recoverPending();
  }

  /* ---------- 1. 이용권 선택 ---------- */
  var PRODUCTS = [], CATEGORIES = null, PRIVACY_URL = "", LAYOUT = UI ? UI.normalize() : { categoryLayout: "list", productLayout: "list" };
  function loadProducts() {
    // 매번 최신 값을 읽습니다. 화면을 떠난 뒤 도착한 응답은 적용하지 않습니다.
    return api("/api/kiosk/products");
  }
  function supportedLayout(layout) { return layout === "grid" && typeof sdk.template.renderSelectGridPage === "function" ? "grid" : "list"; }
  // 상품 종류부터 고르면 한 화면에서 비교하는 항목이 2~3개로 줄어듭니다.
  var purchaseScreenVersion = 0;
  function startPurchase() {
    var version = ++purchaseScreenVersion;
    // 최신 설정을 읽는 동안에도 버튼이 눌렸음을 즉시 보여 줍니다.
    sdk.template.renderSelectPage({
      title: "이용권을 불러오고 있어요", subtitle: "잠시만 기다려 주세요",
      options: [], onBack: renderIdle
    });
    loadProducts().then(function (j) {
      if (version !== purchaseScreenVersion) return;
      PRIVACY_URL = j.privacyUrl || "";
      CATEGORIES = j.categories || null;
      LAYOUT = UI.normalize(j.layout);
      PRODUCTS = j.products || [];
      if (!PRODUCTS.length) { toast("현재 판매 중인 이용권이 없어요.", "error"); renderIdle(); return; }
      showCategories(PRODUCTS);
    }).catch(function (e) {
      if (version !== purchaseScreenVersion) return;
      if (!onAuthError(e)) { toast("이용권을 불러오지 못했어요. 다시 시도해 주세요.", "error"); renderIdle(); }
    });
  }
  function showCategories(list) {
    var page = UI.categoryPage(supportedLayout(LAYOUT.categoryLayout), function (group) { showProducts(list, group); }, imageUrl, CATEGORIES, list);
    page.params.navbarButton = { label: "직원 관리", onClick: startStaff };
    page.params.onBack = renderIdle;
    sdk.template[page.method](page.params);
  }
  function productLabel(p) {
    return UI.productLabel(p);
  }
  function showProducts(list, group) {
    var page = UI.productPage(list, group, supportedLayout(LAYOUT.productLayout), askPhone, imageUrl, CATEGORIES);
    page.params.onBack = function () { showCategories(list); };
    sdk.template[page.method](page.params);
  }

  /* ---------- 2. 휴대폰 번호 ---------- */
  function askPhone(p) {
    sdk.template.renderInputPage({
      type: "phone",
      top: { title: "휴대폰 번호를 입력해 주세요", subtitle: productLabel(p) + " · " + won(p.price) },
      input: { placeholder: "010-" },
      disclaimer: "이 번호로 이용권을 등록해요",
      onSubmit: function (value) {
        var d = digits(value);
        if (!/^01[016789]\d{7,8}$/.test(d)) { toast("휴대폰 번호를 다시 확인해 주세요.", "error"); return; }
        askAgreement(p, d);
      },
      onBack: function () { showCategories(PRODUCTS); }
    });
  }

  /* ---------- 3. 개인정보 수집 · 이용 안내 동의 ---------- */
  function askAgreement(p, phone) {
    sdk.template.renderAgreementPage({
      title: "개인정보 이용에 동의해 주세요",
      subtitle: "등록 번호 " + phone.replace(/^(\d{3})(\d{4})(\d{4})$/, "$1-$2-$3"),
      agreements: { required: [{ id: "privacy", title: "개인정보 수집 · 이용 동의 (필수)", href: PRIVACY_URL || (API + "/privacy") }], optional: [] },
      onSubmit: function (ids) {
        if (!ids || ids.indexOf("privacy") < 0) { toast("필수 항목에 동의해 주세요.", "error"); return; }
        return prepare(p, phone);
      }
    });
  }

  /* ---------- 4. 결제 준비 · 금액 확인 ---------- */
  function prepare(p, phone) {
    return api("/api/kiosk/intents", { productId: p.id, phone: phone, agreePrivacy: true }).then(function (it) {
      var discount = it.listPrice ? it.listPrice - it.amount : 0;
      sdk.template.renderOrderPage({
        localeCode: "ko",
        order: {
          items: [{ label: productLabel(p), value: it.listPrice || it.amount, quantity: 1, imageUrl: imageUrl(p.image),
            options: [{ type: "option", label: "등록 번호 " + phone.replace(/^(\d{3})(\d{4})(\d{4})$/, "$1-$2-$3"), value: 0 }] }],
          discounts: discount ? [{ label: "친구 동반 할인", value: discount }] : [],
          summary: {
            totalAmount: it.amount,
            discountAmount: discount || undefined,
            earned: { label: it.preview.extends ? "연장 후 종료" : "이용 종료", value: it.preview.endsText }
          }
        },
        onClick: function () { pay(it); },
        navbarButton: { label: "번호 수정", onClick: function () { askPhone(p); } },
        onBack: function () { askPhone(p); }
      });
    }).catch(function (e) { if (!onAuthError(e)) { toast(e.message && e.status === 400 ? e.message : "결제를 준비하지 못했어요. 다시 시도해 주세요.", "error"); renderIdle(); } });
  }

  /* ---------- 5. 결제 · 결과 보고 ---------- */
  var paying = false;
  function pay(it) {
    if (paying) return; paying = true;
    // 카드 결제창이 닫혀도 이전 금액 확인 화면이 다시 드러나지 않게 합니다.
    sdk.template.renderSelectPage({
      title: "결제를 진행하고 있어요", subtitle: "결제창의 안내를 따라 주세요", options: []
    });
    var pending = JSON.stringify({ paymentKey: it.paymentKey, productName: it.productName, at: Date.now() });
    sset(K_PENDING, pending).then(function () {
      return sdk.payment.requestPayment({
        paymentKey: it.paymentKey, tax: it.payment.tax, supplyValue: it.payment.supplyValue,
        taxExemptValue: 0, tip: 0, localeCode: "ko",
        excludePaymentTypes: ["CASH"]          // 무인 매장이라 현금은 받지 않습니다
      }).catch(function (e) { return { type: "FAILED", message: (e && e.message) || "결제 오류" }; });
    }).then(function (result) {
      result = result || { type: "FAILED", message: "결제 결과 없음" };
      if (result.type === "SUCCESS") {
        // 승인 성공 직후 완료 안내로 바꾸고, 서버 저장 뒤 확정 종료 시각을 표시합니다.
        showDone(it.productName, null, true);
        return report(it.paymentKey, result).then(function (j) {
          sdel(K_PENDING);
          showDone(j.pass.productName, j.pass.endsText);
        }, function (e) {
          // 결제는 됐지만 서버 보고가 안 된 경우: 저장소에 남겨 두고 대기 화면에서 다시 보고합니다.
          logFailure("PAYMENT_RESULT_REPORT_FAILED", it.paymentKey, e);
          console.error("report", e);
          showDone(it.productName);
        });
      }
      // 시간 초과는 실제로 승인됐을 수도 있어 저장소에 남겨 두고 나중에 getPayment 로 확인합니다.
      if (result.type !== "TIMEOUT") sdel(K_PENDING);
      report(it.paymentKey, result).catch(function (e) { logFailure("PAYMENT_RESULT_REPORT_FAILED", it.paymentKey, e); console.error("report", e); });
      sdk.template.renderResultPage({
        type: "image", status: "error",
        title: result.type === "CANCELED" ? "결제를 취소했어요" : result.type === "TIMEOUT" ? "결제 시간이 지났어요" : "결제하지 못했어요",
        description: "처음 화면으로 돌아가요",
        timerMs: 5000, onTimeout: renderIdle, localeCode: "ko",
        buttons: [{ label: "처음으로", onClick: renderIdle, closeOnClick: true }]
      });
    }).finally(function () { paying = false; });
  }
  // text 타입은 짧은 대기번호용 초대형 글자라 날짜가 겹칩니다.
  // 중앙 정렬되는 기본 성공 화면에서 날짜·시간을 두 줄로 구분합니다.
  function passEndTitle(endsText) {
    return String(endsText).trim().replace(/\s+(\d{1,2}:\d{2})$/, "\n$1") + "까지 이용";
  }
  function showDone(name, endsText, registering) {
    if (registering) {
      // 저장 중에는 닫힘 타이머·확정 종료 시각 없이 승인 완료 사실만 안내합니다.
      sdk.template.renderSelectPage({
        title: "결제가 완료됐어요", subtitle: "이용권을 등록하고 있어요", options: []
      });
      return;
    }
    sdk.template.renderResultPage({
      type: "image", status: "success",
      title: endsText ? passEndTitle(endsText) : "결제는 완료됐어요",
      description: endsText ? productLabel({ name: name }) + " · 구매 완료" : "이용권 등록을 확인하고 있어요",
      timerMs: 10000, onTimeout: renderIdle, localeCode: "ko",
      buttons: [{ label: "확인", onClick: renderIdle, closeOnClick: true }]
    });
  }

  /* ---------- 응답 유실 복구 (대기 화면으로 돌아올 때마다) ---------- */
  var recovering = false;
  function recoverPending() {
    if (recovering || paying || !token) return;
    recovering = true;
    var recoveryKey = "";
    sget(K_PENDING).then(function (raw) {
      if (!raw) return;
      var p; try { p = JSON.parse(raw); } catch (e) { return sdel(K_PENDING); }
      recoveryKey = p.paymentKey;
      return sdk.payment.getPayment({ paymentKey: p.paymentKey }).then(function (res) {
        if (res && res.type === "SUCCESS") return report(p.paymentKey, res).then(function () { return sdel(K_PENDING); });
      }, function (e) {
        // 승인 결과가 없으면(PAYMENT_NOT_FOUND) 결제가 안 된 것 — 2분이 지났으면 시간 초과로 정리합니다.
        if (/PAYMENT_NOT_FOUND/.test(String((e && (e.code || e.message)) || e))) {
          if (Date.now() - (p.at || 0) > 120e3) return report(p.paymentKey, { type: "TIMEOUT", message: "PAYMENT_NOT_FOUND" }).then(function () { return sdel(K_PENDING); }, function (err) { logFailure("PAYMENT_RESULT_REPORT_FAILED", p.paymentKey, err); });
          return;
        }
        logFailure("PAYMENT_RECOVERY_FAILED", p.paymentKey, e);
      });
    }).catch(function (e) { logFailure("PAYMENT_RECOVERY_FAILED", recoveryKey, e); console.error("recover", e); }).finally(function () { recovering = false; });
  }

  /* ---------- 관리 (직원): 카드 결제 취소 ----------
     플러그인 결제는 토스 POS 에 남지 않아 POS 에서 취소할 수 없으므로, 결제한 이 단말기에서 취소합니다.
     이용권 고르기 화면 오른쪽 위 '관리' → 관리 비밀번호(KIOSK_STAFF_PIN) → 최근 결제 → 취소 확인 → requestPaymentCancel */
  var staffToken = null;
  function startStaff() {
    sdk.template.renderInputPage({
      type: "number",
      top: { title: "관리 비밀번호를 입력해 주세요", subtitle: "매장 직원 전용" },
      input: { placeholder: "비밀번호", type: "password", maxLength: 8 },
      button: { label: "확인" },
      onSubmit: function (value) {
        return api("/api/kiosk/staff", { pin: digits(value) }).then(function (j) {
          staffToken = j.staffToken;
          return recoverCancel().then(function () { showRefundList(j.payments || []); });
        }).catch(function (e) { if (!onAuthError(e)) toast(e.code === "too-many" ? "잠시 뒤 다시 시도해 주세요." : (e.message || "확인하지 못했어요."), "error"); });
      },
      onBack: startPurchase
    });
  }
  function showRefundList(list) {
    sdk.template.renderSelectPage({
      title: list.length ? "취소할 결제를 골라 주세요" : "취소할 결제가 없어요",
      subtitle: "이 단말기의 최근 30일 결제",
      options: list.map(function (x) {
        return { title: productLabel({ name: x.productName }), subtitle: won(x.amount) + " · " + x.phoneMasked, description: x.paidText, onClick: function () { confirmRefund(x); } };
      }),
      onBack: renderIdle
    });
  }
  function confirmRefund(x) {
    sdk.template.renderSelectPage({
      title: "이 결제를 전액 취소할까요?",
      subtitle: productLabel({ name: x.productName }) + " · " + won(x.amount),
      options: [
        { title: "전액 취소하기", subtitle: x.phoneMasked, description: "이용권도 함께 취소돼요", onClick: function () { doRefund(x); } },
        { title: "결제 유지하기", onClick: function () { renderIdle(); } }
      ],
      onBack: renderIdle
    });
  }
  function doRefund(x) {
    if (paying) return; paying = true;
    api("/api/kiosk/refund", { staffToken: staffToken, paymentKey: x.paymentKey, stage: "start" }).then(function (j) {
      return sset(K_CANCEL, x.paymentKey).then(function () {
        return sdk.payment.requestPaymentCancel(j.params).catch(function (e) { return { type: "FAILED", message: (e && e.message) || "취소 오류" }; });
      });
    }).then(function (result) {
      result = result || { type: "FAILED" };
      if (result.type !== "SUCCESS") {
        sdel(K_CANCEL);
        sdk.template.renderResultPage({ type: "image", status: "error", title: "결제를 취소하지 못했어요", description: result.type === "CANCELED" ? "취소 화면을 닫았어요" : "다시 시도해 주세요", timerMs: 6000, onTimeout: renderIdle, localeCode: "ko" });
        return;
      }
      return api("/api/kiosk/refund", { staffToken: staffToken, paymentKey: x.paymentKey, stage: "result", type: "SUCCESS", response: result.response }).then(function () {
        sdel(K_CANCEL);
        sdk.template.renderResultPage({ type: "image", status: "success", title: "결제를 취소했어요", description: x.productName + " · " + won(x.amount) + "\n이용권도 취소했어요", timerMs: 8000, onTimeout: renderIdle, localeCode: "ko" });
      }, function (e) {
        logFailure("CANCEL_RECOVERY_FAILED", x.paymentKey, e);
        sdk.template.renderResultPage({ type: "image", status: "success", title: "카드 취소는 됐어요", description: "서버 기록은 다음에 관리 화면에 들어올 때 다시 맞춰요", timerMs: 8000, onTimeout: renderIdle, localeCode: "ko" });
      });
    }).catch(function (e) {
      if (!onAuthError(e)) { toast(e.message || "취소를 준비하지 못했어요.", "error"); renderIdle(); }
    }).finally(function () { paying = false; });
  }
  // 취소 응답이 서버에 못 갔던 건: 관리 화면에 들어올 때 getPaymentCancel 로 확인해 다시 보고합니다.
  function recoverCancel() {
    var recoveryKey = "";
    return sget(K_CANCEL).then(function (key) {
      if (!key) return;
      recoveryKey = key;
      return sdk.payment.getPaymentCancel({ paymentKey: key }).then(function (res) {
        if (res && res.type === "SUCCESS") return api("/api/kiosk/refund", { staffToken: staffToken, paymentKey: key, stage: "result", type: "SUCCESS", response: res.response }).then(function () { toast("지난 결제 취소를 기록했어요.", "success"); return sdel(K_CANCEL); });
        return sdel(K_CANCEL);
      }, function (e) {
        if (/PAYMENT_NOT_FOUND/.test(String(e && (e.code || e.message) || e))) return sdel(K_CANCEL);
        logFailure("CANCEL_RECOVERY_FAILED", key, e);
      });
    }).catch(function (e) { logFailure("CANCEL_RECOVERY_FAILED", recoveryKey, e); console.error("recover-cancel", e); });
  }

  /* ---------- 남은 시간 확인 ---------- */
  function startLookup() {
    sdk.template.renderInputPage({
      type: "phone",
      top: { title: "휴대폰 번호를 입력해 주세요", subtitle: "이용 종료 시각을 확인해요" },
      input: { placeholder: "010-" },
      onSubmit: function (value) {
        var d = digits(value);
        if (!/^01[016789]\d{7,8}$/.test(d)) { toast("휴대폰 번호를 다시 확인해 주세요.", "error"); return; }
        return api("/api/kiosk/lookup", { phone: d }).then(function (j) {
          if (j.active) sdk.template.renderResultPage({ type: "image", status: "success", title: passEndTitle(j.endsText), description: j.phoneMasked + " · 이용 종료 안내", timerMs: 8000, onTimeout: renderIdle, localeCode: "ko", buttons: [{ label: "확인", onClick: renderIdle, closeOnClick: true }] });
          else sdk.template.renderResultPage({ type: "image", status: "error", title: "이용 중인 이용권이 없어요", description: j.phoneMasked, timerMs: 6000, onTimeout: renderIdle, localeCode: "ko", buttons: [{ label: "이용권 구매", onClick: startPurchase, closeOnClick: true }] });
        }).catch(function (e) { if (!onAuthError(e)) toast("확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.", "error"); });
      },
      onBack: renderIdle
    });
  }

  /* ---------- 시작 ---------- */
  if (!sdk || !UI) { document.getElementById("app").textContent = "화면을 불러오지 못했어요. 플러그인 파일을 확인해 주세요."; return; }
  installTouchFeedback();
  sget(K_TOKEN).then(function (t) { token = t; if (token) renderIdle(); else renderPair(); });
})();
