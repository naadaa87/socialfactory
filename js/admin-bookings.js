(function(){
  'use strict';
  var A=window.SF_ADMIN;if(!A)return;
  var $=A.$,esc=A.esc,api=A.api,rows=[],ready=false,syncEnabled=false,syncReady=false;
  var purposes={meeting:'회의',education:'교육·클래스',seminar:'세미나·강연',study:'스터디',workshop:'워크숍',shooting:'촬영',other:'기타'};
  var labels={requested:'확인 대기',awaiting_payment:'결제 대기',confirmed:'예약 확정',cancelled:'취소',expired:'신청 만료',payment_review:'결제 확인 필요',creating:'결제요청 중',requested_payment:'결제 대기',paid:'결제 완료',pending:'결제 대기',refunded:'환불 확인',partial_refund:'부분취소 확인 필요',review:'처리 확인 필요'};
  labels.unpaid='미결제';labels.failed='발급 실패';labels.refund_pending='부분환불 확인';
  labels.sync_pending='외부 일정 확인 중';labels.paid_verifying='결제 완료 · 최종 일정 확인 중';labels.cancelling='결제 취소 확인 중';labels.releasing='확보 시간 해제 중';
  var syncLabels={pending:'일정 확인 대기',blocking:'외부 시간 확보 중',blocked:'외부 시간 확보 완료',verifying:'최신 일정 확인 중',releasing:'확보 시간 해제 중',released:'확보 시간 해제 완료',review:'연동 확인 필요',conflict:'외부 예약 충돌'};
  function err(e){if(!A.guard(e))A.toast((e.data && e.data.message) || e.message);}
  function url(value){try{var u=new URL(value),canonical=new URL((window.SF_CONFIG || {}).siteUrl || location.origin).origin;return u.protocol==='https:' && (((u.origin===location.origin || u.origin===canonical) && u.pathname==='/booking-status') || u.hostname==='payapp.kr' || u.hostname.endsWith('.payapp.kr'))?u.href:'';}catch(e){return '';}}
  function paymentLink(value){var u=url(value);return u?'<div class="acts"><a class="btn btn-light btn-sm" href="'+esc(u)+'" target="_blank" rel="noopener noreferrer">결제 링크 열기</a><button class="btn btn-light btn-sm" type="button" data-copy-payment="'+esc(u)+'">링크 복사</button></div>':'';}
  function hm(min){return (min>=1440?'익일 ':'')+String(Math.floor(min%1440/60)).padStart(2,'0')+':'+String(min%60).padStart(2,'0');}
  function showRows(){
    $('#booking-request-list').innerHTML=rows.length?rows.map(function(r){
      var pending=r.status==='requested',canCancel=(pending || r.status==='awaiting_payment') && ['creating','paid','paid_verifying','review','refund_pending','cancelling','releasing'].indexOf(r.payment_status)===-1,syncState=r.sync_state || (r.sync && r.sync.state) || '';
      var automatic=syncEnabled?'<p class="small muted">스페이스클라우드: '+esc(syncLabels[syncState] || '자동 일정 확인 준비 중')+'</p>':'';
      var approval=pending?(syncEnabled?(!syncState?'<div class="acts"><button type="button" class="btn btn-primary btn-sm" data-booking-action="approve" data-code="'+esc(r.code)+'" '+(!ready || !syncReady?'disabled':'')+'>일정 확인 · 결제 준비</button></div>':''):'<label><input type="checkbox" data-external-check="'+esc(r.code)+'"> 외부 채널 일정을 확인하고 해당 시간을 판매 중지했습니다.</label><div class="acts"><button type="button" class="btn btn-primary btn-sm" data-booking-action="approve" data-code="'+esc(r.code)+'" '+(!ready?'disabled':'')+'>승인 · 페이앱 링크 발급</button></div>'):'';
      return '<details class="card mt"><summary><b>'+esc(r.code)+' · '+esc(r.customer_name)+'</b> — '+esc(r.date)+' '+esc(hm(r.start_min))+'–'+esc(hm(r.end_min))+' · '+esc(r.room.replace('r',''))+'번룸 · '+esc(labels[r.status] || r.status)+'</summary><div class="mt"><p>'+esc(r.phone)+' · '+esc(r.company || '개인')+' · '+esc(r.people)+'명 · '+A.won(r.amount)+'</p><p>활용 목적: '+esc(purposes[r.purpose] || r.purpose)+' '+esc(r.purpose_detail || '')+'</p><p>기타 요청: '+esc(r.requests || '없음')+'</p><p class="small muted">결제 상태: '+esc(labels[r.payment_status] || r.payment_status || '미결제')+(r.expires_at?' · 신청 확보 기한: '+esc(r.expires_at):'')+'</p>'+
        automatic+approval+
        paymentLink(r.payment_url)+(canCancel?'<div class="acts"><button class="btn btn-light btn-sm" type="button" data-booking-action="cancel" data-code="'+esc(r.code)+'">'+(syncEnabled?'신청 취소 · 확보 시간 해제':'신청 취소 · 미결제 링크 닫기')+'</button></div>':'')+'</div></details>';
    }).join(''):A.emptyMsg('접수된 예약 신청이 없습니다.');
  }
  function load(){
    $('#booking-request-list').textContent='불러오는 중…';
    return Promise.all([api('/api/admin/booking-requests'),api('/api/admin/booking-payapp')]).then(function(results){
      var bookings=results[0],payments=results[1];rows=bookings.results || [];ready=!!payments.ready;syncEnabled=!!(bookings.sync && bookings.sync.enabled);syncReady=!!(bookings.sync && bookings.sync.ready);
      $('#payapp-ready').textContent=ready?'페이앱 연결 설정이 준비되어 있습니다. 결제 완료는 서버 통보 확인 후 반영됩니다.':'페이앱 연결 설정이 필요합니다. Cloudflare 비밀값 PAYAPP_USERID · PAYAPP_LINK_KEY · PAYAPP_LINK_VALUE · PAYAPP_REQUEST_KEY와 PAYAPP_SITE_URL을 설정해 주세요.';
      $('#office-invoice-submit').disabled=!ready;
      if(syncEnabled)$('#payapp-ready').textContent+=' '+(syncReady?'공간대관은 외부 시간 확보 후 결제 링크를 준비합니다.':'스페이스클라우드 자동 일정 확인 연결을 점검해 주세요. 확인 전에는 결제가 진행되지 않습니다.');
      showRows();
      var selected=$('#office-inquiry').value;
      $('#office-inquiry').innerHTML='<option value="">상담 접수 내역 선택</option>'+(payments.inquiries || []).map(function(i){return '<option value="'+i.id+'">'+esc(i.receipt+' · '+i.name+' · '+i.phone+(i.company?' · '+i.company:''))+'</option>';}).join('');
      $('#office-inquiry').value=selected;
      $('#office-invoice-list').innerHTML=(payments.results || []).map(function(p){return '<div class="card mt"><b>'+esc(p.label)+'</b><p>'+esc(p.name || '')+' · '+A.won(p.amount)+' · '+esc(p.status==='requested'?'결제 대기':labels[p.status] || p.status)+'</p>'+paymentLink(p.pay_url)+(['requested','pending','failed'].includes(p.status)?'<button type="button" class="btn btn-light btn-sm" data-office-cancel="'+esc(p.code)+'">미결제 청구 취소</button>':'')+'</div>';}).join('') || A.emptyMsg('독립사무실 청구 내역이 없습니다.');
    }).catch(function(e){$('#booking-request-list').textContent=(e.data && e.data.message) || e.message;err(e);});
  }
  $('#booking-admin-reload').addEventListener('click',load);
  $('#view-booking').addEventListener('click',function(event){
    var copy=event.target.closest('[data-copy-payment]');
    if(copy){if(navigator.clipboard)navigator.clipboard.writeText(copy.dataset.copyPayment).then(function(){A.toast('결제 링크를 복사했습니다.');}).catch(function(){A.toast('결제 링크를 열어 주소를 복사해 주세요.');});return;}
    var b=event.target.closest('[data-booking-action]');
    if(b){var code=b.dataset.code,action=b.dataset.bookingAction,check=Array.from(document.querySelectorAll('[data-external-check]')).find(function(c){return c.dataset.externalCheck===code;});
      if(action==='approve' && !syncEnabled && (!check || !check.checked)){A.toast('외부 일정 확인과 판매 중지를 체크해 주세요.');return;}
      b.disabled=true;api('/api/admin/booking-requests',{method:'PATCH',body:{code:code,action:action,external_checked:!!(check && check.checked)}}).then(function(){A.toast(action==='approve'?(syncEnabled?'일정 확인 후 결제 링크를 준비합니다.':'승인했습니다. 결제 링크를 고객에게 전달해 주세요.'):(syncEnabled?'신청 취소와 외부 시간 해제를 처리합니다.':'신청을 취소했습니다.'));return load();}).catch(err).finally(function(){b.disabled=false;});return;
    }
    b=event.target.closest('[data-office-cancel]');if(b){b.disabled=true;api('/api/admin/booking-payapp',{method:'POST',body:{action:'cancel',code:b.dataset.officeCancel}}).then(load).catch(err).finally(function(){b.disabled=false;});}
  });
  $('#office-invoice-form').addEventListener('submit',function(event){
    event.preventDefault();var form=event.currentTarget;if(!form.reportValidity())return;
    var b=$('#office-invoice-submit'),msg=$('#office-invoice-message');b.disabled=true;msg.textContent='결제 링크를 만들고 있습니다…';
    api('/api/admin/booking-payapp',{method:'POST',body:{inquiry_id:Number(form.elements.inquiry_id.value),label:form.elements.label.value,amount:Number(form.elements.amount.value),contract_confirmed:form.elements.contract_confirmed.checked}}).then(function(j){msg.textContent=j.message;form.elements.contract_confirmed.checked=false;return load();}).catch(function(e){msg.textContent=(e.data && e.data.message) || e.message;err(e);}).finally(function(){b.disabled=!ready;});
  });
  A.LOAD.booking=load;
})();
