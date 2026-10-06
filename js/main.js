/* 소셜팩토리 홈페이지 공통 스크립트 */
(function () {
  "use strict";
  var CFG = window.SF_CONFIG || {};
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var get = function (path) {
    return path.split(".").reduce(function (o, k) { return (o && o[k] !== undefined) ? o[k] : ""; }, CFG);
  };

  /* ---------- 헤더 ---------- */
  var header = $(".site-header");
  var onScroll = function () {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var toggle = $(".nav-toggle");
  var links = $(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "메뉴 닫기" : "메뉴 열기");
    });
    $$("a", links).forEach(function (a) {
      a.addEventListener("click", function () {
        links.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* 현재 페이지 표시 */
  var here = location.pathname.replace(/\/index\.html$/, "/").replace(/\/$/, "/index.html");
  $$(".nav-links a").forEach(function (a) {
    var href = a.getAttribute("href") || "";
    if (!href || href.indexOf("#") === 0 || a.closest(".nav-cta")) return;
    var target = href.replace(/^\.\//, "");
    if (here.split("/").pop() === target || (target === "index.html" && /\/$/.test(location.pathname))) {
      a.setAttribute("aria-current", "page");
    }
  });

  /* ---------- 등장 애니메이션 ---------- */
  var reveals = $$(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("is-in"); });
  }

  /* ---------- 설정값 반영 ---------- */
  // 텍스트: <span data-sf="address"></span>
  $$("[data-sf]").forEach(function (el) {
    var v = get(el.getAttribute("data-sf"));
    if (v) { el.textContent = v; }
    else if (el.hasAttribute("data-sf-hide")) {
      var wrap = el.closest(el.getAttribute("data-sf-hide") || "li") || el;
      wrap.hidden = true;
    }
  });

  // 채널 버튼: <a data-channel="kakao">
  var channelHref = {
    phone: function (v) { return "tel:" + v.replace(/[^0-9+]/g, ""); },
    email: function (v) { return "mailto:" + v; },
    kakao: function (v) { return v; },
    naver: function (v) { return v; },
    spacecloud: function (v) { return v; },
    instagram: function (v) { return v; }
  };
  var visibleChannels = 0;
  $$("[data-channel]").forEach(function (a) {
    var key = a.getAttribute("data-channel");
    var v = get("contact." + key);
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
  $$(".channels-empty").forEach(function (el) { el.hidden = visibleChannels > 0; });
  $$("[data-if-channels]").forEach(function (el) { el.hidden = visibleChannels === 0; });

  // 지도 링크
  var addr = get("address");
  $$("[data-map]").forEach(function (a) {
    var q = encodeURIComponent(addr || "한아름건물 화양동 10-1");
    a.href = a.getAttribute("data-map") === "kakao"
      ? "https://map.kakao.com/?q=" + q
      : "https://map.naver.com/p/search/" + q;
    a.target = "_blank"; a.rel = "noopener";
  });

  // 요금
  var showPrice = !!(CFG.pricing && CFG.pricing.show);
  $$("[data-pricing]").forEach(function (el) {
    var v = get("pricing." + el.getAttribute("data-pricing"));
    var box = el.closest("[data-pricing-box]") || el;
    if (showPrice && v) { el.textContent = v; box.hidden = false; }
    else { box.hidden = true; }
  });
  $$("[data-pricing-fallback]").forEach(function (el) { el.hidden = showPrice; });

  // 푸터 회사 정보
  var comp = CFG.company || {};
  var compLine = [comp.name, comp.ceo, comp.regNo, comp.address].filter(Boolean).join(" · ");
  $$("[data-company-line]").forEach(function (el) { el.textContent = compLine; });
  $$("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });

  /* ---------- 문의 폼 ---------- */
  var form = $("#inquiry-form");
  if (form) {
    var status = $(".form-status", form);
    var setStatus = function (msg, cls) { status.textContent = msg; status.className = "form-status " + (cls || ""); };
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var data = {};
      new FormData(form).forEach(function (v, k) { data[k] = String(v).trim(); });
      if (!data.name || !data.phone || !data.message) { setStatus("이름, 연락처, 문의 내용은 꼭 적어 주세요.", "err"); return; }
      if (data.website) { return; } // 스팸 방지용 숨김 필드
      data.page = location.href;
      var btn = $("button[type=submit]", form);
      btn.disabled = true; setStatus("보내는 중입니다…");

      var fallback = function () {
        var email = get("contact.email");
        var lines = [
          "[소셜팩토리 문의] " + (data.type || "일반 문의"),
          "이름: " + data.name,
          "연락처: " + data.phone,
          "이메일: " + (data.email || "-"),
          "희망 일시: " + (data.when || "-"),
          "인원: " + (data.people || "-"),
          "",
          data.message
        ];
        if (email) {
          location.href = "mailto:" + email + "?subject=" + encodeURIComponent(lines[0]) + "&body=" + encodeURIComponent(lines.join("\n"));
          setStatus("메일 앱이 열립니다. 전송이 되지 않으면 아래 채널로 보내 주세요.", "ok");
        } else {
          var text = lines.join("\n");
          var done = function () { setStatus("문의 내용을 복사했습니다. 아래 카카오톡 채널이나 예약 채널에 붙여 넣어 보내 주세요.", "ok"); };
          if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, done); } else { done(); }
        }
        btn.disabled = false;
      };

      fetch("/api/inquiry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j && j.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok) { form.reset(); setStatus("문의가 접수되었습니다. 확인 후 연락드리겠습니다.", "ok"); btn.disabled = false; }
          else { fallback(); }
        })
        .catch(fallback);
    });
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
    var LIMIT = 12, expanded = false, current = "all";
    var apply = function () {
      var shown = 0;
      scenes.forEach(function (s) {
        var tags = (s.getAttribute("data-tags") || "").split(" ");
        var ok = current === "all" || tags.indexOf(current) >= 0;
        if (ok && !expanded && shown >= LIMIT) ok = false;
        s.hidden = !ok; if (ok) shown++;
      });
      var total = scenes.filter(function (s) { var t = (s.getAttribute("data-tags") || "").split(" "); return current === "all" || t.indexOf(current) >= 0; }).length;
      if (moreBtn) { moreBtn.hidden = expanded || total <= LIMIT; moreBtn.textContent = "활용 예시 " + (total - LIMIT) + "개 더 보기"; }
    };
    chips.forEach(function (c) {
      c.addEventListener("click", function () {
        chips.forEach(function (x) { x.classList.remove("is-on"); });
        c.classList.add("is-on"); current = c.getAttribute("data-filter") || "all"; expanded = false; apply();
      });
    });
    if (moreBtn) moreBtn.addEventListener("click", function () { expanded = true; apply(); });
    apply();
  }

  /* ---------- 라이트박스 ---------- */
  var lbLinks = $$("[data-lightbox]");
  if (lbLinks.length) {
    var lb = document.createElement("div");
    lb.className = "lightbox"; lb.setAttribute("role", "dialog"); lb.setAttribute("aria-modal", "true"); lb.setAttribute("aria-label", "이미지 크게 보기");
    lb.innerHTML = '<button class="lb-close" type="button" aria-label="닫기">×</button><button class="lb-nav lb-prev" type="button" aria-label="이전">‹</button><img alt=""><button class="lb-nav lb-next" type="button" aria-label="다음">›</button><div class="lb-cap"></div>';
    document.body.appendChild(lb);
    var lbImg = $("img", lb), lbCap = $(".lb-cap", lb), idx = 0;
    var visible = function () { return lbLinks.filter(function (a) { return a.offsetParent !== null || a.closest(".scene") === null; }); };
    var list = lbLinks;
    var show = function (i) {
      idx = (i + list.length) % list.length;
      var a = list[idx], im = a.querySelector("img");
      lbImg.src = a.getAttribute("href"); lbImg.alt = im ? im.alt : "";
      lbCap.textContent = im ? im.alt : "";
    };
    var open = function (a) { list = visible(); show(Math.max(0, list.indexOf(a))); lb.classList.add("is-open"); document.body.classList.add("lb-locked"); };
    var close = function () { lb.classList.remove("is-open"); document.body.classList.remove("lb-locked"); lbImg.src = ""; };
    lbLinks.forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); open(a); }); });
    $(".lb-close", lb).addEventListener("click", close);
    $(".lb-prev", lb).addEventListener("click", function () { show(idx - 1); });
    $(".lb-next", lb).addEventListener("click", function () { show(idx + 1); });
    lb.addEventListener("click", function (e) { if (e.target === lb) close(); });
    document.addEventListener("keydown", function (e) {
      if (!lb.classList.contains("is-open")) return;
      if (e.key === "Escape") close(); else if (e.key === "ArrowLeft") show(idx - 1); else if (e.key === "ArrowRight") show(idx + 1);
    });
  }
})();
