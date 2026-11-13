import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureStore,encryptState,decryptState,saveState,loadState,savePublicState,loadPublicState,savePublicCandidate,loadPublicCandidate,promotePublicCandidate,publicCandidateStatus,reserveBudget,settleBudget,lockRunner,dailyLimit,monthlyLimit,rollingLimit } from '../store.mjs';
import { createRunner } from '../runner.mjs';
import { persistentConnector } from '../connection.mjs';
import { QueueClient } from '../../../integrations/spacecloud-worker/queue.mjs';

const CLOCK=Date.parse('2026-11-06T10:00:00Z');
const PRIVATE_STATE={cookies:[{name:'auth',value:'PRIVATE-LOGIN-COOKIE',domain:'partner.spacecloud.kr',path:'/'}],origins:[{origin:'https://partner.spacecloud.kr',localStorage:[{name:'example',value:'PRIVATE-LOCAL-STATE'}]}]};
const PUBLIC_STATE={cookies:[{name:'guest_auth',value:'PRIVATE-GUEST-LOGIN-COOKIE',domain:'www.spacecloud.kr',path:'/'}],origins:[{origin:'https://www.spacecloud.kr',localStorage:[{name:'guest_auth',value:'PRIVATE-GUEST-STATE'}]}]};
const job={id:'opaque-job-id',job_id:'opaque-job-id',lease_token:'leased-server-token',action:'block',code:'B261208-TESTRUN',marker:'SFWEB:B261208-TESTRUN',room:'r5',date:'2026-12-08',start_min:240,end_min:360};

function fixture(overrides={}) {
  const sqlite=new DatabaseSync(':memory:');
  let tail=Promise.resolve();
  const DB={prepare(sql){let args=[];const statement={bind(...values){args=values;return statement;},
    async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},
    async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return statement;},batch(statements){
      const task=tail.then(async()=>{sqlite.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.run());sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}});
      tail=task.catch(()=>{});return task;
    }};
  const counters={claims:0,maintenance:0,heartbeats:0,completions:[],launches:0,connects:0,acquires:0,closes:[],disconnects:0,driverInitializations:0,guestVerifications:0,rooms:[],restored:[],contexts:[],storageReads:[],drivers:[],navigations:[],liveViews:[],liveViewTargets:[],popupClicks:0};
  const sessions=new Map();
  let nextSession=0,clock=CLOCK,closeFails=false,knownMissing404=false,launchFails=false,currentJob=job,popupURL='https://accounts.kakao.com/login',callbackIncomplete=false;
  function context(savedState=PRIVATE_STATE){let currentState=structuredClone(savedState);const pages=[],pageWaiters=[];
    function makePage(initial='about:blank'){let url=initial;return {async goto(value){url=value;counters.navigations.push(value);if(value==='https://www.spacecloud.kr/auth/login?source=detail-page')currentState=PUBLIC_STATE;},url:()=>url,
      getByText(text,options){assert.equal(text,'카카오로 로그인');assert.deepEqual(options,{exact:true});return {filter(options){assert.deepEqual(options,{visible:true});return this;},async waitFor(options){assert.deepEqual(options,{state:'visible',timeout:10000});},async count(){return 1;},async click(){counters.popupClicks++;const popup=makePage(popupURL);pages.push(popup);assert(pageWaiters.length);pageWaiters.shift()(popup);}};},
      async waitForURL(predicate,options){if(url==='https://www.spacecloud.kr/auth/login?source=detail-page'){
        assert.deepEqual(options,{waitUntil:'domcontentloaded',timeout:8000});if(!callbackIncomplete)url='https://www.spacecloud.kr/space/82026';
        if(!predicate(new URL(url)))throw Object.assign(new Error('callback has not completed'),{name:'TimeoutError'});
      }else if(!predicate(new URL(url)))throw new Error('popup destination is not allowed');}};}
    const ctx={pages:()=>pages,setStorageState(value){currentState=structuredClone(value);},
    async newPage(){const page=makePage();pages.push(page);return page;},
    waitForEvent(event){assert.equal(event,'page');return new Promise(resolve=>pageWaiters.push(resolve));},
    async newCDPSession(page){counters.liveViewTargets.push(page);return {async send(command,options){assert.equal(command,'Cloudflare.getLiveView');assert(['tab','full'].includes(options.mode));counters.liveViews.push(options);return {devtoolsFrontendUrl:'https://live.browser.run/ui/view?jwt=PRIVATE-SHORT-LIVED-VIEW'};}};},
    async storageState(){counters.storageReads.push(ctx);return structuredClone(currentState);}};return ctx;}
  function browserFor(id){const state=sessions.get(id);assert(state,'fake session must exist');return {sessionId:()=>id,contexts:()=>[state.context],
    async newContext(options){const ctx=context(options.storageState || PUBLIC_STATE);counters.restored.push(options.storageState);counters.contexts.push({context:ctx,options});return ctx;},async close(){counters.disconnects++;}};}
  const BROWSER={async acquire(){counters.acquires++;const id='session-'+(++nextSession);sessions.set(id,{context:context()});return {sessionId:id};},
    async closeSession(id){counters.closes.push(id);if(closeFails)throw new Error('remote closure was not acknowledged');sessions.delete(id);return {status:'closed'};},
    async getSession(id){if(!sessions.has(id) && knownMissing404)throw Object.assign(new Error('no such session'),{status:404});return sessions.has(id)?{sessionId:id,status:'active'}:null;}};
  class Queue {async claim(){counters.claims++;return currentJob;}async maintenance(){counters.maintenance++;return {ok:true,maintenance:true};}async heartbeat(){counters.heartbeats++;}async complete(claim,result){counters.completions.push({claim,result});return {ok:true};}}
  class Driver {constructor(ctx,config){this.context=ctx;this.config=config;counters.drivers.push(this);}async initialize(){counters.driverInitializations++;}async openRoom(room){counters.rooms.push(room);}async hostMonth(){return '2026.11';}async verifyGuestLogin(){counters.guestVerifications++;return {guest_ready:true};}}
  const deps={Queue,Driver,now:()=>clock,
    async launch(){counters.launches++;if(launchFails)throw new Error('unknown acquisition result');const {sessionId}=await BROWSER.acquire();return browserFor(sessionId);},
    async connect(binding,id){counters.connects++;return browserFor(id);},
    async execute(claim,driver,heartbeat){assert.equal(driver.config.allowWrites,true);await heartbeat();return {status:'succeeded',receipt:{observed_at:clock}};}};
  const env={STATE_DB:DB,BROWSER,ENABLED:'true',ALLOW_WRITES:'true',CLOUD_PLAN_MODE:'free',CLOUD_PLAN_CONFIRMED_FREE:'true',LOGIN_CLEANUP_SCHEDULED:'true',
    SESSION_ENCRYPTION_KEY:'test-only-encryption-key-more-than-thirty-two-chars',CLOUD_ADMIN_TOKEN:'test-only-cloud-administrator-token-long-enough',
    SPACECLOUD_WORKER_TOKEN:'test-only-website-worker-token-thirty-two-chars',API_ORIGIN:'https://site.example',...overrides};
  return {env,sqlite,counters,deps,sessions,runner:createRunner(deps),advance(ms){clock+=ms;},setJob(value){currentJob=value;},setCallbackIncomplete(value=true){callbackIncomplete=value;},setPopupURL(value){popupURL=value;},setCloseFailure(value=true){closeFails=value;},setMissing404(value=true){knownMissing404=value;},setLaunchFailure(value=true){launchFails=value;},now:()=>clock};
}
async function ready(f){await ensureStore(f.env);await saveState(f.env,PRIVATE_STATE);await savePublicState(f.env,PUBLIC_STATE);return f;}
const reservation=(f)=>f.sqlite.prepare('SELECT * FROM cloud_budget_reservations ORDER BY started_at DESC,rowid DESC LIMIT 1').get();
const budget=(f)=>f.sqlite.prepare('SELECT * FROM cloud_budget WHERE id=1').get();
const lock=(f)=>f.sqlite.prepare('SELECT * FROM cloud_runner_lock WHERE id=1').get();
function request(f,path,{method='POST',token=f.env.CLOUD_ADMIN_TOKEN,body={},origin}={}){return new Request('https://runner.example'+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(origin?{origin}:{}),'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})});}

test('login state encryption uses distinct nonces and rejects tampering or a different key',async()=>{
  const secret='high-entropy-test-secret-longer-than-thirty-two';
  const first=await encryptState(PRIVATE_STATE,secret),second=await encryptState(PRIVATE_STATE,secret);
  assert.notEqual(first,second);assert(!first.includes('PRIVATE-LOGIN-COOKIE'));assert(!first.includes('PRIVATE-LOCAL-STATE'));
  assert.deepEqual(await decryptState(first,secret),PRIVATE_STATE);
  const tampered=JSON.parse(first),bytes=Buffer.from(tampered.data,'base64');bytes[0]^=1;tampered.data=bytes.toString('base64');
  await assert.rejects(decryptState(JSON.stringify(tampered),secret),{code:'session-unreadable'});
  await assert.rejects(decryptState(first,secret+'different'),{code:'session-unreadable'});
});

test('manual-login connector attaches the existing persistent default context without acquiring another browser',async()=>{
  let attached,called=0;
  const binding={};
  const connector=persistentConnector(endpoint=>{called++;attached=new URL(endpoint);return {existing:true};},(received,options)=>{assert.equal(received,binding);return 'http://sdk.invalid/v1/devtools/browser/'+options.sessionId+'?browser_binding=BROWSER';});
  assert.deepEqual(connector(binding,'owned-existing-session'),{existing:true});assert.equal(called,1);
  assert.equal(attached.pathname,'/v1/devtools/browser/owned-existing-session');assert.equal(attached.searchParams.get('persistent'),'true');
});

test('large browser storage state survives encrypted persistence without base64 argument limits',async()=>{
  const state={cookies:[],origins:[{origin:'https://partner.spacecloud.kr',localStorage:[{name:'large-auth-state',value:'x'.repeat(200000)}]}]},secret='large-state-encryption-test-secret-more-than-thirty-two';
  const cipher=await encryptState(state,secret);assert.deepEqual(await decryptState(cipher,secret),state);assert(!cipher.includes('large-auth-state'));
});

test('daily and monthly reservations enforce both caps atomically under concurrent requests',async()=>{
  const f=fixture({DAILY_BROWSER_BUDGET_MS:'300000',MONTHLY_BROWSER_BUDGET_MS:'500000'});await ensureStore(f.env);
  const attempts=await Promise.allSettled(Array.from({length:4},()=>reserveBudget(f.env,150000,{now:CLOCK})));
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,2);assert.equal(budget(f).day_ms,300000);assert.equal(budget(f).month_ms,300000);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_budget_reservations').get().n,2);
  const nextDay=CLOCK+86400000;await reserveBudget(f.env,150000,{now:nextDay});
  await assert.rejects(reserveBudget(f.env,150000,{now:nextDay}),{code:'daily-budget'});
  assert.equal(budget(f).day_ms,150000);assert.equal(budget(f).month_ms,450000);
});

test('zero configured caps stop use and paid inclusion does not raise caps beyond their ceilings',async()=>{
  const f=fixture({DAILY_BROWSER_BUDGET_MS:'0'});await ensureStore(f.env);
  assert.equal(dailyLimit(f.env),0);await assert.rejects(reserveBudget(f.env,1),{code:'daily-budget'});
  assert.equal(dailyLimit({DAILY_BROWSER_BUDGET_MS:'99999999'}),540000);
  assert.equal(dailyLimit({CLOUD_PLAN_MODE:'paid-included',INCLUDED_BUDGET_CONFIRMED:'true',DAILY_BROWSER_BUDGET_MS:'99999999'}),5400000);
  assert.equal(monthlyLimit({MONTHLY_BROWSER_BUDGET_MS:'999999999'}),7200000);
  assert.equal(rollingLimit({ROLLING_32D_BROWSER_BUDGET_MS:'999999999'}),7200000);
});

test('the paid 90-minute day cannot overshoot a day or increase either two-hour total cap or the free nine-minute ceiling',async()=>{
  const f=fixture({CLOUD_PLAN_MODE:'paid-included',INCLUDED_BUDGET_CONFIRMED:'true',DAILY_BROWSER_BUDGET_MS:'99999999',MONTHLY_BROWSER_BUDGET_MS:'99999999',ROLLING_32D_BROWSER_BUDGET_MS:'99999999'});
  await ensureStore(f.env);
  await assert.rejects(reserveBudget(f.env,5400001,{now:CLOCK}),{code:'daily-budget'});
  await reserveBudget(f.env,5400000,{now:CLOCK});
  await assert.rejects(reserveBudget(f.env,1,{now:CLOCK}),{code:'daily-budget'});
  await reserveBudget(f.env,1800000,{now:CLOCK+86400000});
  assert.equal(budget(f).month_ms,7200000);assert.equal(budget(f).day_ms,1800000);
  await assert.rejects(reserveBudget(f.env,1,{now:CLOCK+2*86400000}),{code:'daily-budget'});
  assert.equal(f.sqlite.prepare('SELECT SUM(reserved_ms) total FROM cloud_budget_reservations').get().total,7200000);
  assert.equal(dailyLimit({CLOUD_PLAN_MODE:'free',DAILY_BROWSER_BUDGET_MS:'3600000'}),540000);
  assert.equal(dailyLimit({CLOUD_PLAN_MODE:'paid-included',INCLUDED_BUDGET_CONFIRMED:'false',DAILY_BROWSER_BUDGET_MS:'3600000'}),540000);
});

test('confirmed closure refunds unused allowance once while uncertain closure retains the complete reservation',async()=>{
  const f=fixture();await ensureStore(f.env);const first=await reserveBudget(f.env,150000,{now:CLOCK});
  await settleBudget(f.env,first,{closed:true,now:CLOCK+20000});assert.equal(budget(f).day_ms,25000);
  await settleBudget(f.env,first,{closed:true,now:CLOCK+1000});assert.equal(budget(f).day_ms,25000);
  const second=await reserveBudget(f.env,150000,{now:CLOCK});await settleBudget(f.env,second,{closed:false,now:CLOCK+1000});
  assert.equal(budget(f).day_ms,175000);assert.equal(reservation(f).state,'review');assert.equal(reservation(f).charged_ms,150000);
});

test('refunding an old month never reduces the new month allowance',async()=>{
  const f=fixture();await ensureStore(f.env);
  const old=await reserveBudget(f.env,150000,{now:Date.parse('2026-10-31T23:50:00Z')});
  await reserveBudget(f.env,150000,{now:Date.parse('2026-11-01T00:00:01Z')});
  await settleBudget(f.env,old,{closed:true,now:old.started_at+10000});
  assert.equal(budget(f).month,'2026-11');assert.equal(budget(f).month_ms,150000);assert.equal(budget(f).day_ms,150000);
});

test('no booking is leased until login and sufficient browser budget are ready',async()=>{
  const f=fixture();await ensureStore(f.env);await assert.rejects(f.runner.runOne(f.env),{code:'login-required'});assert.equal(f.counters.claims,0);
  await saveState(f.env,PRIVATE_STATE);await assert.rejects(f.runner.runOne(f.env),{code:'guest-login-required'});assert.equal(f.counters.claims,0);
  await savePublicState(f.env,PUBLIC_STATE);f.env.DAILY_BROWSER_BUDGET_MS='0';await assert.rejects(f.runner.runOne(f.env),{code:'daily-budget'});
  assert.equal(f.counters.claims,0);assert.equal(f.counters.launches,0);assert.equal(lock(f).token,null);assert.equal(lock(f).review,0);
});

test('an idle queue never launches Chrome or consumes the reserved allowance',async()=>{
  const f=await ready(fixture());f.setJob(null);const result=await f.runner.runOne(f.env);
  assert.equal(result.idle,true);assert.equal(f.counters.claims,1);assert.equal(f.counters.launches,0);assert.equal(budget(f).day_ms,0);assert.equal(reservation(f).state,'closed');
});

test('run wake endpoint is scoped, only acknowledges and never leases or launches browser work',async()=>{
  const f=await ready(fixture());
  let res=await f.runner.fetch(request(f,'/run',{token:f.env.SPACECLOUD_WORKER_TOKEN}),f.env);assert.equal(res.status,202);assert.equal((await res.json()).scheduled,true);
  assert.equal(f.counters.claims,0);assert.equal(f.counters.launches,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_budget_reservations').get().n,0);
  for(const path of ['/status','/login/start','/guest-login/start','/guest-login/save','/guest-login/cancel','/guest-login/view','/guest-login/revalidate','/check','/maintenance']){
    res=await f.runner.fetch(request(f,path,{token:f.env.SPACECLOUD_WORKER_TOKEN,method:path==='/status'?'GET':'POST'}),f.env);assert.equal(res.status,401,path);
  }
  res=await f.runner.fetch(request(f,'/run',{token:'incorrect-token'}),f.env);assert.equal(res.status,401);
});

test('public health never reveals tokens, stored state or login links; controls reject cross-origin calls',async()=>{
  const f=await ready(fixture());const res=await f.runner.fetch(request(f,'/health',{method:'GET',token:''}),f.env),text=await res.text();
  assert.equal(res.status,200);for(const secret of [f.env.CLOUD_ADMIN_TOKEN,f.env.SPACECLOUD_WORKER_TOKEN,'PRIVATE-LOGIN-COOKIE','jwt='])assert(!text.includes(secret));
  assert.equal((await f.runner.fetch(request(f,'/login/start',{origin:'https://attacker.example'}),f.env)).status,403);
  assert.equal(f.counters.acquires,0);
});

test('a scheduled job restores login, reports once and always terminates its remote browser',async()=>{
  const f=await ready(fixture());const result=await f.runner.runOne(f.env);
  assert.equal(result.status,'succeeded');assert.equal(f.counters.claims,1);assert.equal(f.counters.launches,1);assert.deepEqual(f.counters.restored,[PRIVATE_STATE,PUBLIC_STATE]);
  assert.equal(f.counters.completions.length,1);assert.equal(f.counters.completions[0].result.status,'succeeded');assert.equal(f.sessions.size,0);assert.equal(f.counters.closes.length,1);
  assert.equal(reservation(f).state,'closed');assert.equal(lock(f).token,null);assert.equal(lock(f).review,0);
  assert(!f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud'").get().cipher.includes('PRIVATE-LOGIN-COOKIE'));
});

test('public verification restores only its separate guest profile and never overwrites the host login',async()=>{
  const f=await ready(fixture());await f.runner.runOne(f.env);
  assert.equal(f.counters.contexts.length,2);const [host,guest]=f.counters.contexts,driver=f.counters.drivers[0];
  assert.notEqual(host.context,guest.context);assert.deepEqual(host.options.storageState,PRIVATE_STATE);assert.deepEqual(guest.options.storageState,PUBLIC_STATE);
  for(const {options} of [host,guest]){assert.equal(options.locale,'ko-KR');assert.equal(options.timezoneId,'Asia/Seoul');assert.deepEqual(options.viewport,{width:1600,height:1100});}
  assert.equal(driver.context,host.context);assert.equal(driver.config.publicContext,guest.context);
  assert.deepEqual(f.counters.storageReads,[host.context,guest.context]);assert.deepEqual(await loadState(f.env),PRIVATE_STATE);
  assert(!JSON.stringify(await loadState(f.env)).includes('PRIVATE-GUEST-LOGIN-COOKIE'));assert.deepEqual(await loadPublicState(f.env),PUBLIC_STATE);assert.equal(f.sessions.size,0);
});

test('read-only host checks and manual host login need no guest context or saved guest profile',async()=>{
  const check=fixture();await ensureStore(check.env);await saveState(check.env,PRIVATE_STATE);await check.runner.runOne(check.env,{check:true});
  assert.equal(check.counters.contexts.length,1);assert.deepEqual(check.counters.restored,[PRIVATE_STATE]);assert.equal(check.counters.drivers[0].config.publicContext,undefined);
  assert.deepEqual(check.counters.storageReads,[check.counters.contexts[0].context]);assert.deepEqual(await loadState(check.env),PRIVATE_STATE);
  assert.equal(await loadPublicState(check.env),null);
  const login=fixture(),started=await login.runner.startLogin(login.env);await login.runner.saveLogin(login.env,started.login_id);
  assert.equal(login.counters.contexts.length,0);assert.equal(login.counters.drivers[0].config.publicContext,undefined);assert.equal(login.counters.storageReads.length,1);
  assert.deepEqual(await loadState(login.env),PRIVATE_STATE);assert.equal(login.sessions.size,0);
});

test('exceptions during browser work report review and still close Chrome before releasing the lock',async()=>{
  const f=await ready(fixture()),runner=createRunner({...f.deps,async execute(){throw new Error('fixture UI failure');}});
  await assert.rejects(runner.runOne(f.env),/fixture UI failure/);
  assert.equal(f.counters.completions.at(-1).result.status,'review');assert.equal(f.sessions.size,0);assert.equal(reservation(f).state,'closed');assert.equal(lock(f).review,0);
});

test('unknown browser closure retains full allowance and quarantines later launches',async()=>{
  const f=await ready(fixture());f.setCloseFailure();await f.runner.runOne(f.env);
  assert.equal(reservation(f).state,'review');assert.equal(reservation(f).charged_ms,150000);assert.equal(budget(f).day_ms,150000);assert.equal(lock(f).review,1);
  await assert.rejects(f.runner.runOne(f.env),{code:'runner-busy'});assert.equal(f.counters.launches,1);
});

test('an ambiguous browser acquisition is not treated as a free no-op',async()=>{
  const f=await ready(fixture());f.setLaunchFailure();await assert.rejects(f.runner.runOne(f.env),/unknown acquisition result/);
  assert.equal(reservation(f).state,'review');assert.equal(reservation(f).charged_ms,150000);assert.equal(lock(f).review,1);assert.equal(f.counters.completions.at(-1).result.status,'review');
});

test('a known missing-session response confirms closure but a generic transport failure does not',async()=>{
  const f=await ready(fixture());f.setMissing404();await f.runner.runOne(f.env);assert.equal(reservation(f).state,'closed');assert.equal(lock(f).review,0);
  const g=await ready(fixture());g.env.BROWSER.getSession=async()=>{throw new Error('network transport is unavailable');};await g.runner.runOne(g.env);
  assert.equal(reservation(g).state,'review');assert.equal(lock(g).review,1);assert.equal(reservation(g).charged_ms,150000);
});

test('the provider exact missing-session error confirms closure while arbitrary 404 text does not',async()=>{
  const f=await ready(fixture());f.env.BROWSER.getSession=async()=>{throw new Error('BrowserBindingError: Session not found (status=404)');};
  await f.runner.runOne(f.env);assert.equal(reservation(f).state,'closed');assert.equal(lock(f).review,0);
  const g=await ready(fixture());g.env.BROWSER.getSession=async()=>{throw new Error('upstream login page returned 404');};
  await g.runner.runOne(g.env);assert.equal(reservation(g).state,'review');assert.equal(lock(g).review,1);
});

test('manual login saves only verified encrypted state and explicitly ends the cloud session',async()=>{
  const f=fixture();const started=await f.runner.startLogin(f.env);
  assert.equal(f.counters.liveViews[0].mode,'tab');
  assert(started.live_view_url.startsWith('https://live.browser.run/'));assert.equal(f.counters.claims,0);assert.equal(f.sessions.size,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_session').get().n,0);assert.equal(lock(f).review,0);assert(lock(f).token);
  f.advance(20000);const saved=await f.runner.saveLogin(f.env,started.login_id);assert.equal(saved.saved,true);assert.deepEqual(await loadState(f.env),PRIVATE_STATE);
  assert.deepEqual(f.counters.rooms,['r5']);assert.equal(f.sessions.size,0);assert.equal(f.counters.claims,0);assert.equal(f.counters.completions.length,0);
  const stored=f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud'").get().cipher;assert(!stored.includes('PRIVATE-LOGIN-COOKIE'));
  assert.equal(reservation(f).state,'closed');assert.equal(lock(f).token,null);
});

test('guest authentication is encrypted separately, excludes SSO storage and never overwrites the host profile',async()=>{
  const f=fixture();await ensureStore(f.env);await saveState(f.env,PRIVATE_STATE);
  const host=f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud'").get().cipher;
  const guest=structuredClone(PUBLIC_STATE);guest.cookies.push({name:'google',value:'DO-NOT-STORE',domain:'.google.com',path:'/'});
  guest.origins.push({origin:'https://nid.naver.com',localStorage:[{name:'naver',value:'DO-NOT-STORE'}]});
  await savePublicState(f.env,guest);assert.deepEqual(await loadPublicState(f.env),PUBLIC_STATE);assert.deepEqual(await loadState(f.env),PRIVATE_STATE);
  assert.equal(f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud'").get().cipher,host);
  const cipher=f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud_public'").get().cipher;
  for(const secret of ['PRIVATE-GUEST-LOGIN-COOKIE','PRIVATE-GUEST-STATE','DO-NOT-STORE'])assert(!cipher.includes(secret));
  const status=await f.runner.status(f.env);assert.equal(status.public_login_saved,true);assert(Number.isSafeInteger(status.public_session_updated_at));
  assert(!JSON.stringify(status).includes('PRIVATE-GUEST'));assert(!JSON.stringify(status).includes(cipher));
});

test('host authentication alone cannot acknowledge automatic work or lease a booking',async()=>{
  const f=fixture();await ensureStore(f.env);await saveState(f.env,PRIVATE_STATE);
  let response=await f.runner.fetch(request(f,'/run',{token:f.env.SPACECLOUD_WORKER_TOKEN}),f.env);
  assert.equal(response.status,503);assert.equal((await response.json()).error,'guest-login-required');
  await assert.rejects(f.runner.runOne(f.env),{code:'guest-login-required'});assert.equal(f.counters.claims,0);assert.equal(f.counters.launches,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_budget_reservations').get().n,0);
  const status=await f.runner.status(f.env);assert.equal(status.login_saved,true);assert.equal(status.public_login_saved,false);assert.equal(status.public_session_updated_at,null);
});

test('explicit public API verification needs only the host profile and never creates or saves a guest context',async()=>{
  const f=fixture({PUBLIC_AVAILABILITY_MODE:'public-api-v1'});await ensureStore(f.env);await saveState(f.env,PRIVATE_STATE);
  const status=await f.runner.status(f.env);assert.deepEqual(status.public_verification,{mode:'public-api-v1',configured:true});assert.equal(status.public_login_saved,false);
  const wake=await f.runner.fetch(request(f,'/run',{token:f.env.SPACECLOUD_WORKER_TOKEN}),f.env);assert.equal(wake.status,202);assert.equal(f.counters.claims,0);
  const result=await f.runner.runOne(f.env);assert.equal(result.status,'succeeded');assert.equal(f.counters.claims,1);assert.equal(f.counters.contexts.length,1);
  assert.deepEqual(f.counters.restored,[PRIVATE_STATE]);assert.equal(f.counters.drivers[0].config.publicAvailabilityMode,'public-api-v1');assert.equal(f.counters.drivers[0].config.publicContext,undefined);
  assert.deepEqual(f.counters.storageReads,[f.counters.contexts[0].context]);assert.equal(await loadPublicState(f.env),null);assert.equal(f.counters.guestVerifications,0);assert.equal(f.sessions.size,0);
});

test('public API mode does not read or overwrite an old guest profile even when its ciphertext is unreadable',async()=>{
  const f=await ready(fixture({PUBLIC_AVAILABILITY_MODE:'public-api-v1'}));f.sqlite.prepare("UPDATE cloud_session SET cipher='not-json-private-legacy-state' WHERE id='spacecloud_public'").run();
  await f.runner.runOne(f.env);assert.equal(f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud_public'").get().cipher,'not-json-private-legacy-state');
  assert.equal(f.counters.contexts.length,1);assert.equal(f.counters.guestVerifications,0);
});

test('an unsupported explicit public verification mode never falls back to saved guest authentication',async()=>{
  for(const mode of ['public-api-v2','PUBLIC-API-V1','public-api-v1 ','guest-browser']){
    const f=await ready(fixture({PUBLIC_AVAILABILITY_MODE:mode}));await assert.rejects(f.runner.runOne(f.env),{code:'public-verification-mode'});
    const response=await f.runner.fetch(request(f,'/run',{token:f.env.SPACECLOUD_WORKER_TOKEN}),f.env);assert.equal(response.status,503);assert.equal((await response.json()).error,'public-verification-mode');
    assert.deepEqual((await f.runner.status(f.env)).public_verification,{mode:'unsupported',configured:false});assert.equal(f.counters.claims,0);assert.equal(f.counters.launches,0);
  }
});

test('public API mode cannot bypass a missing host profile or browser budget',async()=>{
  const missing=fixture({PUBLIC_AVAILABILITY_MODE:'public-api-v1'});await ensureStore(missing.env);await savePublicState(missing.env,PUBLIC_STATE);
  await assert.rejects(missing.runner.runOne(missing.env),{code:'login-required'});assert.equal(missing.counters.claims,0);assert.equal(missing.counters.launches,0);
  const budget=fixture({PUBLIC_AVAILABILITY_MODE:'public-api-v1',DAILY_BROWSER_BUDGET_MS:'0'});await ensureStore(budget.env);await saveState(budget.env,PRIVATE_STATE);
  await assert.rejects(budget.runner.runOne(budget.env),{code:'daily-budget'});assert.equal(budget.counters.claims,0);assert.equal(budget.counters.launches,0);
});

test('legacy guest revalidation still checks actual guest authentication when public API mode is configured',async()=>{
  const f=await ready(fixture({PUBLIC_AVAILABILITY_MODE:'public-api-v1'}));await f.runner.revalidateGuest(f.env);
  assert.equal(f.counters.drivers[0].config.publicAvailabilityMode,'guest-browser');assert.equal(f.counters.guestVerifications,1);assert.deepEqual(f.counters.restored,[PUBLIC_STATE]);
});

test('manual guest login opens the observed customer login route and saves only verified guest state',async()=>{
  const f=fixture();await ensureStore(f.env);await saveState(f.env,PRIVATE_STATE);
  const host=f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud'").get().cipher;
  const started=await f.runner.startGuestLogin(f.env);assert.equal(started.purpose,'guest');assert.deepEqual(f.counters.navigations,['https://www.spacecloud.kr/auth/login?source=detail-page']);
  assert.equal(f.counters.liveViews[0].mode,'tab');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_login').get().n,0);assert.equal(f.sqlite.prepare('SELECT state FROM cloud_guest_login WHERE id=?').get(started.login_id).state,'active');
  assert.equal(f.sessions.size,1);assert.equal(f.counters.claims,0);assert.equal(await loadPublicState(f.env),null);
  f.advance(20000);const saved=await f.runner.saveGuestLogin(f.env,started.login_id);assert.equal(saved.saved,true);assert.equal(saved.purpose,'guest');
  assert.equal(f.counters.guestVerifications,2);assert.deepEqual(f.counters.rooms,[]);assert.equal(f.counters.drivers[0].config.allowWrites,false);
  assert.equal(f.counters.drivers[0].config.publicPage,f.counters.liveViewTargets[0]);assert.equal(f.counters.drivers[0].config.publicContext,f.counters.drivers[0].context);assert.deepEqual(await loadPublicState(f.env),PUBLIC_STATE);
  assert.equal(f.counters.contexts.length,1);assert.deepEqual(f.counters.contexts[0].options,{storageState:PUBLIC_STATE,locale:'ko-KR',timezoneId:'Asia/Seoul',viewport:{width:1600,height:1100}});
  assert.equal(f.counters.drivers[1].context,f.counters.contexts[0].context);assert.equal(f.counters.acquires,1);assert.equal(f.counters.storageReads.length,2);
  assert.notEqual(f.counters.storageReads[0],f.counters.storageReads[1]);
  assert.equal(f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud'").get().cipher,host);assert.deepEqual(await loadState(f.env),PRIVATE_STATE);
  assert.equal(f.sqlite.prepare('SELECT state FROM cloud_guest_login WHERE id=?').get(started.login_id).state,'saved');
  assert.equal(f.sessions.size,0);assert.equal(lock(f).token,null);assert.equal(lock(f).review,0);assert.equal(reservation(f).state,'closed');
});

test('guest full view reuses the active browser and original budget without renewing or closing the login',async()=>{
  const f=fixture(),started=await f.runner.startGuestLogin(f.env);f.advance(10000);
  const before={login:f.sqlite.prepare('SELECT * FROM cloud_guest_login').get(),budget:reservation(f),lock:lock(f)};
  const result=await f.runner.viewGuestLogin(f.env,started.login_id);
  assert.equal(result.purpose,'guest');assert.equal(result.login_id,started.login_id);assert.equal(result.expires_at,started.expires_at);
  assert.equal(f.counters.liveViews.at(-1).mode,'full');assert.equal(f.counters.liveViews.at(-1).expiresInMs,started.expires_at-f.now()-5000);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM cloud_guest_login').get(),before.login);assert.deepEqual(reservation(f),before.budget);assert.deepEqual(lock(f),before.lock);
  assert.equal(f.counters.acquires,1);assert.equal(f.counters.closes.length,0);assert.equal(f.sessions.size,1);assert.equal(f.counters.claims,0);assert.equal(f.counters.disconnects,2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_budget_reservations').get().n,1);
});

test('Kakao guest start shows the exact OAuth popup while keeping the original Spacecloud callback page alive',async()=>{
  const f=fixture(),response=await f.runner.fetch(request(f,'/guest-login/start',{body:{provider:'kakao'}}),f.env);
  assert.equal(response.status,200);const started=await response.json();assert.equal(started.provider,'kakao');assert.equal(started.purpose,'guest');
  const context=f.sessions.get(started.sessionId).context,pages=context.pages();assert.equal(pages.length,2);
  assert.equal(pages[0].url(),'https://www.spacecloud.kr/auth/login?source=detail-page');assert.equal(pages[1].url(),'https://accounts.kakao.com/login');
  assert.equal(f.counters.liveViewTargets[0],pages[1]);assert.equal(f.counters.liveViews[0].mode,'tab');assert.equal(f.counters.popupClicks,1);
  assert.equal(f.counters.acquires,1);assert.equal(f.counters.closes.length,0);assert.equal(f.counters.storageReads.length,0);assert.equal(await loadPublicState(f.env),null);
  assert.equal(reservation(f).reserved_ms,360000);await f.runner.saveGuestLogin(f.env,started.login_id);assert.deepEqual(await loadPublicState(f.env),PUBLIC_STATE);
});

test('only the literal Kakao provider is accepted and it is limited to guest login',async()=>{
  for(const [path,provider] of [['/guest-login/start','naver'],['/guest-login/start','https://attacker.invalid'],['/guest-login/start','KAKAO'],['/guest-login/start',null],['/login/start','kakao']]){
    const f=fixture(),response=await f.runner.fetch(request(f,path,{body:{provider}}),f.env);assert.equal(response.status,400);assert.equal((await response.json()).error,'login-provider');
    assert.equal(f.counters.acquires,0);assert.equal(f.counters.connects,0);
  }
});

test('Kakao OAuth popup accepts only the two observed HTTPS provider hosts',async()=>{
  for(const url of ['https://attacker.invalid/login','http://accounts.kakao.com/login','https://accounts.kakao.com.attacker.invalid/login','https://user@accounts.kakao.com/login','https://accounts.kakao.com:444/login']){
    const f=fixture();f.setPopupURL(url);await assert.rejects(f.runner.startGuestLogin(f.env,{provider:'kakao'}),/popup destination is not allowed/);
    assert.equal(f.counters.liveViews.length,0);assert.equal(f.sessions.size,0);assert.equal(reservation(f).state,'closed');assert.equal(await loadPublicState(f.env),null);
  }
  const f=fixture();f.setPopupURL('https://kauth.kakao.com/oauth/authorize');const result=await f.runner.startGuestLogin(f.env,{provider:'kakao'});assert.equal(result.provider,'kakao');assert.equal(f.counters.liveViews[0].mode,'tab');
});

test('guest view rejects host IDs, invalid IDs, expired deadlines and lost leases without closing a browser',async()=>{
  const host=fixture(),startedHost=await host.runner.startLogin(host.env);
  for(const id of [startedHost.login_id,'not-a-uuid'])await assert.rejects(host.runner.viewGuestLogin(host.env,id),{code:'login-session'});
  assert.equal(host.counters.connects,1);assert.equal(host.counters.closes.length,0);
  const expired=fixture(),started=await expired.runner.startGuestLogin(expired.env);expired.advance(240001);
  await assert.rejects(expired.runner.viewGuestLogin(expired.env,started.login_id),{code:'login-expired'});assert.equal(expired.counters.closes.length,0);assert.equal(expired.sessions.size,1);
  const lost=fixture(),active=await lost.runner.startGuestLogin(lost.env);lost.sqlite.prepare('UPDATE cloud_runner_lock SET review=1').run();
  await assert.rejects(lost.runner.viewGuestLogin(lost.env,active.login_id),{code:'runner-lock'});assert.equal(lost.counters.closes.length,0);assert.equal(lost.sessions.size,1);
});

test('guest save verifies restored desktop state and persists refreshed credentials without logging private data',async()=>{
  const f=fixture(),started=await f.runner.startGuestLogin(f.env),captured=[];
  const previous=console.error;console.error=(...args)=>captured.push(args);
  const refreshed=structuredClone(PUBLIC_STATE);refreshed.cookies.push({name:'fresh',value:'REFRESHED-VERIFIED-GUEST',domain:'.spacecloud.kr',path:'/'});
  class DesktopGuest extends f.deps.Driver {async verifyGuestLogin(){
    if(this.config.publicPage){assert.equal(this.config.publicPage,f.counters.liveViewTargets[0]);return {guest_ready:true};}
    const created=f.counters.contexts[0];assert.equal(this.context,created.context);assert.deepEqual(created.options.storageState,PUBLIC_STATE);
    assert.deepEqual(created.options.viewport,{width:1600,height:1100});
    this.reportReview({phase:'public-progress',step:'month',event:'layout',client_width:1600,inner_height:1100,raw:'PRIVATE-RAW-CONTENT',cookie:'PRIVATE-GUEST-LOGIN-COOKIE',url:'https://example.invalid/?token=PRIVATE-TOKEN'});
    this.context.setStorageState(refreshed);return {guest_ready:true};
  }}
  try{await createRunner({...f.deps,Driver:DesktopGuest}).saveGuestLogin(f.env,started.login_id);}finally{console.error=previous;}
  assert.deepEqual(await loadPublicState(f.env),refreshed);assert.equal(await loadState(f.env),null);assert.equal(f.counters.acquires,1);assert.equal(f.sessions.size,0);
  assert.equal(captured.length,1);assert.deepEqual(captured[0],['spacecloud-cloud','guest-login-review',{phase:'public-progress',step:'month',event:'layout',client_width:1600,inner_height:1100}]);
  assert(!JSON.stringify(captured).includes('PRIVATE'));
});

test('host and guest login receipts cannot save or cancel each other',async()=>{
  const f=fixture(),host=await f.runner.startLogin(f.env);
  for(const action of ['save','cancel']){
    const response=await f.runner.fetch(request(f,'/guest-login/'+action,{body:{login_id:host.login_id}}),f.env);
    assert.equal(response.status,409);assert.equal((await response.json()).error,'login-session');assert.equal(f.sessions.size,1);
  }
  assert.equal(f.sqlite.prepare('SELECT state FROM cloud_login WHERE id=?').get(host.login_id).state,'active');
  await f.runner.saveLogin(f.env,host.login_id,{cancel:true});
  const guest=await f.runner.startGuestLogin(f.env);
  for(const action of ['save','cancel']){
    const response=await f.runner.fetch(request(f,'/login/'+action,{body:{login_id:guest.login_id}}),f.env);
    assert.equal(response.status,409);assert.equal((await response.json()).error,'login-session');assert.equal(f.sessions.size,1);
  }
  const response=await f.runner.fetch(request(f,'/guest-login/cancel',{body:{login_id:guest.login_id}}),f.env);assert.equal(response.status,200);assert.equal((await response.json()).purpose,'guest');
  assert.equal(f.sqlite.prepare('SELECT state FROM cloud_guest_login WHERE id=?').get(guest.login_id).state,'cancelled');
  assert.equal(f.sessions.size,0);assert.equal(f.counters.guestVerifications,0);assert.equal(await loadPublicState(f.env),null);
});

test('a missing original guest calendar proof preserves the login and existing host and guest authentication',async()=>{
  const f=await ready(fixture()),started=await f.runner.startGuestLogin(f.env);
  const before=f.sqlite.prepare('SELECT id,cipher FROM cloud_session ORDER BY id').all();
  class NotLoggedIn extends f.deps.Driver {async verifyGuestLogin(){return {guest_ready:false};}}
  const runner=createRunner({...f.deps,Driver:NotLoggedIn});
  await assert.rejects(runner.saveGuestLogin(f.env,started.login_id),{code:'guest-login-validation',retryable:true,phase:'original-calendar'});
  assert.deepEqual(f.sqlite.prepare('SELECT id,cipher FROM cloud_session ORDER BY id').all(),before);
  assert.equal(f.sqlite.prepare('SELECT state FROM cloud_guest_login WHERE id=?').get(started.login_id).state,'active');assert.equal(f.sessions.size,1);assert.equal(f.counters.closes.length,0);assert.equal(lock(f).review,0);
  assert.equal(await loadPublicCandidate(f.env,{now:f.now()}),null);
});

test('guest login expiry uses the same cleanup budget and never touches bookings or host login',async()=>{
  const f=fixture();await ensureStore(f.env);await saveState(f.env,PRIVATE_STATE);await f.runner.startGuestLogin(f.env);
  assert.equal(reservation(f).reserved_ms,360000);f.advance(300001);await f.runner.maintenance(f.env);
  assert.equal(f.sqlite.prepare('SELECT state FROM cloud_guest_login').get().state,'expired');assert.equal(f.sessions.size,0);assert.equal(f.counters.claims,0);assert.equal(f.counters.guestVerifications,0);
  assert.deepEqual(await loadState(f.env),PRIVATE_STATE);assert.equal(await loadPublicState(f.env),null);assert.equal(reservation(f).state,'closed');assert.equal(lock(f).token,null);
});

test('guest verification deadline preserves the source and original expiry without saving unverified state',async()=>{
  const f=fixture(),started=await f.runner.startGuestLogin(f.env);
  class HangingGuest extends f.deps.Driver {async verifyGuestLogin(){return new Promise(()=>{});}}
  const runner=createRunner({...f.deps,Driver:HangingGuest,setDeadline(fn,ms){return setTimeout(()=>{f.advance(ms);fn();},1);}});
  const before={login:f.sqlite.prepare('SELECT * FROM cloud_guest_login').get(),budget:reservation(f),lock:lock(f)};
  await assert.rejects(runner.saveGuestLogin(f.env,started.login_id),{code:'guest-login-validation',retryable:true});
  assert.equal(await loadPublicState(f.env),null);assert.equal(f.sessions.size,1);assert.equal(f.counters.closes.length,0);assert.equal(reservation(f).state,'reserved');assert.equal(lock(f).review,0);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM cloud_guest_login').get(),before.login);assert.deepEqual(reservation(f),before.budget);assert.deepEqual(lock(f),before.lock);
  f.advance(300001);await f.runner.maintenance(f.env);assert.equal(f.sessions.size,0);assert.equal(reservation(f).state,'closed');
});

test('an incomplete OAuth callback preserves the same receipt and exports no authentication',async()=>{
  const f=fixture(),started=await f.runner.startGuestLogin(f.env);f.setCallbackIncomplete();
  const before={login:f.sqlite.prepare('SELECT * FROM cloud_guest_login').get(),budget:reservation(f),lock:lock(f)};
  const response=await f.runner.fetch(request(f,'/guest-login/save',{body:{login_id:started.login_id}}),f.env),data=await response.json();
  assert.equal(response.status,409);assert.equal(data.error,'guest-login-incomplete');assert.equal(data.retryable,true);assert.equal(data.resumable,true);
  assert.equal(data.login_id,started.login_id);assert.equal(data.expires_at,started.expires_at);assert.equal(data.phase,'callback');assert(data.recovery_view_url.startsWith('https://live.browser.run/'));
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM cloud_guest_login').get(),before.login);assert.deepEqual(reservation(f),before.budget);assert.deepEqual(lock(f),before.lock);
  assert.equal(f.counters.storageReads.length,0);assert.equal(f.counters.closes.length,0);assert.equal(f.sessions.size,1);assert.equal(await loadPublicCandidate(f.env,{now:f.now()}),null);
  f.setCallbackIncomplete(false);const saved=await f.runner.saveGuestLogin(f.env,started.login_id);assert.equal(saved.saved,true);assert.equal(f.counters.acquires,1);assert.equal(f.sessions.size,0);
});

test('source proof precedes candidate capture and an isolated failure preserves both candidate and source for retry',async()=>{
  const f=fixture(),started=await f.runner.startGuestLogin(f.env);let sourceVerified=false;
  const before={login:f.sqlite.prepare('SELECT * FROM cloud_guest_login').get(),budget:reservation(f),lock:lock(f)};
  class CloneFails extends f.deps.Driver {async verifyGuestLogin(){
    if(this.config.publicPage){assert.equal(f.counters.storageReads.length,0);sourceVerified=true;return {guest_ready:true};}
    assert.equal(sourceVerified,true);assert(await loadPublicCandidate(f.env,{now:f.now()}));throw new Error('PRIVATE-FAILURE-CONTENT');
  }}
  const runner=createRunner({...f.deps,Driver:CloneFails});const response=await runner.fetch(request(f,'/guest-login/save',{body:{login_id:started.login_id}}),f.env),data=await response.json();
  assert.equal(response.status,409);assert.equal(data.error,'guest-login-validation');assert.equal(data.phase,'isolated-calendar');assert.equal(data.retryable,true);
  assert(!JSON.stringify(data).includes('PRIVATE-FAILURE-CONTENT'));assert.equal(f.counters.closes.length,0);assert.equal(f.sessions.size,1);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM cloud_guest_login').get(),before.login);assert.deepEqual(reservation(f),before.budget);assert.deepEqual(lock(f),before.lock);
  const candidate=await loadPublicCandidate(f.env,{now:f.now()});assert.deepEqual(candidate.state,PUBLIC_STATE);assert.equal(candidate.expires_at-candidate.created_at,30*60000);
  assert.equal(await loadPublicState(f.env),null);const status=await f.runner.status(f.env);assert.equal(status.public_candidate_saved,true);assert.equal(status.public_login_saved,false);
  assert(!JSON.stringify(status).includes('PRIVATE-GUEST'));assert(!JSON.stringify(status).includes(candidate.version));
  f.advance(1000);assert.equal((await f.runner.saveGuestLogin(f.env,started.login_id)).saved,true);assert.equal(f.counters.acquires,1);assert.equal(f.sessions.size,0);
  assert.equal(await loadPublicCandidate(f.env,{now:f.now()}),null);assert.equal((await f.runner.status(f.env)).public_candidate_saved,false);
});

test('candidate staging is encrypted, versioned and first-party-only and stale versions cannot overwrite a newer candidate',async()=>{
  const f=fixture();await ensureStore(f.env);const candidateState={...structuredClone(PUBLIC_STATE),sessionStorage:{secret:'DO-NOT-CAPTURE'}};
  candidateState.cookies.push({name:'kakao',value:'PROVIDER-SECRET',domain:'.kakao.com',path:'/'});
  candidateState.origins.push({origin:'https://accounts.kakao.com',localStorage:[{name:'provider',value:'PROVIDER-SECRET'}]});
  const first=await savePublicCandidate(f.env,candidateState,{now:f.now()}),second=await savePublicCandidate(f.env,PUBLIC_STATE,{now:f.now()+1});
  assert.notEqual(first.version,second.version);const stored=f.sqlite.prepare('SELECT * FROM cloud_auth_candidates').get();
  assert.equal(stored.id,'spacecloud_public_candidate');assert(!stored.cipher.includes('PRIVATE-GUEST'));assert(!stored.cipher.includes('PROVIDER-SECRET'));
  assert.deepEqual((await loadPublicCandidate(f.env,{now:f.now()})).state,PUBLIC_STATE);assert.equal(await loadPublicState(f.env),null);
  await assert.rejects(promotePublicCandidate(f.env,first,PUBLIC_STATE,{now:f.now()+2}),{code:'guest-candidate-unverified'});
  assert.equal(await loadPublicState(f.env),null);assert.equal((await loadPublicCandidate(f.env,{now:f.now()+2})).version,second.version);
});

test('candidate TTL cannot be extended by inspection and expiry removes unusable candidate without launching Chrome',async()=>{
  const f=fixture();await ensureStore(f.env);const candidate=await savePublicCandidate(f.env,PUBLIC_STATE,{now:f.now()});
  const first=await publicCandidateStatus(f.env,{now:f.now()});assert.equal(first.public_candidate_expires_at,candidate.expires_at);
  f.advance(30*60000);assert.equal(await loadPublicCandidate(f.env,{now:f.now()}),null);assert.equal((await f.runner.status(f.env)).public_candidate_saved,false);
  await assert.rejects(f.runner.revalidateGuest(f.env),{code:'guest-candidate-unverified'});assert.equal(f.counters.launches,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_auth_candidates').get().n,0);
});

test('a fresh browser revalidates a pending candidate before the old public profile and never touches host state or queue',async()=>{
  const f=await ready(fixture()),state=structuredClone(PUBLIC_STATE);state.cookies[0].value='PENDING-CANDIDATE-COOKIE';
  await savePublicCandidate(f.env,state,{now:f.now()});const host=f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud'").get().cipher;
  const result=await f.runner.revalidateGuest(f.env);assert.equal(result.saved,true);assert.equal(result.purpose,'guest');
  assert.equal(f.counters.launches,1);assert.deepEqual(f.counters.restored,[state]);assert.equal(f.counters.drivers[0].config.allowWrites,false);
  assert.equal(f.counters.drivers[0].config.publicContext,f.counters.drivers[0].context);assert.equal(f.counters.claims,0);assert.equal(f.counters.completions.length,0);
  assert.equal(f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud'").get().cipher,host);assert.deepEqual(await loadPublicState(f.env),state);
  assert.equal(await loadPublicCandidate(f.env,{now:f.now()}),null);assert.equal(f.sessions.size,0);assert.equal(reservation(f).reserved_ms,90000);assert.equal(reservation(f).state,'closed');assert.equal(lock(f).token,null);
});

test('cold verification falls back to a saved public profile when there is no pending candidate',async()=>{
  const f=await ready(fixture());const response=await f.runner.fetch(request(f,'/guest-login/revalidate'),f.env);assert.equal(response.status,200);assert.equal((await response.json()).saved,true);
  assert.equal(f.counters.launches,1);assert.deepEqual(f.counters.restored,[PUBLIC_STATE]);assert.equal(f.counters.claims,0);assert.equal(f.sessions.size,0);
});

test('failed cold verification retains candidate version and both saved profiles and closes only its new browser',async()=>{
  const f=await ready(fixture());await savePublicCandidate(f.env,PUBLIC_STATE,{now:f.now()});
  const before={candidate:f.sqlite.prepare('SELECT * FROM cloud_auth_candidates').get(),profiles:f.sqlite.prepare('SELECT id,cipher FROM cloud_session ORDER BY id').all()};
  class ColdFails extends f.deps.Driver {async verifyGuestLogin(){return {guest_ready:false};}}
  await assert.rejects(createRunner({...f.deps,Driver:ColdFails}).revalidateGuest(f.env),{code:'guest-candidate-unverified'});
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM cloud_auth_candidates').get(),before.candidate);assert.deepEqual(f.sqlite.prepare('SELECT id,cipher FROM cloud_session ORDER BY id').all(),before.profiles);
  assert.equal(f.sessions.size,0);assert.equal(f.counters.claims,0);assert.equal(lock(f).token,null);assert.equal(lock(f).review,0);
});

test('cold verification cannot bypass its browser budget or an active preserved source login',async()=>{
  const f=fixture({DAILY_BROWSER_BUDGET_MS:'0'});await ensureStore(f.env);await savePublicCandidate(f.env,PUBLIC_STATE,{now:f.now()});
  await assert.rejects(f.runner.revalidateGuest(f.env),{code:'daily-budget'});assert.equal(f.counters.launches,0);assert.equal(lock(f).token,null);
  const active=fixture(),started=await active.runner.startGuestLogin(active.env);await savePublicCandidate(active.env,PUBLIC_STATE,{now:active.now()});
  await assert.rejects(active.runner.revalidateGuest(active.env),{code:'runner-busy'});assert.equal(active.counters.launches,0);assert.equal(active.sessions.size,1);
  await active.runner.saveGuestLogin(active.env,started.login_id,{cancel:true});assert(await loadPublicCandidate(active.env,{now:active.now()}));
  await active.runner.revalidateGuest(active.env);assert.equal(active.counters.launches,1);assert.equal(active.sessions.size,0);
});

test('cold verification deadline is bounded and keeps its candidate for a later retry',async()=>{
  const f=fixture();await ensureStore(f.env);await savePublicCandidate(f.env,PUBLIC_STATE,{now:f.now()});
  class HangingCold extends f.deps.Driver {async verifyGuestLogin(){return new Promise(()=>{});}}
  const runner=createRunner({...f.deps,Driver:HangingCold,setDeadline(fn,ms){return setTimeout(()=>{f.advance(ms);fn();},1);}});
  await assert.rejects(runner.revalidateGuest(f.env),{code:'guest-candidate-unverified'});assert(await loadPublicCandidate(f.env,{now:f.now()}));
  assert.equal(f.sessions.size,0);assert.equal(reservation(f).state,'closed');assert.equal(f.counters.claims,0);assert.equal(lock(f).token,null);
});

test('a lock read returning after the verification timeout cannot start a late promotion',async()=>{
  const f=await ready(fixture());await savePublicCandidate(f.env,PUBLIC_STATE,{now:f.now()});
  const before={candidate:f.sqlite.prepare('SELECT * FROM cloud_auth_candidates').get(),profiles:f.sqlite.prepare('SELECT id,cipher FROM cloud_session ORDER BY id').all()};
  let release,signal,fireDeadline,reads=0;const gate=new Promise(resolve=>release=resolve),paused=new Promise(resolve=>signal=resolve);
  const prepare=f.env.STATE_DB.prepare;
  f.env.STATE_DB.prepare=function(sql){const statement=prepare.call(this,sql);
    if(sql==='SELECT token,expires_at,review FROM cloud_runner_lock WHERE id=1'){
      const first=statement.first;statement.first=async function(){const row=await first.call(this);if(++reads===2){signal();await gate;}return row;};
    }
    return statement;
  };
  const runner=createRunner({...f.deps,setDeadline(fn,ms){fireDeadline=()=>{f.advance(ms);fn();};return 1;},clearDeadline(){}});
  const operation=runner.revalidateGuest(f.env);await paused;fireDeadline();await assert.rejects(operation,{code:'guest-candidate-unverified'});
  assert.equal(f.sessions.size,0);assert.equal(lock(f).token,null);release();await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM cloud_auth_candidates').get(),before.candidate);
  assert.deepEqual(f.sqlite.prepare('SELECT id,cipher FROM cloud_session ORDER BY id').all(),before.profiles);assert.equal(f.counters.claims,0);
});

test('candidate staging, promotion and public-profile fallback recheck their deadline after encryption before sending any write',async()=>{
  for(const kind of ['candidate','public','staging']){
    const f=await ready(fixture()),candidate=await savePublicCandidate(f.env,PUBLIC_STATE,{now:f.now()});
    const before={candidate:f.sqlite.prepare('SELECT * FROM cloud_auth_candidates').get(),profiles:f.sqlite.prepare('SELECT id,cipher FROM cloud_session ORDER BY id').all()};
    let valid=true,release,signal;const gate=new Promise(resolve=>release=resolve),paused=new Promise(resolve=>signal=resolve);
    const encrypt=crypto.subtle.encrypt;
    crypto.subtle.encrypt=async function(...args){const result=await encrypt.apply(this,args);signal();await gate;return result;};
    const guard=()=>{if(!valid)throw Object.assign(new Error('fixture deadline'),{code:'fixture-deadline'});};
    try{
      const operation=kind==='candidate'?promotePublicCandidate(f.env,candidate,PUBLIC_STATE,{now:f.now(),guard}):kind==='public'?savePublicState(f.env,PUBLIC_STATE,{guard}):savePublicCandidate(f.env,PUBLIC_STATE,{now:f.now(),guard});
      await paused;valid=false;release();await assert.rejects(operation,{code:'fixture-deadline'});
    }finally{crypto.subtle.encrypt=encrypt;release();}
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM cloud_auth_candidates').get(),before.candidate);
    assert.deepEqual(f.sqlite.prepare('SELECT id,cipher FROM cloud_session ORDER BY id').all(),before.profiles);
  }
});

test('successful public checks persist rotated guest cookies only in the guest profile',async()=>{
  const f=await ready(fixture()),refreshed=structuredClone(PUBLIC_STATE);refreshed.cookies.push({name:'guest_refresh',value:'ROTATED-GUEST-COOKIE',domain:'.spacecloud.kr',path:'/'});
  const runner=createRunner({...f.deps,async execute(claim,driver,heartbeat){driver.config.publicContext.setStorageState(refreshed);await heartbeat();return {status:'succeeded'};}});
  await runner.runOne(f.env);assert.deepEqual(await loadPublicState(f.env),refreshed);assert.deepEqual(await loadState(f.env),PRIVATE_STATE);
  assert(!JSON.stringify(await loadState(f.env)).includes('ROTATED-GUEST-COOKIE'));
});

test('an unverified job cannot overwrite a saved guest profile with its failed session',async()=>{
  const f=await ready(fixture()),before=f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud_public'").get().cipher;
  const runner=createRunner({...f.deps,async execute(claim,driver,heartbeat){driver.config.publicContext.setStorageState({cookies:[],origins:[]});await heartbeat();return {status:'review'};}});
  await runner.runOne(f.env);assert.equal(f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud_public'").get().cipher,before);
  assert.deepEqual(await loadPublicState(f.env),PUBLIC_STATE);
});

test('a failed host login verification is closed and recorded as failed without saving authentication',async()=>{
  const f=fixture(),started=await f.runner.startLogin(f.env);
  class WrongAccount extends f.deps.Driver {async openRoom(){throw new Error('wrong host account');}}
  const runner=createRunner({...f.deps,Driver:WrongAccount});
  await assert.rejects(runner.saveLogin(f.env,started.login_id),/wrong host account/);
  assert.equal(f.sqlite.prepare('SELECT state FROM cloud_login WHERE id=?').get(started.login_id).state,'failed');
  assert.equal(await loadState(f.env),null);assert.equal(f.sessions.size,0);assert.equal(lock(f).review,0);
});

test('expiry maintenance closes an abandoned login without reading or changing Spacecloud reservations',async()=>{
  const f=fixture();await f.runner.startLogin(f.env);f.advance(300001);await f.runner.maintenance(f.env);
  assert.equal(f.sessions.size,0);assert.equal(f.counters.driverInitializations,0);assert.equal(f.counters.claims,0);assert.equal(f.counters.completions.length,0);
  assert.equal(f.sqlite.prepare('SELECT state FROM cloud_login').get().state,'expired');assert.equal(reservation(f).state,'closed');assert.equal(lock(f).token,null);
});

test('cost confirmation and a cleanup schedule are prerequisites even for read-only cloud checks',async()=>{
  for(const override of [{CLOUD_PLAN_CONFIRMED_FREE:'false'},{LOGIN_CLEANUP_SCHEDULED:'false'}]){
    const f=await ready(fixture(override));await assert.rejects(f.runner.runOne(f.env,{check:true}),{code:override.LOGIN_CLEANUP_SCHEDULED?'cleanup-not-scheduled':'cost-not-confirmed'});
    assert.equal(f.counters.claims,0);assert.equal(f.counters.launches,0);
  }
  const f=await ready(fixture({CLOUD_PLAN_MODE:'paid-included',INCLUDED_BUDGET_CONFIRMED:'true',CLOUD_PLAN_CONFIRMED_FREE:'false'}));
  const result=await f.runner.runOne(f.env,{check:true});assert.equal(result.read_only,true);assert.deepEqual(result.rooms,['r1','r2','r3','r4','r5']);assert.equal(f.counters.claims,0);assert.equal(f.counters.completions.length,0);assert.equal(f.sessions.size,0);
});

test('disabled automatic scheduling performs maintenance without leasing bookings or starting browsers',async()=>{
  const f=await ready(fixture({ENABLED:'false'}));await f.runner.scheduled(f.env);assert.equal(f.counters.maintenance,1);assert.equal(f.counters.claims,0);assert.equal(f.counters.launches,0);
});

test('website payment expiry runs before missing login, browser budget and quarantined lock gates',async()=>{
  const noLogin=fixture();await noLogin.runner.scheduled(noLogin.env);
  assert.equal(noLogin.counters.maintenance,1);assert.equal(noLogin.counters.claims,0);assert.equal(noLogin.counters.launches,0);
  const noBudget=await ready(fixture({DAILY_BROWSER_BUDGET_MS:'0'}));await noBudget.runner.scheduled(noBudget.env);
  assert.equal(noBudget.counters.maintenance,1);assert.equal(noBudget.counters.claims,0);assert.equal(noBudget.counters.launches,0);
  const quarantined=await ready(fixture());quarantined.sqlite.prepare('UPDATE cloud_runner_lock SET review=1 WHERE id=1').run();await quarantined.runner.scheduled(quarantined.env);
  assert.equal(quarantined.counters.maintenance,1);assert.equal(quarantined.counters.claims,0);assert.equal(quarantined.counters.launches,0);
});

test('payment expiry does not require a configured cloud browser or paid-plan confirmation',async()=>{
  const f=fixture({BROWSER:null,CLOUD_PLAN_CONFIRMED_FREE:'false'});await f.runner.scheduled(f.env);
  assert.equal(f.counters.maintenance,1);assert.equal(f.counters.claims,0);assert.equal(f.counters.launches,0);
});

test('scheduled expiry failures are contained and never waive the browser budget gate',async()=>{
  const f=await ready(fixture({DAILY_BROWSER_BUDGET_MS:'0'}));
  class FailingQueue extends f.deps.Queue {async maintenance(){f.counters.maintenance++;throw Object.assign(new Error('website unavailable'),{code:'queue-http-503'});}}
  const runner=createRunner({...f.deps,Queue:FailingQueue});await runner.scheduled(f.env);
  assert.equal(f.counters.maintenance,1);assert.equal(f.counters.claims,0);assert.equal(f.counters.launches,0);
});

test('website maintenance uses the scoped queue token with no lease request or credential redirect',async()=>{
  const calls=[],queue=new QueueClient({origin:'https://site.example',token:'scoped-private-queue-token-longer-than-thirty-two'},async(url,options)=>{
    calls.push({url,options});return Response.json({ok:true,maintenance:true});
  });
  assert.deepEqual(await queue.maintenance(),{ok:true,maintenance:true});assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://site.example/api/internal/spacecloud-sync');assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.redirect,'manual');
  assert.equal(calls[0].options.headers.Authorization,'Bearer scoped-private-queue-token-longer-than-thirty-two');
  assert.deepEqual(JSON.parse(calls[0].options.body),{action:'maintenance'});
});

test('saved authentication excludes Google, Naver and other SSO provider storage',async()=>{
  const f=fixture();await ensureStore(f.env);
  const state=structuredClone(PRIVATE_STATE);
  state.cookies.push({name:'google',value:'DO-NOT-KEEP',domain:'.google.com',path:'/'},{name:'lookalike',value:'DO-NOT-KEEP',domain:'spacecloud.kr.attacker.test',path:'/'});
  state.origins.push({origin:'https://nid.naver.com',localStorage:[{name:'private-sso',value:'DO-NOT-KEEP'}]});
  await saveState(f.env,state);assert.deepEqual(await loadState(f.env),PRIVATE_STATE);
});

test('calendar month rollover cannot reset the rolling 32-day browser allowance',async()=>{
  const f=fixture({DAILY_BROWSER_BUDGET_MS:'300000',MONTHLY_BROWSER_BUDGET_MS:'300000',ROLLING_32D_BROWSER_BUDGET_MS:'300000'});await ensureStore(f.env);
  const old=await reserveBudget(f.env,200000,{now:Date.parse('2026-11-30T12:00:00Z')});await settleBudget(f.env,old,{closed:false});
  await assert.rejects(reserveBudget(f.env,150000,{now:Date.parse('2026-12-01T12:00:00Z')}),{code:'daily-budget'});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_budget_reservations').get().n,1);
  await reserveBudget(f.env,150000,{now:Date.parse('2027-01-03T12:00:00Z')});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_budget_reservations').get().n,2);
});

test('a browser reservation never crosses the UTC usage-day boundary',async()=>{
  const f=fixture();await ensureStore(f.env);
  await assert.rejects(reserveBudget(f.env,150000,{now:Date.parse('2026-11-06T23:59:00Z')}),{code:'budget-window'});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_budget_reservations').get().n,0);
});

test('an expired orphan runner lock is quarantined rather than silently recycled',async()=>{
  const f=fixture();await ensureStore(f.env);await lockRunner(f.env,{duration:1000,now:f.now()});f.advance(2000);
  await f.runner.maintenance(f.env);assert.equal(lock(f).review,1);assert.equal(await lockRunner(f.env,{now:f.now()}),null);
});

test('the work deadline covers an acquisition that never resolves',async()=>{
  const f=await ready(fixture());
  const runner=createRunner({...f.deps,launch:()=>new Promise(()=>{}),setDeadline(fn,ms){return setTimeout(()=>{f.advance(ms);fn();},1);}});
  await assert.rejects(runner.runOne(f.env),{code:'browser-deadline'});
  assert.equal(f.counters.driverInitializations,0);assert.equal(reservation(f).state,'review');assert.equal(lock(f).review,1);
});

test('the work deadline also covers browser-context and driver initialization',async()=>{
  const f=await ready(fixture());
  class HangingDriver extends f.deps.Driver {async initialize(){f.counters.driverInitializations++;return new Promise(()=>{});}}
  const runner=createRunner({...f.deps,Driver:HangingDriver,setDeadline(fn,ms){return setTimeout(()=>{f.advance(ms);fn();},1);}});
  await assert.rejects(runner.runOne(f.env),{code:'browser-deadline'});
  assert.equal(f.sessions.size,0);assert.equal(reservation(f).state,'closed');assert.equal(f.counters.completions.at(-1).result.status,'review');
});

test('the login deadline starts before its remote acquisition',async()=>{
  const f=fixture();f.env.BROWSER.acquire=()=>new Promise(()=>{});
  const runner=createRunner({...f.deps,setDeadline(fn,ms){return setTimeout(()=>{f.advance(ms);fn();},1);}});
  await assert.rejects(runner.startLogin(f.env),{code:'login-expired'});
  assert.equal(reservation(f).state,'review');assert.equal(reservation(f).charged_ms,360000);assert.equal(lock(f).review,1);
});

test('scheduled payment collection uses the saved server login and the existing budget without a reservation lease',async()=>{
  const f=await ready(fixture({SPACECLOUD_CLOUD_SALES:'true',PUBLIC_AVAILABILITY_MODE:'public-api-v1'}));
  f.setJob(null);
  const plan={from:'2026-10-01',to:'2026-11-06',observed_at:CLOCK},rows=[{reservation_id:'1234',amount:10000}];
  const calls=[];
  const runner=createRunner({...f.deps,
    async requestPayments(config,body){
      calls.push(body);assert.equal(config.origin,'https://site.example');
      return body.action==='begin'?{ok:true,plan}:{ok:true,counts:{added:1}};
    },
    async collectPayments(context,received,live){assert.deepEqual(received,plan);live();return rows;}
  });
  await runner.scheduled(f.env,CLOCK);
  assert.deepEqual(calls,[{action:'begin',retry:false},{action:'sync',complete:true,observed_at:CLOCK,rows}]);
  assert.equal(f.counters.launches,1);
  assert.equal(f.counters.maintenance,1);
  assert.equal(f.counters.claims,1); // Separate website reservation poll returned no job.
  assert.equal(f.counters.completions.length,0);
  assert.equal(f.counters.driverInitializations,0);
  assert.equal(f.counters.closes.length,1);
  assert.equal(lock(f).token,null);
});

test('scheduled full host calendar collection restores the server login, commits complete scopes and closes within the shared budget',async()=>{
 const f=await ready(fixture({SPACECLOUD_CLOUD_CALENDAR:'true'})),calls=[];
 const plan={observed_at:CLOCK,scopes:[{space:'r1',month:'2026-11',product_id:'140236'}]};
 let began=false;
 const runner=createRunner({...f.deps,
  requestCalendar:async(config,body)=>{calls.push(body);if(body.action==='begin'){if(began)return {plan:null};began=true;return {plan};}return {ok:true};},
  collectCalendar:async(context,received,live)=>{assert.equal(received,plan);live();assert.equal(typeof context.storageState,'function');return [{...plan.scopes[0],events:[]}];}
 });
 f.setJob(null);await runner.scheduled(f.env,CLOCK);
 assert.deepEqual(calls.map(b=>b.action),['begin','sync']);assert.equal(calls[1].complete,true);assert.equal(f.counters.launches,1);assert.equal(f.counters.closes.length,1);
 assert.equal(f.counters.completions.length,0);assert.equal(lock(f).token,null);
 await runner.scheduled(f.env,CLOCK+60000);assert.equal(f.counters.launches,1);
});

test('a full calendar API audit continues with zero browser allowance and does not acquire or reserve a browser',async()=>{
 const f=await ready(fixture({SPACECLOUD_CLOUD_CALENDAR:'true',DAILY_BROWSER_BUDGET_MS:'0',MONTHLY_BROWSER_BUDGET_MS:'0'})),calls=[];
 const plan={observed_at:CLOCK,scopes:[{space:'r1',month:'2026-11',product_id:'140236'}]};
 const runner=createRunner({...f.deps,requestCalendar:async(config,body)=>{calls.push(body);return body.action==='begin'?{plan}:{ok:true};},
  collectCalendarAPI:async(state,received,{live})=>{live();assert.equal(received,plan);return {state,snapshots:[]};}});
 await runner.runCalendar(f.env);
 assert.deepEqual(calls.map(b=>b.action),['begin','sync']);assert.equal(calls[1].transport,'api');
 assert.equal(f.counters.launches,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_budget_reservations').get().n,0);assert.equal(lock(f).token,null);
});
