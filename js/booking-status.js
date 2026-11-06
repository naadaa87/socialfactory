(function(){
  'use strict';
  var title=document.getElementById('payment-title'),message=document.getElementById('payment-message'),detail=document.getElementById('payment-detail'),button=document.getElementById('payment-reload'),form=document.getElementById('payment-consent');
  var pay=document.getElementById('payment-open'),agree=document.getElementById('payment-agree'),cancel=document.getElementById('booking-cancel');
  var params=new URLSearchParams(location.search),code=params.get('code') || '',token=params.get('t') || '';
  var timer,polls=0,checking=false,posting=false,cancelling=false,checkoutRequested=false,latest=null;
  function item(label,value){var dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;detail.append(dt,dd);}
  function readResponse(r){return r.json().then(function(j){if(!r.ok || !j.ok){var e=new Error();e.paymentMessage=j.message || '예약·결제 상태를 확인하지 못했습니다.';throw e;}return j;});}
  function request(url,options){
    var controller=new AbortController(),timeout=setTimeout(function(){controller.abort();},20000);
    return fetch(url,Object.assign({credentials:'same-origin',cache:'no-store',signal:controller.signal},options || {})).then(readResponse).finally(function(){clearTimeout(timeout);});
  }
  function controls(){
    button.disabled=checking || posting || cancelling;
    pay.disabled=posting || cancelling || checkoutRequested;
    cancel.disabled=checking || posting || cancelling;
  }
  function poll(){
    clearTimeout(timer);
    if(polls++<60) timer=setTimeout(check,2000);
    else {
      checkoutRequested=false;controls();
      message.textContent=latest && (latest.status==='paid_verifying' || (latest.booking && latest.booking.payment_status==='paid_verifying'))?'결제는 확인되었지만 최종 일정 확인이 지연되고 있습니다. 추가 결제 없이 다시 확인을 누르거나 접수번호로 담당자에게 문의해 주세요.':'일정 또는 결제 확인이 지연되고 있습니다. 다시 확인을 눌러 주세요. 이미 결제했다면 추가 결제하지 않고 담당자에게 문의해 주세요.';
    }
  }
  function show(j){
    latest=j;detail.replaceChildren();item('접수·청구번호',j.code);item('결제 항목',j.label || '소셜팩토리 공간대관');item('청구금액',Number(j.amount).toLocaleString('ko-KR')+'원');detail.hidden=false;
    var paid=j.status==='paid',confirmed=j.booking && j.booking.status==='confirmed',sync=j.sync || {};
    var paidVerifying=j.status==='paid_verifying' || (j.booking && j.booking.payment_status==='paid_verifying');
    var terminal=paid || paidVerifying || ['cancelled','refunded','failed','review','partial_refund','sync_review','sync_conflict'].indexOf(j.status)!==-1 || ['review','conflict','released'].indexOf(sync.state)!==-1 || (j.booking && j.booking.status==='payment_review');
    if(terminal)checkoutRequested=false;
    form.hidden=terminal || !(j.can_pay || j.can_start_payment || checkoutRequested);
    cancel.hidden=paidVerifying || !j.can_cancel;
    if(j.booking){
      item('이용일',j.booking.date);item('예약 인원',j.booking.people+'명');
      var showTime=function(n){return(n>=1440?'익일 ':'')+String(Math.floor(n%1440/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');};
      item('예약 시간',showTime(j.booking.start_min)+' → '+showTime(j.booking.end_min));
    }
    if(paid && (j.kind==='office' || confirmed)){
      title.textContent=j.kind==='room'?'예약이 확정되었습니다':'결제가 확인되었습니다';
      message.textContent=j.kind==='room'?'예약하신 시간에 이용해 주세요. 입실과 이용 안내는 담당자가 전달해 드립니다.':'독립사무실 이용료 결제가 확인되었습니다. 상담한 입주 조건과 이용 안내를 확인해 주세요.';
    }else if(paidVerifying){
      title.textContent='결제가 확인되었습니다. 최종 일정을 확인하고 있습니다';message.textContent='스페이스클라우드의 최신 일정을 확인한 뒤 예약 확정을 안내합니다. 추가 결제 없이 잠시 기다려 주세요.';poll();
    }else if(j.status==='releasing' || sync.state==='releasing'){
      title.textContent='예약 신청 취소를 처리하고 있습니다';message.textContent=sync.message || '결제 내역을 확인하고 확보했던 시간을 해제하고 있습니다. 완료될 때까지 잠시 기다려 주세요.';poll();
    }else if(j.status==='cancelled' || j.status==='refunded'){
      title.textContent=j.status==='refunded'?'결제 취소가 확인되었습니다':'예약·결제요청이 취소되었습니다';message.textContent='변경이나 재예약은 담당자에게 문의해 주세요. 환불 입금 시점은 결제수단에 따라 다를 수 있습니다.';
    }else if(j.status==='sync_conflict' || sync.state==='conflict'){
      title.textContent='선택한 시간에 다른 예약이 있습니다';message.textContent=sync.message || '결제는 진행할 수 없습니다. 다른 일정을 선택하거나 담당자에게 문의해 주세요.';
    }else if(j.status==='sync_review' || sync.state==='review'){
      title.textContent='담당자가 예약 일정을 확인하고 있습니다';message.textContent=sync.message || '일정 확보 여부를 확인하고 있습니다. 추가 신청이나 결제 없이 접수번호로 문의해 주세요.';
    }else if(j.status==='review' || j.status==='partial_refund' || (j.booking && j.booking.status==='payment_review')){
      title.textContent='담당자가 결제 상태를 확인하고 있습니다';message.textContent='추가 결제 없이 담당자에게 접수번호를 알려 주세요.';
    }else if(j.status==='failed'){
      title.textContent='결제요청을 만들지 못했습니다';message.textContent='결제요청 처리와 일정 해제 상태를 담당자에게 확인해 주세요.';
    }else if(j.status==='sync_pending' || ['pending','blocking','verifying'].indexOf(sync.state)!==-1){
      title.textContent='스페이스클라우드 일정을 확인하고 있습니다';message.textContent=sync.message || '신청한 시간을 다른 예약 채널에서도 확보한 뒤 결제할 수 있습니다. 잠시 기다려 주세요.';poll();
    }else{
      title.textContent=checkoutRequested?'결제 직전 일정을 다시 확인하고 있습니다':(j.can_pay || j.can_start_payment)?'예약·청구 내용을 확인해 주세요':paid?'예약 확정을 확인하고 있습니다':'결제 완료 확인을 기다리고 있습니다';
      message.textContent=checkoutRequested?'스페이스클라우드의 최신 일정을 확인한 뒤 페이앱으로 연결합니다.':(j.can_pay || j.can_start_payment)?'아래 내용과 조건을 확인한 뒤 페이앱으로 결제해 주세요. 이미 결제했다면 다시 확인을 눌러 주세요.':'결제 결과가 반영되는 데 시간이 걸릴 수 있습니다. 이미 결제했다면 다시 결제하지 않고 잠시 후 확인해 주세요.';
      if(!j.can_pay && (checkoutRequested || !j.can_start_payment))poll();
    }
    controls();
  }
  function openPayment(){
    if(posting || cancelling || !agree.checked){checkoutRequested=false;controls();return Promise.resolve();}
    clearTimeout(timer);posting=true;checkoutRequested=true;controls();
    return request('/api/booking/payment-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code,t:token,consent:agree.checked})}).then(function(j){
      if(j.pending){title.textContent='결제 직전 일정을 다시 확인하고 있습니다';message.textContent=j.message || '스페이스클라우드 최신 일정을 확인하고 있습니다.';poll();return;}
      var u=new URL(j.url);
      if(u.protocol!=='https:' || !(u.hostname==='payapp.kr' || u.hostname.endsWith('.payapp.kr')) || u.username || u.password)throw new Error();
      location.assign(u.href);
    }).catch(function(e){checkoutRequested=false;message.textContent=e.paymentMessage || '결제 연결을 확인하지 못했습니다. 잠시 후 다시 시도하거나 담당자에게 문의해 주세요.';}).finally(function(){posting=false;controls();});
  }
  function check(){
    clearTimeout(timer);if(checking || posting || cancelling)return Promise.resolve();
    if(!code || !token){form.hidden=true;cancel.hidden=true;title.textContent='확인 링크가 필요합니다';message.textContent='예약 신청 후 받은 진행 상태 링크로 다시 접속해 주세요.';controls();return Promise.resolve();}
    checking=true;controls();
    return request('/api/booking/payment-status?code='+encodeURIComponent(code)+'&t='+encodeURIComponent(token)).then(function(j){
      show(j);
      // Continue only the checkout explicitly requested on this page, after a fresh receipt.
      if(checkoutRequested && j.can_pay && agree.checked)return openPayment();
    }).catch(function(e){checkoutRequested=false;form.hidden=true;cancel.hidden=true;title.textContent='예약·결제 상태를 확인하지 못했습니다';message.textContent=(e.paymentMessage || '서버 연결을 확인하고 잠시 후 다시 시도해 주세요.')+' 이미 결제했다면 추가 결제 없이 다시 확인해 주세요.';}).finally(function(){checking=false;controls();});
  }
  form.addEventListener('submit',function(e){e.preventDefault();if(posting || cancelling || !form.reportValidity())return;polls=0;openPayment();});
  agree.addEventListener('change',function(){if(!agree.checked){checkoutRequested=false;controls();}});
  cancel.addEventListener('click',function(){
    if(cancelling || posting || !latest || !latest.can_cancel)return;
    if(!window.confirm('예약 신청을 취소할까요? 결제 내역과 확보한 시간의 해제를 확인한 뒤 처리됩니다.'))return;
    clearTimeout(timer);cancelling=true;checkoutRequested=false;controls();var queued=false;
    request('/api/booking/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code,t:token})}).then(function(j){queued=true;polls=0;message.textContent=j.message || '예약 신청 취소를 처리하고 있습니다.';}).catch(function(e){message.textContent=e.paymentMessage || '취소 결과를 확인하지 못했습니다. 다시 확인하거나 담당자에게 문의해 주세요.';}).finally(function(){cancelling=false;controls();if(queued)check();});
  });
  button.addEventListener('click',function(){polls=0;check();});check();
})();
