/* 프론트 UI 설정·미리보기. 실제 플러그인과 ui.js의 화면 모델을 공유합니다. */
(function () {
  "use strict";
  var A = window.SF_ADMIN, UI = window.SF_KIOSK_UI;
  if (!A || !UI) return;
  var $ = A.$, $$ = A.$$, esc = A.esc;
  var form = $("#kui-form"), loaded = false, loading = false, saving = false;
  var saved = null, draft = UI.normalize(), products = [], categories = [], updatedAt = null;
  var screen = "category", group = "day", previewOptions = [];
  function dirty() { return !!saved && (draft.categoryLayout !== saved.categoryLayout || draft.productLayout !== saved.productLayout); }
  function say(text, error) {
    $("#kui-message").textContent = text;
    $("#kui-message").classList.toggle("kui-error", !!error);
  }
  function syncControls() {
    form.querySelectorAll("fieldset").forEach(function (field) { field.disabled = !loaded || saving; });
    form.querySelectorAll('input[type="radio"]').forEach(function (input) { input.checked = draft[input.name] === input.value; });
    $("#kui-save").disabled = !loaded || saving || !dirty();
    $("#kui-save").textContent = saving ? "저장 중…" : "선택한 화면 저장";
    $("#kui-reset").disabled = !loaded || saving || !dirty();
    $("#kui-saved").textContent = !loaded ? "설정 불러오기 필요" : updatedAt ? "저장: " + updatedAt.slice(0, 16) : "기본 설정 사용 중";
    $("#kui-draft-status").textContent = dirty() ? "저장 전 미리보기" : "저장된 설정";
    $("#kui-draft-status").classList.toggle("warn", dirty());
  }
  function imageUrl(name) { return "/toss-front-plugin/images/" + name; }
  function renderPreview() {
    var visibleGroups = categories.filter(function (category) { return products.some(function (product) { return product.category === category.id; }); });
    if (visibleGroups.length && !visibleGroups.some(function (category) { return category.id === group; })) group = visibleGroups[0].id;
    $("#kui-groups .chips").innerHTML = visibleGroups.map(function (category) {
      return '<button type="button" class="chip" data-kui-group="' + esc(category.id) + '" aria-pressed="false">' + esc(category.name) + '</button>';
    }).join("");
    $$("[data-kui-screen]").forEach(function (button) {
      var active = button.dataset.kuiScreen === screen;
      button.classList.toggle("on", active); button.setAttribute("aria-pressed", String(active));
    });
    $$("[data-kui-group]").forEach(function (button) {
      var active = button.dataset.kuiGroup === group;
      button.classList.toggle("on", active); button.setAttribute("aria-pressed", String(active));
    });
    $("#kui-groups").hidden = screen !== "product";
    $("#kui-back").hidden = screen !== "product";
    var page = screen === "category"
      ? UI.categoryPage(draft.categoryLayout, function (nextGroup) { group = nextGroup; screen = "product"; renderPreview(); }, imageUrl, categories, products)
      : UI.productPage(products, group, draft.productLayout, function (product) {
        $("#kui-selection").textContent = UI.productLabel(product) + " · " + A.won(product.price) + "을 선택했어요. 미리보기에서는 결제하지 않아요.";
      }, imageUrl, categories);
    previewOptions = page.params.options;
    var grid = page.method === "renderSelectGridPage";
    $("#kui-preview").innerHTML = "<h3>" + esc(page.params.title) + "</h3><p>" + esc(page.params.subtitle || "") + '</p><div class="kui-options' + (grid ? " kui-options-grid" : "") + '">'
      + previewOptions.map(function (option, index) {
        return '<button class="kui-option" type="button" data-kui-option="' + index + '">'
          + (option.iconUrl ? '<img src="' + esc(option.iconUrl) + '" alt="">' : "")
          + "<span><strong>" + esc(option.title) + "</strong>" + (option.subtitle ? "<small>" + esc(option.subtitle) + "</small>" : "")
          + (option.description ? "<em>" + esc(option.description) + "</em>" : "") + "</span></button>";
      }).join("") + "</div>" + (!previewOptions.length ? '<p>현재 판매 중인 이용권이 없어요.</p>' : "");
    $("#kui-selection").textContent = screen === "category" ? "분류를 눌러 상품 화면도 확인해 보세요." : "상품을 눌러도 실제 구매나 결제는 진행되지 않아요.";
    syncControls();
  }
  A.loadKioskUi = function () {
    if (loaded) { renderPreview(); return Promise.resolve(); }
    if (loading) return Promise.resolve();
    loading = true;
    say("화면 설정을 불러오고 있어요.");
    $("#kui-retry").hidden = true;
    return A.api("/api/admin/kiosk-ui").then(function (result) {
      saved = UI.normalize(result.layout); draft = UI.normalize(result.layout);
      updatedAt = result.layout.updatedAt; products = result.products || []; categories = result.categories || []; loaded = true;
      say("구성을 선택해 미리 보고, 마음에 드는 화면을 저장해 주세요.");
      renderPreview();
    }).catch(function (error) {
      if (!A.guard(error)) say(error.message || "화면 설정을 불러오지 못했어요.", true);
      $("#kui-retry").hidden = false;
    }).finally(function () { loading = false; syncControls(); });
  };
  form.addEventListener("change", function (event) {
    var input = event.target;
    if (!loaded || saving || !["categoryLayout", "productLayout"].includes(input.name)) return;
    draft[input.name] = input.value;
    screen = input.name === "categoryLayout" ? "category" : "product";
    say(dirty() ? "아직 저장하지 않았어요. 미리 본 뒤 저장해 주세요." : "저장된 설정과 같아요.");
    renderPreview();
  });
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (!loaded || saving || !dirty()) return;
    saving = true; syncControls(); say("선택한 화면을 저장하고 있어요.");
    A.api("/api/admin/kiosk-ui", { method: "PUT", body: { layout: UI.normalize(draft) } }).then(function (result) {
      saved = UI.normalize(result.layout); draft = UI.normalize(result.layout); updatedAt = result.layout.updatedAt;
      say("저장했어요. 다음 ‘이용권 구매’부터 반영돼요.");
      A.toast("프론트 화면 설정을 저장했어요."); renderPreview();
    }).catch(function (error) {
      if (!A.guard(error)) say(error.message || "저장하지 못했어요. 다시 시도해 주세요.", true);
    }).finally(function () { saving = false; syncControls(); });
  });
  $("#kui-reset").addEventListener("click", function () {
    if (!loaded || saving) return;
    draft = UI.normalize(saved); say("저장된 설정으로 되돌렸어요."); renderPreview();
  });
  $("#kui-retry").addEventListener("click", function () { A.loadKioskUi(); });
  $$("[data-kui-screen]").forEach(function (button) { button.addEventListener("click", function () {
    screen = button.dataset.kuiScreen; renderPreview();
  }); });
  $("#kui-groups").addEventListener("click", function (event) {
    var button = event.target.closest("[data-kui-group]");
    if (button) { group = button.dataset.kuiGroup; screen = "product"; renderPreview(); }
  });
  $("#kui-back").addEventListener("click", function () { screen = "category"; renderPreview(); });
  $("#kui-preview").addEventListener("click", function (event) {
    var button = event.target.closest("[data-kui-option]");
    if (button && loaded) previewOptions[Number(button.dataset.kuiOption)]?.onClick();
  });
})();
