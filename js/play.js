/* 소셜팩토리 모임 도구 · 게임 (/play)
   서버 없이 이 브라우저에서만 움직입니다. 적은 이름과 항목은 이 기기에만 남습니다.
   도구를 열면 주소 끝에 #timer 처럼 붙어서, 그 주소를 보내면 바로 그 도구가 열립니다. */
(function () {
  "use strict";
  var D = window.SF_PLAY_DATA, stage = document.querySelector("[data-stage]");
  if (!D || !stage) return;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var won = function (n) { return Math.round(n).toLocaleString("ko-KR") + "원"; };
  function store(key, val) { try { if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null"); localStorage.setItem(key, JSON.stringify(val)); } catch (e) { return null; } return val; }
  function rnd(n) { var a = new Uint32Array(1); (window.crypto || window.msCrypto).getRandomValues(a); return a[0] % n; }
  function shuffle(list) { var a = list.slice(); for (var i = a.length - 1; i > 0; i--) { var j = rnd(i + 1), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function pick(list) { return list[rnd(list.length)]; }
  function kstHour() { return new Date(Date.now() + 9 * 3600e3).getUTCHours(); }
  var QUIET = kstHour() >= 22 || kstHour() < 7;
  var toastT;
  function toast(msg) {
    var t = $(".pl-toast");
    if (!t) { t = document.createElement("div"); t.className = "pl-toast"; t.setAttribute("role", "status"); t.setAttribute("aria-live", "polite"); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function copy(text, done) {
    var ok = function () { toast(done || "복사했습니다."); };
    var fallback = function () { var ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); ok(); } catch (e) { window.prompt("아래 내용을 복사해 주세요.", text); } ta.remove(); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
  }
  function lines(text, max) {
    return String(text || "").split(/[\n,]+/).map(function (s) { return s.trim().slice(0, 30); }).filter(Boolean).slice(0, max || 60);
  }

  /* ---------- 소리 (22시 ~ 7시에는 처음부터 꺼 둡니다) ---------- */
  var sound = store("sf-play-sound");
  if (sound === null || QUIET) sound = !QUIET;
  var actx = null;
  /* 휴대폰 브라우저는 사용자가 누른 순간에만 소리를 켤 수 있어서, 시작 버튼을 누를 때 미리 깨워 둡니다 */
  function unlock() { if (!sound) return; try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === "suspended") actx.resume(); } catch (e) { /* 무시 */ } }
  function beep(times, high) {
    if (navigator.vibrate) try { navigator.vibrate(times > 1 ? [180, 120, 180, 120, 180] : 120); } catch (e) { /* 무시 */ }
    if (!sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      for (var i = 0; i < (times || 1); i++) {
        var o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + i * 0.32;
        o.type = "sine"; o.frequency.value = high ? 1046 : 784; o.connect(g); g.connect(actx.destination);
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
        o.start(t); o.stop(t + 0.26);
      }
    } catch (e) { /* 무시 */ }
  }

  /* ---------- 도구 목록 ---------- */
  var TOOLS = {
    timer: { name: "타이머", run: toolTimer },
    teams: { name: "팀 나누기", run: toolTeams },
    order: { name: "순서 · 한 명 뽑기", run: toolOrder },
    wheel: { name: "돌림판", run: toolWheel },
    ladder: { name: "사다리 타기", run: toolLadder },
    split: { name: "회비 정산", run: toolSplit },
    cards: { name: "대화 카드", run: toolCards },
    balance: { name: "밸런스 게임", run: toolBalance },
    bingo: { name: "사람 빙고", run: toolBingo },
    liar: { name: "라이어 게임", run: toolLiar },
    chosung: { name: "초성 퀴즈", run: toolChosung },
    speed: { name: "스피드 퀴즈", run: toolSpeed }
  };
  var body = $("[data-stage-body]", stage), titleEl = $("[data-stage-title]", stage);
  var current = "", cleanup = null, lastFocus = null, wake = null, keyHandler = null;
  function onKey(fn) { keyHandler = fn; }
  function open(id, opt) {
    if (!TOOLS[id]) return;
    if (cleanup) { try { cleanup(); } catch (e) { /* 무시 */ } cleanup = null; }
    keyHandler = null;
    if (!current) lastFocus = document.activeElement;
    current = id;
    titleEl.textContent = TOOLS[id].name;
    stage.setAttribute("data-tool", id);
    body.innerHTML = "";
    $("[data-qr-pop]", stage).hidden = true;
    stage.hidden = false; document.documentElement.classList.add("pl-open");
    /* 도구마다 새 상자를 만들어 넘깁니다. 같은 상자를 다시 쓰면 앞 도구의 이벤트가 남아 서로 엉킵니다 */
    var host = document.createElement("div"); host.className = "pl-host"; body.appendChild(host);
    cleanup = TOOLS[id].run(host, opt || {}) || null;
    body.scrollTop = 0;
    var f = $("[data-close]", stage); if (f) f.focus({ preventScroll: true });
    if (navigator.wakeLock && !wake) navigator.wakeLock.request("screen").then(function (w) { wake = w; }, function () {});
    document.title = TOOLS[id].name + " · 모임 도구 | 소셜팩토리 건대";
  }
  var baseTitle = document.title;
  function close() {
    if (!current) return;
    if (cleanup) { try { cleanup(); } catch (e) { /* 무시 */ } cleanup = null; }
    keyHandler = null; current = "";
    stage.hidden = true; document.documentElement.classList.remove("pl-open"); body.innerHTML = "";
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    if (wake) { wake.release().catch(function () {}); wake = null; }
    document.title = baseTitle;
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }
  /* #cards:book 처럼 쓰면 대화 카드의 묶음까지 골라서 엽니다 */
  function parseHash(h) { var p = String(h || "").replace(/^#/, "").split(":"); return { id: p[0], deck: p[1] || "" }; }
  function route() {
    var h = parseHash(location.hash);
    if (TOOLS[h.id]) open(h.id, { deck: h.deck }); else close();
  }
  window.addEventListener("hashchange", route);
  $("[data-close]", stage).addEventListener("click", function () {
    if (history.state && history.state.plOpened) history.back();
    else { history.replaceState(null, "", location.pathname + location.search); close(); }
  });
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[href^='#']");
    if (!a) return;
    var h = parseHash(a.getAttribute("href"));
    if (!TOOLS[h.id]) return;
    e.preventDefault();
    if (current === h.id && !h.deck) return;
    history.pushState({ plOpened: true }, "", a.getAttribute("href"));
    open(h.id, { deck: h.deck });
  });
  document.addEventListener("keydown", function (e) {
    if (!current) return;
    if (e.key === "Escape" && !document.fullscreenElement) { e.preventDefault(); $("[data-close]", stage).click(); return; }
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (keyHandler) keyHandler(e);
  });
  /* 크게 보기 · 소리 · QR */
  var fullBtn = $("[data-full]", stage);
  if (!stage.requestFullscreen) fullBtn.hidden = true;
  fullBtn.addEventListener("click", function () {
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    else stage.requestFullscreen().catch(function () { toast("이 브라우저는 전체 화면을 지원하지 않습니다."); });
  });
  document.addEventListener("fullscreenchange", function () { fullBtn.textContent = document.fullscreenElement ? "작게 보기" : "크게 보기"; stage.classList.toggle("is-full", !!document.fullscreenElement); });
  var soundBtn = $("[data-sound]", stage);
  var paintSound = function () { soundBtn.setAttribute("aria-pressed", sound ? "true" : "false"); soundBtn.textContent = sound ? "소리 켬" : "소리 끔"; };
  paintSound();
  soundBtn.addEventListener("click", function () { sound = !sound; store("sf-play-sound", sound); paintSound(); if (sound) beep(1); });
  var qrPop = $("[data-qr-pop]", stage);
  $("[data-qr]", stage).addEventListener("click", function () {
    if (!qrPop.hidden) { qrPop.hidden = true; return; }
    var url = location.origin + "/play#" + current;
    var box = $("[data-qr-box]", qrPop);
    if (typeof window.qrcode === "function") { var q = window.qrcode(0, "M"); q.addData(url); q.make(); box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }
    else box.textContent = url;
    $("[data-qr-url]", qrPop).textContent = url.replace(/^https?:\/\//, "");
    qrPop.hidden = false;
  });
  $("[data-qr-close]", qrPop).addEventListener("click", function () { qrPop.hidden = true; });
  $("[data-qr-copy]", qrPop).addEventListener("click", function () { copy(location.origin + "/play#" + current, "링크를 복사했습니다."); });

  /* 공통 이름 목록 (팀 나누기 · 순서 뽑기 · 사다리가 함께 씁니다) */
  var NAMES_KEY = "sf-play-names";
  function namesField(id) {
    return '<div class="pl-field"><label for="' + id + '">참여자 이름 <span class="pl-hint-in">한 줄에 한 명, 또는 쉼표로 구분</span></label><textarea id="' + id + '" rows="5" placeholder="예) 민지, 준호, 서연, 도윤">' + esc(store(NAMES_KEY) || "") + "</textarea></div>";
  }

  /* =========================================================
     타이머
     ========================================================= */
  function toolTimer(el) {
    var total = store("sf-play-timer") || 300000, left = total, running = false, endAt = 0, iv = 0, R = 54, C = 2 * Math.PI * R;
    el.innerHTML = '<div class="pl-timer"><div class="pl-ring" data-ring><svg viewBox="0 0 120 120" aria-hidden="true"><circle class="bg" cx="60" cy="60" r="54"/><circle class="fg" data-fg cx="60" cy="60" r="54" stroke-dasharray="' + C + '" stroke-dashoffset="0"/></svg><div class="pl-digits" data-digits role="timer" aria-live="off"></div></div>'
      + '<div class="pl-chips" role="group" aria-label="시간 고르기">' + [1, 3, 5, 10, 15, 25, 50].map(function (m) { return '<button type="button" data-min="' + m + '">' + m + "분</button>"; }).join("") + "</div>"
      + '<div class="pl-chips small" role="group" aria-label="시간 조절"><button type="button" data-add="-60">−1분</button><button type="button" data-add="-10">−10초</button><button type="button" data-add="10">+10초</button><button type="button" data-add="60">+1분</button></div>'
      + '<div class="pl-ctrl"><button type="button" class="btn btn-primary btn-lg" data-go>시작</button><button type="button" class="btn btn-outline btn-lg" data-reset>처음으로</button></div>'
      + '<p class="pl-hint">스페이스 키로 시작 · 멈춤. 1분 남으면 숫자가 파랗게 바뀌고, 끝나면 화면이 깜빡이며 알려 줍니다.</p></div>';
    var digits = $("[data-digits]", el), fg = $("[data-fg]", el), ring = $("[data-ring]", el), go = $("[data-go]", el);
    function fmt(ms) { var s = Math.ceil(ms / 1000), m = Math.floor(s / 60); return (m < 10 ? "0" : "") + m + ":" + ("0" + (s % 60)).slice(-2); }
    function draw() {
      digits.textContent = fmt(left);
      fg.setAttribute("stroke-dashoffset", String(C * (1 - (total ? left / total : 0))));
      ring.classList.toggle("warn", running && left <= 60000 && total > 60000);
      go.textContent = running ? "멈춤" : (left < total && left > 0 ? "이어서" : "시작");
    }
    function stop() { running = false; clearInterval(iv); draw(); }
    function tick() {
      left = Math.max(0, endAt - Date.now());
      if (left <= 0) { stop(); ring.classList.add("done"); beep(3, true); setTimeout(function () { ring.classList.remove("done"); }, 4200); left = 0; draw(); return; }
      draw();
    }
    function toggle() {
      if (running) { left = Math.max(0, endAt - Date.now()); stop(); return; }
      if (left <= 0) left = total;
      running = true; endAt = Date.now() + left; ring.classList.remove("done"); clearInterval(iv); iv = setInterval(tick, 200); draw();
      unlock();
    }
    function set(ms) { total = Math.max(10000, Math.min(ms, 180 * 60000)); left = total; store("sf-play-timer", total); stop(); }
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-min")) set(+b.getAttribute("data-min") * 60000);
      else if (b.hasAttribute("data-add")) {
        var d = +b.getAttribute("data-add") * 1000;
        if (running) { endAt = Math.max(Date.now() + 1000, endAt + d); total = Math.max(total, endAt - Date.now()); tick(); }
        else { left = Math.max(10000, left + d); if (left > total) total = left; store("sf-play-timer", total); draw(); }
      } else if (b.hasAttribute("data-go")) toggle();
      else if (b.hasAttribute("data-reset")) { left = total; stop(); ring.classList.remove("done"); }
    });
    onKey(function (e) { if (e.key === " " || e.code === "Space") { e.preventDefault(); toggle(); } });
    draw();
    return function () { clearInterval(iv); };
  }

  /* =========================================================
     팀 나누기
     ========================================================= */
  function toolTeams(el) {
    var mode = store("sf-play-teams-mode") || "count", n = store("sf-play-teams-n") || 2, last = null;
    el.innerHTML = '<div class="pl-split">' + '<div class="pl-panel">' + namesField("pl-names")
      + '<div class="pl-field"><label for="pl-people">이름 없이 인원만 <span class="pl-hint-in">이름을 비워 두면 번호로 나눕니다</span></label><input id="pl-people" type="number" min="2" max="60" inputmode="numeric" value="' + (store("sf-play-people") || 8) + '"></div>'
      + '<div class="pl-field"><span class="pl-label">나누는 방법</span><div class="pl-seg" role="radiogroup"><label><input type="radio" name="mode" value="count"' + (mode === "count" ? " checked" : "") + '><span>팀 수로</span></label><label><input type="radio" name="mode" value="size"' + (mode === "size" ? " checked" : "") + '><span>팀당 인원으로</span></label></div></div>'
      + '<div class="pl-field"><label for="pl-n" data-n-label>' + (mode === "count" ? "몇 팀으로" : "한 팀에 몇 명") + '</label><div class="pl-stepper"><button type="button" data-step="-1" aria-label="줄이기">−</button><input id="pl-n" type="number" min="1" max="30" inputmode="numeric" value="' + n + '"><button type="button" data-step="1" aria-label="늘리기">+</button></div></div>'
      + '<div class="pl-ctrl left"><button type="button" class="btn btn-primary btn-lg" data-make>팀 나누기</button></div></div>'
      + '<div class="pl-result" data-result><p class="pl-empty">이름을 적고 \'팀 나누기\'를 누르면 여기에 팀이 나옵니다.</p></div></div>';
    var res = $("[data-result]", el);
    function people() {
      var names = lines($("#pl-names", el).value);
      if (names.length >= 2) return names;
      var c = Math.max(2, Math.min(60, parseInt($("#pl-people", el).value, 10) || 0));
      var out = []; for (var i = 1; i <= c; i++) out.push(i + "번"); return out;
    }
    function make() {
      var list = shuffle(people()), m = $("input[name=mode]:checked", el).value, k = Math.max(1, parseInt($("#pl-n", el).value, 10) || 1);
      store(NAMES_KEY, $("#pl-names", el).value); store("sf-play-teams-mode", m); store("sf-play-teams-n", k); store("sf-play-people", $("#pl-people", el).value);
      var teams = m === "count" ? Math.min(k, list.length) : Math.max(1, Math.ceil(list.length / k));
      var out = []; for (var t = 0; t < teams; t++) out.push([]);
      list.forEach(function (p, i) { out[i % teams].push(p); });
      last = out;
      res.innerHTML = '<div class="pl-teams">' + out.map(function (team, i) {
        return '<div class="pl-team" style="--d:' + (i * 70) + 'ms"><h3>' + (i + 1) + "팀 <small>" + team.length + "명</small></h3><ul>" + team.map(function (p, j) { return "<li" + (j === 0 ? ' class="lead"' : "") + ">" + esc(p) + "</li>"; }).join("") + "</ul></div>";
      }).join("") + '</div><div class="pl-ctrl"><button type="button" class="btn btn-primary" data-make>다시 섞기</button><button type="button" class="btn btn-outline" data-copy>결과 복사</button></div><p class="pl-hint">각 팀의 첫 번째 사람을 조장으로 정해도 좋습니다.</p>';
    }
    el.addEventListener("change", function (e) { if (e.target.name === "mode") $("[data-n-label]", el).textContent = e.target.value === "count" ? "몇 팀으로" : "한 팀에 몇 명"; });
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-step")) { var i = $("#pl-n", el); i.value = Math.max(1, Math.min(30, (parseInt(i.value, 10) || 1) + +b.getAttribute("data-step"))); }
      else if (b.hasAttribute("data-make")) make();
      else if (b.hasAttribute("data-copy") && last) copy(last.map(function (t, i) { return (i + 1) + "팀: " + t.join(", "); }).join("\n"), "팀 나눈 결과를 복사했습니다.");
    });
  }

  /* =========================================================
     순서 · 한 명 뽑기
     ========================================================= */
  function toolOrder(el) {
    var picked = [], spin = 0;
    el.innerHTML = '<div class="pl-split"><div class="pl-panel">' + namesField("pl-names")
      + '<label class="pl-check"><input type="checkbox" data-skip checked> 한 명 뽑기에서 이미 뽑힌 사람은 빼기</label>'
      + '<div class="pl-ctrl left"><button type="button" class="btn btn-primary btn-lg" data-one>한 명 뽑기</button><button type="button" class="btn btn-outline btn-lg" data-all>전체 순서 정하기</button></div></div>'
      + '<div class="pl-result" data-result><p class="pl-empty">발표 순서, 오늘의 당번, 첫 질문을 받을 사람을 정할 때 써 보세요.</p></div></div>';
    var res = $("[data-result]", el);
    var names = function () { var v = $("#pl-names", el).value; store(NAMES_KEY, v); return lines(v); };
    function one() {
      var all = names();
      if (all.length < 2) { toast("이름을 두 명 이상 적어 주세요."); return; }
      var pool = $("[data-skip]", el).checked ? all.filter(function (n) { return picked.indexOf(n) < 0; }) : all;
      if (!pool.length) { picked = []; pool = all; toast("모두 한 번씩 뽑혀서 처음부터 다시 뽑습니다."); }
      var win = pick(pool), t0 = Date.now(), dur = 1400;
      res.innerHTML = '<div class="pl-big" data-big aria-live="polite"></div><p class="pl-sub" data-sub></p>';
      var big = $("[data-big]", res);
      clearInterval(spin);
      spin = setInterval(function () {
        if (Date.now() - t0 >= dur) {
          clearInterval(spin); big.textContent = win; big.classList.add("pop"); picked.push(win); beep(1, true);
          $("[data-sub]", res).textContent = picked.length > 1 ? "지금까지 뽑힌 사람: " + picked.join(", ") : "";
          return;
        }
        big.textContent = pick(pool);
      }, 70);
    }
    function all() {
      var list = names();
      if (list.length < 2) { toast("이름을 두 명 이상 적어 주세요."); return; }
      var o = shuffle(list);
      res.innerHTML = '<ol class="pl-order">' + o.map(function (n, i) { return '<li style="--d:' + (i * 60) + 'ms"><b>' + (i + 1) + "</b>" + esc(n) + "</li>"; }).join("") + '</ol><div class="pl-ctrl"><button type="button" class="btn btn-outline" data-copy>순서 복사</button></div>';
      res.setAttribute("data-order", o.join("\n"));
    }
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-one")) one();
      else if (b.hasAttribute("data-all")) all();
      else if (b.hasAttribute("data-copy")) copy(res.getAttribute("data-order").split("\n").map(function (n, i) { return (i + 1) + ". " + n; }).join("\n"), "순서를 복사했습니다.");
    });
    return function () { clearInterval(spin); };
  }

  /* =========================================================
     돌림판
     ========================================================= */
  function toolWheel(el) {
    var COLORS = [["#2855E8", "#fff"], ["#18233A", "#fff"], ["#DCE7FF", "#18233A"], ["#5B7BEF", "#fff"], ["#2E3A55", "#fff"], ["#EEF3FF", "#18233A"]];
    var saved = store("sf-play-wheel"), items = saved && saved.length ? saved : D.wheel[Object.keys(D.wheel)[0]].slice(), rot = 0, spinning = false, raf = 0;
    el.innerHTML = '<div class="pl-split wheel"><div class="pl-wheel-wrap"><div class="pl-wheel"><canvas data-cv aria-label="돌림판" role="img"></canvas><span class="pl-pin" aria-hidden="true"></span><button type="button" class="pl-hub" data-spin>돌리기</button></div><p class="pl-big small" data-out aria-live="polite"></p></div>'
      + '<div class="pl-panel"><div class="pl-field"><label for="pl-items">항목 <span class="pl-hint-in">한 줄에 하나, 2~12개</span></label><textarea id="pl-items" rows="7">' + esc(items.join("\n")) + "</textarea></div>"
      + '<div class="pl-chips small left" role="group" aria-label="예시 불러오기">' + Object.keys(D.wheel).map(function (k) { return '<button type="button" data-preset="' + esc(k) + '">' + esc(k) + "</button>"; }).join("") + "</div>"
      + '<label class="pl-check"><input type="checkbox" data-remove> 나온 항목은 다음 판에서 빼기</label>'
      + '<div class="pl-ctrl left"><button type="button" class="btn btn-primary btn-lg" data-spin>돌리기</button></div></div></div>';
    var cv = $("[data-cv]", el), ctx2 = cv.getContext("2d"), out = $("[data-out]", el), ta = $("#pl-items", el);
    function size() {
      var box = cv.parentNode.getBoundingClientRect().width || 320, dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(box * dpr); cv.height = Math.round(box * dpr); cv.style.width = box + "px"; cv.style.height = box + "px";
      draw();
    }
    function draw() {
      var w = cv.width, r = w / 2, n = items.length || 1, seg = 2 * Math.PI / n;
      ctx2.clearRect(0, 0, w, w);
      for (var i = 0; i < n; i++) {
        var a0 = rot + i * seg - Math.PI / 2, c = COLORS[i % COLORS.length];
        if (n % COLORS.length === 1 && i === n - 1) c = COLORS[1];
        ctx2.beginPath(); ctx2.moveTo(r, r); ctx2.arc(r, r, r - 2, a0, a0 + seg); ctx2.closePath(); ctx2.fillStyle = c[0]; ctx2.fill();
        ctx2.strokeStyle = "#fff"; ctx2.lineWidth = Math.max(2, w / 220); ctx2.stroke();
        ctx2.save(); ctx2.translate(r, r); ctx2.rotate(a0 + seg / 2); ctx2.fillStyle = c[1];
        var fs = Math.max(11 * (cv.width / (parseFloat(cv.style.width) || cv.width)), Math.min(w / 16, (r * 0.62) / Math.max(3, Math.min(12, (items[i] || "").length))));
        ctx2.font = "700 " + fs + "px Pretendard Variable, Pretendard, system-ui, sans-serif"; ctx2.textAlign = "right"; ctx2.textBaseline = "middle";
        var label = items[i] || ""; if (label.length > 12) label = label.slice(0, 11) + "…";
        ctx2.fillText(label, r - w * 0.06, 0); ctx2.restore();
      }
    }
    function read() { var v = lines(ta.value, 12); if (v.length >= 2) { items = v; store("sf-play-wheel", items); } return v.length >= 2; }
    function spin() {
      if (spinning) return;
      if (!read()) { toast("항목을 두 개 이상 적어 주세요."); return; }
      draw();
      var n = items.length, seg = 2 * Math.PI / n, win = rnd(n), off = seg * (0.15 + rnd(70) / 100);
      var want = ((-(win * seg + off)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI), cur = (rot % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      var delta = want - cur; if (delta < 0) delta += 2 * Math.PI;
      var from = rot, to = rot + delta + 2 * Math.PI * 6, t0 = performance.now(), dur = 4200;
      spinning = true; out.textContent = ""; out.classList.remove("pop");
      var step = function (now) {
        var p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 4);
        rot = from + (to - from) * e; draw();
        if (p < 1) { raf = requestAnimationFrame(step); return; }
        spinning = false; out.textContent = items[win]; out.classList.add("pop"); beep(2, true);
        if ($("[data-remove]", el).checked && items.length > 2) { var left = items.slice(); left.splice(win, 1); setTimeout(function () { ta.value = left.join("\n"); read(); draw(); }, 1500); }
      };
      raf = requestAnimationFrame(step);
    }
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-spin")) spin();
      else if (b.hasAttribute("data-preset")) { ta.value = D.wheel[b.getAttribute("data-preset")].join("\n"); read(); out.textContent = ""; draw(); }
    });
    ta.addEventListener("input", function () { if (read()) draw(); });
    onKey(function (e) { if (e.key === " " || e.key === "Enter") { e.preventDefault(); spin(); } });
    window.addEventListener("resize", size); size();
    return function () { cancelAnimationFrame(raf); window.removeEventListener("resize", size); };
  }

  /* =========================================================
     사다리 타기
     ========================================================= */
  function toolLadder(el) {
    var LEVELS = 11, n = Math.max(2, Math.min(8, store("sf-play-ladder-n") || 4)), rungs = [], tops = [], bottoms = [], done = {};
    var PATH = ["#2855E8", "#E8543A", "#14A37F", "#9B51E0", "#F2A100", "#0FA3C7", "#D6337F", "#18233A"];
    function defaults() {
      var nm = lines(store(NAMES_KEY) || "", 8);
      tops = []; bottoms = [];
      for (var i = 0; i < n; i++) { tops.push(nm[i] || (i + 1) + "번"); bottoms.push(i === 0 ? "당첨" : "통과"); }
    }
    function gen() {
      rungs = []; for (var l = 0; l < LEVELS; l++) { var row = []; for (var g = 0; g < n - 1; g++) row.push(!row[g - 1] && rnd(100) < 45); rungs.push(row); }
      for (var g2 = 0; g2 < n - 1; g2++) {
        var has = rungs.some(function (r) { return r[g2]; });
        if (!has) for (var t = 0; t < 30; t++) { var lv = rnd(LEVELS); if (!rungs[lv][g2 - 1] && !rungs[lv][g2 + 1]) { rungs[lv][g2] = true; break; } }
      }
      done = {};
    }
    function trace(i) {
      var X = function (c) { return 50 + c * 100; }, Y = function (l) { return 30 + (l + 1) * (440 / (LEVELS + 1)); };
      var col = i, pts = [[X(col), 10]];
      for (var l = 0; l < LEVELS; l++) {
        if (col > 0 && rungs[l][col - 1]) { pts.push([X(col), Y(l)], [X(col - 1), Y(l)]); col--; }
        else if (col < n - 1 && rungs[l][col]) { pts.push([X(col), Y(l)], [X(col + 1), Y(l)]); col++; }
      }
      pts.push([X(col), 490]);
      return { pts: pts, end: col };
    }
    function setup() {
      el.innerHTML = '<div class="pl-panel wide"><div class="pl-field"><span class="pl-label">참여 인원</span><div class="pl-chips left">' + [2, 3, 4, 5, 6, 7, 8].map(function (k) { return '<button type="button" data-n="' + k + '"' + (k === n ? ' aria-pressed="true"' : "") + ">" + k + "명</button>"; }).join("") + "</div></div>"
        + '<div class="pl-ladder-inputs" style="--n:' + n + '"><span class="pl-label">위쪽: 이름</span><div class="row">' + tops.map(function (t, i) { return '<input data-top="' + i + '" maxlength="8" value="' + esc(t) + '" aria-label="' + (i + 1) + '번째 이름">'; }).join("") + '</div><span class="pl-label">아래쪽: 결과</span><div class="row">' + bottoms.map(function (t, i) { return '<input data-bottom="' + i + '" maxlength="8" value="' + esc(t) + '" aria-label="' + (i + 1) + '번째 결과">'; }).join("") + "</div></div>"
        + '<div class="pl-ctrl left"><button type="button" class="btn btn-primary btn-lg" data-build>사다리 만들기</button></div><p class="pl-hint">결과는 사다리를 탈 때까지 가려 둡니다. \'당첨\' 대신 \'간식 사 오기\', \'첫 발표\'처럼 바꿔 써 보세요.</p></div>';
    }
    function board() {
      var w = n * 100, svg = '<svg class="pl-ladder" viewBox="0 0 ' + w + ' 500" aria-hidden="true">';
      for (var c = 0; c < n; c++) svg += '<line x1="' + (50 + c * 100) + '" y1="10" x2="' + (50 + c * 100) + '" y2="490"/>';
      rungs.forEach(function (row, l) { row.forEach(function (on, g) { if (on) { var y = 30 + (l + 1) * (440 / (LEVELS + 1)); svg += '<line x1="' + (50 + g * 100) + '" y1="' + y + '" x2="' + (150 + g * 100) + '" y2="' + y + '"/>'; } }); });
      svg += '<g data-paths></g></svg>';
      el.innerHTML = '<div class="pl-ladder-board" style="--n:' + n + '"><div class="row names">' + tops.map(function (t, i) { return '<button type="button" data-go="' + i + '" style="--c:' + PATH[i] + '">' + esc(t) + "</button>"; }).join("") + "</div>"
        + '<div class="pl-ladder-svg">' + svg + "</div>"
        + '<div class="row results">' + bottoms.map(function (t, i) { return '<span data-res="' + i + '"><i>?</i><b>' + esc(t) + "</b></span>"; }).join("") + "</div></div>"
        + '<div class="pl-ladder-summary" data-sum hidden></div>'
        + '<div class="pl-ctrl"><button type="button" class="btn btn-primary" data-allgo>한 번에 모두 보기</button><button type="button" class="btn btn-outline" data-rebuild>새 사다리</button><button type="button" class="btn btn-outline" data-edit>이름 · 결과 고치기</button></div><p class="pl-hint">위쪽 이름을 누르면 그 사람의 사다리를 탑니다.</p>';
    }
    function run(i, fast) {
      if (done[i]) return;
      var tr = trace(i), g = $("[data-paths]", el), len = 0;
      for (var k = 1; k < tr.pts.length; k++) len += Math.abs(tr.pts[k][0] - tr.pts[k - 1][0]) + Math.abs(tr.pts[k][1] - tr.pts[k - 1][1]);
      var pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      pl.setAttribute("points", tr.pts.map(function (p) { return p.join(","); }).join(" "));
      pl.setAttribute("stroke", PATH[i]); pl.style.strokeDasharray = len; pl.style.strokeDashoffset = len;
      pl.style.transition = "stroke-dashoffset " + (fast ? 0.6 : 1.6) + "s ease-in-out";
      g.appendChild(pl); pl.getBoundingClientRect(); pl.style.strokeDashoffset = 0;
      done[i] = tr.end;
      var btn = $('[data-go="' + i + '"]', el); if (btn) btn.classList.add("on");
      setTimeout(function () {
        var r = $('[data-res="' + tr.end + '"]', el); if (r) { r.classList.add("open"); r.style.setProperty("--c", PATH[i]); }
        if (!fast) beep(1, true);
        summary();
      }, fast ? 650 : 1650);
    }
    function summary() {
      var keys = Object.keys(done); if (!keys.length) return;
      var s = $("[data-sum]", el); s.hidden = false;
      s.innerHTML = keys.map(function (i) { return '<span style="--c:' + PATH[i] + '"><b>' + esc(tops[i]) + "</b> → " + esc(bottoms[done[i]]) + "</span>"; }).join("");
    }
    function readInputs() {
      $$("[data-top]", el).forEach(function (x) { tops[+x.getAttribute("data-top")] = x.value.trim() || (+x.getAttribute("data-top") + 1) + "번"; });
      $$("[data-bottom]", el).forEach(function (x) { bottoms[+x.getAttribute("data-bottom")] = x.value.trim() || "-"; });
    }
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-n")) { readInputs(); n = +b.getAttribute("data-n"); store("sf-play-ladder-n", n); var ot = tops.slice(), ob = bottoms.slice(); defaults(); for (var i = 0; i < n; i++) { if (ot[i]) tops[i] = ot[i]; if (ob[i]) bottoms[i] = ob[i]; } setup(); }
      else if (b.hasAttribute("data-build")) { readInputs(); gen(); board(); }
      else if (b.hasAttribute("data-go")) run(+b.getAttribute("data-go"));
      else if (b.hasAttribute("data-allgo")) { for (var j = 0; j < n; j++) run(j, true); }
      else if (b.hasAttribute("data-rebuild")) { gen(); board(); }
      else if (b.hasAttribute("data-edit")) setup();
    });
    defaults(); setup();
  }

  /* =========================================================
     회비 정산
     ========================================================= */
  function toolSplit(el) {
    var s = store("sf-play-split") || { rows: [["대관료", ""], ["음료 · 다과", ""], ["", ""]], people: 6, unit: 100, way: "up" };
    function rowHtml(r, i) { return '<div class="pl-row" data-row><input data-k placeholder="항목" maxlength="20" value="' + esc(r[0]) + '" aria-label="' + (i + 1) + '번째 항목"><input data-v inputmode="numeric" placeholder="금액" value="' + esc(r[1]) + '" aria-label="' + (i + 1) + '번째 금액"><button type="button" class="pl-x" data-del aria-label="이 줄 지우기">×</button></div>'; }
    el.innerHTML = '<div class="pl-split"><div class="pl-panel"><div class="pl-field"><span class="pl-label">쓴 돈</span><div data-rows>' + s.rows.map(rowHtml).join("") + '</div><button type="button" class="pl-mini" data-addrow>+ 항목 더하기</button></div>'
      + '<div class="pl-field"><label for="pl-people2">나눌 인원</label><div class="pl-stepper"><button type="button" data-pstep="-1" aria-label="줄이기">−</button><input id="pl-people2" type="number" min="1" max="200" inputmode="numeric" value="' + s.people + '"><button type="button" data-pstep="1" aria-label="늘리기">+</button></div></div>'
      + '<div class="pl-field"><label for="pl-unit">끝자리 맞추기</label><select id="pl-unit">' + [[1, "그대로"], [10, "10원 단위"], [100, "100원 단위"], [1000, "1,000원 단위"]].map(function (u) { return '<option value="' + u[0] + '"' + (+s.unit === u[0] ? " selected" : "") + ">" + u[1] + "</option>"; }).join("") + "</select></div>"
      + '<div class="pl-field"><span class="pl-label">남거나 모자라는 돈</span><div class="pl-seg" role="radiogroup"><label><input type="radio" name="way" value="up"' + (s.way !== "down" ? " checked" : "") + '><span>올려 받기</span></label><label><input type="radio" name="way" value="down"' + (s.way === "down" ? " checked" : "") + '><span>내려 받고 모임장이 채우기</span></label></div></div>'
      + '<div class="pl-field"><label for="pl-pay">받는 곳 <span class="pl-hint-in">(선택) 메시지 끝에 붙습니다. 이 기기에도 저장하지 않습니다.</span></label><input id="pl-pay" maxlength="60" placeholder="예) 카카오페이 송금 · 모임장에게"></div></div>'
      + '<div class="pl-result" data-result></div></div>';
    var res = $("[data-result]", el), msg = "";
    function num(v) { return parseInt(String(v || "").replace(/[^\d]/g, ""), 10) || 0; }
    function read() {
      s.rows = $$("[data-row]", el).map(function (r) { return [$("[data-k]", r).value.trim(), $("[data-v]", r).value.trim()]; });
      s.people = Math.max(1, Math.min(200, parseInt($("#pl-people2", el).value, 10) || 1));
      s.unit = +$("#pl-unit", el).value; s.way = $("input[name=way]:checked", el).value;
      store("sf-play-split", s);
    }
    function calc() {
      read();
      var items = s.rows.filter(function (r) { return num(r[1]) > 0; }), total = items.reduce(function (a, r) { return a + num(r[1]); }, 0);
      if (!total) { res.innerHTML = '<p class="pl-empty">금액을 적으면 한 사람이 낼 돈이 바로 계산됩니다.</p>'; msg = ""; return; }
      var raw = total / s.people, each = s.way === "down" ? Math.floor(raw / s.unit) * s.unit : Math.ceil(raw / s.unit) * s.unit;
      var got = each * s.people, diff = got - total;
      var note = diff === 0 ? "딱 맞게 나뉩니다." : diff > 0 ? "모두 내면 " + won(diff) + "이 남습니다. 다음 모임 회비로 넘기거나 돌려주세요." : "모임장이 " + won(-diff) + "을 더 채우면 됩니다.";
      res.innerHTML = '<div class="pl-bill"><span>한 사람이</span><b>' + won(each) + '</b><small>' + s.people + "명 · 합계 " + won(total) + "</small></div>"
        + '<ul class="pl-bill-list">' + items.map(function (r) { return "<li><span>" + esc(r[0] || "기타") + "</span><b>" + won(num(r[1])) + "</b></li>"; }).join("") + "</ul>"
        + '<p class="pl-sub">' + note + '</p><div class="pl-ctrl"><button type="button" class="btn btn-primary" data-copymsg>정산 메시지 복사</button></div>';
      var pay = $("#pl-pay", el).value.trim();
      msg = "[모임 정산]\n" + items.map(function (r) { return (r[0] || "기타") + " " + won(num(r[1])); }).join("\n") + "\n합계 " + won(total) + " · " + s.people + "명\n한 사람당 " + won(each) + (pay ? "\n\n" + pay : "");
    }
    el.addEventListener("input", calc);
    el.addEventListener("change", calc);
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-addrow")) { var box = $("[data-rows]", el), n = $$("[data-row]", el).length; if (n >= 12) return; box.insertAdjacentHTML("beforeend", rowHtml(["", ""], n)); $("[data-row]:last-child [data-k]", box).focus(); }
      else if (b.hasAttribute("data-del")) { if ($$("[data-row]", el).length > 1) b.closest("[data-row]").remove(); else { $("[data-k]", b.parentNode).value = ""; $("[data-v]", b.parentNode).value = ""; } calc(); }
      else if (b.hasAttribute("data-pstep")) { var i = $("#pl-people2", el); i.value = Math.max(1, Math.min(200, (parseInt(i.value, 10) || 1) + +b.getAttribute("data-pstep"))); calc(); }
      else if (b.hasAttribute("data-copymsg") && msg) copy(msg, "정산 메시지를 복사했습니다. 단체방에 붙여 넣어 주세요.");
    });
    calc();
  }

  /* =========================================================
     대화 카드
     ========================================================= */
  function toolCards(el, opt) {
    var deckId = opt.deck || store("sf-play-deck") || D.decks[0].id, list = [], i = 0;
    function deck() { for (var k = 0; k < D.decks.length; k++) if (D.decks[k].id === deckId) return D.decks[k]; return D.decks[0]; }
    function load(sh) { list = shuffle(deck().items); i = 0; if (sh) toast("카드를 섞었습니다."); paint(); }
    el.innerHTML = '<div class="pl-tabs" role="tablist" aria-label="카드 묶음">' + D.decks.map(function (d) { return '<button type="button" role="tab" data-deck="' + d.id + '" aria-selected="' + (d.id === deckId) + '">' + esc(d.name) + "</button>"; }).join("") + "</div>"
      + '<button type="button" class="pl-card" data-next aria-live="polite"><span class="pl-card-deck" data-dname></span><span class="pl-card-q" data-q></span><span class="pl-card-n" data-n></span></button>'
      + '<div class="pl-ctrl"><button type="button" class="btn btn-outline btn-lg" data-prev>이전</button><button type="button" class="btn btn-primary btn-lg" data-next>다음 질문</button><button type="button" class="btn btn-outline btn-lg" data-shuffle>섞기</button></div>'
      + '<p class="pl-hint">카드를 누르거나 → 키를 누르면 다음 질문으로 넘어갑니다. 답하기 어려운 질문은 \'패스\'해도 괜찮아요.</p>';
    function paint() {
      var d = deck(), card = $(".pl-card", el);
      $("[data-dname]", el).textContent = d.name; $("[data-q]", el).textContent = list[i]; $("[data-n]", el).textContent = (i + 1) + " / " + list.length;
      card.classList.remove("flip"); card.offsetWidth; card.classList.add("flip");
      $$("[data-deck]", el).forEach(function (b) { b.setAttribute("aria-selected", b.getAttribute("data-deck") === deckId ? "true" : "false"); });
    }
    function go(d) { i = (i + d + list.length) % list.length; paint(); }
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-deck")) { deckId = b.getAttribute("data-deck"); store("sf-play-deck", deckId); load(); }
      else if (b.hasAttribute("data-next")) go(1);
      else if (b.hasAttribute("data-prev")) go(-1);
      else if (b.hasAttribute("data-shuffle")) load(true);
    });
    onKey(function (e) { if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); go(1); } else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); } });
    load();
  }

  /* =========================================================
     밸런스 게임
     ========================================================= */
  function toolBalance(el) {
    var list = shuffle(D.balance), i = 0, votes = [0, 0];
    el.innerHTML = '<div class="pl-vs"><button type="button" class="pl-side a" data-vote="0"><span data-a></span><b data-ca>0</b></button><span class="pl-vs-mark" aria-hidden="true">VS</span><button type="button" class="pl-side b" data-vote="1"><span data-b></span><b data-cb>0</b></button></div>'
      + '<p class="pl-sub center" data-n></p>'
      + '<div class="pl-ctrl"><button type="button" class="btn btn-outline btn-lg" data-undo>한 표 빼기</button><button type="button" class="btn btn-primary btn-lg" data-next>다음 질문</button><button type="button" class="btn btn-outline btn-lg" data-shuffle>섞기</button></div>'
      + '<p class="pl-hint">손을 들어 고른 뒤 사람 수만큼 누르세요. 고른 이유를 한 사람씩 들어 보면 더 재미있습니다.</p>';
    var hist = [];
    function paint() {
      $("[data-a]", el).textContent = list[i][0]; $("[data-b]", el).textContent = list[i][1];
      $("[data-ca]", el).textContent = votes[0]; $("[data-cb]", el).textContent = votes[1];
      $("[data-n]", el).textContent = (i + 1) + " / " + list.length;
      var t = votes[0] + votes[1];
      $(".pl-side.a", el).style.setProperty("--p", t ? votes[0] / t : 0); $(".pl-side.b", el).style.setProperty("--p", t ? votes[1] / t : 0);
      $(".pl-side.a", el).classList.toggle("lead", votes[0] > votes[1]); $(".pl-side.b", el).classList.toggle("lead", votes[1] > votes[0]);
    }
    function next() { i = (i + 1) % list.length; votes = [0, 0]; hist = []; paint(); }
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-vote")) { var k = +b.getAttribute("data-vote"); votes[k]++; hist.push(k); paint(); }
      else if (b.hasAttribute("data-undo")) { if (hist.length) { votes[hist.pop()]--; paint(); } }
      else if (b.hasAttribute("data-next")) next();
      else if (b.hasAttribute("data-shuffle")) { list = shuffle(D.balance); i = -1; next(); toast("질문을 섞었습니다."); }
    });
    onKey(function (e) { if (e.key === "ArrowRight") { e.preventDefault(); next(); } else if (e.key === "1" || e.key === "ArrowUp") { votes[0]++; hist.push(0); paint(); } else if (e.key === "2" || e.key === "ArrowDown") { votes[1]++; hist.push(1); paint(); } });
    paint();
  }

  /* =========================================================
     사람 빙고 (각자 휴대폰으로)
     ========================================================= */
  function toolBingo(el) {
    var KEY = "sf-play-bingo", today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
    var st = store(KEY);
    function fresh(size) { st = { day: today, size: size, items: shuffle(D.bingo).slice(0, size * size), marks: {} }; store(KEY, st); }
    if (!st || st.day !== today || !st.items) fresh(4);
    var edit = -1;
    function linesDone() {
      var n = st.size, m = function (r, c) { return !!st.marks[r * n + c]; }, cnt = 0, r, c, ok;
      for (r = 0; r < n; r++) { ok = true; for (c = 0; c < n; c++) ok = ok && m(r, c); if (ok) cnt++; }
      for (c = 0; c < n; c++) { ok = true; for (r = 0; r < n; r++) ok = ok && m(r, c); if (ok) cnt++; }
      ok = true; for (r = 0; r < n; r++) ok = ok && m(r, r); if (ok) cnt++;
      ok = true; for (r = 0; r < n; r++) ok = ok && m(r, n - 1 - r); if (ok) cnt++;
      return cnt;
    }
    var prevLines = linesDone();
    function paint() {
      var lc = linesDone(), filled = Object.keys(st.marks).length;
      el.innerHTML = '<div class="pl-bingo-head"><p><b>방법</b> 칸에 맞는 사람을 찾아 직접 물어보고 이름을 적으세요. 한 사람 이름은 한 번만 쓸 수 있어요.</p><div class="pl-chips small"><button type="button" data-size="4"' + (st.size === 4 ? ' aria-pressed="true"' : "") + '>4 × 4</button><button type="button" data-size="5"' + (st.size === 5 ? ' aria-pressed="true"' : "") + ">5 × 5</button></div></div>"
        + '<div class="pl-bingo-score' + (lc ? " on" : "") + '" aria-live="polite">' + (lc ? "빙고 " + lc + "줄!" : filled + "칸 채움") + "</div>"
        + '<div class="pl-bingo" style="--n:' + st.size + '">' + st.items.map(function (t, i) { var nm = st.marks[i]; return '<button type="button" data-cell="' + i + '" class="' + (nm ? "on" : "") + (edit === i ? " editing" : "") + '"><span>' + esc(t) + "</span>" + (nm ? "<b>" + esc(nm) + "</b>" : "") + "</button>"; }).join("") + "</div>"
        + (edit >= 0 ? '<form class="pl-bingo-edit" data-form><label for="pl-bn">' + esc(st.items[edit]) + '</label><div class="pl-share"><input id="pl-bn" maxlength="10" placeholder="이 사람의 이름" value="' + esc(st.marks[edit] || "") + '"><button type="submit" class="btn btn-primary">적기</button>' + (st.marks[edit] ? '<button type="button" class="btn btn-outline" data-clear>지우기</button>' : "") + '<button type="button" class="btn btn-outline" data-cancel>닫기</button></div><p class="pl-status" data-msg></p></form>' : "")
        + '<div class="pl-ctrl"><button type="button" class="btn btn-outline" data-new>새 판</button></div>';
      if (edit >= 0) { var inp = $("#pl-bn", el); if (inp) inp.focus(); }
      if (lc > prevLines) { beep(2, true); toast("빙고 " + lc + "줄!"); }
      prevLines = lc;
    }
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-cell")) { edit = +b.getAttribute("data-cell"); paint(); }
      else if (b.hasAttribute("data-size")) { var sz = +b.getAttribute("data-size"); if (sz !== st.size && (!Object.keys(st.marks).length || window.confirm("판 크기를 바꾸면 적은 이름이 지워집니다. 바꿀까요?"))) { fresh(sz); edit = -1; prevLines = 0; paint(); } }
      else if (b.hasAttribute("data-clear")) { delete st.marks[edit]; store(KEY, st); edit = -1; paint(); }
      else if (b.hasAttribute("data-cancel")) { edit = -1; paint(); }
      else if (b.hasAttribute("data-new")) { if (!Object.keys(st.marks).length || window.confirm("새 판을 만들까요? 적은 이름이 지워집니다.")) { fresh(st.size); edit = -1; prevLines = 0; paint(); } }
    });
    el.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = $("#pl-bn", el).value.trim(), msg = $("[data-msg]", el);
      if (!v) { msg.textContent = "이름을 적어 주세요."; return; }
      for (var k in st.marks) if (+k !== edit && st.marks[k] === v) { msg.textContent = "'" + v + "' 님은 이미 다른 칸에 적었어요. 다른 사람을 찾아보세요."; return; }
      st.marks[edit] = v; store(KEY, st); edit = -1; paint();
    });
    paint();
  }

  /* =========================================================
     라이어 게임 (휴대폰 하나를 돌려 가며)
     ========================================================= */
  function wordCats(quizOk) { return D.words.filter(function (c) { return quizOk || !c.quiz; }); }
  function catSelect(id, cur, quizOk) {
    return '<select id="' + id + '"><option value="">전체에서 무작위</option>' + wordCats(quizOk).map(function (c) { return '<option value="' + c.id + '"' + (c.id === cur ? " selected" : "") + ">" + esc(c.name) + "</option>"; }).join("") + "</select>";
  }
  function catOf(id, quizOk) { var cs = wordCats(quizOk); for (var i = 0; i < cs.length; i++) if (cs[i].id === id) return cs[i]; return pick(cs); }
  function toolLiar(el) {
    var cfg = store("sf-play-liar") || { n: 5, liars: 1, cat: "", mode: "basic" }, g = null, iv = 0;
    function setup() {
      clearInterval(iv);
      el.innerHTML = '<div class="pl-panel narrow"><p class="pl-lead">모두 같은 제시어를 받고, <b>라이어만</b> 제시어를 모릅니다. 한 사람씩 제시어를 한마디로 설명하고, 누가 라이어인지 맞혀 보세요.</p>'
        + '<div class="pl-field"><label for="pl-ln">인원</label><div class="pl-stepper"><button type="button" data-st="n" data-d="-1" aria-label="줄이기">−</button><input id="pl-ln" type="number" min="3" max="12" value="' + cfg.n + '" inputmode="numeric"><button type="button" data-st="n" data-d="1" aria-label="늘리기">+</button></div></div>'
        + '<div class="pl-field"><span class="pl-label">라이어 수</span><div class="pl-seg"><label><input type="radio" name="liars" value="1"' + (cfg.liars !== 2 ? " checked" : "") + '><span>1명</span></label><label><input type="radio" name="liars" value="2"' + (cfg.liars === 2 ? " checked" : "") + "><span>2명 (7명 이상)</span></label></div></div>"
        + '<div class="pl-field"><label for="pl-lc">주제</label>' + catSelect("pl-lc", cfg.cat, false) + "</div>"
        + '<div class="pl-field"><span class="pl-label">방식</span><div class="pl-seg col"><label><input type="radio" name="mode" value="basic"' + (cfg.mode !== "fool" ? " checked" : "") + '><span>기본: 라이어는 자기가 라이어인 걸 압니다</span></label><label><input type="radio" name="mode" value="fool"' + (cfg.mode === "fool" ? " checked" : "") + "><span>바보 라이어: 라이어도 비슷한 다른 단어를 받아, 자기가 라이어인지 모릅니다</span></label></div></div>"
        + '<div class="pl-ctrl left"><button type="button" class="btn btn-primary btn-lg" data-start>게임 시작</button></div></div>';
    }
    function start() {
      var n = Math.max(3, Math.min(12, parseInt($("#pl-ln", el).value, 10) || 5));
      var liars = n >= 7 && $("input[name=liars]:checked", el).value === "2" ? 2 : 1;
      cfg = { n: n, liars: liars, cat: $("#pl-lc", el).value, mode: $("input[name=mode]:checked", el).value }; store("sf-play-liar", cfg);
      newGame();
    }
    function newGame() {
      var cat = catOf(cfg.cat, false), ws = shuffle(cat.items), set = [];
      while (set.length < cfg.liars) { var p = rnd(cfg.n); if (set.indexOf(p) < 0) set.push(p); }
      g = { cat: cat, word: ws[0], fake: ws[1], liars: set, who: 0, seen: false };
      pass();
    }
    function pass() {
      el.innerHTML = '<div class="pl-liar"><span class="pl-chip">' + (g.who + 1) + " / " + cfg.n + '</span><h3 class="pl-big small">' + (g.who + 1) + "번 차례입니다</h3><p class=\"pl-sub center\">다른 사람이 화면을 보지 않게 휴대폰을 받아 주세요.</p>"
        + '<div class="pl-ctrl"><button type="button" class="btn btn-primary btn-lg" data-show>내 제시어 보기</button></div></div>';
    }
    function show() {
      var isLiar = g.liars.indexOf(g.who) >= 0, last = g.who === cfg.n - 1;
      var inner = isLiar && cfg.mode !== "fool"
        ? '<span class="pl-chip red">라이어</span><h3 class="pl-big">당신은 라이어입니다</h3><p class="pl-sub center">주제는 <b>' + esc(g.cat.name) + "</b>입니다. 다른 사람의 설명을 듣고 제시어를 짐작해 들키지 않게 설명하세요.</p>"
        : '<span class="pl-chip">주제 · ' + esc(g.cat.name) + '</span><h3 class="pl-big">' + esc(isLiar ? g.fake : g.word) + '</h3><p class="pl-sub center">라이어가 눈치채지 못하게, 너무 뻔하지 않게 설명하세요.</p>';
      el.innerHTML = '<div class="pl-liar shown">' + inner + '<div class="pl-ctrl"><button type="button" class="btn btn-primary btn-lg" data-hide>' + (last ? "확인했어요 · 게임 시작" : "확인했어요 · 가리고 넘기기") + "</button></div></div>";
    }
    function discuss() {
      var T = 180000, end = 0;
      el.innerHTML = '<div class="pl-liar"><span class="pl-chip">주제 · ' + esc(g.cat.name) + '</span><h3 class="pl-big small">모두 확인했습니다</h3>'
        + '<ol class="pl-steps"><li>1번부터 돌아가며 제시어를 한마디로 설명합니다.</li><li>한 바퀴(또는 두 바퀴)가 끝나면 다 함께 라이어를 가리킵니다.</li><li>지목된 사람이 라이어라면, 라이어가 제시어를 맞힐 기회를 한 번 얻습니다.</li></ol>'
        + '<div class="pl-mini-timer" data-mt>3:00</div>'
        + '<div class="pl-ctrl"><button type="button" class="btn btn-outline btn-lg" data-mtgo>토론 3분 재기</button><button type="button" class="btn btn-primary btn-lg" data-reveal>라이어 공개</button></div></div>';
      var mt = $("[data-mt]", el);
      $("[data-mtgo]", el).addEventListener("click", function () {
        end = Date.now() + T; clearInterval(iv);
        iv = setInterval(function () { var l = Math.max(0, end - Date.now()), s = Math.ceil(l / 1000); mt.textContent = Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); mt.classList.toggle("warn", l < 30000); if (!l) { clearInterval(iv); beep(3, true); } }, 250);
      });
    }
    function reveal() {
      clearInterval(iv);
      var names = g.liars.slice().sort(function (a, b) { return a - b; }).map(function (x) { return (x + 1) + "번"; }).join(", ");
      el.innerHTML = '<div class="pl-liar shown"><span class="pl-chip red">라이어</span><h3 class="pl-big">' + names + '</h3><p class="pl-sub center">제시어는 <b>' + esc(g.word) + "</b>" + (cfg.mode === "fool" ? ", 라이어가 받은 단어는 <b>" + esc(g.fake) + "</b>" : "") + "였습니다.</p>"
        + '<div class="pl-ctrl"><button type="button" class="btn btn-primary btn-lg" data-again>같은 설정으로 한 판 더</button><button type="button" class="btn btn-outline btn-lg" data-setup>설정 바꾸기</button></div></div>';
      beep(1, true);
    }
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-st")) { var i = $("#pl-ln", el); i.value = Math.max(3, Math.min(12, (parseInt(i.value, 10) || 5) + +b.getAttribute("data-d"))); }
      else if (b.hasAttribute("data-start")) start();
      else if (b.hasAttribute("data-show")) show();
      else if (b.hasAttribute("data-hide")) { if (g.who === cfg.n - 1) discuss(); else { g.who++; pass(); } }
      else if (b.hasAttribute("data-reveal")) { if (window.confirm("라이어를 공개할까요?")) reveal(); }
      else if (b.hasAttribute("data-again")) newGame();
      else if (b.hasAttribute("data-setup")) setup();
    });
    setup();
    return function () { clearInterval(iv); };
  }

  /* =========================================================
     초성 퀴즈
     ========================================================= */
  var CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
  function chosung(s) { return String(s).replace(/[가-힣]/g, function (ch) { return CHO[Math.floor((ch.charCodeAt(0) - 0xAC00) / 588)]; }); }
  function toolChosung(el) {
    var cat = store("sf-play-cho-cat") || "", deck = [], i = 0, open = false, hint = false, timed = !!store("sf-play-cho-timed"), iv = 0, end = 0;
    function build() {
      deck = [];
      wordCats(true).forEach(function (c) { if (!cat || c.id === cat) c.items.forEach(function (w) { deck.push({ w: w, c: c.name }); }); });
      deck = shuffle(deck); i = 0;
    }
    el.innerHTML = '<div class="pl-toolbar"><label>주제 ' + catSelect("pl-cc", cat, true) + '</label><label class="pl-check"><input type="checkbox" data-timed' + (timed ? " checked" : "") + "> 10초 안에 맞히기</label></div>"
      + '<div class="pl-quiz"><span class="pl-chip" data-cat></span><div class="pl-cho" data-cho aria-live="polite"></div><div class="pl-answer" data-ans></div><div class="pl-bar10" data-bar hidden><i></i></div><p class="pl-sub center" data-n></p></div>'
      + '<div class="pl-ctrl"><button type="button" class="btn btn-outline btn-lg" data-hint>힌트</button><button type="button" class="btn btn-outline btn-lg" data-open>정답 보기</button><button type="button" class="btn btn-primary btn-lg" data-next>다음 문제</button></div>'
      + '<p class="pl-hint">먼저 외친 사람이 한 점. → 키로 다음 문제, 엔터로 정답을 볼 수 있습니다.</p>';
    function paint() {
      var q = deck[i];
      $("[data-cho]", el).textContent = chosung(q.w);
      $("[data-cat]", el).textContent = hint || open ? q.c + " · " + q.w.replace(/\s/g, "").length + "글자" : "초성 퀴즈";
      var a = $("[data-ans]", el); a.textContent = open ? q.w : ""; a.classList.toggle("on", open);
      $("[data-n]", el).textContent = (i + 1) + " / " + deck.length;
      var bar = $("[data-bar]", el); bar.hidden = !timed || open;
      clearInterval(iv);
      if (timed && !open) {
        end = Date.now() + 10000; var fill = $("i", bar); fill.style.width = "100%";
        iv = setInterval(function () { var l = Math.max(0, end - Date.now()); fill.style.width = (l / 100) + "%"; if (!l) { clearInterval(iv); beep(2); open = true; paint(); } }, 100);
      }
    }
    function next() { i = (i + 1) % deck.length; if (!i) deck = shuffle(deck); open = false; hint = false; paint(); }
    el.addEventListener("change", function (e) {
      if (e.target.id === "pl-cc") { cat = e.target.value; store("sf-play-cho-cat", cat); build(); open = false; hint = false; paint(); }
      else if (e.target.hasAttribute("data-timed")) { timed = e.target.checked; store("sf-play-cho-timed", timed); paint(); }
    });
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-hint")) { hint = true; paint(); }
      else if (b.hasAttribute("data-open")) { open = true; paint(); }
      else if (b.hasAttribute("data-next")) next();
    });
    onKey(function (e) { if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); next(); } else if (e.key === "Enter") { e.preventDefault(); open = true; paint(); } });
    build(); paint();
    return function () { clearInterval(iv); };
  }

  /* =========================================================
     스피드 퀴즈
     ========================================================= */
  function toolSpeed(el) {
    var cfg = store("sf-play-speed") || { cat: "", sec: 90 }, used = [], board = [], iv = 0, g = null;
    function setup() {
      clearInterval(iv);
      el.innerHTML = '<div class="pl-panel narrow"><p class="pl-lead">설명하는 사람이 화면을 팀원에게 보여 주지 않고 제시어를 설명합니다. 제시어에 들어간 말은 쓰면 안 돼요. 맞히면 \'맞혔어요\', 어려우면 \'패스\'.</p>'
        + '<div class="pl-field"><label for="pl-sc">주제</label>' + catSelect("pl-sc", cfg.cat, false) + "</div>"
        + '<div class="pl-field"><span class="pl-label">제한 시간</span><div class="pl-seg">' + [60, 90, 120].map(function (s) { return '<label><input type="radio" name="sec" value="' + s + '"' + (cfg.sec === s ? " checked" : "") + "><span>" + s + "초</span></label>"; }).join("") + "</div></div>"
        + '<div class="pl-field"><label for="pl-team">팀 이름</label><input id="pl-team" maxlength="12" value="' + (board.length + 1) + '팀"></div>'
        + (board.length ? '<div class="pl-score"><span class="pl-label">지금까지</span>' + board.map(function (b) { return "<span><b>" + esc(b.team) + "</b> " + b.score + "개</span>"; }).join("") + "</div>" : "")
        + '<div class="pl-ctrl left"><button type="button" class="btn btn-primary btn-lg" data-start>시작</button>' + (board.length ? '<button type="button" class="btn btn-outline btn-lg" data-resetboard>점수 지우기</button>' : "") + "</div></div>";
    }
    function nextWord() {
      var cat = catOf(cfg.cat, false), pool = [];
      (cfg.cat ? [cat] : wordCats(false)).forEach(function (c) { c.items.forEach(function (w) { if (used.indexOf(w) < 0) pool.push({ w: w, c: c.name }); }); });
      if (!pool.length) { used = []; return nextWord(); }
      var q = pick(pool); used.push(q.w); return q;
    }
    function start() {
      cfg = { cat: $("#pl-sc", el).value, sec: +$("input[name=sec]:checked", el).value }; store("sf-play-speed", cfg);
      g = { team: $("#pl-team", el).value.trim() || (board.length + 1) + "팀", log: [], q: null, end: 0 };
      var c = 3;
      el.innerHTML = '<div class="pl-quiz"><div class="pl-count" data-c>3</div><p class="pl-sub center">' + esc(g.team) + " 준비!</p></div>";
      iv = setInterval(function () { c--; if (c > 0) { $("[data-c]", el).textContent = c; beep(1); } else { clearInterval(iv); play(); } }, 800);
    }
    function play() {
      g.end = Date.now() + cfg.sec * 1000; g.q = nextWord(); beep(1, true);
      el.innerHTML = '<div class="pl-speed-top"><span class="pl-chip" data-cat></span><b class="pl-speed-time" data-t></b><span class="pl-chip blue" data-sc>0개</span></div>'
        + '<div class="pl-quiz"><div class="pl-cho word" data-w aria-live="polite"></div></div>'
        + '<div class="pl-ctrl big"><button type="button" class="btn btn-outline btn-lg" data-pass>패스</button><button type="button" class="btn btn-primary btn-lg" data-ok>맞혔어요</button></div><p class="pl-hint">← 패스 · → 맞혔어요</p>';
      paint();
      iv = setInterval(function () {
        var l = Math.max(0, g.end - Date.now()), t = $("[data-t]", el); if (!t) return;
        t.textContent = Math.ceil(l / 1000) + "초"; t.classList.toggle("warn", l < 10000);
        if (!l) { clearInterval(iv); finish(); }
      }, 200);
    }
    function paint() { $("[data-w]", el).textContent = g.q.w; $("[data-cat]", el).textContent = g.q.c; $("[data-sc]", el).textContent = g.log.filter(function (x) { return x.ok; }).length + "개"; }
    function answer(ok) { if (!g || !g.q || Date.now() >= g.end) return; g.log.push({ w: g.q.w, ok: ok }); if (ok) beep(1, true); g.q = nextWord(); paint(); }
    function finish() {
      beep(3, true);
      var score = g.log.filter(function (x) { return x.ok; }).length;
      board.push({ team: g.team, score: score }); g.q = null;
      el.innerHTML = '<div class="pl-quiz"><span class="pl-chip">' + esc(g.team) + '</span><div class="pl-big">' + score + '개 맞힘</div><ul class="pl-log">' + g.log.map(function (x) { return '<li class="' + (x.ok ? "ok" : "") + '">' + esc(x.w) + "<small>" + (x.ok ? "맞힘" : "패스") + "</small></li>"; }).join("") + "</ul></div>"
        + '<div class="pl-ctrl"><button type="button" class="btn btn-primary btn-lg" data-setup>다음 팀</button></div>';
    }
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      if (b.hasAttribute("data-start")) start();
      else if (b.hasAttribute("data-ok")) answer(true);
      else if (b.hasAttribute("data-pass")) answer(false);
      else if (b.hasAttribute("data-setup")) setup();
      else if (b.hasAttribute("data-resetboard")) { board = []; setup(); }
    });
    onKey(function (e) { if (e.key === "ArrowRight") { e.preventDefault(); answer(true); } else if (e.key === "ArrowLeft") { e.preventDefault(); answer(false); } });
    setup();
    return function () { clearInterval(iv); };
  }

  /* 밤 시간 안내 */
  var quietNote = document.querySelector("[data-quiet]");
  if (quietNote && QUIET) quietNote.hidden = false;
  route();
})();
