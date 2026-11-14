(function(){
 'use strict';const A=window.SF_ADMIN;if(!A)return;const {$,api,esc}=A,box=$('#pk-automation'),status=$('#pk-automation-status');let busy=false;
 async function load(){
  try{const r=await api('/api/admin/parking-automation');const on=r.enabled&&r.site_enabled;status.textContent=(on?'서버 자동 등록 켜짐':r.configured?'기존 아마노 계정 연결됨 · 자동 등록 꺼짐':'아마노 계정 연결 확인 필요')+' · '+(r.busy?'현재 등록 처리 중':'')+(r.last_run?'\n최근 처리: '+(r.last_run.finished_at||r.last_run.started_at||'')+' · 완료 '+(r.last_run.processed||0)+'건 · 입차 대기 '+(r.last_run.waiting||0)+'건 · 확인 필요 '+(r.last_run.issues||[]).length+'건'+(r.last_run.error?' · '+r.last_run.error:''):'');const alertStatus=$('#pk-automation-alert-status'),labels={queued:'발송 대기',sending:'전송 중',accepted:'발송 접수',delivered:'전달 완료',failed:'발송 실패',unknown:'결과 확인 필요'};alertStatus.textContent=r.error_alerts_enabled?'관리자 오류 문자 켜짐 · 수신 끝번호 '+r.error_alert_receivers.join(', ')+' · 등록 오류는 주문별 1회, 잔액 부족은 하루 1회': '관리자 오류 문자 수신 설정 확인 필요';if(r.error_alert_status?.ok===false)alertStatus.textContent+=' · '+r.error_alert_status.error;$('#pk-automation-alert-history').innerHTML=(r.error_notifications||[]).slice(-5).reverse().map(e=>'<li>'+esc(e.kind==='balance'?'아마노 잔액 부족':e.kind==='registration'?'자동 등록 오류':'서버 연결 오류')+' · 끝번호 '+esc(e.receiver_last4)+' · '+esc(labels[e.status]||e.status)+' · '+esc(new Date(e.created_at).toLocaleString('ko-KR'))+(e.error?' · '+esc(e.error):'')+'</li>').join('');const paidStatus=$('#pk-paid-alert-status');
 paidStatus.textContent=r.paid_alerts_enabled?'관리자 결제 문자 켜짐 · 수신 끝번호 '+r.paid_alert_receivers.join(', '):'관리자 결제 문자 꺼짐';
 if(r.paid_alert_last_run?.ok===false)paidStatus.textContent+=' · '+r.paid_alert_last_run.error;
 $('#pk-paid-alert-history').innerHTML=(r.paid_notifications||[]).slice(-10).reverse().map(e=>'<li>'+esc(e.oid)+' · 끝번호 '+esc(e.receiver_last4)+' · '+esc(labels[e.status]||e.status)+(e.error?' · '+esc(e.error):'')+'</li>').join('');
 $('#pk-automation-enable').disabled=!r.configured||on;$('#pk-automation-disable').disabled=!on;}
  catch(e){status.textContent=e.message||'아마노 자동 등록 연결을 확인해 주세요.';$('#pk-automation-alert-status').textContent='관리자 오류 문자 상태를 확인하지 못했습니다.';}
 }
 box.addEventListener('click',async e=>{const b=e.target.closest('[data-pk-auto]');if(!b||busy)return;busy=true;box.querySelectorAll('button').forEach(x=>x.disabled=true);
  try{await api('/api/admin/parking-automation',{method:'POST',body:b.dataset.pkAuto==='check'?{action:'check'}:{action:'settings',enabled:b.dataset.pkAuto==='enable',confirm_policy:true}});await load();}catch(err){status.textContent=err.message;}finally{busy=false;$('#pk-automation-check').disabled=false;}
 });
 $('#pk-admin-reload').addEventListener('click',load);
 const original=A.LOAD.parking;A.LOAD.parking=async()=>{await Promise.allSettled([original(),load()]);};
})();
