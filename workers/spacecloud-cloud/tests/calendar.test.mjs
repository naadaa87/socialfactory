import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHostMonth,collectHostCalendar} from '../calendar.mjs';
const scope={space:'r2',month:'2026-11',product_id:'140235'};
const grid=()=>Array.from({length:35},()=>({reservations:[],external_schedules:[]}));
test('host API inclusive hours match the official calendar and only needed manual data is retained',()=>{
 const raw=grid();raw[12].external_schedules=[{id:55,symd:'20261113',shour:10,ehour:13,name:'고객',phone:'PRIVATE_PHONE',memo:'PRIVATE_MEMO'}];
 assert.deepEqual(parseHostMonth(raw,scope).events,[{id:'55',date:'2026-11-13',start_min:600,end_min:840,title:'고객'}]);
 raw[13].external_schedules=[{id:56,symd:'20261114',shour:23,ehour:0,name:'심야'}];
 assert.equal(parseHostMonth(raw,scope).events[1].end_min,1500);
 assert(!JSON.stringify(parseHostMonth(raw,scope)).includes('PRIVATE'));
});
test('incomplete grids, unexpected dates, invalid hours and non-array responses fail closed',()=>{
 for(const raw of [[],{},grid().slice(1)])assert.throws(()=>parseHostMonth(raw,scope));
 for(const extra of [{symd:'20261112'},{shour:24},{ehour:99},{id:'invalid'}]){
  const raw=grid();raw[12].external_schedules=[{id:55,symd:'20261113',shour:10,ehour:13,name:'고객',...extra}];assert.throws(()=>parseHostMonth(raw,scope));
 }
});
test('collector restores login via the official app and performs only scoped GET requests',async()=>{
 const requests=[],raw=grid();let predicate,closed=false;
 const context={newPage:async()=>({setDefaultTimeout(){},waitForResponse(check){predicate=check;return Promise.resolve({status:()=>200,request:()=>({headers:()=>({authorization:'PRIVATE_AUTH'})})});},async goto(url){assert(url.startsWith('https://partner.spacecloud.kr/reservation-calendar?'));}}),request:{async get(url,options){requests.push({url,options});return {status:()=>200,json:async()=>raw};}}};
 const result=await collectHostCalendar(context,{scopes:[scope]},()=>assert.equal(closed,false));
 assert.equal(result.length,1);assert.equal(requests.length,1);
 const r=requests[0];assert.equal(new URL(r.url).origin,'https://api.spacecloud.kr');assert.equal(new URL(r.url).searchParams.get('product_id'),'140235');assert.equal(r.options.maxRedirects,0);
 assert(predicate({url:()=>r.url,request:()=>({method:()=> 'GET'})}));assert(!predicate({url:()=>r.url.replace('api.spacecloud.kr','evil.test'),request:()=>({method:()=> 'GET'})}));
 assert(!JSON.stringify(result).includes('PRIVATE_AUTH'));
});

test('legacy API uppercase field names are normalized just as in the official host app',()=>{
 const raw=Array.from({length:35},()=>({RESERVATIONS:[],EXTERNAL_SCHEDULES:[]}));
 raw[12].EXTERNAL_SCHEDULES=[{ID:55,SYMD:'20261113',SHOUR:10,EHOUR:13,NAME:'최신 예약'}];
 assert.equal(parseHostMonth(raw,scope).events[0].end_min,840);
});

test('normal calendar reads use the saved server profile directly, refresh expired tokens once, and never send credentials outside the official API',async()=>{
 const {collectHostCalendarAPI}=await import('../calendar.mjs');
 const saved={cookies:[],origins:[{origin:'https://partner.spacecloud.kr',localStorage:[{name:'spacecloud__userInfo',value:JSON.stringify({accessToken:'EXPIRED_PRIVATE',refreshToken:'REFRESH_PRIVATE',name:'PRIVATE_PROFILE'})}]}]};
 const scopes=[scope,{...scope,space:'r1',product_id:'140236'}],calls=[];
 const result=await collectHostCalendarAPI(saved,{scopes},{fetcher:async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin,'https://api.spacecloud.kr');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');calls.push({path:u.pathname,auth:options.headers.Authorization});
  if(u.pathname.endsWith('/get_token')){assert.equal(options.headers.Authorization,'REFRESH_PRIVATE');return new Response(JSON.stringify({token:'ROTATED_PRIVATE'}));}
  return options.headers.Authorization==='EXPIRED_PRIVATE'?new Response('',{status:401}):new Response(JSON.stringify(grid()));
 }});
 assert.equal(result.snapshots.length,2);assert.equal(calls.filter(c=>c.path.endsWith('/get_token')).length,1);
 assert.equal(JSON.parse(result.state.origins[0].localStorage[0].value).accessToken,'ROTATED_PRIVATE');
 assert.equal(JSON.parse(saved.origins[0].localStorage[0].value).accessToken,'EXPIRED_PRIVATE');
 assert(!JSON.stringify(result.snapshots).includes('PRIVATE'));
 assert.equal(await collectHostCalendarAPI({origins:[]},{scopes}),null);
});

test('normal paid reservations use host status and ID so cancelled copies cannot survive stale iCal',()=>{
 const raw=grid();raw[12].reservations=[
  {id:123,symd:'20261113',shour:10,ehour:12,rsv_stat_cd:'RSCMP',user_info:{name:'예약자*',phone:'PRIVATE_PHONE'}},
  {id:124,symd:'20261113',shour:14,ehour:15,rsv_stat_cd:'CANCELLED',user_info:{name:'취소'}},
  {id:125,symd:'20261113',eymd:'20261120',shour:9,ehour:17,rsv_stat_cd:'RSCMP',user_info:{name:'여러 날'}}
 ];
 const snapshot=parseHostMonth(raw,scope);
 assert.deepEqual(snapshot.paid_ids,['123','125']);
 assert.deepEqual(snapshot.events,[{id:'123',date:'2026-11-13',start_min:600,end_min:780,title:'예약자*',kind:'reservation'}]);
 assert(!JSON.stringify(snapshot).includes('PRIVATE_PHONE'));
});

test('rate limits retain the provider retry delay instead of initiating browser restoration',async()=>{
 const {collectHostCalendarAPI}=await import('../calendar.mjs');
 const state={origins:[{origin:'https://partner.spacecloud.kr',localStorage:[{name:'spacecloud__userInfo',value:JSON.stringify({accessToken:'private'})}]}]};
 await assert.rejects(()=>collectHostCalendarAPI(state,{scopes:[scope]},{fetcher:async()=>new Response('',{status:429,headers:{'Retry-After':'120'}})}),e=>e.code==='host-calendar-rate-limit'&&e.retry_after_ms===120000);
});
