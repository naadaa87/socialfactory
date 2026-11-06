(function(){
  'use strict';
  var A=window.SF_ADMIN;if(!A || !A.LOAD || typeof A.LOAD.booking!=='function')return;
  var $=A.$,status=$('#booking-cloud-status'),budget=$('#booking-cloud-budget'),message=$('#booking-cloud-message');
  var start=$('#booking-cloud-start'),guestStart=$('#booking-cloud-guest-start'),revalidate=$('#booking-cloud-revalidate'),refresh=$('#booking-cloud-refresh'),save=$('#booking-cloud-save'),cancel=$('#booking-cloud-cancel'),panel=$('#booking-cloud-login'),link=$('#booking-cloud-view'),expiry=$('#booking-cloud-expiry');
  if(!status || !start)return;
  var snapshot=null,busy=false,loading=false,loginId='',loginPurpose='',expiresAt=0,expiryTimer;
  function purposeName(purpose){return purpose==='guest'?'고객 달력':'호스트';}
  function minutes(ms){return (Math.ceil(Number(ms)/6000)/10).toLocaleString('ko-KR',{maximumFractionDigits:1});}
  function time(ms){return new Date(ms).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});}
  function safeView(value){if(typeof value!=='string' || value.length>8192)return '';try{var u=new URL(value);return u.protocol==='https:' && u.hostname==='live.browser.run' && !u.username && !u.password && !u.port?u.href:'';}catch(e){return '';}}
  function candidate(){return !!(snapshot && snapshot.public_candidate_saved && !snapshot.public_login_saved && (typeof snapshot.public_candidate_expires_at!=='number' || snapshot.public_candidate_expires_at>Date.now()));}
  function controls(){
    var unavailable=busy || loading || !snapshot || snapshot.runner.busy || snapshot.runner.review;
    start.disabled=unavailable || !!loginId;guestStart.disabled=start.disabled;
    refresh.disabled=busy || loading;save.disabled=busy || loading || !loginId || expiresAt<=Date.now();cancel.disabled=busy || loading || !loginId;
    revalidate.hidden=!candidate();revalidate.disabled=unavailable || !!loginId || !candidate();
    panel.hidden=!loginId;
  }
  function clearLogin(){clearTimeout(expiryTimer);loginId='';loginPurpose='';expiresAt=0;link.removeAttribute('href');panel.hidden=true;}
  function deadline(value){
    clearTimeout(expiryTimer);expiresAt=value;expiry.textContent=purposeName(loginPurpose)+' 로그인 화면의 유효시간: '+time(expiresAt)+'까지 (원래 유효시간 유지)';
    expiryTimer=setTimeout(function(){clearLogin();message.textContent='로그인 화면의 유효시간이 지났습니다. 보관 상태가 있으면 저장 상태 재확인을 이용할 수 있습니다.';controls();load();},Math.max(1,expiresAt-Date.now()));
  }
  function error(e){
    if(A.guard(e)){clearLogin();snapshot=null;return true;}
    message.textContent=(e.data && e.data.message) || '클라우드 연결 결과를 확인하지 못했습니다. 상태를 다시 확인한 뒤 진행해 주세요.';return false;
  }
  function api(body){
    var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},body && (body.action==='revalidate' || (body.action==='save' && body.purpose==='guest'))?70000:40000);
    return A.api('/api/admin/booking-cloud',body?{method:'POST',body:body,signal:controller.signal}:{signal:controller.signal}).finally(function(){clearTimeout(timer);});
  }
  function render(j){
    snapshot=j;
    var login=j.login_saved?'호스트 로그인 상태 저장됨'+(j.session_updated_at?' · 마지막 저장 '+time(j.session_updated_at):''):'호스트 로그인 연결 필요';
    var guest=j.public_login_saved?'고객 달력 로그인 상태 저장됨'+(j.public_session_updated_at?' · 마지막 저장 '+time(j.public_session_updated_at):''):j.public_candidate_saved?'고객 달력 로그인 상태 보관됨 · 복원 확인 필요'+(j.public_candidate_updated_at?' · 보관 '+time(j.public_candidate_updated_at):''):'고객 달력 로그인 연결 필요';
    var runner=j.runner.review?'이전 작업 결과 확인 필요':j.runner.busy?'현재 작업 중':'작업 대기 중';
    status.textContent=login+' / '+guest+' / '+runner+' / '+(j.booking_enabled && j.enabled && j.allow_writes && j.login_saved && j.public_login_saved?'홈페이지 자동 예약 접수 중':'홈페이지 자동 예약 접수 준비 중');
    budget.textContent='최근 32일 '+minutes(j.budget.rolling_32d_reserved_ms)+'분 / 한도 '+minutes(j.budget.rolling_32d_limit_ms)+'분 · 오늘 '+minutes(j.budget.daily_reserved_ms)+'분 / '+minutes(j.budget.daily_limit_ms)+'분 · 이번 달 '+minutes(j.budget.monthly_reserved_ms)+'분 / '+minutes(j.budget.monthly_limit_ms)+'분 (일·월 집계는 UTC 기준)';
  }
  function load(){
    if(loading || busy)return Promise.resolve();loading=true;controls();
    return api().then(render).catch(function(e){snapshot=null;status.textContent='클라우드 상태를 확인하지 못했습니다.';error(e);}).finally(function(){loading=false;controls();});
  }
  function action(which,purpose){
    if(busy || loading)return;
    var selectedPurpose=which==='revalidate'?'guest':which==='start'?purpose:loginPurpose;
    if(['host','guest'].indexOf(selectedPurpose)===-1)return;
    if(which==='revalidate' && (!candidate() || loginId)){message.textContent='남아 있는 로그인 화면을 저장하거나 종료한 뒤 보관 상태를 확인해 주세요.';return;}
    if(['save','cancel'].indexOf(which)!==-1 && (!loginId || (which==='save' && expiresAt<=Date.now()))){clearLogin();message.textContent='로그인 화면의 유효시간이 지났습니다. 보관된 상태가 있으면 저장 상태 재확인을 이용해 주세요.';controls();return;}
    busy=true;controls();message.textContent=which==='start'?purposeName(selectedPurpose)+' 로그인 화면을 준비하고 있습니다. 최대 30초 정도 걸릴 수 있습니다.':which==='save'?purposeName(selectedPurpose)+' 로그인을 확인하고 안전하게 저장하고 있습니다.':which==='revalidate'?'보관한 로그인 상태를 복원하여 확인하고 있습니다. 새 로그인 입력은 필요하지 않습니다.':'로그인 화면을 종료하고 있습니다.';
    var body={action:which,purpose:selectedPurpose};if(['save','cancel'].indexOf(which)!==-1)body.login_id=loginId;
    if(which==='start' && selectedPurpose==='guest')body.provider='kakao';
    api(body).then(function(j){
      if(which==='start'){
        var view=safeView(j.live_view_url);
        if(j.purpose!==selectedPurpose || !view || typeof j.login_id!=='string' || !j.expires_at || j.expires_at<=Date.now())throw new Error('invalid-login-response');
        loginId=j.login_id;loginPurpose=selectedPurpose;link.href=view;link.textContent=purposeName(loginPurpose)+' 로그인 화면 열기 ↗';deadline(j.expires_at);
        message.textContent='아래 로그인 화면 열기를 눌러 '+(loginPurpose==='guest'?'카카오로 로그인한 뒤':'스페이스클라우드 호스트 계정에 로그인한 뒤')+', 이 관리자 화면으로 돌아와 로그인 저장을 눌러 주세요. 비밀번호와 인증번호를 채팅에 보내지 마세요.';
      }else if(j.pending){message.textContent=j.message || '복원 상태 확인을 진행하고 있습니다. 상태 다시 확인으로 결과를 확인해 주세요.';}
      else if(which==='cancel'){clearLogin();message.textContent='로그인 화면을 종료했습니다. 보관한 상태가 있으면 저장 상태 재확인을 이용할 수 있습니다.';}
      else if(j.saved===true){clearLogin();message.textContent=purposeName(selectedPurpose)+' 로그인 상태의 복원을 확인하여 암호화 저장했습니다.';}
      else throw new Error('unverified-login-response');
    }).catch(function(e){
      if(error(e))return;
      if(which==='save' && loginId && expiresAt>Date.now()){
        var shorter=e.data && e.data.retryable===true && e.data.expires_at;
        // Server metadata may shorten this receipt, but can never extend its original deadline.
        if(Number.isSafeInteger(shorter) && shorter>Date.now() && shorter<expiresAt)deadline(shorter);
        var recovery=e.data && e.data.retryable===true && selectedPurpose==='guest' && safeView(e.data.recovery_view_url);
        if(recovery)link.href=recovery;
        message.textContent+=' 로그인 화면과 입력 상태는 남은 유효시간 동안 유지합니다. 같은 화면에서 확인한 뒤 다시 저장할 수 있습니다.';
      }else if(which==='save' && expiresAt<=Date.now())clearLogin();
    }).finally(function(){busy=false;controls();load();});
  }
  start.addEventListener('click',function(){action('start','host');});guestStart.addEventListener('click',function(){action('start','guest');});revalidate.addEventListener('click',function(){action('revalidate','guest');});save.addEventListener('click',function(){action('save');});cancel.addEventListener('click',function(){action('cancel');});refresh.addEventListener('click',load);
  link.addEventListener('click',function(e){if(expiresAt<=Date.now()){e.preventDefault();clearLogin();message.textContent='로그인 화면이 만료되었습니다. 보관 상태를 먼저 확인해 주세요.';controls();}});
  $('#booking-admin-reload').addEventListener('click',load);
  var original=A.LOAD.booking;
  A.LOAD.booking=function(){var result=original.apply(this,arguments);load();return result;};
  window.addEventListener('pagehide',clearLogin);
  controls();
})();
