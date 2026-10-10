/* 소셜팩토리 홈페이지 공통 스크립트 */
(function () {
  "use strict";
  var CFG = window.SF_CONFIG || {};
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var get = function (path) {
    return path.split(".").reduce(function (o, k) { return (o && o[k] !== undefined && o[k] !== null) ? o[k] : ""; }, CFG);
  };
  var text = function (v) { return (v === undefined || v === null || typeof v === "object") ? "" : String(v).trim(); };

  /* ---------- 헤더 ---------- */
  var header = $(".site-header");
  var onScroll = function () { if (header) header.classList.toggle("is-scrolled", window.scrollY > 8); };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var toggle = $(".nav-toggle");
  var links = $(".nav-links");
  var closeNav = function () {
    if (!links || !toggle) return;
    links.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "메뉴 열기");
  };
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "메뉴 닫기" : "메뉴 열기");
      if (open) { var first = $("a", links); if (first) first.focus(); }
    });
    $$("a", links).forEach(function (a) { a.addEventListener("click", closeNav); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && links.classList.contains("is-open")) { closeNav(); toggle.focus(); }
    });
  }

  /* 현재 페이지 표시 (+ 공간 페이지 안에서는 보고 있는 구역 표시) */
  var file = (location.pathname.split("/").pop() || "index.html");
  var navLinks = $$(".nav-links a").filter(function (a) { return !a.closest(".nav-cta"); });
  var setCurrent = function (target) {
    navLinks.forEach(function (a) {
      var href = a.getAttribute("href") || "";
      var same = href === target || href.split("#")[0] === target;
      if (same) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  };
  var samePageLinks = navLinks.filter(function (a) { return (a.getAttribute("href") || "").split("#")[0] === file; });
  if (samePageLinks.length > 1 && "IntersectionObserver" in window) {
    var ids = samePageLinks.map(function (a) { return (a.getAttribute("href") || "").split("#")[1]; }).filter(Boolean);
    var sections = ids.map(function (id) { return document.getElementById(id); }).filter(Boolean);
    var current = location.hash && ids.indexOf(location.hash.slice(1)) >= 0 ? file + location.hash : file + "#" + ids[0];
    setCurrent(current);
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) setCurrent(file + "#" + e.target.id); });
    }, { rootMargin: "-30% 0px -55% 0px", threshold: 0 });
    sections.forEach(function (s) { spy.observe(s); });
  } else {
    setCurrent(file);
  }

  /* ---------- 등장 애니메이션 (JS가 있을 때만 적용) ---------- */
  var reveals = $$(".reveal");
  if (document.documentElement.classList.contains("js") && "IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("is-in"); });
  }

  /* ---------- 설정값 반영 ---------- */
  // <span data-sf="pricing.rooms.r1" data-sf-empty="확정 후 안내">  → 값이 있으면 값, 없으면 대체 문구(흐리게)
  $$("[data-sf]").forEach(function (el) {
    var v = text(get(el.getAttribute("data-sf")));
    if (v) { el.textContent = v; el.classList.remove("is-empty"); }
    else if (el.hasAttribute("data-sf-empty")) { el.textContent = el.getAttribute("data-sf-empty"); el.classList.add("is-empty"); }
    else if (el.hasAttribute("data-sf-hide")) {
      var wrap = el.closest(el.getAttribute("data-sf-hide") || "li") || el;
      wrap.hidden = true;
    }
  });
  // 값이 하나도 없으면 감추는 상자: <div data-hide-if-empty> ... <span data-sf> ... </div>
  $$("[data-hide-if-empty]").forEach(function (box) {
    var any = $$("[data-sf]", box).some(function (el) { return text(get(el.getAttribute("data-sf"))); });
    box.hidden = !any;
  });

  // 운영 상태 배너
  var status = CFG.status || {};
  $$("[data-status-text]").forEach(function (el) {
    var t = text(status.text) || (status.mode === "open" ? "소셜팩토리 건대 이용 안내" : "오픈 준비 중");
    el.textContent = t;
  });
  $$("[data-status-tag]").forEach(function (el) { el.textContent = status.mode === "open" ? "OPEN" : "COMING SOON"; });
  document.documentElement.setAttribute("data-status", status.mode === "open" ? "open" : "preparing");
  $$("[data-if-open]").forEach(function (el) { el.hidden = status.mode !== "open"; });
  $$("[data-if-preparing]").forEach(function (el) { el.hidden = status.mode === "open"; });

  // 채널 버튼: <a data-channel="kakao">
  var channelHref = {
    phone: function (v) { return "tel:" + v.replace(/[^0-9+]/g, ""); },
    email: function (v) { return "mailto:" + v; }
  };
  var visibleChannels = 0;
  var channelList = [];
  $$("[data-channel]").forEach(function (a) {
    var key = a.getAttribute("data-channel");
    var v = text(get("contact." + key));
    if (v) {
      a.href = channelHref[key] ? channelHref[key](v) : v;
      if (key !== "phone" && key !== "email") { a.target = "_blank"; a.rel = "noopener"; }
      var valEl = $("[data-channel-value]", a);
      if (valEl) valEl.textContent = v;
      a.hidden = false;
      visibleChannels++;
    } else {
      a.hidden = true;
    }
  });
  ["kakao", "naver", "spacecloud", "instagram", "phone", "email"].forEach(function (k) { if (text(get("contact." + k))) channelList.push(k); });
  $$(".channels-empty").forEach(function (el) { el.hidden = visibleChannels > 0; });
  $$("[data-channel-qr]").forEach(function (el) { el.hidden = !text(get("contact." + el.getAttribute("data-channel-qr"))); });
  $$("[data-if-channels]").forEach(function (el) { el.hidden = visibleChannels === 0; });

  // 대표 예약 채널 버튼: <a data-booking data-space="r1">
  var booking = CFG.booking || {};
  var bookingUrl = booking.primary ? text(get("contact." + booking.primary)) : "";
  $$("[data-booking]").forEach(function (a) {
    var space = a.getAttribute("data-space") || "";
    if (bookingUrl) {
      a.href = bookingUrl; a.target = "_blank"; a.rel = "noopener";
      a.textContent = text(booking.label) || "예약 채널에서 일정 확인";
    } else if (a.hasAttribute("data-fallback-label")) {
      a.href = "contact.html?purpose=rental" + (space ? "&space=" + space : "");
      a.textContent = a.getAttribute("data-fallback-label");
    } else {
      a.hidden = true;
    }
  });

  // 지도 링크
  var addr = text(get("address"));
  $$("[data-map]").forEach(function (a) {
    var q = encodeURIComponent(addr || "한아름건물 화양동 10-1");
    a.href = a.getAttribute("data-map") === "kakao" ? "https://map.kakao.com/?q=" + q : "https://map.naver.com/p/search/" + q;
    a.target = "_blank"; a.rel = "noopener";
  });

  // 푸터 회사 정보
  var comp = CFG.company || {};
  var compLine = [comp.name, comp.ceo, comp.regNo, comp.address].map(text).filter(Boolean).join(" · ");
  $$("[data-company-line]").forEach(function (el) { el.textContent = compLine; });
  $$("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });

  // 구조화 데이터 보강 (전화번호 · 이메일이 설정된 경우)
  var ld = $("#sf-ldjson");
  if (ld) {
    try {
      var data = JSON.parse(ld.textContent);
      var tel = text(get("contact.phone"));
      if (tel) data.telephone = tel;
      var mail = text(get("contact.email"));
      if (mail) data.email = mail;
      if (text(get("siteUrl"))) data.url = text(get("siteUrl"));
      ld.textContent = JSON.stringify(data);
    } catch (e) { /* 무시 */ }
  }

  /* ---------- 룸 고르기 (인원 · 용도) ---------- */
  $$("[data-picker]").forEach(function (picker) {
    var listSel = picker.getAttribute("data-picker");
    var list = listSel ? $(listSel) : null;
    if (!list) return;
    var cards = $$("[data-room-card]", list);
    var selPeople = $("select[name=people]", picker);
    var selUse = $("select[name=use]", picker);
    var result = $("[data-picker-result]", picker);
    var original = cards.slice();
    var apply = function () {
      var p = selPeople ? parseInt(selPeople.value, 10) : 0;
      var u = selUse ? selUse.value : "";
      var matched = [];
      cards.forEach(function (c) {
        var min = parseInt(c.getAttribute("data-min"), 10) || 0;
        var max = parseInt(c.getAttribute("data-max"), 10) || 999;
        var uses = (c.getAttribute("data-uses") || "").split(" ");
        var ok = true;
        if (p) ok = ok && p <= max && p >= Math.max(1, min - 10);
        if (u) ok = ok && uses.indexOf(u) >= 0;
        var strong = ok && (!p || (p >= min && p <= max));
        c.classList.toggle("is-match", ok && (!!p || !!u));
        c.classList.toggle("is-strong", strong && (!!p || !!u));
        c.classList.toggle("is-dim", !ok && (!!p || !!u));
        if (ok) matched.push(c);
      });
      var order = (p || u) ? matched.concat(cards.filter(function (c) { return matched.indexOf(c) < 0; })) : original;
      order.forEach(function (c) { list.appendChild(c); });
      if (result) {
        if (!p && !u) result.textContent = "인원이나 진행 방식을 고르면 맞는 룸을 앞으로 모아 보여 드립니다.";
        else if (!matched.length) result.textContent = "조건에 맞는 룸이 없습니다. 인원을 나누어 진행하거나 문의 폼에 조건을 남겨 주세요.";
        else result.textContent = "조건에 맞는 룸 " + matched.length + "개를 앞으로 모았습니다. 표기 인원은 배치에 따라 달라지니 상세에서 배치별 인원을 확인해 주세요.";
      }
    };
    [selPeople, selUse].forEach(function (s) { if (s) s.addEventListener("change", apply); });
    var reset = $("[data-picker-reset]", picker);
    if (reset) reset.addEventListener("click", function () { if (selPeople) selPeople.value = ""; if (selUse) selUse.value = ""; apply(); });
    apply();
  });

  /* ---------- 문의 폼 ---------- */
  var form = $("#inquiry-form");
  if (form) {
    var inquiry = CFG.inquiry || {};
    var formWrap = form.closest("[data-form-wrap]") || form.parentNode;
    var disabledNote = $("[data-form-disabled]");
    if (inquiry.enabled === false) {
      form.hidden = true;
      if (disabledNote) disabledNote.hidden = false;
    } else {
      var statusEl = $(".form-status", form);
      var btn = $("button[type=submit]", form);
      var btnLabel = btn ? btn.textContent : "문의 보내기";
      var purposeSel = $("select[name=purpose]", form);
      var spaceSel = $("select[name=space]", form);
      var subId = $("input[name=submissionId]", form);
      var doneBox = $("[data-form-done]");
      var failBox = $("[data-form-fail]");
      var newId = function () {
        var id = "";
        if (window.crypto && crypto.randomUUID) id = crypto.randomUUID().replace(/-/g, "");
        else { for (var i = 0; i < 24; i++) id += Math.floor(Math.random() * 36).toString(36); }
        return id;
      };
      if (subId && !subId.value) subId.value = newId();

      // 보유 기간 · 안내문 버전
      $$("[data-retention]", form).forEach(function (el) { el.textContent = text(inquiry.retention) || "문의 처리 완료 후 6개월"; });
      $$("[data-notice-version]", form).forEach(function (el) { el.textContent = text(inquiry.noticeVersion) || ""; });

      // 주소의 ?purpose=rental&space=r1 로 미리 선택
      var params = {};
      location.search.replace(/^\?/, "").split("&").forEach(function (kv) {
        if (!kv) return; var p = kv.split("="); params[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || "").replace(/\+/g, " "));
      });
      if (params.purpose && purposeSel && $$("option", purposeSel).some(function (o) { return o.value === params.purpose; })) purposeSel.value = params.purpose;
      if (params.space && spaceSel && $$("option", spaceSel).some(function (o) { return o.value === params.space; })) spaceSel.value = params.space;

      // 목적에 따라 보이는 항목
      var syncPurpose = function () {
        var p = purposeSel ? purposeSel.value : "";
        $$("[data-when-purpose]", form).forEach(function (el) {
          var list = (el.getAttribute("data-when-purpose") || "").split(/[ ,]+/);
          var show = list.indexOf(p) >= 0;
          el.hidden = !show;
          $$("input, textarea, select", el).forEach(function (f) { if (!show) f.removeAttribute("aria-invalid"); });
        });
        var emailReq = $("[data-email-required]", form);
        if (emailReq) emailReq.hidden = p !== "business";
        var spaceField = spaceSel ? spaceSel.closest(".field") : null;
        if (spaceField) spaceField.hidden = ["coworking", "office", "proposal"].indexOf(p) >= 0;
        var hint = $("[data-purpose-hint]", form);
        if (hint) {
          var hints = {
            rental: "예: 20명 교육, 토요일 오후 2시간, 노트북 화면 연결 필요",
            regular: "예: 매주 화요일 19~21시, 12명 독서모임, 3개월 이상 · 레지던트 호스트 희망",
            business: "예: 신입 교육 30명, 10월 셋째 주 평일 하루, 견적서 필요",
            coworking: "예: 4주권 문의, 야간 이용 위주, 통화 가능 구역 여부",
            office: "예: 2인, 1주권, 11월 둘째 주부터, 화상회의 위주",
            partner: "예: 원데이 클래스 월 2회, 8~10명, 토요일 오후 · 공동 기획·홍보 희망",
            proposal: "예: ○○동 2층 60평, 공실 기간, 임대 조건 협의 가능",
            other: "궁금한 내용을 적어 주세요"
          };
          hint.textContent = hints[p] || hints.other;
        }
      };
      if (purposeSel) purposeSel.addEventListener("change", syncPurpose);
      syncPurpose();

      var setStatus = function (msg, cls) { if (statusEl) { statusEl.textContent = msg; statusEl.className = "form-status " + (cls || ""); } };
      var fieldError = function (name, msg) {
        var input = form.elements[name]; if (!input) return;
        var field = input.closest ? input.closest(".field") : null;
        var err = field ? $(".field-error", field) : null;
        if (msg) { input.setAttribute("aria-invalid", "true"); if (err) { err.textContent = msg; err.hidden = false; } }
        else { input.removeAttribute("aria-invalid"); if (err) { err.textContent = ""; err.hidden = true; } }
      };
      var collect = function () {
        var data = {};
        new FormData(form).forEach(function (v, k) { data[k] = String(v).trim(); });
        data.consent = !!form.elements.consent.checked;
        data.noticeVersion = text(inquiry.noticeVersion);
        data.page = location.href;
        return data;
      };
      var validate = function (data) {
        var first = null;
        var mark = function (name, msg) { fieldError(name, msg); if (msg && !first) first = form.elements[name]; };
        mark("name", data.name ? "" : "이름 또는 단체명을 적어 주세요.");
        var digits = (data.phone || "").replace(/[^0-9]/g, "");
        mark("phone", digits.length >= 9 && digits.length <= 15 ? "" : "연락 가능한 전화번호를 적어 주세요.");
        var emailOk = !data.email || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email);
        if (data.purpose === "business" && !data.email) mark("email", "기업·단체 문의는 견적을 받을 이메일이 필요합니다.");
        else mark("email", emailOk ? "" : "이메일 형식을 확인해 주세요.");
        mark("message", data.message ? "" : "문의 내용을 적어 주세요.");
        mark("consent", data.consent ? "" : "문의 접수를 위한 개인정보 수집·이용 안내를 확인해 주세요.");
        if (first) {
          setStatus(first.name === "consent" ? "문의 접수를 위한 개인정보 수집·이용 안내를 확인해 주세요." : "이름과 연락처, 문의 내용을 확인해 주세요.", "err");
          first.focus();
          return false;
        }
        return true;
      };
      ["name", "phone", "email", "message"].forEach(function (n) {
        var el = form.elements[n]; if (el) el.addEventListener("input", function () { fieldError(n, ""); });
      });
      if (form.elements.consent) form.elements.consent.addEventListener("change", function () { fieldError("consent", ""); });

      var summaryText = function (data) {
        var purposeLabel = purposeSel ? purposeSel.options[purposeSel.selectedIndex].text : data.purpose;
        var spaceLabel = spaceSel && !spaceSel.closest(".field").hidden ? spaceSel.options[spaceSel.selectedIndex].text : "";
        return [
          "[소셜팩토리 문의] " + purposeLabel + (spaceLabel ? " · " + spaceLabel : ""),
          "이름: " + data.name, "연락처: " + data.phone, "이메일: " + (data.email || "-"),
          data.company ? "회사·단체: " + data.company : null,
          "희망 일시: " + (data.when || "-"), "인원: " + (data.people || "-"),
          data.schedule ? "정기 일정: " + data.schedule : null,
          "", data.message
        ].filter(function (l) { return l !== null; }).join("\n");
      };

      var showFail = function (data, msg) {
        setStatus(msg || "문의가 접수되지 않았습니다. 작성 내용은 남아 있습니다. 다시 보내거나 아래 상담 채널로 연락해 주세요.", "err");
        if (btn) { btn.disabled = false; btn.textContent = "다시 보내기"; }
        if (!failBox) return;
        failBox.hidden = false;
        var email = text(get("contact.email"));
        var mailBtn = $("[data-fail-mail]", failBox);
        var copyBtn = $("[data-fail-copy]", failBox);
        var manual = $("[data-fail-manual]", failBox);
        var copyStatus = $("[data-fail-status]", failBox);
        var channels = $("[data-fail-channels]", failBox);
        var none = $("[data-fail-none]", failBox);
        var body = summaryText(data);
        if (channels) channels.hidden = visibleChannels === 0;
        if (none) none.hidden = visibleChannels > 0 || !!email;
        if (mailBtn) {
          mailBtn.hidden = !email;
          mailBtn.href = email ? "mailto:" + email + "?subject=" + encodeURIComponent(body.split("\n")[0]) + "&body=" + encodeURIComponent(body) : "#";
          mailBtn.onclick = function () { if (copyStatus) { copyStatus.textContent = "메일 작성 화면이 열립니다. 메일을 보내야 문의가 전달됩니다."; copyStatus.className = "form-status warn"; } };
        }
        if (copyBtn) {
          copyBtn.hidden = channelList.length === 0;
          copyBtn.onclick = function () {
            var ok = function () { if (copyStatus) { copyStatus.textContent = "문의 내용을 복사했습니다. 아래 상담 채널에 붙여넣어 보내주세요."; copyStatus.className = "form-status ok"; } };
            var fail = function () {
              if (copyStatus) { copyStatus.textContent = "자동 복사가 되지 않았습니다. 아래 내용을 선택해 복사하거나 상담 채널로 연락해 주세요."; copyStatus.className = "form-status warn"; }
              if (manual) { manual.hidden = false; manual.value = body; manual.focus(); manual.select(); }
            };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(body).then(ok, fail); else fail();
          };
        }
        if (manual) { manual.hidden = true; manual.value = body; }
        failBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
      };

      var showDone = function (receipt) {
        if (failBox) failBox.hidden = true;
        form.hidden = true;
        if (doneBox) {
          doneBox.hidden = false;
          var r = $("[data-receipt]", doneBox); if (r) r.textContent = receipt || "";
          var note = $("[data-reply-note]", doneBox); if (note) { note.textContent = text(inquiry.replyNote); note.hidden = !text(inquiry.replyNote); }
          doneBox.scrollIntoView({ behavior: "smooth", block: "start" });
          var again = $("[data-form-again]", doneBox);
          if (again) again.onclick = function () {
            form.reset(); if (subId) subId.value = newId(); syncPurpose(); setStatus("", "");
            doneBox.hidden = true; form.hidden = false; if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
            form.elements.name.focus();
          };
        }
      };

      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var data = collect();
        if (data.website) { showDone("SF-000000-0000"); return; } // 스팸 봇
        if (!validate(data)) return;
        if (btn) { btn.disabled = true; }
        setStatus("문의를 보내고 있습니다.", "");
        if (failBox) failBox.hidden = true;
        var timer = setTimeout(function () { }, 0);
        var ctrl = ("AbortController" in window) ? new AbortController() : null;
        if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, 15000);
        fetch("/api/inquiry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: ctrl ? ctrl.signal : undefined })
          .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j || {} }; }, function () { return { status: r.status, j: {} }; }); })
          .then(function (res) {
            clearTimeout(timer);
            if (res.j && res.j.ok && res.j.receipt) { showDone(res.j.receipt); return; }
            if (res.status === 400 && res.j && res.j.error === "invalid") {
              var map = { name: "이름 또는 단체명을 적어 주세요.", phone: "연락 가능한 전화번호를 적어 주세요.", email: "이메일을 확인해 주세요.", message: "문의 내용을 적어 주세요.", consent: "문의 접수를 위한 개인정보 수집·이용 안내를 확인해 주세요." };
              (res.j.fields || []).forEach(function (f) { if (map[f]) fieldError(f, map[f]); });
              setStatus("입력 내용을 확인해 주세요.", "err");
              if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
              return;
            }
            if (res.status === 429) { setStatus("짧은 시간에 여러 번 보내셨습니다. 잠시 후 다시 시도해 주세요.", "err"); if (btn) { btn.disabled = false; btn.textContent = btnLabel; } return; }
            showFail(data);
          })
          .catch(function () { clearTimeout(timer); showFail(data); });
      });
    }
  }

  /* ---------- 평면도 ---------- */
  $$(".floorplan .zone[data-target]").forEach(function (z) {
    var go = function () {
      var t = document.getElementById(z.getAttribute("data-target"));
      if (!t) return;
      t.scrollIntoView({ behavior: "smooth", block: "start" });
      $$(".is-target").forEach(function (e) { e.classList.remove("is-target"); });
      t.classList.add("is-target");
      setTimeout(function () { t.classList.remove("is-target"); }, 2400);
    };
    z.addEventListener("click", go);
    z.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    var title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    var name = z.querySelector(".z-name"); title.textContent = (name ? name.textContent : "") + " 안내로 이동";
    z.appendChild(title);
  });

  /* ---------- 활용 예시 필터 ---------- */
  var chips = $$(".chips .chip");
  if (chips.length) {
    var scenes = $$(".scenes .scene");
    var moreBtn = $("[data-scenes-more]");
    var LIMIT = 12, expanded = false, currentF = "all";
    var applyF = function () {
      var shown = 0;
      scenes.forEach(function (s) {
        var tags = (s.getAttribute("data-tags") || "").split(" ");
        var ok = currentF === "all" || tags.indexOf(currentF) >= 0;
        if (ok && !expanded && shown >= LIMIT) ok = false;
        s.hidden = !ok; if (ok) shown++;
      });
      var total = scenes.filter(function (s) { var t = (s.getAttribute("data-tags") || "").split(" "); return currentF === "all" || t.indexOf(currentF) >= 0; }).length;
      if (moreBtn) { moreBtn.hidden = expanded || total <= LIMIT; moreBtn.textContent = "활용 예시 " + (total - LIMIT) + "개 더 보기"; }
    };
    chips.forEach(function (c) {
      c.setAttribute("aria-pressed", c.classList.contains("is-on") ? "true" : "false");
      c.addEventListener("click", function () {
        chips.forEach(function (x) { x.classList.remove("is-on"); x.setAttribute("aria-pressed", "false"); });
        c.classList.add("is-on"); c.setAttribute("aria-pressed", "true");
        currentF = c.getAttribute("data-filter") || "all"; expanded = false; applyF();
      });
    });
    if (moreBtn) moreBtn.addEventListener("click", function () { expanded = true; applyF(); });
    applyF();
  }

  /* ---------- 라이트박스 (초점 이동 · 복귀) ---------- */
  var lbLinks = $$("[data-lightbox]");
  if (lbLinks.length) {
    var lb = document.createElement("div");
    lb.className = "lightbox"; lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true"); lb.setAttribute("aria-label", "이미지 크게 보기"); lb.hidden = true;
    lb.innerHTML = '<button class="lb-close" type="button" aria-label="닫기">×</button><button class="lb-nav lb-prev" type="button" aria-label="이전 이미지">‹</button><img alt=""><button class="lb-nav lb-next" type="button" aria-label="다음 이미지">›</button><div class="lb-cap"></div>';
    document.body.appendChild(lb);
    var lbImg = $("img", lb), lbCap = $(".lb-cap", lb), idx = 0, opener = null;
    var visible = function () { return lbLinks.filter(function (a) { return a.offsetParent !== null; }); };
    var list = lbLinks;
    var show = function (i) {
      idx = (i + list.length) % list.length;
      var a = list[idx], im = a.querySelector("img");
      var alt = im ? im.alt : (a.getAttribute("data-alt") || "");
      lbImg.src = a.getAttribute("href"); lbImg.alt = alt;
      var tag = a.getAttribute("data-img-tag") || (a.closest("[data-img-tag]") ? a.closest("[data-img-tag]").getAttribute("data-img-tag") : "");
      lbCap.textContent = [alt, tag].filter(Boolean).join(" · ");
    };
    var open = function (a) {
      opener = a; list = visible(); if (!list.length) list = lbLinks;
      show(Math.max(0, list.indexOf(a)));
      lb.hidden = false;
      document.body.classList.add("lb-locked");
      requestAnimationFrame(function () { lb.classList.add("is-open"); setTimeout(function () { $(".lb-close", lb).focus(); }, 30); });
    };
    var close = function () {
      lb.classList.remove("is-open"); lb.hidden = true; document.body.classList.remove("lb-locked"); lbImg.src = "";
      if (opener && opener.focus) opener.focus();
    };
    lbLinks.forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); open(a); }); });
    $(".lb-close", lb).addEventListener("click", close);
    $(".lb-prev", lb).addEventListener("click", function () { show(idx - 1); });
    $(".lb-next", lb).addEventListener("click", function () { show(idx + 1); });
    lb.addEventListener("click", function (e) { if (e.target === lb) close(); });
    document.addEventListener("keydown", function (e) {
      if (lb.hidden) return;
      if (e.key === "Escape") { close(); return; }
      if (e.key === "ArrowLeft") show(idx - 1);
      else if (e.key === "ArrowRight") show(idx + 1);
      else if (e.key === "Tab") {
        var focusables = $$("button", lb);
        var first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  /* ---------- 3D 둘러보기 인라인 임베드 ---------- */
  var embed = $("#tour-embed");
  if (embed) {
    var frame = $("iframe", embed);
    $$("[data-tour-embed]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (!frame.getAttribute("src")) frame.setAttribute("src", frame.getAttribute("data-src"));
        embed.hidden = false;
        embed.scrollIntoView({ behavior: "smooth", block: "start" });
        var closeBtn = $("[data-tour-close]", embed); if (closeBtn) closeBtn.focus();
      });
    });
    $$("[data-tour-close]").forEach(function (b) {
      b.addEventListener("click", function () {
        embed.hidden = true; frame.removeAttribute("src");
        var openBtn = $("[data-tour-embed]"); if (openBtn) openBtn.focus();
      });
    });
  }

  /* ---------- 조감도: 번호와 목록을 함께 강조 ---------- */
  $$(".aerial-map").forEach(function (map) {
    $$("[data-am]", map).forEach(function (el) {
      var k = el.getAttribute("data-am");
      function set(on) { $$('[data-am="' + k + '"]', map).forEach(function (x) { x.classList.toggle("is-hot", on); }); }
      el.addEventListener("mouseenter", function () { set(true); });
      el.addEventListener("mouseleave", function () { set(false); });
      el.addEventListener("focus", function () { set(true); });
      el.addEventListener("blur", function () { set(false); });
    });
  });
})();
