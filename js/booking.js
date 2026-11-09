/* 소셜팩토리 — 공간대관 신청과 일정 확인. 예약 확정은 결제 통보 후 진행합니다. */
(function () {
  "use strict";
  var pad = function (n) { return String(n).padStart(2, "0"); };
  var dateIsReal = function (s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s; };
  var addDays = function (s, n) { return new Date(Date.parse(s + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10); };
  var kstNow = function () { var d = new Date(Date.now() + 9 * 3600000); return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
  var hm = function (n) { var d = Math.floor(n / 1440), m = ((n % 1440) + 1440) % 1440; return (d === 1 ? "다음 날 " : d === -1 ? "전날 " : d ? d + "일 뒤 " : "") + pad(Math.floor(m / 60)) + ":" + pad(m % 60); };
  var overlaps = function (s, e, blocked) { return blocked.some(function (b) { return s < b.end_min && b.start_min < e; }); };
  var money = function (v) { return Math.round(v).toLocaleString("ko-KR") + "원"; };
  var dateTime = function (date, minute) { return addDays(date, Math.floor(minute / 1440)).replace(/-/g, ".") + " " + hm(minute % 1440); };
  var quote = function (pricing, room, date, start, end) {
    if (!dateIsReal(date) || !pricing.rooms || !pricing.rooms[room] || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || start % 30 || end % 30) return null;
    var hol = pricing.holidays || [], rates = pricing.rooms[room], total = 0;
    var isHol = function (day) { var dow = new Date(day + "T00:00:00Z").getUTCDay(); return dow === 0 || dow === 6 || hol.indexOf(day) !== -1; };
    for (var t = start; t < end; t += 30) {
      var day = addDays(date, Math.floor(t / 1440)), hour = (t % 1440) / 60, key;
      if (hour >= 7) key = (isHol(day) ? "hd" : "wd") + (hour < 12 ? "Early" : "Std");
      else key = isHol(addDays(day, -1)) && isHol(day) ? "hdEarly" : "wdEarly";
      if (!Number.isFinite(+rates[key]) || +rates[key] < 0) return null;
      total += +rates[key] / 2;
    }
    return Math.round(total);
  };
  var root = document.querySelector("[data-booking-app]");
  if (!root) return;
  var $ = function (s) { return root.querySelector(s); }, $$ = function (s) { return Array.prototype.slice.call(root.querySelectorAll(s)); };
  var form = $("[data-booking-form]"), fields = form.elements, cfg = window.SF_CONFIG || {};
  var pricing = window.SF_BOOKING_RATES || cfg.pricing || {};
  var roomNames = { r1: "1번룸", r2: "2번룸", r3: "3번룸", r4: "4번룸", r5: "5번룸" };
  var availability = { ready: false, loading: false, blocked: [], step: 30, serial: 0, controller: null };
  var busy = false, finished = false, submission = null;
  var initialTimePreference = null;
  var startGrid = $("[data-start-time-grid]"), timeButtons = [];
  var inlineTotal = $("[data-inline-total]");
  var submit = $("[data-submit]"), scheduleError = $("[data-schedule-error]"), submitError = $("[data-submit-error]");
  var room = function () { return (form.querySelector("[name=room]:checked") || {}).value || "r3"; };
  var capacity = function () { return +((pricing.rooms || {})[room()] || {}).max || { r1: 36, r2: 40, r3: 16, r4: 48, r5: 30 }[room()]; };
  var val = function (key) { return String(fields[key].value || "").trim(); };
  var selectedMinutes = function () { return { start: val("start_min") === "" ? NaN : +val("start_min"), end: val("end_min") === "" ? NaN : +val("end_min") }; };
  var setError = function (node, message) { node.textContent = message || ""; node.hidden = !message; };
  var syncDateBounds = function (now) { fields.date.min = now.date; fields.date.max = addDays(now.date, 365); };
  var startTimeReason = function (start, now) {
    if (!dateIsReal(val("date"))) return "날짜 선택 후";
    if (val("date") < now.date) return "지난 시간";
    if (val("date") > fields.date.max) return "이용 날짜 확인";
    if (availability.loading) return "확인 중";
    if (!availability.ready) return "일정 확인 필요";
    if (availability.open === false) return "예약 준비 중";
    if (val("date") < now.date || (val("date") === now.date && start < now.minute)) return "지난 시간";
    if (overlaps(start, start + availability.step, availability.blocked)) return "예약 마감";
    if (overlaps(start, start + 120, availability.blocked)) return "2시간 확보 불가";
    return "선택 가능";
  };
  var refreshStartOptions = function (now) {
    syncDateBounds(now);
    Array.prototype.forEach.call(fields.start_min.options, function (item) {
      if (item.value === "") return;
      var reason = startTimeReason(+item.value, now);
      item.bookingReason = reason; item.disabled = reason !== "선택 가능";
      item.textContent = hm(+item.value) + (item.disabled ? " · " + reason : "");
    });
    fields.start_min.disabled = !availability.ready || availability.loading || availability.open === false || !dateIsReal(val("date")) || val("date") < fields.date.min || val("date") > fields.date.max;
    var selected = fields.start_min.selectedOptions[0];
    if (fields.start_min.value !== "" && (!selected || selected.disabled || fields.start_min.disabled)) {
      fields.start_min.value = ""; fields.end_min.value = ""; fields.end_min.disabled = true;
      setError(scheduleError, selected && selected.bookingReason === "지난 시간" ? "선택한 시작 시간이 지났습니다. 시작·종료 시간을 다시 골라 주세요." : "선택한 시작 시간을 현재 이용할 수 없습니다. 시작·종료 시간을 다시 골라 주세요.");
    }
  };
  var syncTimeGrid = function () {
    refreshStartOptions(kstNow());
    timeButtons.forEach(function (item) {
      var reason = item.option.bookingReason;
      var disabled = busy || finished || fields.start_min.disabled || item.option.disabled || !availability.ready || availability.loading || availability.open === false;
      var selected = !disabled && fields.start_min.value === item.option.value;
      item.button.disabled = disabled;
      item.button.className = "booking-time" + (selected ? " is-selected" : "");
      item.button.setAttribute("aria-pressed", selected ? "true" : "false");
      item.button.setAttribute("aria-label", hm(+item.option.value) + " · " + (selected ? "선택됨" : reason));
      item.status.textContent = selected ? "선택됨" : reason;
    });
  };
  var renderTimeGrid = function () {
    if (!startGrid) return;
    startGrid.innerHTML = ""; timeButtons = [];
    Array.prototype.forEach.call(fields.start_min.options, function (item) {
      if (item.value === "") return;
      var button = document.createElement("button"), label = document.createElement("span"), status = document.createElement("span");
      button.type = "button"; button.value = item.value; label.className = "booking-time-label"; label.textContent = hm(+item.value); status.className = "booking-time-status";
      button.appendChild(label); button.appendChild(status);
      button.addEventListener("click", function () {
        syncTimeGrid();
        if (button.disabled || busy || finished || !availability.ready || availability.loading || availability.open === false) return;
        fields.start_min.value = item.value;
        fields.start_min.dispatchEvent(new Event("change", { bubbles: true }));
      });
      startGrid.appendChild(button); timeButtons.push({ button: button, option: item, status: status });
    });
    syncTimeGrid();
  };
  var scheduleProblem = function () {
    var s = selectedMinutes(), date = val("date"), now = kstNow();
    if(availability.open===false)return "온라인 예약을 준비 중입니다. 잠시 후 다시 확인하거나 담당자에게 문의해 주세요.";
    if (!availability.ready || availability.loading) return "이용 가능한 일정을 먼저 확인해 주세요.";
    if (!dateIsReal(date) || date < now.date) return "이용 날짜를 확인해 주세요.";
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end)) return "시작 시간과 종료 시간을 골라 주세요.";
    if (date === now.date && s.start < now.minute) return "이미 지난 시간은 신청할 수 없습니다. 시작 시간을 다시 골라 주세요.";
    if (s.start < 0 || s.start >= 1440 || s.start % availability.step || s.end % availability.step || s.end - s.start < 120 || s.end - s.start > 1440) return "최소 2시간부터 최대 24시간까지, " + availability.step + "분 단위로 선택해 주세요.";
    if (overlaps(s.start, s.end, availability.blocked)) return "선택하신 시간에 다른 신청 또는 예약이 있습니다. 다른 시간을 골라 주세요.";
    if (!Number.isInteger(+val("people")) || +val("people") < 1 || +val("people") > capacity()) return roomNames[room()] + "은 1~" + capacity() + "명까지 신청할 수 있습니다.";
    return "";
  };
  var renderSummary = function () {
    syncTimeGrid();
    var s = selectedMinutes(), validTimes = dateIsReal(val("date")) && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start;
    $("[data-summary-room]").textContent = roomNames[room()];
    $("[data-summary-people]").textContent = val("people") ? val("people") + "명" : "인원을 입력해 주세요";
    $("[data-summary-time]").textContent = validTimes ? dateTime(val("date"), s.start) + " ~ " + dateTime(val("date"), s.end) : "날짜·시간을 골라 주세요";
    $("[data-summary-duration]").textContent = validTimes ? (s.end - s.start) / 60 + "시간" : "—";
    var amount = validTimes ? quote(pricing, room(), val("date"), s.start, s.end) : null;
    $("[data-summary-amount]").textContent = amount === null ? "—" : money(amount);
    var inlineText = amount === null ? "" : (s.end - s.start) / 60 + "시간 · 예상 대관료 " + money(amount);
    if (inlineTotal.textContent !== inlineText) inlineTotal.textContent = inlineText;
    var problem = scheduleProblem();
    submit.disabled = busy || finished || !!problem;
  };
  var option = function (select, value, label, disabled) { var o = document.createElement("option"); o.value = value; o.textContent = label; o.disabled = !!disabled; select.appendChild(o); return o; };
  var buildEndTimes = function (preferred) {
    var start = +fields.start_min.value, list = fields.end_min;
    list.innerHTML = ""; option(list, "", "종료 시간을 골라 주세요");
    if (!availability.ready || availability.open === false || fields.start_min.value === "" || !fields.start_min.selectedOptions[0] || fields.start_min.selectedOptions[0].disabled) { list.disabled = true; renderSummary(); return; }
    list.disabled = false;
    for (var end = start + 120; end <= start + 1440; end += availability.step) {
      var blocked = overlaps(start, end, availability.blocked);
      option(list, end, hm(end) + " · " + (end - start) / 60 + "시간" + (blocked ? " · 예약 마감" : ""), blocked);
    }
    var wanted = preferred !== undefined ? String(preferred) : String(start + 120);
    var found = Array.prototype.find.call(list.options, function (o) { return o.value === wanted && !o.disabled; });
    list.value = found ? wanted : "";
    renderSummary();
  };
  var buildTimes = function (preferredStart, preferredEnd) {
    var list = fields.start_min, now = kstNow(); syncDateBounds(now); list.innerHTML = "";
    option(list, "", availability.ready ? "시작 시간을 골라 주세요" : "일정 확인 후 선택할 수 있습니다");
    list.disabled = !availability.ready || availability.open === false;
    for (var start = 0; start < 1440; start += availability.step) {
      var reason = startTimeReason(start, now), blocked = reason !== "선택 가능";
      var item = option(list, start, hm(start) + (blocked ? " · " + reason : ""), blocked);
      item.bookingReason = reason;
    }
    if (preferredStart !== undefined && Array.prototype.some.call(list.options, function (o) { return o.value === String(preferredStart) && !o.disabled; })) list.value = String(preferredStart);
    renderTimeGrid();
    buildEndTimes(preferredEnd);
  };
  var loadAvailability = async function () {
    var serial = ++availability.serial, date = val("date"), selectedRoom = room(), s = selectedMinutes();
    if (initialTimePreference && (initialTimePreference.room !== selectedRoom || initialTimePreference.date !== date)) initialTimePreference = null;
    if (availability.controller) availability.controller.abort();
    availability.ready = false; availability.loading = false; availability.blocked = [];
    setError(scheduleError, ""); setError(submitError, "");
    $("[data-blocked-times]").textContent = ""; $("[data-retry-availability]").hidden = true;
    buildTimes();
    if (!dateIsReal(date) || date < fields.date.min || date > fields.date.max) { $("[data-availability-message]").textContent = date ? "오늘부터 1년 이내의 이용 날짜를 골라 주세요." : "날짜를 선택하면 신청 가능한 시간을 확인합니다."; $("[data-availability-panel]").setAttribute("aria-busy", "false"); return; }
    availability.loading = true;
    syncTimeGrid();
    $("[data-availability-panel]").setAttribute("aria-busy", "true"); $("[data-availability-message]").textContent = "신청 가능한 시간을 확인하고 있습니다…";
    var controller = new AbortController(); availability.controller = controller;
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var response = await fetch("/api/booking/availability?room=" + encodeURIComponent(selectedRoom) + "&date=" + encodeURIComponent(date), { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      var data = await response.json();
      if (serial !== availability.serial) return;
      if (!response.ok || !data.ok || !Array.isArray(data.blocked)) { var failure = new Error("availability"); failure.bookingMessage = data.message || "일정을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요."; throw failure; }
      availability.blocked = data.blocked.filter(function (b) { return Number.isFinite(+b.start_min) && Number.isFinite(+b.end_min) && +b.end_min > +b.start_min; }).map(function (b) { return { start_min: +b.start_min, end_min: +b.end_min }; });
      availability.step = data.step_minutes === 60 ? 60 : 30;
      $("[data-time-step]").textContent = "최소 2시간 · " + (availability.step === 60 ? "1시간" : "30분") + " 단위 · 1회 최대 24시간. 준비와 정리 시간까지 포함해 선택해 주세요. 모든 시간은 한국 시간 기준입니다.";
      availability.ready = true; availability.loading = false; availability.open = data.booking_open !== false;
      $("[data-availability-message]").textContent = (data.external && data.external.message) || data.message || "신청 가능한 시간입니다. 외부 예약을 포함한 최종 일정은 운영자가 확인합니다.";
      var blockedNode = $("[data-blocked-times]");
      availability.blocked.forEach(function (b) { if (b.end_min <= 0 || b.start_min >= 2880) return; var tag = document.createElement("span"); tag.textContent = hm(Math.max(0, b.start_min)) + "–" + hm(Math.min(2880, b.end_min)) + " 신청 불가"; blockedNode.appendChild(tag); });
      if (initialTimePreference && initialTimePreference.room === room() && initialTimePreference.date === val("date")) {
        var preference = initialTimePreference; initialTimePreference = null;
        var validPreference = Number.isInteger(preference.start) && Number.isInteger(preference.end)
          && preference.start >= 0 && preference.start < 1440 && preference.start % availability.step === 0 && preference.end % availability.step === 0
          && preference.end - preference.start >= 120 && preference.end - preference.start <= 1440;
        if (validPreference) buildTimes(preference.start, preference.end);
        if (!validPreference || val("start_min") !== String(preference.start) || val("end_min") !== String(preference.end)) {
          buildTimes();
          setError(scheduleError, "요금 계산기에서 고른 시간은 현재 예약할 수 없거나 이용 기준에 맞지 않습니다. 시작·종료 시간을 다시 선택해 주세요.");
        }
      } else buildTimes(Number.isFinite(s.start) ? s.start : undefined, Number.isFinite(s.end) ? s.end : undefined);
      if (+val("people") > capacity() && scheduleError.hidden) setError(scheduleError, roomNames[room()] + "은 최대 " + capacity() + "명입니다. 인원을 확인해 주세요.");
    } catch (error) {
      if (serial !== availability.serial) return;
      availability.loading = false; availability.ready = false;
      $("[data-availability-message]").textContent = error.name === "AbortError" ? "일정 확인이 지연되고 있습니다. 다시 확인하거나 문의해 주세요." : error.bookingMessage || "일정을 확인할 수 없습니다. 잠시 후 다시 확인하거나 문의해 주세요.";
      $("[data-retry-availability]").hidden = false;
      buildTimes();
    } finally { clearTimeout(timer); if (serial === availability.serial) { availability.loading = false; $("[data-availability-panel]").setAttribute("aria-busy", "false"); renderSummary(); } }
  };
  var syncRoom = function () {
    $("[data-selected-room]").textContent = roomNames[room()];
    $("[data-selected-capacity]").textContent = "최대 " + capacity() + "명";
    fields.people.max = capacity(); $("[data-capacity-note]").textContent = "선택한 방 최대 " + capacity() + "명 · 인원 추가요금 없음";
    if (+val("people") > capacity()) setError(scheduleError, roomNames[room()] + "은 최대 " + capacity() + "명입니다. 인원을 확인해 주세요.");
    loadAvailability();
  };
  var requestId = function () { return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : "booking-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 15); };
  var requestPayload = function () {
    var s = selectedMinutes();
    return { room: room(), date: val("date"), start_min: s.start, end_min: s.end, people: +val("people"), name: val("name"), phone: val("phone"), company: val("company"), email: val("email"), purpose: val("purpose"), purpose_detail: val("purpose_detail"), requests: val("requests"), consent: fields.consent.checked && fields.conditions.checked, website: val("website") };
  };
  var showSuccess = function (data, payload) {
    finished = true; form.hidden = true;
    var success = $("[data-booking-success]"); success.hidden = false;
    $("[data-receipt]").textContent = "접수번호 " + data.code;
    var summary = $("[data-success-summary]"); summary.textContent = "";
    var automatic = !!data.status_url;
    var rows = [["공간", roomNames[payload.room]], ["일시", dateTime(payload.date, payload.start_min) + " ~ " + dateTime(payload.date, payload.end_min)], ["인원", payload.people + "명"], ["예상 대관료", Number.isFinite(+data.amount) ? money(+data.amount) + " · 추가 요청 별도" : "확인 후 안내"], ["접수 상태", automatic ? "스페이스클라우드 일정 확인 중" : "운영자 확인 대기"]];
    rows.forEach(function (row) { var wrap = document.createElement("div"), term = document.createElement("dt"), detail = document.createElement("dd"); term.textContent = row[0]; detail.textContent = row[1]; wrap.appendChild(term); wrap.appendChild(detail); summary.appendChild(wrap); });
    $("[data-success-message]").textContent = automatic ? "신청한 시간을 스페이스클라우드에서도 확보한 뒤 결제를 안내합니다. 아래에서 진행 상태를 확인하고 페이앱 결제까지 완료해 주세요. 결제 전에는 예약이 확정되지 않습니다." : "아직 예약이 확정된 상태는 아닙니다. 신청하신 일정과 요청사항을 확인한 뒤 연락드리며, 페이앱 결제 확인 후 최종 확정됩니다.";
    var statusLink = $("[data-booking-status-link]"); statusLink.hidden = true;
    if (typeof data.status_url === "string" && /^\/booking-status\?/.test(data.status_url) && !/[\r\n]/.test(data.status_url)) { statusLink.href = data.status_url; statusLink.hidden = false; }
    success.focus(); success.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  form.addEventListener("submit", async function (event) {
    event.preventDefault(); if (busy || finished) return;
    setError(submitError, ""); setError(scheduleError, "");
    if (!form.reportValidity()) return;
    var problem = scheduleProblem();
    if (problem) { setError(scheduleError, problem); fields.start_min.focus(); return; }
    if (!/^[0-9+()\s-]{9,20}$/.test(val("phone")) || val("phone").replace(/\D/g, "").length < 9) { setError(submitError, "연락받으실 휴대전화 번호를 확인해 주세요."); fields.phone.focus(); return; }
    var payload = requestPayload(), fingerprint = JSON.stringify(payload);
    if (!submission || submission.fingerprint !== fingerprint) submission = { fingerprint: fingerprint, id: requestId() };
    payload.submissionId = submission.id;
    busy = true; $$("fieldset").forEach(function (fieldset) { fieldset.disabled = true; }); syncTimeGrid(); submit.disabled = true; submit.textContent = "예약 신청을 접수하고 있습니다…"; form.setAttribute("aria-busy", "true");
    var controller = new AbortController(), timer = setTimeout(function () { controller.abort(); }, 20000);
    try {
      var response = await fetch("/api/booking/requests", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
      var data = await response.json();
      if (!response.ok || !data.ok || !data.code) {
        if (response.status === 409) { await loadAvailability(); setError(submitError, data.message || "선택하신 시간이 먼저 신청되었습니다. 다른 시간을 골라 주세요."); }
        else setError(submitError, data.message || (response.status === 429 ? "신청이 많아 잠시 접수를 제한하고 있습니다. 잠시 후 다시 시도해 주세요." : "신청을 접수하지 못했습니다. 입력 내용을 확인하거나 잠시 후 다시 시도해 주세요."));
        if (data.field && fields[data.field] && typeof fields[data.field].focus === "function") fields[data.field].focus();
        return;
      }
      showSuccess(data, payload);
    } catch (error) { setError(submitError, error.name === "AbortError" ? "응답이 지연되고 있습니다. 접수 결과 확인을 위해 같은 내용으로 다시 시도해 주세요." : "서버 연결을 확인하지 못했습니다. 같은 내용으로 다시 시도하거나 문의해 주세요."); }
    finally { clearTimeout(timer); busy = false; $$("fieldset").forEach(function (fieldset) { fieldset.disabled = false; }); submit.textContent = "예약 신청하기 →"; form.setAttribute("aria-busy", "false"); renderSummary(); }
  });
  var clearSelectedTimes = function () { fields.start_min.value = ""; fields.end_min.value = ""; };
  $$("[name=room]").forEach(function (input) { input.addEventListener("change", function () { initialTimePreference = null; clearSelectedTimes(); syncRoom(); }); });
  fields.date.addEventListener("change", function () { initialTimePreference = null; clearSelectedTimes(); loadAvailability(); });
  fields.start_min.addEventListener("change", function () { setError(scheduleError, ""); refreshStartOptions(kstNow()); buildEndTimes(); });
  fields.end_min.addEventListener("change", function () { setError(scheduleError, scheduleProblem()); renderSummary(); });
  fields.people.addEventListener("input", function () { var people = +val("people"); setError(scheduleError, people > capacity() ? roomNames[room()] + "은 최대 " + capacity() + "명입니다." : ""); renderSummary(); });
  fields.purpose.addEventListener("change", function () { var other = val("purpose") === "other"; fields.purpose_detail.required = other; $("[data-purpose-detail-note]").textContent = other ? "기타 선택 시 필수" : "선택"; });
  $("[data-retry-availability]").addEventListener("click", loadAvailability);
  var params = new URLSearchParams(window.location.search), initialRoom = params.get("room");
  var initialRoomInput = $$("[name=room]").find(function (input) { return input.value === initialRoom; });
  if (initialRoomInput) {
    initialRoomInput.checked = true;
    $("[data-room-picker]").open = false;
  }
  syncDateBounds(kstNow());
  var initialDate = params.get("date"); if (dateIsReal(initialDate) && initialDate >= fields.date.min && initialDate <= fields.date.max) fields.date.value = initialDate;
  var initialPeople = params.get("people");
  if (/^\d{1,9}$/.test(initialPeople || "") && +initialPeople > 0) fields.people.value = String(+initialPeople);
  var initialPurpose = params.get("purpose");
  if (Array.prototype.some.call(fields.purpose.options, function (item) { return item.value === initialPurpose && item.value !== ""; })) fields.purpose.value = initialPurpose;
  ["purpose_detail", "requests"].forEach(function (key) {
    var value = params.get(key), limit = fields[key].maxLength > 0 ? fields[key].maxLength : key === "purpose_detail" ? 500 : 2000;
    if (value !== null) fields[key].value = value.slice(0, limit);
  });
  fields.purpose_detail.required = val("purpose") === "other";
  $("[data-purpose-detail-note]").textContent = fields.purpose_detail.required ? "기타 선택 시 필수" : "선택";
  if (params.has("start_min") || params.has("end_min")) {
    var urlMinute = function (key) { var value = params.get(key); return /^\d{1,4}$/.test(value || "") ? +value : NaN; };
    initialTimePreference = { room: room(), date: val("date"), start: urlMinute("start_min"), end: urlMinute("end_min") };
  }
  syncRoom();
  var refreshClock = function () { if (!finished) renderSummary(); };
  if (typeof window.addEventListener === "function") { window.addEventListener("focus", refreshClock); window.addEventListener("pageshow", refreshClock); }
  if (typeof document.addEventListener === "function") document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshClock(); });
  if (typeof window.setInterval === "function") window.setInterval(function () { if (!document.hidden) refreshClock(); }, 60000);
})();
