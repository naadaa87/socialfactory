import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../js/admin-booking-cloud.js',import.meta.url),'utf8');
const id='a4a0fd92-0722-49c5-a995-64db762ac3aa';
const cloudStatus=()=>({ok:true,booking_enabled:false,enabled:true,allow_writes:true,login_saved:false,session_updated_at:null,public_login_saved:false,public_session_updated_at:null,public_candidate_saved:false,public_candidate_updated_at:null,public_candidate_expires_at:null,runner:{busy:false,review:false},budget:{rolling_32d_reserved_ms:60000,rolling_32d_limit_ms:7200000,daily_reserved_ms:60000,daily_limit_ms:2700000,monthly_reserved_ms:60000,monthly_limit_ms:7200000}});
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
  if(options.body.action==='start'){assert.equal(options.body.provider,'kakao');return {ok:true,purpose:'guest',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=guest-view',expires_at:Date.now()+300000};}
  assert.equal(options.body.action,'save');assert.equal(options.body.login_id,id);guestSaved=true;return {ok:true,purpose:'guest',saved:true};
 });
 h.A.LOAD.booking();await h.flush();assert(h.node('#booking-cloud-status').textContent.includes('호스트 로그인 상태 저장됨'));assert(h.node('#booking-cloud-status').textContent.includes('고객 달력 로그인 연결 필요'));
 h.node('#booking-cloud-guest-start').events.click();await h.flush();assert(h.node('#booking-cloud-view').textContent.includes('고객 달력'));assert(h.node('#booking-cloud-message').textContent.includes('카카오로 로그인'));assert.equal(h.node('#booking-cloud-start').disabled,true);
 h.node('#booking-cloud-save').events.click();await h.flush();assert.equal(guestSaved,true);assert(h.node('#booking-cloud-status').textContent.includes('고객 달력 로그인 상태 저장됨'));assert.equal(h.node('#booking-cloud-view').href,undefined);
 assert.equal(h.calls.filter(c=>c.options.method==='POST').every(c=>c.options.body.purpose==='guest'),true);
});
test('cancelling a guest login retains its purpose and does not send the private view URL',async()=>{
 let cancelled=false;const h=harness((path,options)=>{
  if(!options.method)return cloudStatus();
  assert.equal(options.body.purpose,'guest');
  if(options.body.action==='start'){assert.equal(options.body.provider,'kakao');return {ok:true,purpose:'guest',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=guest-private',expires_at:Date.now()+300000};}
  assert.equal(options.body.action,'cancel');assert.deepEqual(JSON.parse(JSON.stringify(options.body)),{action:'cancel',purpose:'guest',login_id:id});cancelled=true;return {ok:true,purpose:'guest',cancelled:true};
 });
 h.A.LOAD.booking();await h.flush();h.node('#booking-cloud-guest-start').events.click();await h.flush();h.node('#booking-cloud-cancel').events.click();await h.flush();
 assert.equal(cancelled,true);assert.equal(h.node('#booking-cloud-login').hidden,true);assert(!JSON.stringify(h.calls).includes('guest-private'));
});

test('a retryable guest save keeps the same receipt and recovery link without extending its original deadline',async()=>{
 const original=Date.now()+240000;let saves=0;const h=harness((path,options)=>{
  if(!options.method)return {...cloudStatus(),public_candidate_saved:true,public_candidate_updated_at:Date.now(),public_candidate_expires_at:Date.now()+1800000};
  if(options.body.action==='start')return {ok:true,purpose:'guest',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=original-private',expires_at:original};
  assert.deepEqual(JSON.parse(JSON.stringify(options.body)),{action:'save',purpose:'guest',login_id:id});saves++;
  if(saves===1)throw Object.assign(new Error('not yet verified'),{status:409,data:{error:'guest-login-validation',message:'복원 확인 필요',retryable:true,expires_at:original+60000,recovery_view_url:'https://live.browser.run/ui/view?jwt=recovery-private'}});
  return {ok:true,purpose:'guest',saved:true};
 });
 h.A.LOAD.booking();await h.flush();h.node('#booking-cloud-guest-start').events.click();await h.flush();
 const deadline=[...h.timers].find(([,t])=>t.ms>200000),label=h.node('#booking-cloud-expiry').textContent;
 h.node('#booking-cloud-save').events.click();await h.flush();assert.equal(h.node('#booking-cloud-login').hidden,false);assert.equal(h.node('#booking-cloud-save').disabled,false);assert.equal(h.node('#booking-cloud-view').href,'https://live.browser.run/ui/view?jwt=recovery-private');
 assert.equal(h.node('#booking-cloud-expiry').textContent,label);assert(h.timers.has(deadline[0]),'the original expiry timer is preserved');assert(h.node('#booking-cloud-message').textContent.includes('유지'));assert.equal(h.node('#booking-cloud-revalidate').disabled,true,'an active login is retried in place, not another browser');
 h.node('#booking-cloud-save').events.click();await h.flush();assert.equal(saves,2);assert.equal(h.node('#booking-cloud-login').hidden,true);assert.equal(h.calls.filter(c=>c.options.body?.action==='start').length,1);assert(!JSON.stringify(h.calls).includes('recovery-private'));
});
test('unknown save errors preserve the live receipt, and an unsafe recovery URL cannot replace it',async()=>{
 const h=harness((path,options)=>{
  if(!options.method)return cloudStatus();
  if(options.body.action==='start')return {ok:true,purpose:'guest',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=keep-private',expires_at:Date.now()+240000};
  throw Object.assign(new Error('network'),{data:{retryable:true,expires_at:Date.now()+300000,recovery_view_url:'https://live.browser.run.evil.test/?jwt=bad'}});
 });
 h.A.LOAD.booking();await h.flush();h.node('#booking-cloud-guest-start').events.click();await h.flush();h.node('#booking-cloud-save').events.click();await h.flush();
 assert.equal(h.node('#booking-cloud-login').hidden,false);assert.equal(h.node('#booking-cloud-view').href,'https://live.browser.run/ui/view?jwt=keep-private');assert.equal(h.node('#booking-cloud-save').disabled,false);assert.equal(h.calls.filter(c=>c.options.method==='POST').length,2);
});
test('a saved candidate is never shown as verified and revalidation is an explicit guest-only request without UUID',async()=>{
 let checked=false;const h=harness((path,options)=>{
  if(!options.method)return {...cloudStatus(),booking_enabled:true,login_saved:true,public_candidate_saved:!checked,public_candidate_updated_at:Date.now(),public_candidate_expires_at:Date.now()+1800000,public_login_saved:checked};
  assert.deepEqual(JSON.parse(JSON.stringify(options.body)),{action:'revalidate',purpose:'guest'});checked=true;return {ok:true,purpose:'guest',saved:true};
 });
 h.A.LOAD.booking();await h.flush();assert(h.node('#booking-cloud-status').textContent.includes('보관됨 · 복원 확인 필요'));assert(!h.node('#booking-cloud-status').textContent.includes('접수 중'));assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);assert.equal(h.node('#booking-cloud-revalidate').hidden,false);
 h.node('#booking-cloud-revalidate').events.click();await h.flush();assert.equal(checked,true);assert(h.node('#booking-cloud-status').textContent.includes('고객 달력 로그인 상태 저장됨'));assert.equal(h.node('#booking-cloud-revalidate').hidden,true);assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);
});
test('pending revalidation preserves the unverified state and does not issue another browser request automatically',async()=>{
 const h=harness((path,options)=>!options.method?{...cloudStatus(),public_candidate_saved:true,public_candidate_expires_at:Date.now()+1800000}:{ok:true,purpose:'guest',pending:true,message:'복원 상태 확인 중'});
 h.A.LOAD.booking();await h.flush();h.node('#booking-cloud-revalidate').events.click();await h.flush();assert(h.node('#booking-cloud-message').textContent.includes('복원 상태 확인 중'));assert(h.node('#booking-cloud-status').textContent.includes('복원 확인 필요'));
 h.node('#booking-cloud-refresh').events.click();await h.flush();assert.equal(h.calls.filter(c=>c.options.method==='POST').length,1);assert.equal(h.node('#booking-cloud-login').hidden,true);
});

test('a failed save cannot keep the private login link after its original expiry or start a replacement automatically',async t=>{
 let now=Date.parse('2026-11-07T10:00:00Z');t.mock.method(Date,'now',()=>now);const original=now+240000;
 const h=harness((path,options)=>{
  if(!options.method)return {...cloudStatus(),public_candidate_saved:true,public_candidate_expires_at:now+1800000};
  if(options.body.action==='start')return {ok:true,purpose:'guest',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=expires-private',expires_at:original};
  throw Object.assign(new Error('incomplete'),{data:{error:'guest-login-incomplete',retryable:true,expires_at:original}});
 });
 h.A.LOAD.booking();await h.flush();h.node('#booking-cloud-guest-start').events.click();await h.flush();h.node('#booking-cloud-save').events.click();await h.flush();
 const deadline=[...h.timers].find(([,timer])=>timer.ms===240000);assert(deadline);now=original+1;deadline[1].fn();await h.flush();
 assert.equal(h.node('#booking-cloud-login').hidden,true);assert.equal(h.node('#booking-cloud-view').href,undefined);assert.equal(h.node('#booking-cloud-save').disabled,true);assert.equal(h.node('#booking-cloud-revalidate').hidden,false);assert.equal(h.calls.filter(c=>c.options.method==='POST').length,2);
});

test('public-api-v1 mode needs no guest login, hides its controls and never launches an authentication request',async()=>{
 const h=harness(()=>({...cloudStatus(),booking_enabled:true,login_saved:true,public_login_saved:false,public_candidate_saved:true,public_verification:{mode:'public-api-v1',configured:true}}));
 h.A.LOAD.booking();await h.flush();assert(h.node('#booking-cloud-status').textContent.includes('공개 일정 조회 사용 · 고객 로그인 불필요'));assert(h.node('#booking-cloud-status').textContent.includes('접수 중'));assert.equal(h.node('#booking-cloud-guest-start').hidden,true);assert.equal(h.node('#booking-cloud-revalidate').hidden,true);assert.equal(h.node('#booking-cloud-start').hidden,false);
 h.node('#booking-cloud-guest-start').events.click();await h.flush();h.node('#booking-cloud-revalidate').events.click();await h.flush();assert.equal(h.calls.filter(c=>c.options.method==='POST').length,0);
});
test('an unsupported explicit verifier is not presented as ready even when a guest profile was saved',async()=>{
 const h=harness(()=>({...cloudStatus(),booking_enabled:true,login_saved:true,public_login_saved:true,public_verification:{mode:'unsupported',configured:false}}));
 h.A.LOAD.booking();await h.flush();assert(h.node('#booking-cloud-status').textContent.includes('조회 방식 설정 확인 필요'));assert(!h.node('#booking-cloud-status').textContent.includes('접수 중'));assert.equal(h.node('#booking-cloud-guest-start').hidden,true);assert.equal(h.node('#booking-cloud-revalidate').hidden,true);
});
