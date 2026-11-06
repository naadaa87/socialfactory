(async function(){
 'use strict';
 const form=document.getElementById('pk-buy-form');if(!form)return;
 const $=s=>document.querySelector(s),message=t=>{$('#pk-message').textContent=t||'';};
 const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const plate=v=>String(v||'').normalize('NFKC').replace(/[\s-]/g,''),money=n=>Number(n).toLocaleString('ko-KR')+'원';
 let config,working=false,nextId=0;
 const cards=()=>Array.from($('#pk-vehicles').children);
 const vehicles=()=>cards().map(c=>({ticket:c.querySelector('input[type=radio]:checked')?.value||'',plate:plate(c.querySelector('[data-plate]').value),plateConfirm:plate(c.querySelector('[data-plate-confirm]').value)}));
 function totals(){
  const list=vehicles(),total=list.reduce((n,v)=>n+(config.tickets.find(t=>t.id===v.ticket)?.price||0),0);
  $('#pk-total').textContent=list.length+'대 · 총 '+money(total);$('#pk-add-vehicle').disabled=working||list.length>=10;
  $('#pk-vehicle-count').textContent=list.length+'/10대';
  cards().forEach((c,i)=>{c.querySelector('legend').textContent='차량 '+(i+1);const remove=c.querySelector('[data-remove]');remove.hidden=list.length===1;remove.setAttribute('aria-label','차량 '+(i+1)+' 삭제');});
 }
 function addVehicle(focus=false){
  if(working||cards().length>=10)return;
  const id=++nextId,c=document.createElement('fieldset');c.className='pk-vehicle';
  let selected=false;
  c.innerHTML='<legend>차량</legend><button type="button" class="btn btn-outline btn-sm pk-remove" data-remove>삭제</button><div class="pk-grid"><label class="af-field"><span>차량번호 전체 *</span><input data-plate name="plate_'+id+'" type="text" maxlength="15" autocomplete="off" placeholder="123가4567" required></label><label class="af-field"><span>차량번호 다시 확인 *</span><input data-plate-confirm name="plateConfirm_'+id+'" type="text" maxlength="15" autocomplete="off" placeholder="차량번호 전체 재입력" required></label></div><fieldset class="pk-tickets mt-24"><legend>이 차량의 주차권</legend><div>'+config.tickets.map(t=>{const checked=t.available&&!selected;if(checked)selected=true;return '<label><input type="radio" name="ticket_'+id+'" value="'+esc(t.id)+'" '+(t.available?'required':'disabled')+(checked?' checked':'')+'><span><b>'+esc(t.label)+'</b>'+money(t.price)+(t.available?'':' · 문의')+'</span></label>';}).join('')+'</div></fieldset>';
  $('#pk-vehicles').append(c);c.querySelector('[data-remove]').onclick=()=>{if(working)return;const index=cards().indexOf(c);c.remove();totals();const remaining=cards();remaining[Math.min(index,remaining.length-1)].querySelector('[data-plate]').focus();};
  totals();if(focus)c.querySelector('[data-plate]').focus();
 }
 try{
  const r=await fetch('/api/parking/config',{cache:'no-store'});config=await r.json();if(!r.ok||!config.ok)throw Error();
  $('#pk-operation').textContent=config.operation;if(config.automationEnabled)$('#pk-registration-description').textContent='이용일에 입차한 뒤 구매 내역에서 차량별로 등록을 요청해 주세요. 서버가 실제 입차를 확인하고 자동 등록합니다. 입차 기록이 아직 없으면 대기하며, 할인 적용 완료를 확인하고 출차해 주세요.';$('#pk-daily').textContent='일일권: '+(config.dailyEnabled?config.dailyDetails:'이용 조건을 확인 중입니다. 카카오톡으로 문의해 주세요.');
  form.elements.date.min=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);form.elements.date.max=new Date(Date.now()+9*3600e3+90*864e5).toISOString().slice(0,10);
  addVehicle();$('#pk-pay').disabled=!config.ready;if(!config.ready)message('주차권 온라인 구매를 준비하고 있습니다. 카카오톡으로 문의해 주세요.');
 }catch{message('구매 가능 여부를 확인하지 못했습니다. 잠시 후 다시 접속해 주세요.');return;}
 $('#pk-add-vehicle').onclick=()=>addVehicle(true);form.addEventListener('change',totals);
 form.addEventListener('submit',async e=>{
  e.preventDefault();if(working||!config.ready||!form.reportValidity())return;
  const b={name:form.elements.name.value.trim(),phone:form.elements.phone.value,date:form.elements.date.value,vehicles:vehicles(),policy:config.policy,termsVersion:config.termsVersion,device:matchMedia('(max-width:768px)').matches?'mobile':'pc'};
  for(const k of ['agreeTerms','agreePrivacy','agreeRefund','confirmed'])b[k]=form.elements[k].checked;
  const seen=new Set();for(const [i,v]of b.vehicles.entries()){
   if(!/^(?:[가-힣]{2})?\d{2,3}[가-힣]\d{4}$/.test(v.plate)){message('차량 '+(i+1)+': 차량번호 전체를 확인해 주세요. 예: 123가4567');cards()[i].querySelector('[data-plate]').focus();return;}
   if(v.plate!==v.plateConfirm){message('차량 '+(i+1)+': 두 번 입력한 차량번호가 일치하지 않습니다.');cards()[i].querySelector('[data-plate-confirm]').focus();return;}
   if(seen.has(v.plate)){message('같은 차량번호를 두 번 입력했습니다. 차량마다 한 번씩 입력해 주세요.');cards()[i].querySelector('[data-plate]').focus();return;}seen.add(v.plate);
  }
  working=true;const enabled=Array.from(form.querySelectorAll('input,button')).filter(el=>!el.disabled);enabled.forEach(el=>el.disabled=true);message('결제창을 준비하고 있습니다.');
  try{
   const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(b))),fingerprint=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
   let old;try{old=JSON.parse(sessionStorage.getItem('sf_parking_attempt')||'null');}catch{}
   const attempt=old?.fingerprint===fingerprint?old:{fingerprint,id:crypto.randomUUID()};sessionStorage.setItem('sf_parking_attempt',JSON.stringify(attempt));b.requestId=attempt.id;
   const r=await fetch('/api/parking/create',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}),j=await r.json();
   if(!j.ok)throw Error(j.message||'결제 요청을 확인하지 못했습니다. 내용을 확인한 뒤 같은 요청으로 다시 시도해 주세요.');
   const u=new URL(j.pay.url,location.origin);if(!(u.origin===location.origin||u.protocol==='https:'&&(u.hostname==='payapp.kr'||u.hostname.endsWith('.payapp.kr'))))throw Error('결제창 주소를 확인하지 못했습니다.');location.assign(u.href);
  }catch(err){message(err.message||'연결이 원활하지 않습니다. 다시 결제하기 전에 구매 내역을 확인해 주세요.');working=false;enabled.forEach(el=>el.disabled=false);totals();}
 });
})();
