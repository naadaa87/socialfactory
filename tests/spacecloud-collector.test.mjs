import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../tools/spacecloud-collector/background.js',import.meta.url),'utf8');
function harness(initial={}){let saved={},clicked,updated,handler;const local={settings:initial};let alarmHandler;const requests=[],removed=[],created=[];const updates=[],badges=[],injected=[],alarmCalls=[],alerts=[];let frameRemovals=0,tabStatus='complete';
 const chrome={notifications:{async create(...args){alerts.push(args);}},alarms:{async get(){return null;},async create(...args){alarmCalls.push(args);},async clear(){},onAlarm:{addListener(fn){alarmHandler=fn;}}},storage:{local:{async setAccessLevel(){},async get(k){return {[k]:local[k]};},async set(x){Object.assign(local,x);}},session:{async get(k){return {[k]:saved[k]};},async set(x){Object.assign(saved,x);},async remove(k){delete saved[k];}}},action:{onClicked:{addListener(fn){clicked=fn;}},async setBadgeText(x){badges.push(x);}},tabs:{async create(x){created.push(x);return {id:7,status:'complete'};},async get(){return {id:7,status:tabStatus,url:'https://partner.spacecloud.kr/report/draft?page=1'};},async remove(id){removed.push(id);},onUpdated:{addListener(fn){updated=fn;}},async update(id,x){updates.push([id,x]);}},scripting:{async executeScript(x){injected.push(x);if(frameRemovals-->0)throw Error('Frame with ID 0 was removed.');}},runtime:{id:'test-id',getURL:p=>'chrome-extension://test-id/'+p,onInstalled:{addListener(){}},onStartup:{addListener(){}},async openOptionsPage(){},onMessage:{addListener(fn){handler=fn;}}}};
 vm.runInNewContext(code,{chrome,URL,console,setTimeout:fn=>fn(),fetch:async(url,opt)=>{requests.push(JSON.parse(opt.body));return {ok:true,async json(){return JSON.parse(opt.body).action==='pair'?{ok:true,token:'scoped-test-token',expires_at:Date.now()+86400000}:{ok:true,counts:{added:1,refunded:0,review:0}};}};}});return {local,requests,removed,created,alarmCalls,alerts,frameRemovals:n=>{frameRemovals=n;},tabStatus:x=>{tabStatus=x;},options:m=>new Promise(resolve=>handler(m,{id:'test-id',url:'chrome-extension://test-id/options.html'},resolve)),alarm:()=>alarmHandler({name:'sf-sync-15m'}),saved,updates,badges,injected,start:tab=>clicked(tab),updated:(id,x)=>updated(id,x,{url:'https://partner.spacecloud.kr/report/draft?page=1'}),message:(m,url='https://partner.spacecloud.kr/report/draft?page=1')=>new Promise(resolve=>handler(m,{url,tab:{id:7}},resolve))};}
test('collector preserves filters, traverses pages, deduplicates IDs and removes temporary payment data',async()=>{
 const h=harness();await h.start({id:7,url:'https://partner.spacecloud.kr/report/draft?space=123&page=2'});assert.equal(h.updates.length,0);assert.equal(h.injected.length,1);
 await h.updated(7,{status:'complete'});assert.equal(h.injected.length,2);
 const row={reservation_id:'123',amount:40000,refund_amount:0};
 const a=await h.message({type:'page',rows:[row],next:'/report/draft?space=123&page=2'},'https://partner.spacecloud.kr/report/draft?space=123&page=1');assert(a.next);
 const b=await h.message({type:'page',rows:[row,{...row,reservation_id:'456'}],next:null},'https://partner.spacecloud.kr/report/draft?space=123&page=2');assert.equal(h.updates.length,0);assert.equal(b.file.rows.length,2);assert.equal(b.file.pages,2);assert.equal(h.saved.job,undefined);
});
test('collector fails closed on page loops, changed filters and conflicting payment values',async()=>{
 for(const kind of ['loop','filter','amount']){
  const h=harness();await h.start({id:7,url:'https://partner.spacecloud.kr/report/draft?page=1'});
  if(kind==='amount')await h.message({type:'page',rows:[{reservation_id:'1',amount:10}],next:'/report/draft?page=2'});
  const m=kind==='loop'?{type:'page',rows:[],next:'/report/draft?page=1'}:kind==='filter'?{type:'page',rows:[],next:'/report/draft?space=changed&page=2'}:{type:'page',rows:[{reservation_id:'1',amount:20}],next:null};
  const r=await h.message(m,kind==='amount'?'https://partner.spacecloud.kr/report/draft?page=2':undefined);assert.equal(r.ok,false);assert.equal(h.saved.job,undefined);
 }
});

test('equal reservation fields in different property order are not treated as changed payments',async()=>{
 const h=harness();await h.start({id:7,url:'https://partner.spacecloud.kr/report/draft?page=1'});
 await h.message({type:'page',rows:[{reservation_id:'1',amount:40000,refund_amount:0}],next:'/report/draft?page=2'});
 const r=await h.message({type:'page',rows:[{amount:40000,refund_amount:0,reservation_id:'1'}],next:null},'https://partner.spacecloud.kr/report/draft?page=2');
 assert.equal(r.ok,true);assert.equal(r.file.rows.length,1);
});

test('collector shares prior page identity and rejects a stale table sent as the next page',async()=>{
 const h=harness();await h.start({id:7,url:'https://partner.spacecloud.kr/report/draft?page=1'});
 await h.message({type:'page',rows:[{reservation_id:'1',amount:10}],signature:'1|2',next:'/report/draft?page=2'});
 const state=await h.message({type:'state'},'https://partner.spacecloud.kr/report/draft?page=2');assert.equal(state.previousSignature,'1|2');
 const result=await h.message({type:'page',rows:[],signature:'1|2',next:null},'https://partner.spacecloud.kr/report/draft?page=2');assert.equal(result.ok,false);assert.match(result.error,/이전 페이지/);assert.equal(h.saved.job,undefined);
});

test('15-minute alarms serialize automatic runs, collect draft+account, and send directly without a download',async()=>{
 const h=harness({enabled:true,token:'test-scoped-sync-token',since:'2020-01-01'});
 await Promise.all([h.alarm(),h.alarm()]);assert.equal(h.created.length,1);assert.equal(h.created[0].active,false);
 const state=await h.message({type:'state'});assert.equal(state.auto,true);assert.equal(state.source,'draft');assert(state.configure);
 await h.message({type:'configured'});
 const row={reservation_id:'123',venue:'소셜팩토리 건대 (초특가)',use_date:'2026-10-24',end_date:'2026-10-24',paid_at:'2026-10-23',amount:40000,refund_amount:0};
 const step=await h.message({type:'page',rows:[row],signature:'123',next:null});assert.equal(step.switchTo,'https://partner.spacecloud.kr/report/account');assert.equal(h.requests.length,0);
 const end=await h.message({type:'page',rows:[{...row,refund_amount:10000}],signature:'123',next:null,pageUrl:'https://partner.spacecloud.kr/report/account'},'https://partner.spacecloud.kr/report/account');
 assert(end.synced);assert(!end.file);assert.equal(h.requests.length,1);assert.equal(h.requests[0].complete,true);assert.equal(h.requests[0].rows.length,1);assert.equal(h.requests[0].rows[0].refund_amount,10000);assert.equal(h.removed.length,1);assert.equal(h.saved.job,undefined);
});
test('login expiry sends a server error without submitting partial rows and closes only the owned tab',async()=>{
 const h=harness({enabled:true,token:'test-token'});await h.alarm();await h.message({type:'error',status:'login_required',message:'login'});
 assert.equal(h.requests.length,1);assert.equal(h.requests[0].action,'error');assert.equal(h.requests[0].status,'login_required');assert.equal(h.removed.length,1);assert.equal(h.saved.job,undefined);
});

test('removed navigation frame retries injection without cancelling an automatic job',async()=>{
 const h=harness({enabled:true,token:'test-token'});h.frameRemovals(1);await h.alarm();
 assert.equal(h.injected.length,2);assert(h.saved.job);assert.equal(h.local.lastResult,undefined);assert.equal(h.removed.length,0);
});
test('removed frame while tab is loading waits for the next complete event',async()=>{
 const h=harness({enabled:true,token:'test-token'});h.frameRemovals(1);h.tabStatus('loading');await h.alarm();
 assert.equal(h.injected.length,1);assert(h.saved.job);h.tabStatus('complete');await h.updated(7,{status:'complete'});
 assert.equal(h.injected.length,2);assert(h.saved.job);assert.equal(h.local.lastResult,undefined);
});

test('options pairing enables a 15-minute alarm without exposing the key to content contexts; expiry alerts are deduplicated',async()=>{
 const h=harness();const r=await h.options({type:'connect',code:'test-code',since:'2020-01-01'});assert(r.ok);assert.equal(h.local.settings.enabled,true);assert(h.alarmCalls.some(x=>x[1].periodInMinutes===15));
 const settings=await h.options({type:'settings'});assert(settings.connected);assert(!JSON.stringify(settings).includes('scoped-test-token'));
 const untrusted=await h.message({type:'connect',code:'stolen',since:'2020-01-01'});assert.equal(untrusted.ok,false);
 await h.message({type:'error',status:'login_required'});await h.alarm();await h.message({type:'error',status:'login_required'});assert.equal(h.alerts.length,1);
 const paused=await h.options({type:'pause'});assert(paused.ok);assert.equal(h.local.settings.enabled,false);
});
