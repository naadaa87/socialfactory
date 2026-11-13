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
