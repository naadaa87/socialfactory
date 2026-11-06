(function(){
  'use strict';
  var A=window.SF_ADMIN;if(!A || !A.LOAD || typeof A.LOAD.booking!=='function')return;
  var $=A.$,status=$('#booking-cloud-status'),budget=$('#booking-cloud-budget'),message=$('#booking-cloud-message');
  var start=$('#booking-cloud-start'),refresh=$('#booking-cloud-refresh'),save=$('#booking-cloud-save'),cancel=$('#booking-cloud-cancel'),panel=$('#booking-cloud-login'),link=$('#booking-cloud-view'),expiry=$('#booking-cloud-expiry');
  if(!status || !start)return;
  var snapshot=null,busy=false,loading=false,loginId='',expiresAt=0,expiryTimer;
  function minutes(ms){return (Math.ceil(Number(ms)/6000)/10).toLocaleString('ko-KR',{maximumFractionDigits:1});}
  function time(ms){return new Date(ms).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'});}
  function safeView(value){try{var u=new URL(value);return u.protocol==='https:' && u.hostname==='live.browser.run' && !u.username && !u.password && !u.port?u.href:'';}catch(e){return '';}}
  function controls(){
    start.disabled=busy || loading || !snapshot || snapshot.runner.busy || snapshot.runner.review || !!loginId;
    refresh.disabled=busy || loading;save.disabled=busy || !loginId || expiresAt<=Date.now();cancel.disabled=busy || !loginId;
    panel.hidden=!loginId;
  }
  function clearLogin(){clearTimeout(expiryTimer);loginId='';expiresAt=0;link.removeAttribute('href');panel.hidden=true;}
  function error(e){
    if(A.guard(e)){clearLogin();snapshot=null;return;}
    message.textContent=(e.data && e.data.message) || '클라우드 연결 결과를 확인하지 못했습니다. 상태를 다시 확인한 뒤 진행해 주세요.';
  }
  function api(body){
    var controller=new AbortController(),timer=setTimeout(function(){controller.abort();},40000);
    return A.api('/api/admin/booking-cloud',body?{method:'POST',body:body,signal:controller.signal}:{signal:controller.signal}).finally(function(){clearTimeout(timer);});
  }
  function render(j){
    snapshot=j;
    var login=j.login_saved?'로그인 상태 저장됨'+(j.session_updated_at?' · 마지막 저장 '+time(j.session_updated_at):''):'클라우드 로그인 연결이 필요합니다';
    var runner=j.runner.review?'이전 작업 결과 확인 필요':j.runner.busy?'현재 작업 중':'작업 대기 중';
    status.textContent=login+' / '+runner+' / '+(j.booking_enabled && j.enabled && j.allow_writes?'홈페이지 자동 예약 접수 중':'홈페이지 자동 예약 접수 준비 중');
    budget.textContent='최근 32일 '+minutes(j.budget.rolling_32d_reserved_ms)+'분 / 한도 '+minutes(j.budget.rolling_32d_limit_ms)+'분 · 오늘 '+minutes(j.budget.daily_reserved_ms)+'분 / '+minutes(j.budget.daily_limit_ms)+'분 · 이번 달 '+minutes(j.budget.monthly_reserved_ms)+'분 / '+minutes(j.budget.monthly_limit_ms)+'분 (일·월 집계는 UTC 기준)';
  }
  function load(){
    if(loading || busy)return Promise.resolve();loading=true;controls();
    return api().then(render).catch(function(e){snapshot=null;status.textContent='클라우드 상태를 확인하지 못했습니다.';error(e);}).finally(function(){loading=false;controls();});
  }
  function action(which){
    if(busy)return;
    if(which!=='start' && (!loginId || (which==='save' && expiresAt<=Date.now()))){clearLogin();message.textContent='로그인 화면의 유효시간이 지났습니다. 상태를 확인하고 다시 연결해 주세요.';controls();return;}
    busy=true;controls();message.textContent=which==='start'?'로그인 화면을 준비하고 있습니다. 최대 30초 정도 걸릴 수 있습니다.':which==='save'?'호스트 로그인을 확인하고 안전하게 저장하고 있습니다.':'로그인 화면을 종료하고 있습니다.';
    var body={action:which};if(which!=='start')body.login_id=loginId;
    api(body).then(function(j){
      if(which==='start'){
        var view=safeView(j.live_view_url);
        if(!view || typeof j.login_id!=='string' || !j.expires_at || j.expires_at<=Date.now())throw new Error('invalid-login-response');
        loginId=j.login_id;expiresAt=j.expires_at;link.href=view;expiry.textContent='이 화면의 유효시간: '+time(expiresAt)+'까지 (5분)';
        clearTimeout(expiryTimer);expiryTimer=setTimeout(function(){clearLogin();message.textContent='로그인 화면의 유효시간이 지났습니다. 상태 다시 확인 후 재연결해 주세요.';controls();},Math.max(1,expiresAt-Date.now()));
        message.textContent='아래 로그인 화면 열기를 눌러 호스트 계정에 로그인한 뒤, 이 관리자 화면으로 돌아와 로그인 저장을 눌러 주세요. 비밀번호와 인증번호를 채팅에 보내지 마세요.';
      }else{clearLogin();message.textContent=which==='save'?'로그인 상태를 암호화하여 저장했습니다. 클라우드 연동에서 사용합니다.':'로그인 화면을 종료했습니다.';}
    }).catch(function(e){if(which==='save')clearLogin();error(e);}).finally(function(){busy=false;controls();load();});
  }
  start.addEventListener('click',function(){action('start');});save.addEventListener('click',function(){action('save');});cancel.addEventListener('click',function(){action('cancel');});refresh.addEventListener('click',load);
  link.addEventListener('click',function(e){if(expiresAt<=Date.now()){e.preventDefault();clearLogin();message.textContent='로그인 화면이 만료되었습니다. 상태를 확인하고 다시 연결해 주세요.';controls();}});
  $('#booking-admin-reload').addEventListener('click',load);
  var original=A.LOAD.booking;
  A.LOAD.booking=function(){var result=original.apply(this,arguments);load();return result;};
  window.addEventListener('pagehide',clearLogin);
  controls();
})();
