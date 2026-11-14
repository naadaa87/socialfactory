(function(){
 'use strict';
 const $=s=>document.querySelector(s),params=new URLSearchParams(location.search),oid=params.get('oid')||'',token=params.get('t')||'';
 let order,vehicles=[],timer,loading=false,working=false;const drafts=new Map();
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),money=n=>Number(n||0).toLocaleString('ko-KR')+'원',say=t=>$('#pk-order-message').textContent=t||'';
 const dl=items=>'<dl class="pk-order-dl">'+items.map(([k,v])=>'<div><dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd></div>').join('')+'</dl>';
 function card(p,i){
  const paid=order.status==='paid'&&order.refundedAmount===0,pending=p.requestedAt&&!p.reviewedAt,draft=drafts.get(p.oid)||{};
  return '<article class="pk-vehicle-receipt" data-vehicle="'+esc(p.oid)+'"><h3>차량 '+(i+1)+' · '+esc(p.plate)+'</h3>'+dl([['주차권',p.ticketLabel],['차량 금액',money(p.amount)],['이용일',p.date],['등록 상태',p.statusLabel],['입차 요청',p.arrivalAt||'요청 전'],['할인 적용',p.appliedAt||'적용 전']])+'<p>'+esc(p.operation)+'</p>'+(p.dailyDetails?'<p class="note mt-16">'+esc(p.dailyDetails)+'</p>':'')+(pending?'<p class="note mt-16">이 차량의 취소·정정 문의가 접수됐습니다. 운영자가 확인하고 안내합니다.</p>':'')+(paid&&!p.arrivalAt&&!pending?'<button class="btn btn-primary mt-24" type="button" data-pk-arrival>이 차량 입차했어요 · 등록 요청</button>':'')+(paid&&!pending?'<details class="pk-request"'+(draft.open?' open':'')+'><summary>이 차량 취소·차량번호 정정 문의</summary><form data-pk-request><label class="af-field"><span>문의 내용 *</span><textarea name="reason" maxlength="300" required>'+esc(draft.reason||'')+'</textarea></label><button class="btn btn-outline mt-16" type="submit">이 차량 문의 접수</button><p class="note mt-16">문의 접수만으로 결제가 취소되거나 차량번호가 변경되지는 않습니다. 운영자가 등록·사용 상태를 확인해 안내합니다.</p></form></details>':'')+'</article>';
 }
 async function load(){
  if(loading)return;loading=true;clearTimeout(timer);
  try{
   const r=await fetch('/api/orders/status?oid='+encodeURIComponent(oid)+'&t='+encodeURIComponent(token),{cache:'no-store',credentials:'same-origin'}),j=await r.json();
   if(!r.ok||!j.ok||!j.order?.parking){say('주문을 확인할 수 없습니다. 비회원 주문 조회에서 휴대폰을 인증하거나 구매 내역 링크를 확인해 주세요.');return;}
   document.querySelectorAll('[data-vehicle]').forEach(c=>{drafts.set(c.dataset.vehicle,{reason:c.querySelector('[name=reason]')?.value||'',open:!!c.querySelector('details')?.open});});
   order=j.order;const registrationNote=$('#pk-order-registration-note');if(registrationNote)registrationNote.textContent=order.parkingAutomation?'결제 승인 후 실제 입차를 확인해 바로 자동 등록합니다. 미입차 차량은 1분 간격으로 확인하며, 아래 버튼으로 즉시 다시 확인을 요청할 수 있습니다.':'입차 요청 후 운영자가 주차장에 등록합니다. 할인 적용 완료를 확인하고 출차해 주세요.';vehicles=order.parkingVehicles?.length?order.parkingVehicles:[order.parking];
   $('#pk-order-detail').innerHTML=dl([['결제 주문번호',oid],['결제 상태',order.statusLabel],['구매 차량',vehicles.length+'대'],['결제 합계',money(order.amount)],['누적 환불',money(order.refundedAmount)]])+(order.refundedAmount>0?'<p class="pk-refund-hold">결제 취소 내역이 있어 차량별 등록·사용 상태를 운영자가 확인해야 합니다. 일부 차량 취소는 카카오톡으로 문의해 주세요.</p>':'')+vehicles.map(card).join('');
   $('#pk-order-actions').innerHTML='<div class="pk-actions"><button class="btn btn-outline" type="button" data-pk-refresh>상태 새로고침</button><a class="btn btn-outline" href="/parking-purchase">주차권 추가 구매</a></div>';
   if(order.status==='pending')say('결제 결과 확인 중입니다. 재결제하지 말고 잠시 기다려 주세요.');
   else if(order.refundedAmount>0)say('환불이 반영된 결제입니다. 차량별 주차장 등록·사용 상태와 현장 요금은 별도로 확인해 주세요.');
   else if(order.status!=='paid')say('결제 상태를 확인해 주세요. 결제 완료된 주차권에서 입차 등록을 요청할 수 있습니다.');
   else if(vehicles.every(p=>p.status==='applied'))say('모든 차량의 주차 할인 적용이 완료됐습니다. 출차 전에 적용 내역을 확인해 주세요.');
   else say(order.parkingAutomation?'결제 후 자동으로 입차를 확인합니다. 미입차 차량은 1분마다 확인하며, ‘입차했어요’ 버튼으로 즉시 재확인을 요청할 수 있습니다. 할인 적용 완료를 확인하고 출차해 주세요.':'이용일에 입차한 차량마다 등록을 요청해 주세요. 각 차량의 할인 적용 완료를 확인하고 출차해 주세요.');
   if(order.status==='pending'||order.status==='paid'&&!order.refundedAmount&&vehicles.some(p=>p.status!=='applied'))timer=setTimeout(poll,15000);
  }catch{say('주문을 불러오지 못했습니다. 잠시 후 새로고침해 주세요.');}finally{loading=false;}
 }
 function poll(){if(working||document.activeElement?.closest('[data-pk-request]')){timer=setTimeout(poll,15000);return;}load();}
 async function act(vehicleOid,action,extra={}){
  const p=vehicles.find(v=>v.oid===vehicleOid);if(working||loading||!p)return;working=true;clearTimeout(timer);
  document.querySelectorAll('#pk-order-detail button,#pk-order-actions button').forEach(b=>b.disabled=true);
  try{
   const r=await fetch('/api/parking/action',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({oid:vehicleOid,token,action,expectedVersion:p.version,...extra})}),j=await r.json();
   if(!r.ok||!j.ok)throw Error(j.error||'요청을 처리하지 못했습니다. 상태를 새로 확인해 주세요.');await load();
  }catch(e){say(e.message);}finally{working=false;document.querySelectorAll('#pk-order-detail button,#pk-order-actions button').forEach(b=>b.disabled=false);}
 }
 $('#pk-order-actions').addEventListener('click',e=>{if(!working&&e.target.closest('[data-pk-refresh]'))load();});
 $('#pk-order-detail').addEventListener('click',e=>{const b=e.target.closest('[data-pk-arrival]');if(b)act(b.closest('[data-vehicle]').dataset.vehicle,'arrival');});
 $('#pk-order-detail').addEventListener('submit',e=>{if(!e.target.matches('[data-pk-request]'))return;e.preventDefault();if(e.target.reportValidity())act(e.target.closest('[data-vehicle]').dataset.vehicle,'request',{reason:e.target.elements.reason.value});});
 if(oid)load();else say('주문번호가 없습니다. 비회원 주문 조회에서 구매 내역을 확인해 주세요.');
})();
