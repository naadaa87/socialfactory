import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequestGet as status,onRequestPost as change} from '../functions/api/admin/booking-cloud.js';
const origin='https://socialfactory.test',runner='https://spacecloud.socialfactory.workers.dev',secret='test-only-cloud-admin-token-more-than-thirty-two-characters';
const env={ADMIN_KEY:'local-test-admin',SPACECLOUD_RUNNER_URL:runner,CLOUD_ADMIN_TOKEN:secret,SPACECLOUD_SYNC_ENABLED:'false'};
const id='a4a0fd92-0722-49c5-a995-64db762ac3aa';
const request=(body,headers={})=>new Request(origin+'/api/admin/booking-cloud',{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+env.ADMIN_KEY,origin,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
const payload=()=>({ok:true,enabled:true,allow_writes:true,login_saved:true,session_updated_at:Date.now(),public_login_saved:true,public_session_updated_at:Date.now(),runner:{busy:false,review:false,private_token:secret},budget:{utc_day:'2026-11-06',utc_month:'2026-11',daily_limit_ms:5400000,monthly_limit_ms:7200000,rolling_32d_limit_ms:7200000,daily_reserved_ms:60000,monthly_reserved_ms:120000,rolling_32d_reserved_ms:120000,secret},sessionId:'PRIVATE-BROWSER-SESSION',cipher:secret});
function mock(t,fn){return t.mock.method(globalThis,'fetch',fn);}

test('cloud controls require administrator authentication and exact same-origin writes before any cloud call',async t=>{
 let calls=0;mock(t,async()=>{calls++;throw Error('should not reach cloud');});
 assert.equal((await status({env,request:new Request(origin+'/api/admin/booking-cloud')})).status,401);
 for(const foreign of ['https://evil.test','http://socialfactory.test'])assert.equal((await change({env,request:request({action:'start'},{origin:foreign})})).status,403);
 assert.equal(calls,0);
});
test('status forwards only bounded public control fields and keeps all cloud authentication on server headers',async t=>{
 let sent;mock(t,async(url,options)=>{sent={url,options};return Response.json(payload());});
 const r=await status({env,request:request()}),j=await r.json();assert.equal(r.status,200);assert.equal(j.booking_enabled,false);assert.equal(j.login_saved,true);assert.equal(j.public_login_saved,true);assert(Number.isSafeInteger(j.public_session_updated_at));assert.deepEqual(j.runner,{busy:false,review:false});assert.equal(j.budget.rolling_32d_limit_ms,7200000);
 const text=JSON.stringify(j);for(const value of [secret,'PRIVATE-BROWSER-SESSION','cipher','private_token'])assert(!text.includes(value));
 assert.equal(sent.url,runner+'/status');assert(!sent.url.includes(secret));assert.equal(sent.options.headers.Authorization,'Bearer '+secret);assert.equal(sent.options.method,'GET');assert.equal(sent.options.redirect,'manual');assert(!sent.options.headers.origin);assert(sent.options.signal instanceof AbortSignal);
 assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('referrer-policy'),'no-referrer');
});
test('cloud status rejects malformed or out-of-policy usage values rather than understating them',async t=>{
 for(const changeValue of [j=>j.budget.daily_reserved_ms=-1,j=>j.budget.rolling_32d_limit_ms=7200001,j=>j.budget.monthly_reserved_ms=Infinity,j=>j.budget.daily_limit_ms='5400000',j=>j.runner.review='false',j=>j.public_login_saved='true',j=>j.public_session_updated_at=-1,j=>j.public_candidate_saved='true',j=>j.public_candidate_updated_at=-1,j=>j.public_candidate_expires_at='later']){
  const j=payload();changeValue(j);mock(t,async()=>Response.json(j));const r=await status({env,request:request()});assert.equal(r.status,503);assert(!(await r.text()).includes(secret));
 }
});
test('cloud status accepts the paid 90-minute daily ceiling without expanding monthly or rolling ceilings',async t=>{
 mock(t,async()=>Response.json(payload()));
 let r=await status({env,request:request()}),j=await r.json();assert.equal(r.status,200);assert.equal(j.budget.daily_limit_ms,5400000);
 assert.equal(j.budget.monthly_limit_ms,7200000);assert.equal(j.budget.rolling_32d_limit_ms,7200000);
 for(const [field,limit] of [['daily_limit_ms',5400000],['monthly_limit_ms',7200000],['rolling_32d_limit_ms',7200000]]){
  const invalid=payload();invalid.budget[field]=limit+1;mock(t,async()=>Response.json(invalid));
  r=await status({env,request:request()});assert.equal(r.status,503,field);assert(!(await r.text()).includes(secret));
 }
});
test('only configured workers.dev origin and sufficiently strong admin secret can receive requests',async t=>{
 let calls=0;mock(t,async()=>{calls++;throw Error('must not fetch');});
 for(const extra of [{SPACECLOUD_RUNNER_URL:'https://evil.test'},{SPACECLOUD_RUNNER_URL:runner+'/status'},{SPACECLOUD_RUNNER_URL:'https://127.0.0.1'},{CLOUD_ADMIN_TOKEN:'short'},{CLOUD_ADMIN_TOKEN:secret+'\nInjected'}])assert.equal((await status({env:{...env,...extra},request:request()})).status,503);
 assert.equal(calls,0);
});
test('login start returns only a valid private Live View receipt and not the provider session or secrets',async t=>{
 mock(t,async(url,options)=>{assert.equal(url,runner+'/login/start');assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{});return Response.json({ok:true,login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=private-view',expires_at:Date.now()+300000,sessionId:'PRIVATE-SESSION',cookie:secret});});
 const r=await change({env,request:request({action:'start',url:'https://evil.test'})}),j=await r.json();assert.equal(r.status,200);assert.equal(j.login_id,id);assert.equal(j.purpose,'host');assert.equal(new URL(j.live_view_url).hostname,'live.browser.run');assert(!JSON.stringify(j).includes('PRIVATE-SESSION'));assert(!JSON.stringify(j).includes(secret));
});
test('login start refuses arbitrary redirect targets, invalid session IDs or excessive lifetimes',async t=>{
 for(const extra of [{live_view_url:'https://live.browser.run.evil.test/?jwt=private'},{live_view_url:'http://live.browser.run/view'},{live_view_url:'https://user:password@live.browser.run/view'},{login_id:'not-a-uuid'},{expires_at:Date.now()+600000}]){
  mock(t,async()=>Response.json({ok:true,login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=private-view',expires_at:Date.now()+300000,...extra}));assert.equal((await change({env,request:request({action:'start'})})).status,503);
 }
});
test('save and cancel accept only the named UUID session and do not forward arbitrary fields',async t=>{
 const sent=[];mock(t,async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return Response.json(url.endsWith('/save')?{ok:true,saved:true,cipher:secret}:{ok:true,cancelled:true,sessionId:'private'});});
 for(const action of ['save','cancel']){const r=await change({env,request:request({action,login_id:id,cookie:secret,url:'https://evil.test'})});assert.equal(r.status,200);assert(!(await r.text()).includes(secret));}
 assert.deepEqual(sent,[{url:runner+'/login/save',body:{login_id:id}},{url:runner+'/login/cancel',body:{login_id:id}}]);
 for(const body of [{action:'check'},{action:'start',purpose:'../guest-login'},{action:'start',purpose:null},{action:'save'},{action:'save',login_id:'../../status'},{action:'cancel',login_id:'00000000-0000-0000-0000-000000000000'}])assert.equal((await change({env,request:request(body)})).status,400);
 assert.equal(sent.length,2);
});
test('cloud redirects, non-JSON failures and raw provider errors never escape the proxy',async t=>{
 for(const remote of [()=>new Response('',{status:302,headers:{location:'https://evil.test/?token='+secret}}),()=>new Response(secret,{status:500}),()=>Response.json({ok:false,error:'unknown-'+secret,message:secret},{status:503}),()=>{throw Error(secret);}]){
  mock(t,async()=>remote());const r=await status({env,request:request()});assert.equal(r.status,503);const text=await r.text();assert(!text.includes(secret));assert(!text.includes('evil.test'));
 }
 mock(t,async()=>Response.json({ok:false,error:'daily-budget',message:secret},{status:429}));const r=await change({env,request:request({action:'start'})});assert.equal(r.status,429);assert((await r.json()).message.includes('한도'));
});

test('older host-only status is readable but explicitly reports the missing guest login',async t=>{
 const data=payload();delete data.public_login_saved;delete data.public_session_updated_at;mock(t,async()=>Response.json(data));
 const r=await status({env,request:request()}),j=await r.json();assert.equal(r.status,200);assert.equal(j.login_saved,true);assert.equal(j.public_login_saved,false);assert.equal(j.public_session_updated_at,null);
});
test('guest login controls always use the fixed guest route and keep its purpose on the receipt',async t=>{
 const sent=[];mock(t,async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return Response.json(url.endsWith('/start')?{ok:true,purpose:'guest',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=private-guest',expires_at:Date.now()+300000}:url.endsWith('/save')?{ok:true,saved:true}:{ok:true,cancelled:true});});
 for(const action of ['start','save','cancel']){
  const r=await change({env,request:request({action,purpose:'guest',login_id:id,url:'https://evil.test',path:'/login/'+action})}),j=await r.json();assert.equal(r.status,200);assert.equal(j.purpose,'guest');
 }
 assert.deepEqual(sent,[{url:runner+'/guest-login/start',body:{}},{url:runner+'/guest-login/save',body:{login_id:id}},{url:runner+'/guest-login/cancel',body:{login_id:id}}]);
});

test('an upstream host-purpose receipt cannot be relabelled as a guest login session',async t=>{
 mock(t,async()=>Response.json({ok:true,purpose:'host',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=private-host',expires_at:Date.now()+300000}));
 const r=await change({env,request:request({action:'start',purpose:'guest'})});assert.equal(r.status,503);assert(!(await r.text()).includes('private-host'));
});

test('candidate status forwards only metadata while leaving public readiness false',async t=>{
 const data={...payload(),public_login_saved:false,public_candidate_saved:true,public_candidate_updated_at:Date.now(),public_candidate_expires_at:Date.now()+1800000,candidate:{cipher:secret,cookies:'PRIVATE'}};mock(t,async()=>Response.json(data));
 const r=await status({env,request:request()}),j=await r.json();assert.equal(r.status,200);assert.equal(j.public_candidate_saved,true);assert.equal(j.public_login_saved,false);assert.equal(j.public_candidate_expires_at,data.public_candidate_expires_at);assert(!JSON.stringify(j).includes('PRIVATE'));assert(!JSON.stringify(j).includes(secret));
});
test('only the literal Kakao provider on a guest start is forwarded',async t=>{
 const sent=[];mock(t,async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return Response.json({ok:true,purpose:'guest',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=guest',expires_at:Date.now()+300000});});
 assert.equal((await change({env,request:request({action:'start',purpose:'guest',provider:'kakao',url:'https://evil.test'})})).status,200);assert.deepEqual(sent,[{url:runner+'/guest-login/start',body:{provider:'kakao'}}]);
 for(const body of [{action:'start',purpose:'host',provider:'kakao'},{action:'start',purpose:'guest',provider:'naver'},{action:'save',purpose:'guest',login_id:id,provider:'kakao'}])assert.equal((await change({env,request:request(body)})).status,400);assert.equal(sent.length,1);
});
test('known retryable guest failures preserve only bounded expiry and a safe recovery link',async t=>{
 const expires=Date.now()+240000;
 for(const error of ['guest-login-incomplete','guest-login-validation']){
  mock(t,async()=>Response.json({ok:false,error,retryable:true,resumable:true,purpose:'guest',login_id:id,expires_at:expires,recovery_view_url:'https://live.browser.run/ui/view?jwt=private-recovery',phase:'PRIVATE-PHASE',cipher:secret,message:secret},{status:409}));
  const r=await change({env,request:request({action:'save',purpose:'guest',login_id:id})}),j=await r.json();assert.equal(r.status,409);assert.equal(j.retryable,true);assert.equal(j.expires_at,expires);assert.equal(j.recovery_view_url,'https://live.browser.run/ui/view?jwt=private-recovery');assert(!JSON.stringify(j).includes(secret));assert(!JSON.stringify(j).includes('PRIVATE-PHASE'));assert(!('login_id' in j));
 }
 for(const bad of ['https://evil.test/?jwt=secret','https://live.browser.run.evil.test/view','https://user:password@live.browser.run/view','https://live.browser.run/'+ 'x'.repeat(8192)]){
  mock(t,async()=>Response.json({ok:false,error:'guest-login-validation',retryable:true,purpose:'guest',login_id:id,expires_at:expires,recovery_view_url:bad},{status:409}));const j=await(await change({env,request:request({action:'save',purpose:'guest',login_id:id})})).json();assert.equal(j.retryable,true);assert(!('recovery_view_url' in j));
 }
});
test('retry metadata cannot cross a purpose, action, UUID or expiry boundary',async t=>{
 const base={ok:false,error:'guest-login-validation',retryable:true,purpose:'guest',login_id:id,expires_at:Date.now()+240000};
 for(const extra of [{purpose:'host'},{login_id:'a4a0fd92-0722-49c5-a995-64db762ac3ab'},{expires_at:Date.now()+600000},{expires_at:Date.now()-1},{retryable:'true'},{error:'unknown'}]){
  mock(t,async()=>Response.json({...base,...extra},{status:409}));const j=await(await change({env,request:request({action:'save',purpose:'guest',login_id:id})})).json();assert(!j.retryable);assert(!('expires_at' in j));
 }
 mock(t,async()=>Response.json(base,{status:409}));for(const body of [{action:'save',purpose:'host',login_id:id},{action:'cancel',purpose:'guest',login_id:id}])assert(!(await(await change({env,request:request(body)})).json()).retryable);
});
test('revalidation is a guest-only fixed action and never forwards IDs or arbitrary browser targets',async t=>{
 const sent=[];mock(t,async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return Response.json({ok:true,purpose:'guest',saved:true,cipher:secret});});
 const r=await change({env,request:request({action:'revalidate',purpose:'guest',login_id:'ignored',url:'https://evil.test'})}),j=await r.json();assert.equal(r.status,200);assert.equal(j.saved,true);assert(!JSON.stringify(j).includes(secret));assert.deepEqual(sent,[{url:runner+'/guest-login/revalidate',body:{}}]);
 for(const body of [{action:'revalidate'},{action:'revalidate',purpose:'host'},{action:'revalidate',purpose:'guest',provider:'kakao'}])assert.equal((await change({env,request:request(body)})).status,400);assert.equal(sent.length,1);
 mock(t,async()=>Response.json({ok:true,purpose:'guest',pending:true,cipher:secret},{status:202}));const pending=await change({env,request:request({action:'revalidate',purpose:'guest'})});assert.equal(pending.status,202);assert.equal((await pending.json()).pending,true);
 mock(t,async()=>Response.json({ok:false,error:'guest-candidate-unverified',message:secret},{status:409}));const failed=await change({env,request:request({action:'revalidate',purpose:'guest'})});assert.equal(failed.status,409);assert(!(await failed.text()).includes(secret));
});

test('guest save and revalidation allow bounded cleanup time while ordinary controls retain their shorter timeout',async t=>{
 const delays=[];t.mock.method(globalThis,'setTimeout',(callback,ms)=>{delays.push(ms);return delays.length;});t.mock.method(globalThis,'clearTimeout',()=>{});
 mock(t,async(url)=>Response.json(url.endsWith('/start')?{ok:true,purpose:'host',login_id:id,live_view_url:'https://live.browser.run/ui/view?jwt=host',expires_at:Date.now()+300000}:{ok:true,saved:true}));
 for(const body of [{action:'save',purpose:'guest',login_id:id},{action:'revalidate',purpose:'guest'},{action:'save',purpose:'host',login_id:id},{action:'start',purpose:'host'}])assert.equal((await change({env,request:request(body)})).status,200);
 assert.deepEqual(delays,[65000,65000,35000,35000]);
});

test('public HTTP verifier status remains distinct from guest authentication and drops arbitrary extra fields',async t=>{
 const data={...payload(),public_login_saved:false,public_verification:{mode:'public-api-v1',configured:true,url:'https://evil.test',token:secret}};mock(t,async()=>Response.json(data));
 const r=await status({env,request:request()}),j=await r.json();assert.equal(r.status,200);assert.equal(j.public_login_saved,false);assert.deepEqual(j.public_verification,{mode:'public-api-v1',configured:true});assert(!JSON.stringify(j).includes('evil.test'));assert(!JSON.stringify(j).includes(secret));
 for(const proof of [null,[],{mode:'unknown',configured:true},{mode:'public-api-v1',configured:'true'}]){mock(t,async()=>Response.json({...data,public_verification:proof}));const value=await(await status({env,request:request()})).json();assert.deepEqual(value.public_verification,{mode:'unsupported',configured:false});}
});
