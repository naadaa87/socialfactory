(function(){
 'use strict';const $=id=>document.getElementById(id);if(!$('sc-auto-status'))return;
 async function api(action){const r=await fetch('/api/admin/spacecloud-sync',{method:action?'POST':'GET',credentials:'same-origin',headers:action?{'Content-Type':'application/json'}:{},...(action?{body:JSON.stringify({action})}:{})});const j=await r.json();if(!r.ok)throw Error(j.message||'관리자 로그인과 연결 상태를 확인해 주세요.');return j;}
 const time=t=>t?new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'아직 없음';
 async function refresh(){try{
  const j=await api(),d=j.device;if(!d){$('sc-auto-status').textContent='자동 동기화 미연결';return;}
  const stale=d.enabled&&(!d.last_success||j.now-d.last_success>45*60000);
  $('sc-auto-status').textContent=(d.message||d.status||'연결 대기')+(stale?' · 최근 45분 내 성공 기록 없음 — PC·크롬·로그인을 확인해 주세요.':'');
  $('sc-auto-times').textContent='마지막 시도: '+time(d.last_attempt)+' · 마지막 성공: '+time(d.last_success)+' · 연결 만료: '+time(d.token_until);
  let counts;try{counts=JSON.parse(d.counts||'null');}catch{}
  $('sc-auto-counts').textContent=counts?'최근 처리: 신규 '+counts.added+'건 · 환불 갱신 '+counts.refunded+'건 · 중복 '+counts.unchanged+'건 · 확인 필요 '+counts.review+'건':'';
  const box=$('sc-auto-review');box.replaceChildren();if(j.review.length){const title=document.createElement('strong');title.textContent='확인이 필요한 최근 기록';box.append(title);j.review.forEach(x=>{const p=document.createElement('p');p.textContent='예약 '+x.reservation_id+' · '+x.reason;box.append(p);});}
 }catch(e){$('sc-auto-status').textContent=e.message;}}
 $('sc-auto-pair').addEventListener('click',async()=>{try{const j=await api('pair');$('sc-auto-code').textContent='연결 코드 (10분 유효): '+j.code;setTimeout(()=>{$('sc-auto-code').textContent='';},600000);await refresh();}catch(e){$('sc-auto-status').textContent=e.message;}});
 $('sc-auto-revoke').addEventListener('click',async()=>{try{await api('revoke');$('sc-auto-code').textContent='';await refresh();}catch(e){$('sc-auto-status').textContent=e.message;}});
 refresh();setInterval(()=>{if(!document.hidden)refresh();},60000);
})();
