/* 어드민 미리보기와 실제 플러그인이 같은 문구·상품·SDK 파라미터를 사용합니다.
   그리드는 공개 스펙의 id/title/onClick만 전달합니다. 열 개수·탭·CSS 설정은 없습니다. */
(function (root) {
  "use strict";
  var defaults = { categoryLayout: "list", productLayout: "list" };
  var categories = [
    { id: "day", title: "잠깐 · 하루", subtitle: "2시간 · 24시간", image: "pass-1d.webp" },
    { id: "regular", title: "꾸준히 이용", subtitle: "15일 · 1개월 · 3개월", image: "pass-1m.webp" },
    { id: "friend", title: "친구와 함께", subtitle: "친구 동반 할인권", image: "pass-3m.webp" }
  ];
  var won = function (value) { return Number(value || 0).toLocaleString("ko-KR") + "원"; };
  function productLabel(product) {
    return product.category ? product.name : product.name.replace(/ \(친구 동반.*\)/, "").replace("1일권 (24시간)", "24시간 이용권");
  }
  function normalize(value) {
    return {
      categoryLayout: value && value.categoryLayout === "grid" ? "grid" : "list",
      productLayout: value && value.productLayout === "grid" ? "grid" : "list"
    };
  }
  function page(layout, title, subtitle, items) {
    var grid = layout === "grid";
    return { method: grid ? "renderSelectGridPage" : "renderSelectPage", params: {
      title: title, subtitle: subtitle,
      options: items.map(function (item) {
        if (grid) return { id: item.id, title: item.gridTitle || item.title, onClick: item.onClick };
        return { title: item.title, subtitle: item.subtitle, description: item.description, iconUrl: item.iconUrl, onClick: item.onClick };
      })
    } };
  }
  function categoryOf(product) { return product.category || (product.friend ? "friend" : ["seat-2h", "seat-1d"].indexOf(product.id) >= 0 ? "day" : "regular"); }
  function categoryPage(layout, onSelect, imageUrl, customCategories, products) {
    var groups = customCategories || categories;
    if (products) groups = groups.filter(function (category) { return products.some(function (product) { return categoryOf(product) === category.id; }); });
    return page(layout, "어떤 이용권이 필요한가요?", "이용할 기간을 골라 주세요", groups.map(function (category) {
      return { id: category.id, title: category.name || category.title,
        subtitle: products ? products.filter(function (product) { return categoryOf(product) === category.id; }).length + "가지 이용권" : category.subtitle,
        iconUrl: category.imageUrl || (imageUrl && imageUrl(category.image)), onClick: function () { onSelect(category.id); } };
    }));
  }
  function productPage(products, group, layout, onSelect, imageUrl, customCategories) {
    var selected = products.filter(function (product) {
      return categoryOf(product) === group;
    });
    var category = (customCategories || []).filter(function (item) { return item.id === group; })[0];
    return page(layout, category ? category.name : group === "friend" ? "친구 동반 이용권" : "이용권을 골라 주세요",
      group === "friend" ? "함께 방문해 각자 결제해요" : "남은 이용 기간이 있으면 이어져요",
      selected.map(function (product) {
        var label = productLabel(product), price = won(product.price);
        var discounted = product.listPrice > product.price;
        var rate = discounted ? Math.round((1 - product.price / product.listPrice) * 100) : 0;
        return { id: product.id, title: label, subtitle: price + (discounted ? " · " + rate + "% 할인" : ""), gridTitle: label + " · " + price,
          description: discounted ? "정가 " + won(product.listPrice) + (product.friend ? " · 1인 가격" : "") : product.friend ? "1인 가격" : undefined,
          iconUrl: product.imageUrl || (imageUrl && imageUrl(product.image)), onClick: function () { onSelect(product); } };
      }));
  }
  root.SF_KIOSK_UI = { defaults: defaults, categories: categories, normalize: normalize,
    productLabel: productLabel, categoryPage: categoryPage, productPage: productPage };
})(typeof window !== "undefined" ? window : globalThis);
