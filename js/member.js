/* 소셜팩토리 — 회원 기능 (로그인 · 회원가입 · 마이페이지)
   서버 쪽은 functions/api/auth/*, 데이터는 Cloudflare D1 에 저장됩니다. */
(function () {
  "use strict";
  var page = document.querySelector("[data-member-page]");
  if (!page) return;
  var kind = page.getAttribute("data-member-page");
  var CFG = window.SF_CONFIG || {};
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var params = {};
  location.search.replace(/^\?/, "").split("&").forEach(function (kv) { if (kv) { var p = kv.split("="); params[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || "").replace(/\+/g, " ")); } });
  var safeNext = function (v) { return /^\/[A-Za-z0-9/_\-?=&#.%]*$/.test(v || "") && v.indexOf("//") !== 0 ? v : "/mypage"; };

  var MSG = {
    "no-db": "회원 기능을 준비하고 있습니다. 대관 문의는 회원가입 없이도 남길 수 있습니다.",
    "exists": "이미 가입된 이메일입니다. 로그인해 주세요.",
    "wrong": "이메일 또는 비밀번호가 맞지 않습니다.",
    "too-many": "시도가 많아 잠시 막혔습니다. 15분 뒤 다시 시도해 주세요.",
    "blocked": "이용이 제한된 계정입니다. 카카오톡 문의채널로 문의해 주세요.",
    "expired": "카카오 확인 시간이 지났습니다. '카카오로 시작하기'를 다시 눌러 주세요.",
    "kakao-off": "카카오 로그인을 준비하고 있습니다. 이메일로 이용해 주세요.",
    "kakao-cancel": "카카오 로그인을 취소했습니다.",
    "kakao-state": "카카오 로그인 확인이 끝나지 않았습니다. 다시 시도해 주세요.",
    "kakao": "카카오 로그인 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.",
    "login": "로그인이 풀렸습니다. 다시 로그인해 주세요.",
    "network": "서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    "default": "처리하지 못했습니다. 잠시 후 다시 시도해 주세요."
  };
  var FIELD = {
    email: "이메일 주소를 확인해 주세요.", required: "필수 항목입니다.", phone: "연락 가능한 휴대폰 번호를 적어 주세요.",
    short: "비밀번호는 8자 이상으로 정해 주세요.", weak: "비밀번호에 영문과 숫자를 함께 넣어 주세요.", long: "비밀번호는 72자 이하로 정해 주세요."
  };
  var api = function (method, url, body) {
    return fetch(url, { method: method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j || {} }; }, function () { return { status: r.status, j: {} }; }); })
      .catch(function () { return { status: 0, j: { error: "network" } }; });
  };
  var notice = function (msg, type) {
    var n = $("[data-auth-msg]"); if (!n) return;
    n.textContent = msg || ""; n.hidden = !msg; n.className = "auth-notice" + (type ? " " + type : "");
  };
  var showErr = function (form, key, msg) {
    var e = $("[data-err=\"" + key + "\"]", form); if (!e) return;
    e.textContent = msg || ""; e.hidden = !msg;
    var input = form.elements[key]; if (input && input.setAttribute) { if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid"); }
  };
  var clearErrs = function (form) { $$("[data-err]", form).forEach(function (e) { e.hidden = true; e.textContent = ""; }); $$("[aria-invalid]", form).forEach(function (i) { i.removeAttribute("aria-invalid"); }); };
  var busy = function (btn, on, label) { if (!btn) return; if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || "잠시만요…"; btn.disabled = true; } else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; } };

  // 서버 준비 상태 (DB · 카카오)
  var ready = api("GET", "/api/auth/config").then(function (res) {
    var cfg = res.j || {};
    var on = res.status === 200 && cfg.db;
    $$("[data-auth-off]").forEach(function (el) { el.hidden = on; });
    $$("[data-auth-on]").forEach(function (el) { el.hidden = !on; });
    var next = safeNext(params.next || "/mypage");
    $$("[data-kakao-login]").forEach(function (a) { a.hidden = !(on && cfg.kakao); a.href = "/api/auth/kakao?next=" + encodeURIComponent(next); });
    $$("[data-kakao-or]").forEach(function (el) { el.hidden = !(on && cfg.kakao); });
    return { on: on, kakao: !!cfg.kakao };
  });
  if (params.error && MSG[params.error]) notice(MSG[params.error], "err");

  /* ---------------- 로그인 ---------------- */
  if (kind === "login") {
    var lf = $("[data-login-form]");
    var forgot = $("[data-forgot]");
    if (forgot) forgot.addEventListener("click", function () { var b = $("[data-forgot-box]"); b.hidden = !b.hidden; });
    if (lf) lf.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = lf.elements.email.value.trim(), pw = lf.elements.password.value;
      if (!email || !pw) { notice("이메일과 비밀번호를 적어 주세요.", "err"); (email ? lf.elements.password : lf.elements.email).focus(); return; }
      var btn = $("button[type=submit]", lf); busy(btn, true, "로그인 중…");
      api("POST", "/api/auth/login", { email: email, password: pw, next: safeNext(params.next || "/mypage") }).then(function (res) {
        busy(btn, false);
        if (res.j.ok) {
          location.href = res.j.member && res.j.member.mustChangePassword ? "/mypage#password" : safeNext(res.j.next);
          return;
        }
        notice(MSG[res.j.error] || MSG["default"], "err");
        if (res.j.error === "wrong") { lf.elements.password.value = ""; lf.elements.password.focus(); }
      });
    });
  }

  /* ---------------- 회원가입 ---------------- */
  if (kind === "signup") {
    var sf = $("[data-signup-form]");
    var kakaoMode = params.kakao === "1";
    var all = $("[data-agree-all]");
    var boxes = ["agreeAge", "agreeTerms", "agreePrivacy", "marketing"].map(function (n) { return sf.elements[n]; });
    var syncAll = function () { all.checked = boxes.every(function (b) { return b.checked; }); };
    all.addEventListener("change", function () { boxes.forEach(function (b) { b.checked = all.checked; }); showErr(sf, "agree", ""); });
    boxes.forEach(function (b) { b.addEventListener("change", function () { syncAll(); showErr(sf, "agree", ""); }); });
    var phone = sf.elements.phone;
    phone.addEventListener("input", function () {
      var d = phone.value.replace(/[^0-9]/g, "").slice(0, 11);
      if (/^01/.test(d)) phone.value = d.length > 7 ? d.slice(0, 3) + "-" + d.slice(3, d.length - 4) + "-" + d.slice(-4) : d.length > 3 ? d.slice(0, 3) + "-" + d.slice(3) : d;
    });

    if (kakaoMode) {
      $("[data-email-mode]").hidden = true;
      $("[data-email-fields]").hidden = true;
      $("[data-kakao-mode]").hidden = false;
      $("[data-kakao-email]").hidden = false;
      $("[data-signup-title]").textContent = "카카오로 가입하기";
      $("[data-signup-lead]").textContent = "처음 한 번만 확인하면 다음부터는 카카오 로그인으로 바로 들어올 수 있습니다.";
      api("GET", "/api/auth/kakao/complete").then(function (res) {
        if (!res.j.ok) { notice(MSG.expired, "err"); $("[data-signup-submit]").disabled = true; $("[data-email-mode]").hidden = false; return; }
        if (res.j.nickname && !sf.elements.name.value) sf.elements.name.value = res.j.nickname;
        if (res.j.email) { sf.elements.kemail.value = res.j.email; sf.elements.kemail.readOnly = true; }
      });
    }

    sf.addEventListener("submit", function (e) {
      e.preventDefault();
      clearErrs(sf); notice("");
      var el = sf.elements, bad = null;
      var mark = function (k, msg) { showErr(sf, k, msg); if (!bad && el[k]) bad = el[k]; };
      if (!kakaoMode) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(el.email.value.trim())) mark("email", FIELD.email);
        var pw = el.password.value;
        if (pw.length < 8) mark("password", FIELD.short); else if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) mark("password", FIELD.weak);
        if (el.password2.value !== pw) mark("password2", "비밀번호가 서로 다릅니다.");
      } else if (el.kemail.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(el.kemail.value.trim())) mark("kemail", FIELD.email);
      if (!el.name.value.trim()) mark("name", "이름을 적어 주세요.");
      var digits = el.phone.value.replace(/[^0-9]/g, "");
      if (digits.length < 9 || digits.length > 15) mark("phone", FIELD.phone);
      if (!el.agreeAge.checked || !el.agreeTerms.checked || !el.agreePrivacy.checked) { showErr(sf, "agree", "[필수] 항목에 모두 동의해 주세요."); if (!bad) bad = el.agreeAge; }
      if (bad) { bad.focus(); return; }
      var body = {
        name: el.name.value.trim(), phone: el.phone.value.trim(),
        agreeAge: el.agreeAge.checked, agreeTerms: el.agreeTerms.checked, agreePrivacy: el.agreePrivacy.checked, marketing: el.marketing.checked,
        website: el.website.value, next: safeNext(params.next || "/mypage")
      };
      var url = "/api/auth/signup";
      if (kakaoMode) { url = "/api/auth/kakao/complete"; body.email = el.kemail.value.trim(); }
      else { body.email = el.email.value.trim(); body.password = el.password.value; }
      var btn = $("[data-signup-submit]"); busy(btn, true, "가입하는 중…");
      api("POST", url, body).then(function (res) {
        busy(btn, false);
        if (res.j.ok) { location.href = safeNext(res.j.next) + (safeNext(res.j.next) === "/mypage" ? "?welcome=1" : ""); return; }
        if (res.j.error === "invalid" && res.j.fields) {
          Object.keys(res.j.fields).forEach(function (k) {
            var key = k.indexOf("agree") === 0 ? "agree" : (kakaoMode && k === "email" ? "kemail" : k);
            showErr(sf, key, key === "agree" ? "[필수] 항목에 모두 동의해 주세요." : (FIELD[res.j.fields[k]] || FIELD.required));
          });
          notice("입력 내용을 확인해 주세요.", "err");
          return;
        }
        notice(MSG[res.j.error] || MSG["default"], "err");
        if (res.j.error === "exists") showErr(sf, "email", "이미 가입된 이메일입니다.");
      });
    });
  }

  /* ---------------- 마이페이지 ---------------- */
  if (kind === "mypage") {
    var STATUS = { "new": ["접수", "new"], in_progress: ["상담 중", "ing"], done: ["완료", "done"] };
    var PURPOSE = { rental: "공간 대관", regular: "정기대관", business: "기업 · 단체", coworking: "코워킹", office: "독립사무실", partner: "호스트 · 제휴", proposal: "공간 활용 상담", other: "기타" };
    var SPACE = { r1: "1번룸", r2: "2번룸", r3: "3번룸", r4: "4번룸", r5: "5번룸", coworking: "코워킹", office: "독립사무실", undecided: "" };
    var me = null;
    var loading = $("[data-my-loading]");
    var fill = function (m) {
      me = m;
      var t = function (sel, v) { var el = $(sel); if (el) el.textContent = v; };
      t("[data-my-name]", m.name); t("[data-my-initial]", (m.name || "S").slice(0, 1));
      t("[data-my-provider]", m.provider === "kakao" ? "카카오 계정으로 가입" : "이메일로 가입");
      t("[data-my-email]", m.email || "—"); t("[data-my-phone]", m.phone || "—"); t("[data-my-created]", (m.createdAt || "").slice(0, 10).replace(/-/g, ". "));
      t("[data-my-title]", m.name + "님의 마이페이지");
      var mk = $("[data-my-marketing]"); if (mk) mk.checked = !!m.marketing;
      t("[data-my-marketing-note]", m.marketing ? "받는 중 · " + (m.marketingAt || "").slice(0, 10) + " 동의" : "새 프로그램과 행사, 할인 소식");
      $("[data-pw-card]").hidden = m.provider !== "email";
      $("[data-must-change]").hidden = !m.mustChangePassword;
      $("[data-withdraw-pw]").hidden = m.provider !== "email";
      $("[data-withdraw-word]").hidden = m.provider === "email";
    };
    var renderInquiries = function (list) {
      var ul = $("[data-my-inquiries]");
      ul.innerHTML = list.map(function (r) {
        var st = STATUS[r.status] || [r.status, ""];
        var title = (PURPOSE[r.purpose] || "문의") + (SPACE[r.space] ? " · " + SPACE[r.space] : "");
        var meta = [r.when_text, r.people].filter(Boolean).join(" · ");
        return "<li><div class=\"mi-top\"><span class=\"mi-st " + st[1] + "\">" + esc(st[0]) + "</span><strong>" + esc(title) + "</strong><span class=\"mi-date\">" + esc((r.created_at || "").slice(0, 16)) + "</span></div>" +
          (meta ? "<p class=\"mi-meta\">" + esc(meta) + "</p>" : "") +
          "<p class=\"mi-msg\">" + esc(r.message || "") + "</p><p class=\"mi-receipt\">접수번호 " + esc(r.receipt) + "</p></li>";
      }).join("");
      $("[data-my-empty]").hidden = list.length > 0;
    };
    var load = function () {
      api("GET", "/api/auth/me").then(function (res) {
        if (loading) loading.hidden = true;
        if (!res.j.ok) {
          $("[data-my-guest]").hidden = false;
          if (res.j.error === "no-db") $("[data-my-guest] p").textContent = MSG["no-db"];
          return;
        }
        $("[data-my-main]").hidden = false;
        fill(res.j.member);
        if (params.welcome === "1") { $("[data-my-lead]").textContent = "가입을 환영합니다. 이제 로그인한 상태로 남긴 문의는 이곳에서 처리 상태를 확인할 수 있습니다."; }
        api("GET", "/api/member/inquiries").then(function (r2) { renderInquiries((r2.j && r2.j.results) || []); });
        if (location.hash === "#password" && res.j.member.provider === "email") setTimeout(function () { var f = $("[data-pw-form]"); if (f) { f.scrollIntoView({ block: "center" }); f.elements.current.focus(); } }, 100);
      });
    };
    load();

    $("[data-my-logout]").addEventListener("click", function () {
      api("POST", "/api/auth/logout").then(function () { location.href = "/"; });
    });
    var mk = $("[data-my-marketing]");
    mk.addEventListener("change", function () {
      var want = mk.checked;
      api("PATCH", "/api/auth/me", { marketing: want }).then(function (res) {
        if (res.j.ok) fill(res.j.member); else { mk.checked = !want; alert(MSG[res.j.error] || MSG["default"]); }
      });
    });
    var ef = $("[data-my-edit-form]");
    $("[data-my-edit]").addEventListener("click", function () { ef.hidden = false; ef.elements.name.value = me.name; ef.elements.phone.value = me.phone; ef.elements.name.focus(); });
    $("[data-my-edit-cancel]").addEventListener("click", function () { ef.hidden = true; showErr(ef, "edit", ""); });
    ef.addEventListener("submit", function (e) {
      e.preventDefault();
      api("PATCH", "/api/auth/me", { name: ef.elements.name.value, phone: ef.elements.phone.value }).then(function (res) {
        if (res.j.ok) { fill(res.j.member); ef.hidden = true; showErr(ef, "edit", ""); return; }
        showErr(ef, "edit", res.j.fields ? (res.j.fields.name ? "이름을 적어 주세요." : FIELD.phone) : (MSG[res.j.error] || MSG["default"]));
      });
    });
    var pf = $("[data-pw-form]");
    pf.addEventListener("submit", function (e) {
      e.preventDefault();
      var el = pf.elements;
      if (el.next.value.length < 8 || !/[A-Za-z]/.test(el.next.value) || !/[0-9]/.test(el.next.value)) { showErr(pf, "pw", "새 비밀번호는 8자 이상, 영문과 숫자를 함께 넣어 주세요."); return; }
      if (el.next.value !== el.next2.value) { showErr(pf, "pw", "새 비밀번호가 서로 다릅니다."); return; }
      var btn = $("button[type=submit]", pf); busy(btn, true);
      api("POST", "/api/auth/password", { current: el.current.value, next: el.next.value }).then(function (res) {
        busy(btn, false);
        if (res.j.ok) { pf.reset(); showErr(pf, "pw", ""); $("[data-must-change]").hidden = true; alert("비밀번호를 바꿨습니다. 다른 기기의 로그인은 모두 해제되었습니다."); return; }
        showErr(pf, "pw", res.j.error === "wrong" ? "현재 비밀번호가 맞지 않습니다." : (MSG[res.j.error] || MSG["default"]));
      });
    });
    var wf = $("[data-withdraw-form]");
    wf.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!confirm("정말 탈퇴할까요? 회원 정보는 바로 삭제되고 되돌릴 수 없습니다.")) return;
      api("DELETE", "/api/auth/me", { password: wf.elements.password.value, confirm: wf.elements.confirm.value.trim() }).then(function (res) {
        if (res.j.ok) { alert("탈퇴 처리했습니다. 그동안 이용해 주셔서 감사합니다."); location.href = "/"; return; }
        showErr(wf, "withdraw", res.j.error === "wrong" ? "비밀번호가 맞지 않습니다." : res.j.error === "confirm" ? "'탈퇴'라고 정확히 적어 주세요." : (MSG[res.j.error] || MSG["default"]));
      });
    });
  }
  window.SF_MEMBER_READY = ready;
})();
