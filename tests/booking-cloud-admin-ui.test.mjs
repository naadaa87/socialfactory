import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../js/admin-booking-cloud.js',import.meta.url),'utf8');
const id='a4a0fd92-0722-49c5-a995-64db762ac3aa';
const cloudStatus=()=>({ok:true,booking_enabled:false,enabled:true,allow_writes:true,login_saved:false,session_updated_at:null,public_login_saved:false,public_session_updated_at:null,runner:{busy:false,review:false},budget:{rolling_32d_reserved_ms:60000,rolling_32d_limit_ms:7200000,daily_reserved_ms:60000,daily_limit_ms:2700000,monthly_reserved_ms:60000,monthly_limit_ms:7200000}});
function harness(handler){
 const nodes=new Map(),calls=[],timers=new Map();let previousLoads=0,timerId=0;
 const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{textContent:'',hidden:false,disabled:false,events:{},addEventListener(name,fn){this.events[name]=fn;},removeAttribute(name){delete this[name];}});return nodes.get(selector);};
 const A={$:node,guard:()=>false,LOAD:{booking(){previousLoads++;return 'existing-booking-load';}},api(path,options={}){calls.push({path,options});return Promise.resolve().then(()=>handler(path,options));}};
 const window={SF_ADMIN:A,addEventListener(){},open(){throw Error('the login view must open only from an explicit link click');}};
 Object.defineProperty(window,'localStorage',{get(){throw Error('login sessions must not persist in storage');}});Object.defineProperty(window,'sessionStorage',{get(){throw Error('login sessions must remain in memory');}});
 vm.runInNewContext(source,{window,URL,AbortController,Date,console,setTimeout:(fn,ms)=>{const key=++timerId;timers.set(key,{fn,ms});return key;},clearTimeout:key=>timers.delete(key)});
 return {A,calls,node,timers,get previousLoads(){return previousLoads;},flush:()=>new Promise(resolve=>setImmediate(resolve))};
}
test('cloud status loads only with the reservation view and preserves its existing loader',async()=>{
 const h=harness(()=>cloudStatus());assert.equal(h.calls.length,0);
 assert.equal(h.A.LOAD.booking(),'existing-booking-load');await h.flush();assert.equal(h.previousLoads,1);assert.equal(h.calls.length,1);assert.equal(h.calls[0].path,'/api/admin/booking-cloud');assert(!h.calls[0].options.method);
 assert.equal(h.node('#booking-cloud-start').disabled,false);assert.equal(h.node('#booking-cloud-guest-start').disabled,false);assert(h.node('#booking-cloud-budget').textContent.includes('한도 120분'));assert(h.node('#booking-cloud-status').textContent.includes('접수 준비 중'));
 assert.equal([...h.timers.values()].some(t=>t.ms<40000),false,'no frequent status polling');
});
test('reconnect exposes a private explicit link, then saves only that in-memory session',async()=>{
 let saved=false;
 const h=harness((path,options)=>{
  if(!options.method)return {...cloudStatus(),login_saved:saved};
  if(options.body.action==='start'){assert.equal(options.body.purpose,'host');return {ok:true,purpose:'host',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=private-view',expires_at:Date.now()+300000};}
  assert.equal(options.body.purpose,'host');assert.equal(options.body.action,'save');assert.equal(options.body.login_id,id);saved=true;return {ok:true,saved:true};
 });
 h.A.LOAD.booking();await h.flush();h.node('#booking-cloud-start').events.click();await h.flush();
 assert.equal(h.node('#booking-cloud-login').hidden,false);assert.equal(h.node('#booking-cloud-view').href,'https://live.browser.run/ui/view?jwt=private-view');assert(h.node('#booking-cloud-message').textContent.includes('로그인 저장'));assert.equal(h.node('#booking-cloud-save').disabled,false);
 h.node('#booking-cloud-save').events.click();await h.flush();assert.equal(saved,true);assert.equal(h.node('#booking-cloud-login').hidden,true);assert.equal(h.node('#booking-cloud-view').href,undefined);assert(h.node('#booking-cloud-status').textContent.includes('로그인 상태 저장됨'));
 const posts=h.calls.filter(c=>c.options.method==='POST');assert.equal(posts.length,2);assert.equal(JSON.stringify(posts).includes('private-view'),false,'the Live View bearer URL is not sent back or persisted');
});
test('a malformed private view response never creates an external login link',async()=>{
 const h=harness((path,options)=>!options.method?cloudStatus():{ok:true,purpose:'host',login_id:id,live_view_url:'https://live.browser.run.evil.test/?jwt=private',expires_at:Date.now()+300000});
 h.A.LOAD.booking();await h.flush();h.node('#booking-cloud-start').events.click();await h.flush();
 assert.equal(h.node('#booking-cloud-login').hidden,true);assert.equal(h.node('#booking-cloud-view').href,undefined);assert(h.node('#booking-cloud-message').textContent.includes('확인하지 못했습니다'));
});

test('guest login has a distinct status and saves only the guest purpose kept with the private receipt',async()=>{
 let guestSaved=false;const h=harness((path,options)=>{
  if(!options.method)return {...cloudStatus(),login_saved:true,session_updated_at:Date.now(),public_login_saved:guestSaved,public_session_updated_at:guestSaved?Date.now():null};
  assert.equal(options.body.purpose,'guest');
  if(options.body.action==='start')return {ok:true,purpose:'guest',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=guest-view',expires_at:Date.now()+300000};
  assert.equal(options.body.action,'save');assert.equal(options.body.login_id,id);guestSaved=true;return {ok:true,purpose:'guest',saved:true};
 });
 h.A.LOAD.booking();await h.flush();assert(h.node('#booking-cloud-status').textContent.includes('호스트 로그인 상태 저장됨'));assert(h.node('#booking-cloud-status').textContent.includes('고객 달력 로그인 연결 필요'));
 h.node('#booking-cloud-guest-start').events.click();await h.flush();assert(h.node('#booking-cloud-view').textContent.includes('고객 달력'));assert(h.node('#booking-cloud-message').textContent.includes('고객용 계정'));assert.equal(h.node('#booking-cloud-start').disabled,true);
 h.node('#booking-cloud-save').events.click();await h.flush();assert.equal(guestSaved,true);assert(h.node('#booking-cloud-status').textContent.includes('고객 달력 로그인 상태 저장됨'));assert.equal(h.node('#booking-cloud-view').href,undefined);
 assert.equal(h.calls.filter(c=>c.options.method==='POST').every(c=>c.options.body.purpose==='guest'),true);
});
test('cancelling a guest login retains its purpose and does not send the private view URL',async()=>{
 let cancelled=false;const h=harness((path,options)=>{
  if(!options.method)return cloudStatus();
  assert.equal(options.body.purpose,'guest');
  if(options.body.action==='start')return {ok:true,purpose:'guest',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=guest-private',expires_at:Date.now()+300000};
  assert.equal(options.body.action,'cancel');assert.deepEqual(JSON.parse(JSON.stringify(options.body)),{action:'cancel',purpose:'guest',login_id:id});cancelled=true;return {ok:true,purpose:'guest',cancelled:true};
 });
 h.A.LOAD.booking();await h.flush();h.node('#booking-cloud-guest-start').events.click();await h.flush();h.node('#booking-cloud-cancel').events.click();await h.flush();
 assert.equal(cancelled,true);assert.equal(h.node('#booking-cloud-login').hidden,true);assert(!JSON.stringify(h.calls).includes('guest-private'));
});
