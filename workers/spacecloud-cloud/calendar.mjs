import { ROOMS } from '../../integrations/spacecloud-worker/spacecloud-ui.mjs';
const API='https://api.spacecloud.kr',HOST='https://partner.spacecloud.kr';
const fail=code=>Object.assign(new Error(code),{code});
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
 const events=[],seen=new Set();
 for(let i=0;i<raw.length;i++){
  const cell=raw[i],date=new Date(start+i*86400000).toISOString().slice(0,10);
  if(!cell || !Array.isArray(cell.reservations) || !Array.isArray(cell.external_schedules))throw fail('host-calendar-cell');
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
 return {...scope,events};
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
