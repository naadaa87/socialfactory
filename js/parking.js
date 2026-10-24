/* 주차 안내: 주소 복사와 공유 (전송은 사용자가 공유 창에서 선택) */
(function () {
  'use strict';
  var status = document.getElementById('parking-status');
  var url = 'https://socialfactory.co.kr/parking';
  function say(text) { status.textContent = text; }
  async function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* 수동 복사 대안 */ }
    }
    var field = document.createElement('textarea');
    field.value = text; field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(field); field.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* 아래에서 안내 */ }
    field.remove(); return ok;
  }
  document.querySelectorAll('[data-copy-address]').forEach(function (button) {
    button.addEventListener('click', async function () {
      var address = button.dataset.copyAddress;
      say(await copy(address) ? '주소를 복사했어요. 지도나 메시지에 붙여 넣으세요.' : '자동 복사가 안 돼요. 화면에 표시된 주소를 길게 눌러 복사해 주세요.');
    });
  });
  document.getElementById('parking-share').addEventListener('click', async function () {
    if (navigator.share) {
      try { await navigator.share({ title: '소셜팩토리 건대 주차 안내', text: '건물 및 인근 공영주차장 위치와 요금을 확인하세요.', url: url }); say('공유를 완료했어요.'); return; }
      catch (error) { if (error.name === 'AbortError') return; }
    }
    if (await copy(url)) { say('주차 안내 링크를 복사했어요. 참석자에게 보내 주세요.'); return; }
    document.getElementById('parking-share-fallback').hidden = false;
    document.getElementById('parking-share-url').select();
    say('아래 링크를 직접 복사해 주세요.');
  });
})();
