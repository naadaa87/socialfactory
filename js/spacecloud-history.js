(function () {
  'use strict';
  var input = document.getElementById('sc-history-file');
  if (!input) return;
  var status = document.getElementById('sc-history-status');
  var preview = document.getElementById('sc-history-preview');
  var commit = document.getElementById('sc-history-commit');
  var rows = null;
  var escape = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  }); };
  async function send(action) {
    var response = await fetch('/api/admin/spacecloud-history', { method:'POST', credentials:'same-origin',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:action, rows:rows }) });
    var data = await response.json();
    if (!response.ok) throw Error(data.message || '지난 예약 확인 실패');
    return data;
  }
  input.addEventListener('change', async function () {
    rows = null; commit.hidden = true; preview.innerHTML = '';
    var file = input.files && input.files[0]; if (!file) return;
    status.textContent = '예약번호와 기존 결제내역을 대조하는 중…';
    try {
      if (file.size > 100000) throw Error('100KB 이하의 JSON 파일을 골라 주세요.');
      var data = JSON.parse(await file.text());
      if (data.format !== 'socialfactory-spacecloud-history' || data.version !== 1 || !Array.isArray(data.rows))
        throw Error('지난 예약 보충 형식의 JSON 파일을 골라 주세요.');
      rows = data.rows;
      var result = await send('preview');
      preview.innerHTML = '<table class="tbl"><thead><tr><th>예약번호</th><th>이용일</th><th>공간</th><th>시간</th><th>결과</th></tr></thead><tbody>'
        + result.rows.map(function (r) { return '<tr><td>' + escape(r.reservation_id) + '</td><td>' + escape(r.date)
          + '</td><td>' + escape(r.space) + '</td><td>' + escape(String(r.start_min / 60)) + '–'
          + escape(String(r.end_min / 60)) + '</td><td>' + escape(r.reason || (r.state === 'new' ? '반영 가능' : '이미 보관됨')) + '</td></tr>'; }).join('')
        + '</tbody></table>';
      status.textContent = '새로 반영할 예약 ' + result.new_count + '건' + (result.rows.some(function(r){return r.state==='blocked';}) ? ' · 확인이 필요한 행이 있습니다.' : '');
      commit.hidden = !result.new_count || result.rows.some(function(r){return r.state==='blocked';});
    } catch (error) { rows = null; status.textContent = error.message; }
  });
  commit.addEventListener('click', async function () {
    commit.disabled = true;
    try { var result = await send('commit'); status.textContent = result.message; commit.hidden = true; rows = null; }
    catch (error) { status.textContent = error.message; }
    finally { commit.disabled = false; }
  });
}());
