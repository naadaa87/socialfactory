/* 관리자 — 토스프론트 판매 상품. 홈페이지 상품과 독립적으로 관리합니다. */
(function () {
  "use strict";
  var A = window.SF_ADMIN; if (!A) return;
  var $ = A.$, esc = A.esc, won = A.won, api = A.api, toast = A.toast, guard = A.guard, emptyMsg = A.emptyMsg;
  var items = [], busy = false;
  var categories = { day: "잠깐 · 하루", regular: "꾸준히 이용", friend: "친구와 함께" };
  var units = { hours: "시간", days: "일", months: "개월" };
  function unitOf(p) { return Object.keys(p.duration || {})[0] || "hours"; }
  function load() {
    var box = $("#kp-rows");
    api("/api/admin/kiosk-products").then(function (j) {
      items = j.products || [];
      box.innerHTML = items.length ? items.map(function (p) {
        var unit = unitOf(p);
        return "<tr><td><b>" + esc(p.name) + "</b><small>" + esc(p.short || "") + "</small><small class=\"mono\">" + esc(p.id) + "</small></td>" +
          "<td>" + esc(categories[p.category] || p.category) + "<small>" + esc(p.group) + "</small></td>" +
          "<td><b>" + won(p.price) + "</b>" + (p.listPrice ? "<small>정가 " + won(p.listPrice) + "</small>" : "") + "</td>" +
          "<td>" + esc(p.duration[unit]) + esc(units[unit]) + "</td>" +
          '<td><span class="st ' + (p.active ? "ok" : "gray") + '">' + (p.active ? "판매 중" : "판매 중지") + "</span></td>" +
          '<td><button type="button" class="btn btn-light btn-xs" data-kp-edit="' + esc(p.id) + '">수정</button></td></tr>';
      }).join("") : '<tr><td colspan="6">' + emptyMsg("등록된 상품이 없습니다.") + "</td></tr>";
    }).catch(function (e) { if (!guard(e)) box.innerHTML = '<tr><td colspan="6">' + emptyMsg(e.message) + "</td></tr>"; });
  }
  function open(p) {
    var form = $("#kp-form"); form.hidden = false; form.reset(); $("#kp-msg").hidden = true;
    $("#kp-id").value = p ? p.id : "";
    $("#kp-form-title").textContent = p ? "상품 수정 · " + p.name : "새 토스프론트 상품 등록";
    $("#kp-name").value = p ? p.name : "";
    $("#kp-short").value = p ? p.short || "" : "";
    $("#kp-price").value = p ? p.price : "";
    $("#kp-list-price").value = p && p.listPrice ? p.listPrice : "";
    $("#kp-duration-unit").value = p ? unitOf(p) : "hours";
    $("#kp-duration-value").value = p ? p.duration[unitOf(p)] : 2;
    $("#kp-group").value = p ? p.group : "seat";
    $("#kp-category").value = p ? p.category : "day";
    $("#kp-image").value = p ? p.image : "pass-2h.webp";
    $("#kp-sort").value = p ? p.sortOrder : 100;
    $("#kp-active").checked = p ? p.active : true;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#kp-new").addEventListener("click", function () { open(null); });
  $("#kp-reload").addEventListener("click", load);
  $("#kp-cancel").addEventListener("click", function () { $("#kp-form").hidden = true; });
  $("#kp-rows").addEventListener("click", function (e) {
    var b = e.target.closest("[data-kp-edit]");
    if (b) open(items.filter(function (p) { return p.id === b.dataset.kpEdit; })[0] || null);
  });
  $("#kp-form").addEventListener("submit", function (e) {
    e.preventDefault(); if (busy) return;
    var id = $("#kp-id").value, body = {
      id: id, name: $("#kp-name").value, short: $("#kp-short").value,
      price: +$("#kp-price").value, listPrice: $("#kp-list-price").value ? +$("#kp-list-price").value : null,
      durationUnit: $("#kp-duration-unit").value, durationValue: +$("#kp-duration-value").value,
      group: $("#kp-group").value, category: $("#kp-category").value, image: $("#kp-image").value,
      sortOrder: +$("#kp-sort").value, active: $("#kp-active").checked
    };
    busy = true; $("#kp-save").disabled = true; $("#kp-msg").hidden = true;
    api("/api/admin/kiosk-products", { method: id ? "PATCH" : "POST", body: body }).then(function () {
      $("#kp-form").hidden = true; toast("토스프론트 상품을 저장했습니다."); load();
    }).catch(function (err) {
      if (!guard(err)) { $("#kp-msg").textContent = err.message || "상품을 저장하지 못했습니다."; $("#kp-msg").hidden = false; }
    }).finally(function () { busy = false; $("#kp-save").disabled = false; });
  });
  A.LOAD.kprod = load;
})();
