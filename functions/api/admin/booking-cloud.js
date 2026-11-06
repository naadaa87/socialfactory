import {adminGate} from '../../_lib/admin.js';
import {json,sameOrigin} from '../../_lib/auth.js';
import {cloudRunnerOrigin} from '../../_lib/spacecloud-runner.js';

const TIMEOUT_MS=35000,MAX_BODY=32768;
const uuid=value=>typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const reply=(data,status=200)=>json(data,status,{'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
const failure=(message='클라우드 연결을 확인하지 못했습니다. 상태를 다시 확인한 뒤 진행해 주세요.',status=503,error='cloud-unavailable')=>reply({ok:false,error,message},status);
function config(env){
  const origin=cloudRunnerOrigin(env.SPACECLOUD_RUNNER_URL),token=env.CLOUD_ADMIN_TOKEN;
  return origin && typeof token==='string' && /^[A-Za-z0-9._~+\/=-]{32,512}$/.test(token)?{origin,token}:null;
}
function finite(value,maximum){if(!Number.isSafeInteger(value) || value<0 || value>maximum)throw Error('cloud-shape');return value;}
function timestamp(value){return value===null?null:finite(value,8640000000000000);}
function statusFields(data,env){
  if(!data || !data.budget || !data.runner || ['enabled','allow_writes','login_saved'].some(key=>typeof data[key]!=='boolean')
    || (data.public_login_saved!==undefined && typeof data.public_login_saved!=='boolean')
    || typeof data.runner.busy!=='boolean' || typeof data.runner.review!=='boolean'
    || !/^\d{4}-\d{2}-\d{2}$/.test(data.budget.utc_day || '') || !/^\d{4}-\d{2}$/.test(data.budget.utc_month || ''))throw Error('cloud-shape');
  const b=data.budget;
  return {ok:true,configured:true,booking_enabled:env.SPACECLOUD_SYNC_ENABLED==='true' && env.SPACECLOUD_BOOKING_OPEN!=='false',enabled:data.enabled,allow_writes:data.allow_writes,
    login_saved:data.login_saved,session_updated_at:timestamp(data.session_updated_at),
    public_login_saved:data.public_login_saved===true,public_session_updated_at:timestamp(data.public_session_updated_at===undefined?null:data.public_session_updated_at),
    runner:{busy:data.runner.busy,review:data.runner.review},budget:{utc_day:b.utc_day,utc_month:b.utc_month,
      daily_limit_ms:finite(b.daily_limit_ms,3600000),monthly_limit_ms:finite(b.monthly_limit_ms,7200000),rolling_32d_limit_ms:finite(b.rolling_32d_limit_ms,7200000),
      daily_reserved_ms:finite(b.daily_reserved_ms,32*86400000),monthly_reserved_ms:finite(b.monthly_reserved_ms,32*86400000),rolling_32d_reserved_ms:finite(b.rolling_32d_reserved_ms,32*86400000)}};
}
function liveView(value){
  if(typeof value!=='string' || value.length>8192)return null;
  try{const u=new URL(value);return u.protocol==='https:' && u.hostname==='live.browser.run' && !u.username && !u.password && !u.port?u.href:null;}catch{return null;}
}
function remoteFailure(data,status){
  const messages={
    'runner-busy':'다른 클라우드 작업을 처리하고 있습니다. 작업이 끝난 뒤 상태를 다시 확인해 주세요.',
    'login-required':'새 로그인 화면에서 스페이스클라우드 로그인을 완료한 뒤 저장해 주세요.',
    'public-login-required':'고객 달력 로그인 연결을 완료한 뒤 저장해 주세요.',
    'guest-login-required':'고객 달력 로그인 연결을 완료한 뒤 저장해 주세요.',
    'login-session':'유효한 로그인 화면이 없습니다. 상태를 확인하고 로그인 다시 연결을 눌러 주세요.',
    'login-expired':'로그인 화면의 5분 유효시간이 지났습니다. 로그인 다시 연결을 눌러 주세요.',
    'daily-budget':'설정한 일별 사용 한도에 도달했습니다. 추가 실행 없이 연결을 보류합니다.',
    'monthly-budget':'설정한 월 사용 한도에 도달했습니다. 추가 실행 없이 연결을 보류합니다.',
    'rolling-budget':'설정한 최근 32일 사용 한도에 도달했습니다. 추가 실행 없이 연결을 보류합니다.',
    'close-unconfirmed':'클라우드 브라우저 종료 확인이 필요합니다. 새 작업을 보류하고 상태를 확인해 주세요.'
  };
  const error=typeof data?.error==='string' && Object.hasOwn(messages,data.error)?data.error:'cloud-unavailable';
  return failure(messages[error],status===429?429:status===409?409:503,error);
}
async function proxy(env,action,loginId,purpose='host'){
  const cfg=config(env);if(!cfg)return failure('클라우드 관리자 연결 설정이 필요합니다. 연결 주소와 관리자 인증 설정을 확인해 주세요.',503,'cloud-not-configured');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  try{
    const path=action==='status'?'/status':(purpose==='guest'?'/guest-login/':'/login/')+action;
    const response=await fetch(cfg.origin+path,{method:action==='status'?'GET':'POST',redirect:'manual',signal:controller.signal,
      headers:{Authorization:'Bearer '+cfg.token,Accept:'application/json',...(action==='status'?{}:{'Content-Type':'application/json'})},
      ...(action==='status'?{}:{body:JSON.stringify(action==='start'?{}:{login_id:loginId})})});
    if(Number(response.headers.get('content-length') || 0)>MAX_BODY)return failure();
    const text=await response.text();if(text.length>MAX_BODY)return failure();
    let data;try{data=JSON.parse(text);}catch{return failure();}
    if(!response.ok || data?.ok!==true)return remoteFailure(data,response.status);
    if(action==='status')return reply(statusFields(data,env));
    if(data.purpose!==undefined && data.purpose!==purpose)return failure();
    if(action==='start'){
      const url=liveView(data.live_view_url);
      if(!uuid(data.login_id) || !url || !Number.isSafeInteger(data.expires_at) || data.expires_at<=Date.now() || data.expires_at>Date.now()+360000)return failure();
      return reply({ok:true,purpose,login_id:data.login_id,live_view_url:url,expires_at:data.expires_at});
    }
    if(action==='save' && data.saved===true)return reply({ok:true,purpose,saved:true,message:'클라우드 로그인 상태를 암호화하여 저장했습니다.'});
    if(action==='cancel' && data.cancelled===true)return reply({ok:true,purpose,cancelled:true,message:'로그인 화면을 종료했습니다.'});
    return failure();
  }catch{return failure();}finally{clearTimeout(timer);}
}
export async function onRequestGet({request,env}){
  const denied=await adminGate(request,env,{needDb:false});if(denied)return denied;
  return proxy(env,'status');
}
export async function onRequestPost({request,env}){
  const denied=await adminGate(request,env,{needDb:false});if(denied)return denied;
  if(!sameOrigin(request) || (request.headers.get('origin') && request.headers.get('origin')!==new URL(request.url).origin))return failure('관리자 홈페이지에서 다시 진행해 주세요.',403,'origin');
  let body;try{if(Number(request.headers.get('content-length') || 0)>4096)return failure('입력값을 확인해 주세요.',413,'invalid');const text=await request.text();if(text.length>4096)return failure('입력값을 확인해 주세요.',413,'invalid');body=JSON.parse(text);}catch{return failure('입력값을 확인해 주세요.',400,'invalid');}
  if(!body || typeof body!=='object' || Array.isArray(body) || !['start','save','cancel'].includes(body.action)
    || (body.purpose!==undefined && !['host','guest'].includes(body.purpose))
    || (body.action!=='start' && !uuid(body.login_id)))return failure('진행할 작업과 로그인 화면을 확인해 주세요.',400,'invalid');
  return proxy(env,body.action,body.login_id,body.purpose===undefined?'host':body.purpose);
}
