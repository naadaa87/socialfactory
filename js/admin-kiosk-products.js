/* 관리자 — 토스프론트 판매 상품. 홈페이지 상품과 독립적으로 관리합니다. */
(function () {
  "use strict";
  var A = window.SF_ADMIN; if (!A) return;
  // 예약 패널처럼 화면 영역 밖으로 옮겨, 다른 관리자 화면으로 이동해도 패널이 숨은 화면에 갇히지 않게 합니다.
  document.body.appendChild(document.getElementById("dr-kprod"));
  var $ = A.$, esc = A.esc, won = A.won, api = A.api, toast = A.toast, guard = A.guard, emptyMsg = A.emptyMsg;
  var items = [], categoryItems = [], busy = false;
  function categoryName(id) { var c = categoryItems.find(function (x) { return x.id === id; }); return c ? c.name : id; }
  function categoryOptions(selected) {
    var active = categoryItems.filter(function (c) { return c.active || c.id === selected; });
    $("#kp-category").innerHTML = active.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + (c.active ? '' : ' (판매 중지)') + '</option>';
    }).join('');
    if (selected) $("#kp-category").value = selected;
  }
  var units = { hours: "시간", days: "일", months: "개월" };
  function unitOf(p) { return Object.keys(p.duration || {})[0] || "hours"; }
  function picture(p) {
    return p && p.imageVersion ? "/api/kiosk/product-images/" + encodeURIComponent(p.id) + "?v=" + p.imageVersion :
      "/toss-front-plugin/images/" + encodeURIComponent(p && p.image || $("#kp-image").value);
  }
  function updatePrice() {
    var base = Number($("#kp-base-price").value), rate = Number($("#kp-discount").value);
    $("#kp-price").value = Number.isFinite(base) && base > 0 && Number.isFinite(rate) && rate >= 0 && rate <= 90 ?
      Math.round(base * (100 - rate) / 100) : "";
  }
  function webpBase64(file) {
    if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024)
      return Promise.reject(new Error("PNG·JPG·WebP 파일(5MB 이하)을 골라 주세요."));
    return createImageBitmap(file).then(function (bitmap) {
      try {
        if (bitmap.width > 4096 || bitmap.height > 4096 || bitmap.width * bitmap.height > 16000000)
          throw new Error("이미지 가로·세로는 4096px 이하로 골라 주세요.");
        var scale = Math.min(1, 384 / Math.max(bitmap.width, bitmap.height));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (blob) {
            if (!blob || blob.type !== "image/webp" || blob.size > 150000) { reject(new Error("이미지를 변환하지 못했거나 용량이 150KB를 넘습니다.")); return; }
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result).split(",")[1]); };
            reader.onerror = function () { reject(new Error("이미지를 읽지 못했습니다.")); };
            reader.readAsDataURL(blob);
          }, "image/webp", 0.82);
        });
      } finally { bitmap.close(); }
    });
  }
  function load() {
    var box = $("#kp-rows");
    Promise.all([api("/api/admin/kiosk-categories"), api("/api/admin/kiosk-products")]).then(function (values) {
      categoryItems = values[0].categories || [];
      items = values[1].products || [];
      $("#kc-rows").innerHTML = categoryItems.map(function (c) {
        return '<tr><td><img class="kp-thumb" alt="" src="/toss-front-plugin/images/' + esc(c.image) + '"><b>' + esc(c.name) + '</b><small>' + esc(c.description || c.id) + '</small></td>' +
          '<td>' + c.activeProducts + '개</td><td><span class="st ' + (c.active ? 'ok' : 'gray') + '">' + (c.active ? '노출' : '숨김') + '</span></td>' +
          '<td><button type="button" class="btn btn-light btn-xs" data-kc-edit="' + esc(c.id) + '">수정</button></td></tr>';
      }).join('') || '<tr><td colspan="4">' + emptyMsg('등록된 분류가 없습니다.') + '</td></tr>';
      categoryOptions($("#kp-category").value);
      box.innerHTML = items.length ? items.map(function (p) {
        var unit = unitOf(p);
        return '<tr><td><img class="kp-thumb" alt="" src="' + esc(picture(p)) + '"><b>' + esc(p.name) + "</b><small>" + esc(p.short || "") + "</small><small class=\"mono\">" + esc(p.id) + "</small></td>" +
          "<td>" + esc(categoryName(p.category)) + "<small>" + esc(p.group) + "</small></td>" +
          "<td><b>" + won(p.price) + "</b>" + (p.listPrice ? "<small>정가 " + won(p.listPrice) + " · " + p.discountPercent + "% 할인</small>" : "") + "</td>" +
          "<td>" + esc(p.duration[unit]) + esc(units[unit]) + "</td>" +
          '<td><span class="st ' + (p.active ? "ok" : "gray") + '">' + (p.active ? "판매 중" : "판매 중지") + "</span></td>" +
          '<td><button type="button" class="btn btn-light btn-xs" data-kp-edit="' + esc(p.id) + '">수정</button></td></tr>';
      }).join("") : '<tr><td colspan="6">' + emptyMsg("등록된 상품이 없습니다.") + "</td></tr>";
    }).catch(function (e) { if (!guard(e)) { box.innerHTML = '<tr><td colspan="6">' + emptyMsg(e.message) + "</td></tr>"; $("#kc-rows").innerHTML = '<tr><td colspan="4">' + emptyMsg(e.message) + '</td></tr>'; } });
  }
  function open(p) {
    var form = $("#kp-form"); form.reset(); $("#kp-msg").hidden = true;
    $("#kp-id").value = p ? p.id : "";
    $("#kp-form-title").textContent = p ? "상품 수정 · " + p.name : "새 토스프론트 상품 등록";
    $("#kp-name").value = p ? p.name : "";
    $("#kp-short").value = p ? p.short || "" : "";
    $("#kp-base-price").value = p ? p.listPrice || p.price : "";
    $("#kp-discount").value = p ? p.discountPercent : 0;
    updatePrice();
    $("#kp-duration-unit").value = p ? unitOf(p) : "hours";
    $("#kp-duration-value").value = p ? p.duration[unitOf(p)] : 2;
    $("#kp-group").value = p ? p.group : "seat";
    categoryOptions(p ? p.category : categoryItems.filter(function (c) { return c.active; })[0]?.id);
    $("#kp-image").value = p ? p.image : "pass-2h.webp";
    $("#kp-sort").value = p ? p.sortOrder : 100;
    $("#kp-active").checked = p ? p.active : true;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    $("#kp-file").value = "";
    $("#kp-preview").src = picture(p);
    $("#kp-reset-image").hidden = !(p && p.imageVersion);
    A.openDrawer("#dr-kprod");
    $("#kp-name").focus();
  }
  $("#kp-base-price").addEventListener("input", updatePrice);
  $("#kp-discount").addEventListener("input", updatePrice);
  $("#kp-image").addEventListener("change", function () {
    if (!$("#kp-file").files.length && $("#kp-reset-image").hidden) $("#kp-preview").src = picture(null);
  });
  var previewUrl = null;
  $("#kp-file").addEventListener("change", function () {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    var file = this.files[0];
    if (file) { previewUrl = URL.createObjectURL(file); $("#kp-preview").src = previewUrl; }
    else { previewUrl = null; $("#kp-preview").src = picture(items.filter(function (p) { return p.id === $("#kp-id").value; })[0]); }
  });
  $("#kp-reset-image").addEventListener("click", function () {
    var id = $("#kp-id").value; if (!id) return;
    api("/api/admin/kiosk-product-images", { method: "DELETE", body: { productId: id } }).then(function () {
      $("#kp-reset-image").hidden = true; $("#kp-file").value = ""; $("#kp-preview").src = picture(null); load();
      toast("업로드 이미지를 삭제하고 기본 아이콘으로 바꿨습니다.");
    }).catch(function (e) { if (!guard(e)) toast(e.message); });
  });
  $("#kp-new").addEventListener("click", function () { open(null); });
  function openCategory(c) {
    var form = $("#kc-form"); form.hidden = false; form.reset(); $("#kc-msg").hidden = true;
    $("#kc-id").value = c ? c.id : "";
    $("#kc-form-title").textContent = c ? "분류 수정 · " + c.name : "새 프론트 분류 추가";
    $("#kc-name").value = c ? c.name : "";
    $("#kc-description").value = c ? c.description : "";
    $("#kc-image").value = c ? c.image : "pass-1d.webp";
    $("#kc-sort").value = c ? c.sortOrder : 100;
    $("#kc-active").checked = c ? c.active : true;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#kc-new").addEventListener("click", function () { openCategory(null); });
  $("#kc-cancel").addEventListener("click", function () { $("#kc-form").hidden = true; });
  $("#kc-rows").addEventListener("click", function (e) {
    var b = e.target.closest("[data-kc-edit]");
    if (b) openCategory(categoryItems.find(function (c) { return c.id === b.dataset.kcEdit; }));
  });
  $("#kc-form").addEventListener("submit", function (e) {
    e.preventDefault(); if (busy) return;
    var id = $("#kc-id").value;
    var body = { id: id, name: $("#kc-name").value, description: $("#kc-description").value,
      image: $("#kc-image").value, sortOrder: +$("#kc-sort").value, active: $("#kc-active").checked };
    busy = true; $("#kc-save").disabled = true; $("#kc-msg").hidden = true;
    api("/api/admin/kiosk-categories", { method: id ? "PATCH" : "POST", body: body }).then(function () {
      $("#kc-form").hidden = true; toast("프론트 분류를 저장했습니다."); load();
    }).catch(function (err) {
      if (!guard(err)) { $("#kc-msg").textContent = err.message || "분류를 저장하지 못했습니다."; $("#kc-msg").hidden = false; }
    }).finally(function () { busy = false; $("#kc-save").disabled = false; });
  });
  $("#kp-reload").addEventListener("click", load);
  $("#kp-cancel").addEventListener("click", function () { A.closeDrawer($("#dr-kprod")); });
  $("#kp-rows").addEventListener("click", function (e) {
    var b = e.target.closest("[data-kp-edit]");
    if (b) open(items.filter(function (p) { return p.id === b.dataset.kpEdit; })[0] || null);
  });
  $("#kp-form").addEventListener("submit", function (e) {
    e.preventDefault(); if (busy) return;
    var id = $("#kp-id").value, body = {
      id: id, name: $("#kp-name").value, short: $("#kp-short").value,
      basePrice: +$("#kp-base-price").value, discountPercent: +$("#kp-discount").value,
      durationUnit: $("#kp-duration-unit").value, durationValue: +$("#kp-duration-value").value,
      group: $("#kp-group").value, category: $("#kp-category").value, image: $("#kp-image").value,
      sortOrder: +$("#kp-sort").value, active: $("#kp-active").checked
    };
    busy = true; $("#kp-save").disabled = true; $("#kp-msg").hidden = true;
    var file = $("#kp-file").files[0], productSaved = false;
    api("/api/admin/kiosk-products", { method: id ? "PATCH" : "POST", body: body }).then(function (j) {
      productSaved = true; $("#kp-id").value = j.id;
      return file ? webpBase64(file).then(function (base64) {
        return api("/api/admin/kiosk-product-images", { method: "POST", body: { productId: j.id, base64: base64 } });
      }) : null;
    }).then(function () {
      A.closeDrawer($("#dr-kprod")); toast("토스프론트 상품을 저장했습니다."); load();
    }).catch(function (err) {
      if (!guard(err)) {
        $("#kp-msg").textContent = (productSaved ? "상품은 저장됐습니다. 이미지 업로드 실패: " : "") + (err.message || "상품을 저장하지 못했습니다.");
        $("#kp-msg").hidden = false; if (productSaved) load();
      }
    }).finally(function () { busy = false; $("#kp-save").disabled = false; });
  });
  A.LOAD.kprod = load;
})();
