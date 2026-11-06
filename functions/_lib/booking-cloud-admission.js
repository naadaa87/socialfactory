import { cloudRunnerOrigin } from './spacecloud-runner.js';

// One room needs an initial block, checkout verification and post-payment
// verification. This is admission headroom, not a reservation of future usage.
export const MINIMUM_BOOKING_BROWSER_MS = 3 * (120000 + 60000);
const TIMEOUT_MS=5000,MAX_BODY=16384;
const unavailable=()=>Object.assign(new Error('온라인 예약 연동을 점검 중입니다. 잠시 후 다시 시도하거나 카카오톡으로 문의해 주세요.'),{code:'cloud-admission-unavailable',status:503});
const integer=value=>Number.isSafeInteger(value) && value>=0;

function ready(data,now) {
  if(data?.ok!==true || data.enabled!==true || data.allow_writes!==true || data.login_saved!==true || data.public_login_saved!==true
    || !data.runner || data.runner.review!==false || typeof data.runner.busy!=='boolean' || !data.budget)return false;
  const budget=data.budget,day=new Date(now).toISOString().slice(0,10);
  if(budget.utc_day!==day || budget.utc_month!==day.slice(0,7))return false;
  return [
    ['daily_limit_ms','daily_reserved_ms',5400000],
    ['monthly_limit_ms','monthly_reserved_ms',7200000],
    ['rolling_32d_limit_ms','rolling_32d_reserved_ms',7200000]
  ].every(([limit,used,maximum])=>integer(budget[limit]) && budget[limit]<=maximum && integer(budget[used])
    && budget[limit]-budget[used]>=MINIMUM_BOOKING_BROWSER_MS);
}

async function boundedJson(response) {
  if(Number(response.headers.get('content-length') || 0)>MAX_BODY)throw unavailable();
  const reader=response.body?.getReader();if(!reader)throw unavailable();
  const chunks=[];let bytes=0;
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BODY)throw unavailable();chunks.push(value);}
  }catch(error){try{await reader.cancel();}catch{}throw error;}
  const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(body));
}

/** Fail closed before accepting a new room hold; no browser or provider call. */
export async function assertCloudAdmission(env,{fetcher=(...args)=>globalThis.fetch(...args),now=()=>Date.now()}={}) {
  if(env.SPACECLOUD_SYNC_ENABLED!=='true')return;
  const origin=cloudRunnerOrigin(env.SPACECLOUD_RUNNER_URL),token=env.CLOUD_ADMIN_TOKEN;
  if(!origin || typeof token!=='string' || !/^[A-Za-z0-9._~+\/=-]{32,512}$/.test(token))throw unavailable();
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  try {
    const response=await fetcher(origin+'/status',{method:'GET',redirect:'manual',signal:controller.signal,
      headers:{Authorization:'Bearer '+token,Accept:'application/json','Cache-Control':'no-store'}});
    if(!response.ok || !ready(await boundedJson(response),now()))throw unavailable();
  }catch{throw unavailable();}finally{clearTimeout(timer);}
}
