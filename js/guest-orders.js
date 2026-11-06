(function(){
 'use strict';
 var root=document.querySelector('[data-guest-orders]');if(!root)return;
 var $=function(s){return root.querySelector(s);},challenge='',resendAt=0,verified=false,available=false,sending=false;
 var esc=function(v){return String(v==null?'':v).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});};
 var api=function(method,path,body){return fetch('/api/guest/'+path,{method:method,credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(j){return {status:r.status,j:j};});}).catch(function(){return {status:0,j:{ok:false,message:'서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'}};});};
 var message=function(text,bad){var box=$('[data-guest-message]');box.textContent=text||'';box.hidden=!text;box.className='auth-notice mt-16'+(bad?' err':'');};
 var send=$('[data-guest-send]'),check=$('[data-guest-check]');
 var busy=function(button,on,text){button.disabled=on;button.textContent=on?'처리 중…':text;};
 function tick(){if(!available||sending||verified)return;var seconds=Math.max(0,Math.ceil((resendAt-Date.now())/1000));if(seconds){send.disabled=true;send.textContent=seconds+'초 후 다시 받기';}else if(!verified){send.disabled=false;send.textContent=challenge?'인증번호 다시 받기':'인증번호 받기';}}
 setInterval(tick,1000);
 function renderOrders(j){
  verified=true;$('[data-guest-auth]').hidden=true;$('[data-guest-list]').hidden=false;
  $('[data-guest-phone]').textContent=j.maskedPhone||'';message('');
  var list=j.results||[];$('[data-guest-empty]').hidden=list.length>0;
  $('[data-guest-rows]').innerHTML=list.map(function(o){
   var booking=o.kind==='room' || o.kind==='office',parking=String(o.product_id||'').startsWith('parking-');
   var time=function(n){return(n>=1440?'익일 ':'')+String(Math.floor(n%1440/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');};
   var when=o.kind==='room'?o.date+' '+time(o.start_min)+' → '+time(o.end_min)+' · '+o.people+'명':o.kind==='office'?'입주 일정은 상담한 계약 조건을 확인해 주세요.':o.start_date?(parking?'이용일 ':'이용 시작 ')+o.start_date.slice(0,16):'이용 일정은 주문 상세에서 확인해 주세요.';
   var href=booking?(typeof o.detail_url==='string' && o.detail_url.indexOf('/booking-status?code=')===0?o.detail_url:''):(parking?'/parking-order':'/order-complete')+'?oid='+encodeURIComponent(o.oid);
   var label=booking?(o.kind==='room'?'예약·결제 상태 확인':'독립사무실 청구·결제 확인'):(parking?'주차권 내역 · 등록 요청':'주문 확인 · 시간 변경');
   return '<li><div class="mi-top"><span class="mi-st">'+esc(o.statusLabel)+'</span><strong>'+esc(o.product_name)+'</strong></div><p class="mi-meta">'+Number(o.amount).toLocaleString('ko-KR')+'원 · '+esc(when)+'</p><p class="mi-receipt">'+(booking?'접수·청구번호 ':'주문번호 ')+esc(o.oid)+'</p>'+(href?'<a class="btn btn-outline btn-sm mt-16" href="'+esc(href)+'">'+label+'</a>':'<p class="note mt-16">접수번호로 담당자에게 진행 상태를 문의해 주세요.</p>')+'</li>';
  }).join('');
 }
 function loadOrders(){return api('GET','orders').then(function(r){if(r.j.ok)renderOrders(r.j);else{if(r.status===401){verified=false;challenge='';$('[data-guest-auth]').hidden=false;$('[data-guest-list]').hidden=true;$('[data-guest-code-box]').hidden=true;}message(r.j.message||'인증 시간이 만료되었습니다. 휴대폰을 다시 인증해 주세요.',true);}});}
 $('[data-guest-phone-form]').addEventListener('submit',function(e){e.preventDefault();message('');var phone=this.elements.phone.value.trim();if(!/^01[016789][0-9 -]{7,11}$/.test(phone)){message('구매에 사용한 휴대폰 번호를 입력해 주세요.',true);return;}sending=true;busy(send,true);api('POST','request',{phone:phone}).then(function(r){sending=false;if(r.j.ok){challenge=r.j.challenge;resendAt=Date.now()+r.j.resendAfter*1000;$('[data-guest-code-box]').hidden=false;$('[data-guest-code-form]').elements.code.value='';$('[data-guest-code-form]').elements.code.focus();message(r.j.message);tick();}else{busy(send,false,challenge?'인증번호 다시 받기':'인증번호 받기');message(r.j.message||'인증 문자를 보내지 못했습니다.',true);}});});
 $('[data-guest-code-form]').addEventListener('submit',function(e){e.preventDefault();var code=this.elements.code.value.trim();if(!/^\d{6}$/.test(code)){message('인증번호 6자리를 입력해 주세요.',true);return;}busy(check,true);api('POST','verify',{challenge:challenge,code:code}).then(function(r){busy(check,false,'인증하고 주문 조회');if(r.j.ok)loadOrders();else message(r.j.message||'인증번호를 다시 확인해 주세요.',true);});});
 $('[data-guest-refresh]').addEventListener('click',loadOrders);
 $('[data-guest-logout]').addEventListener('click',function(){api('DELETE','session').then(function(r){if(r.j.ok){verified=false;challenge='';resendAt=0;$('[data-guest-auth]').hidden=false;$('[data-guest-list]').hidden=true;$('[data-guest-code-box]').hidden=true;$('[data-guest-rows]').innerHTML='';$('[data-guest-phone-form]').reset();$('[data-guest-code-form]').reset();message('인증을 종료했습니다.');tick();}else message('인증 종료를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',true);});});
 api('GET','session').then(function(r){$('[data-guest-loading]').hidden=true;if(r.j.verified){loadOrders();return;}available=!!r.j.ready;$('[data-guest-auth]').hidden=false;if(!r.j.ready){send.disabled=true;verified=true;message('휴대폰 인증을 준비하고 있습니다. 주문번호와 함께 카카오톡으로 문의해 주세요.',true);}});
})();
