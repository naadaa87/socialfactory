import {collectHostCalendarAPI,hostKeys,parseHostMonth} from './calendar.mjs';
import {hostAPIHeaders} from './host-auth.mjs';
import {ROOMS} from '../../integrations/spacecloud-worker/spacecloud-ui.mjs';
const API='https://api.spacecloud.kr',HOST='https://partner.spacecloud.kr';
const problem=(code,retry=false,retry_after_ms=60000)=>Object.assign(new Error(code),{code,retry,retry_after_ms});
const validId=id=>typeof id==='string'&&/^\d{1,20}$/.test(id);
const same=(a,b)=>a&&b&&a.space===b.space&&a.date===b.date&&a.start_min===b.start_min&&a.end_min===b.end_min&&a.title===b.title;
const overlaps=(a,b)=>{
 const start=r=>Date.parse(r.date+'T00:00:00+09:00')+r.start_min*60000;
 return a.space===b.space&&start(a)<start(b)+(b.end_min-b.start_min)*60000&&start(b)<start(a)+(a.end_min-a.start_min)*60000;
};
const addDay=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export async function sourceRequest(config,body,{fetcher=fetch}={}) {
 const url=new URL('/api/internal/spacecloud-source',config.origin);
 const r=await fetcher(url.href,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),
  headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await r.json();if(!r.ok||data.ok!==true)throw problem('source-control');return data;
}

// Only host-added external_schedules are writable. Paid reservations never enter
// this executor. Contact details are read transiently and kept at SpaceCloud.
export async function executeSourceJob(job,savedState,{fetcher=fetch,checkpoint,live=()=>{},beforeWrite=async()=>{},onState=async()=>{}}={}) {
 const before=job?.before,target=job?.target;
 if(!validId(before?.id)||!ROOMS[before.space]||!['update','cancel'].includes(job.action)||
  typeof before.title!=='string'||/^SFWEB:/.test(before.title)||!/^\d{4}-\d{2}-\d{2}$/.test(before.date)||
  !/^[A-Za-z0-9_-]{16,64}$/.test(job.id)||typeof checkpoint!=='function')throw problem('source-plan');
 if(job.action==='update'&&(!target||!ROOMS[target.space]||target.title!==before.title||
  !/^\d{4}-\d{2}-\d{2}$/.test(target.date)||!Number.isInteger(target.start_min)||!Number.isInteger(target.end_min)||
  target.start_min<0||target.start_min>=1440||target.start_min%60||target.end_min%60||target.end_min<=target.start_min||target.end_min>1440))throw problem('source-plan');
 let state=structuredClone(savedState),phase=job.phase,resultId=job.result_id;
 const marker='[SFEDIT:'+job.id+']';
 const check=async(next,extra={})=>{live();await checkpoint({action:'checkpoint',phase:next,...extra});phase=next;live();};
 const read=async(points)=>{
  const scopes=[...new Map(points.flatMap(p=>[-1,0,1].map(n=>{
   const month=addDay(p.date,n).slice(0,7);return [p.space+'|'+month,{space:p.space,month,product_id:String(ROOMS[p.space].product)}];
  }))).values()];
  const raw=new Map();
  const collected=await collectHostCalendarAPI(state,{scopes},{live,fetcher:async(url,options)=>{
   const response=await fetcher(url,options);
   if(response.ok&&new URL(url).pathname==='/partner/reservations/calendar')raw.set(String(url),hostKeys(await response.clone().json()));
   return response;
  }});
  if(!collected)throw problem('source-login',true);
  state=collected.state;if(collected.changed)await onState(state);
  const rows=[];
  for(const scope of collected.snapshots)for(const event of scope.events) {
   const parsed={...event,space:scope.space};
   if(event.kind==='reservation'){rows.push(parsed);continue;}
   const url=new URL('/partner/reservations/calendar',API);url.searchParams.set('year',scope.month.slice(0,4));url.searchParams.set('month',scope.month.slice(5));url.searchParams.set('product_id',scope.product_id);
   const details=raw.get(url.href)?.flatMap(cell=>cell.external_schedules||[]).filter(r=>String(r.id)===event.id)||[];
   if(details.length!==1)throw problem('source-ambiguous');
   rows.push({...parsed,raw:details[0]});
  }
  return rows;
 };
 const native=async(space,id,method,body)=>{
  live();await beforeWrite();live();const path='/partner/products/'+ROOMS[space].product+'/external_schedules'+(id?'/'+id:'');
  const user=JSON.parse(state.origins.find(o=>o.origin===HOST).localStorage.find(x=>x.name==='spacecloud__userInfo').value);
  let response;try {response=await fetcher(API+path,{method,redirect:'manual',signal:AbortSignal.timeout(12000),
   headers:{...hostAPIHeaders(state,path,user.accessToken),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
  catch {return; /* A read-back below decides whether the write was accepted. */}
  live();
  if(response.status===429)throw problem('source-rate-limit',true,Math.max(60000,(Number(response.headers.get('retry-after'))||60)*1000));
  if(response.status===401)throw problem('source-login',true);
  if(!response.ok)throw problem('source-write-rejected');
  if(method!=='DELETE') {
   let result;try {result=await response.json();}catch {return;}
   if(result?.success===false)throw problem('source-write-rejected');
  }
 };
 const bodyFor=(current,point,memo=current.raw.memo||'')=>({SDATE:point.date.replaceAll('-',''),EDATE:point.date.replaceAll('-',''),
  SHOUR:String(point.start_min/60),EHOUR:String(point.end_min/60-1),NAME:point.title,
  TEL:typeof current.raw.tel==='string'?current.raw.tel.replaceAll('-',''):String(current.raw.tel||''),MEMO:memo,
  REPEAT_TYPE:'-1',REPEAT_END_DATE:point.date.replaceAll('-','')});
 let rows=await read([before,...(target?[target]:[])]);
 const original=()=>rows.filter(r=>r.space===before.space&&r.id===before.id&&r.kind!=='reservation');
 const found=original();if(found.length>1)throw problem('source-ambiguous');
 let current=found[0];
 if(rows.filter(r=>r.kind!=='reservation'&&same(r,before)).length>1)throw problem('source-ambiguous');
 if(job.action==='cancel') {
  if(!current) {if(phase==='deleting')return {state:'succeeded'};throw problem('source-stale');}
  if(!same(current,before))throw problem('source-stale');
  if(phase==='planned')await check('deleting');
  if(phase!=='deleting')throw problem('source-phase');
  await native(before.space,before.id,'DELETE');
  rows=await read([before]);if(original().length)throw problem('source-write-unverified');
  return {state:'succeeded'};
 }
 if(before.space===target.space) {
  if(current&&same(current,target)&&phase==='writing')return {state:'succeeded'};
  if(!current||!same(current,before))throw problem('source-stale');
  if(rows.some(r=>!(r.space===before.space&&r.id===before.id&&r.kind!=='reservation')&&overlaps(r,target)))throw problem('source-conflict');
  if(phase==='planned')await check('writing');
  if(phase!=='writing')throw problem('source-phase');
  await native(before.space,before.id,'PUT',bodyFor(current,target));
  rows=await read([before,target]);const updated=original();
  if(updated.length!==1||!same(updated[0],target))throw problem('source-write-unverified');
  return {state:'succeeded'};
 }
 // Room changes use the official create + delete operations. The original is
 // retained until a uniquely marked replacement has been read back and journaled.
 const replacements=()=>rows.filter(r=>r.space===target.space&&r.kind!=='reservation'&&String(r.raw?.memo||'').split(/\r?\n/).includes(marker));
 let matches=replacements();if(matches.length>1||matches.some(r=>!same(r,target)))throw problem('source-replacement-ambiguous');
 if(phase==='planned') {
  if(!current||!same(current,before)||matches.length)throw problem('source-stale');
  if(rows.some(r=>overlaps(r,target)))throw problem('source-conflict');
  const memo=(current.raw.memo||'')+(current.raw.memo?'\n':'')+marker;
  if(memo.length>2000)throw problem('source-memo-limit');
  await check('creating');await native(target.space,null,'POST',bodyFor(current,target,memo));
  rows=await read([before,target]);matches=replacements();
 }
 if(phase==='creating') {
  if(matches.length!==1)throw problem('source-creation-uncertain');
  resultId=matches[0].id;await check('created',{result_id:resultId,result_space:target.space});
 }
 if(!validId(resultId)||matches.length!==1||matches[0].id!==resultId)throw problem('source-replacement-missing');
 if(!['created','deleting'].includes(phase))throw problem('source-phase');
 // Re-read after creation so another operator's changed original is never deleted.
 rows=await read([before,target]);matches=replacements();const remaining=original();
 if(matches.length!==1||matches[0].id!==resultId||!same(matches[0],target))throw problem('source-replacement-missing');
 if(!remaining.length&&phase==='deleting')return {state:'succeeded'};
 if(remaining.length!==1||!same(remaining[0],before))throw problem('source-stale');
 if(phase==='created')await check('deleting');
 await native(before.space,before.id,'DELETE');
 rows=await read([before,target]);matches=replacements();
 if(original().length||matches.length!==1||matches[0].id!==resultId||!same(matches[0],target))throw problem('source-write-unverified');
 return {state:'succeeded'};
}
