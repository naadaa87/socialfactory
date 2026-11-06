(function(){
 'use strict';const A=window.SF_ADMIN;if(!A)return;const {$,api}=A,box=$('#pk-automation'),status=$('#pk-automation-status');let busy=false;
 async function load(){
  try{const r=await api('/api/admin/parking-automation');const on=r.enabled&&r.site_enabled;status.textContent=(on?'서버 자동 등록 켜짐':r.configured?'기존 아마노 계정 연결됨 · 자동 등록 꺼짐':'아마노 계정 연결 확인 필요')+' · '+(r.busy?'현재 등록 처리 중':'')+(r.last_run?'\n최근 처리: '+(r.last_run.finished_at||r.last_run.started_at||'')+' · 완료 '+(r.last_run.processed||0)+'건 · 입차 대기 '+(r.last_run.waiting||0)+'건 · 확인 필요 '+(r.last_run.issues||[]).length+'건'+(r.last_run.error?' · '+r.last_run.error:''):'');$('#pk-automation-enable').disabled=!r.configured||on;$('#pk-automation-disable').disabled=!on;}
  catch(e){status.textContent=e.message||'아마노 자동 등록 연결을 확인해 주세요.';}
 }
 box.addEventListener('click',async e=>{const b=e.target.closest('[data-pk-auto]');if(!b||busy)return;busy=true;box.querySelectorAll('button').forEach(x=>x.disabled=true);
  try{await api('/api/admin/parking-automation',{method:'POST',body:b.dataset.pkAuto==='check'?{action:'check'}:{action:'settings',enabled:b.dataset.pkAuto==='enable',confirm_policy:true}});await load();}catch(err){status.textContent=err.message;}finally{busy=false;$('#pk-automation-check').disabled=false;}
 });
 const original=A.LOAD.parking;A.LOAD.parking=async()=>{await Promise.allSettled([original(),load()]);};
})();
