import { ROOMS } from '../../integrations/spacecloud-worker/spacecloud-ui.mjs';
const API='https://api.spacecloud.kr',HOST='https://partner.spacecloud.kr';
const fail=code=>Object.assign(new Error(code),{code});
const rateLimit=response=>{
 const raw=response.headers.get('retry-after'),seconds=Number(raw);
 const delay=raw && Number.isFinite(seconds)?seconds*1000:raw?Date.parse(raw)-Date.now():60000;
 return Object.assign(fail('host-calendar-rate-limit'),{retry_after_ms:Math.max(30000,Number.isFinite(delay)?delay:60000)});
};
const iso=compact=>/^\d{8}$/.test(String(compact))?String(compact).replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'):String(compact);
function hostKeys(value){
 if(Array.isArray(value))return value.map(hostKeys);
 if(!value || typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).map(([key,v])=>[key.replace(/([A-Z]+)([A-Z][a-z])/g,'$1_$2').replace(/([a-z\d])([A-Z])/g,'$1_$2').replace(/[-\s]+/g,'_').toLowerCase(),hostKeys(v)]));
}
export function parseHostMonth(raw,scope){
 raw=hostKeys(raw);
 if(!Array.isArray(raw))throw fail('host-calendar-shape');
 const first=Date.parse(scope.month+'-01T00:00:00Z'),last=new Date(first);last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);
 const start=first-new Date(first).getUTCDay()*86400000,days=Math.ceil((last.getTime()-start+86400000)/604800000)*7;
 if(raw.length!==days)throw fail('host-calendar-days');
 const events=[],seen=new Set(),paidIds=new Set();
 for(let i=0;i<raw.length;i++){
  const cell=raw[i],date=new Date(start+i*86400000).toISOString().slice(0,10);
  if(!cell || !Array.isArray(cell.reservations) || !Array.isArray(cell.external_schedules))throw fail('host-calendar-cell');
  for(const row of cell.reservations){
   if(!['RSREQ','RSCFM','RSCMP','USEDC'].includes(row.rsv_stat_cd))continue;
   const id=String(row.id);
   if(!/^[0-9]{1,20}$/.test(id))throw fail('host-calendar-paid-identity');
   paidIds.add(id);
   // A multi-day layout we cannot interpret stays protected by its observed ID.
   // Never infer cancellation merely because its geometry is unsupported.
   const dateOfBooking=iso(row.symd),sh=Number(row.shour),eh=Number(row.ehour);
   if(dateOfBooking!==date || date.slice(0,7)!==scope.month || row.shour==null || row.ehour==null
    || !Number.isInteger(sh)||!Number.isInteger(eh)||sh<0||sh>23||eh<0||eh>23)continue;
   const start_min=sh*60,end_min=(eh+1+(eh+1<=sh?24:0))*60;
   const expectedEnd=new Date(Date.parse(date+'T00:00:00Z')+(end_min>=1440?86400000:0)).toISOString().slice(0,10);
   if(row.eymd && ![date,expectedEnd].includes(iso(row.eymd)))continue;
   const key='paid:'+id+'|'+date+'|'+start_min+'|'+end_min;
   if(seen.has(key))continue;seen.add(key);
   events.push({id,date,start_min,end_min,title:String(row.user_info?.name||('스페이스클라우드 예약 #'+id)).normalize('NFC').trim().slice(0,200),kind:'reservation'});
  }
  for(const row of cell.external_schedules){
   if(date.slice(0,7)!==scope.month)continue;
   if(iso(row.symd)!==date || !/^[0-9]{1,20}$/.test(String(row.id)) || typeof row.name!=='string' || !row.name.trim() || row.name.length>200)throw fail('host-calendar-manual');
   const sh=Number(row.shour),eh=Number(row.ehour);
   if(!Number.isInteger(sh)||!Number.isInteger(eh)||sh<0||sh>23||eh<0||eh>23)throw fail('host-calendar-hours');
   // The official host calendar renders ehour as its inclusive final hour.
   const start_min=sh*60,end_min=(eh+1+(eh+1<=sh?24:0))*60;
   const key=String(row.id)+'|'+date+'|'+start_min+'|'+end_min;
   if(seen.has(key))throw fail('host-calendar-duplicate');seen.add(key);
   events.push({id:String(row.id),date,start_min,end_min,title:row.name.normalize('NFC').trim()});
  }
 }
 return {...scope,events,paid_ids:[...paidIds]};
}
export async function collectHostCalendar(context,plan,live=()=>{}){
 if(!Array.isArray(plan?.scopes)||!plan.scopes.length||plan.scopes.length>180)throw fail('host-calendar-plan');
 for(const s of plan.scopes)if(!ROOMS[s.space] || String(ROOMS[s.space].product)!==s.product_id || !/^20\d{2}-\d{2}$/.test(s.month))throw fail('host-calendar-plan');
 const page=await context.newPage();page.setDefaultTimeout(15000);
 const match=r=>{try{const u=new URL(r.url());return u.origin===API && u.pathname==='/partner/reservations/calendar' && r.request().method()==='GET';}catch{return false;}};
 // Let the official application restore/refresh its own login. Reuse only the
 // resulting first-party calendar request's authorization, held in memory.
 const initial=page.waitForResponse(match,{timeout:25000});
 await page.goto(HOST+'/reservation-calendar?product=140492&space=82026',{waitUntil:'domcontentloaded',timeout:25000});
 const observed=await initial;live();
 if(observed.status()!==200)throw fail('host-calendar-login');
 const header=observed.request().headers().authorization;
 if(typeof header!=='string'||!header)throw fail('host-calendar-login');
 const result=new Array(plan.scopes.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(5,plan.scopes.length)},async()=>{
  while(cursor<plan.scopes.length){
   const index=cursor++,s=plan.scopes[index];live();
   const url=new URL(API+'/partner/reservations/calendar');url.searchParams.set('year',s.month.slice(0,4));url.searchParams.set('month',s.month.slice(5));url.searchParams.set('product_id',s.product_id);
   const response=await context.request.get(url.href,{headers:{Authorization:header,Accept:'application/json'},maxRedirects:0,timeout:20000});live();
   if(response.status()!==200)throw fail('host-calendar-http');
   result[index]=parseHostMonth(await response.json(),s);
  }
 }));
 live();return result;
}
export async function calendarRequest(config,body){
 try{const r=await fetch(config.origin+'/api/internal/spacecloud-calendar',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok || data.ok!==true)throw fail('calendar-sync-rejected');return data;}catch{throw fail('calendar-sync-rejected');}
}

// Normal calendar reads need no Browser Run session. Use only the existing
// encrypted server-side host profile and the official app's token-refresh flow.
// Never return credentials, cookies or unrelated profile fields in a receipt.
export async function collectHostCalendarAPI(savedState,plan,{fetcher=fetch,live=()=>{}}={}){
 const state=structuredClone(savedState),origin=state?.origins?.find(o=>o.origin===HOST);
 const entry=origin?.localStorage?.find(e=>e.name==='spacecloud__userInfo');
 let user;try{user=JSON.parse(entry?.value||'null');}catch{return null;}
 if(!user || typeof user.accessToken!=='string' || !user.accessToken)return null;
 for(const s of plan.scopes)if(!ROOMS[s.space]||String(ROOMS[s.space].product)!==s.product_id||!/^20\d{2}-\d{2}$/.test(s.month))throw fail('host-calendar-plan');
 const originalToken=user.accessToken;
 let refreshTask=null,failed=null;
 const check=()=>{live();if(failed)throw failed;};
 const refresh=()=>refreshTask||=(async()=>{
  check();const token=user.refreshToken||user.accessToken;
  const r=await fetcher(API+'/partner/users/get_token',{method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Authorization:token,Accept:'application/json'}});
  if(r.status===429)throw rateLimit(r);
  if(r.status!==200)throw fail('host-calendar-login');const value=await r.json();check();
  if(typeof value.token!=='string'||!value.token||value.token.length>16384)throw fail('host-calendar-login');
  user={...user,accessToken:value.token};entry.value=JSON.stringify(user);
 })();
 const snapshots=new Array(plan.scopes.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(5,plan.scopes.length)},async()=>{
  try {while(cursor<plan.scopes.length){
   const index=cursor++,s=plan.scopes[index];check();
   const url=new URL(API+'/partner/reservations/calendar');url.searchParams.set('year',s.month.slice(0,4));url.searchParams.set('month',s.month.slice(5));url.searchParams.set('product_id',s.product_id);
   const get=()=>fetcher(url.href,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Authorization:user.accessToken,Accept:'application/json'}});
   let r=await get();check();
   if(r.status===401){await refresh();r=await get();check();}
   if(r.status===429)throw rateLimit(r);
   if(r.status===401)throw fail('host-calendar-login');
   if(r.status!==200)throw fail('host-calendar-http');
   snapshots[index]=parseHostMonth(await r.json(),s);check();
  }} catch(error){failed ||= error;throw error;}
 }));
 return {snapshots,state,changed:user.accessToken!==originalToken};
}
