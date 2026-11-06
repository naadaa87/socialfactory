import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureStore,encryptState,decryptState,saveState,loadState,reserveBudget,settleBudget,lockRunner,dailyLimit,monthlyLimit } from '../store.mjs';
import { createRunner } from '../runner.mjs';
import { persistentConnector } from '../connection.mjs';

const CLOCK=Date.parse('2026-11-06T10:00:00Z');
const PRIVATE_STATE={cookies:[{name:'auth',value:'PRIVATE-LOGIN-COOKIE',domain:'partner.spacecloud.kr',path:'/'}],origins:[{origin:'https://partner.spacecloud.kr',localStorage:[{name:'example',value:'PRIVATE-LOCAL-STATE'}]}]};
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
  const counters={claims:0,heartbeats:0,completions:[],launches:0,connects:0,acquires:0,closes:[],disconnects:0,driverInitializations:0,rooms:[],restored:[]};
  const sessions=new Map();
  let nextSession=0,clock=CLOCK,closeFails=false,knownMissing404=false,launchFails=false,currentJob=job;
  function context(){const pages=[];return {pages:()=>pages,
    async newPage(){let url='about:blank';const page={async goto(value){url=value;},url:()=>url};pages.push(page);return page;},
    async newCDPSession(){return {async send(command,options){assert.equal(command,'Cloudflare.getLiveView');assert.equal(options.mode,'tab');return {devtoolsFrontendUrl:'https://live.browser.run/ui/view?jwt=PRIVATE-SHORT-LIVED-VIEW'};}};},
    async storageState(){return structuredClone(PRIVATE_STATE);}};}
  function browserFor(id){const state=sessions.get(id);assert(state,'fake session must exist');return {sessionId:()=>id,contexts:()=>[state.context],
    async newContext(options){counters.restored.push(options.storageState);return state.context;},async close(){counters.disconnects++;}};}
  const BROWSER={async acquire(){counters.acquires++;const id='session-'+(++nextSession);sessions.set(id,{context:context()});return {sessionId:id};},
    async closeSession(id){counters.closes.push(id);if(closeFails)throw new Error('remote closure was not acknowledged');sessions.delete(id);return {status:'closed'};},
    async getSession(id){if(!sessions.has(id) && knownMissing404)throw Object.assign(new Error('no such session'),{status:404});return sessions.has(id)?{sessionId:id,status:'active'}:null;}};
  class Queue {async claim(){counters.claims++;return currentJob;}async heartbeat(){counters.heartbeats++;}async complete(claim,result){counters.completions.push({claim,result});return {ok:true};}}
  class Driver {constructor(ctx,config){this.context=ctx;this.config=config;}async initialize(){counters.driverInitializations++;}async openRoom(room){counters.rooms.push(room);}async hostMonth(){return '2026.11';}}
  const deps={Queue,Driver,now:()=>clock,
    async launch(){counters.launches++;if(launchFails)throw new Error('unknown acquisition result');const {sessionId}=await BROWSER.acquire();return browserFor(sessionId);},
    async connect(binding,id){counters.connects++;return browserFor(id);},
    async execute(claim,driver,heartbeat){assert.equal(driver.config.allowWrites,true);await heartbeat();return {status:'succeeded',receipt:{observed_at:clock}};}};
  const env={STATE_DB:DB,BROWSER,ENABLED:'true',ALLOW_WRITES:'true',CLOUD_PLAN_MODE:'free',CLOUD_PLAN_CONFIRMED_FREE:'true',LOGIN_CLEANUP_SCHEDULED:'true',
    SESSION_ENCRYPTION_KEY:'test-only-encryption-key-more-than-thirty-two-chars',CLOUD_ADMIN_TOKEN:'test-only-cloud-administrator-token-long-enough',
    SPACECLOUD_WORKER_TOKEN:'test-only-website-worker-token-thirty-two-chars',API_ORIGIN:'https://site.example',...overrides};
  return {env,sqlite,counters,deps,sessions,runner:createRunner(deps),advance(ms){clock+=ms;},setJob(value){currentJob=value;},setCloseFailure(value=true){closeFails=value;},setMissing404(value=true){knownMissing404=value;},setLaunchFailure(value=true){launchFails=value;},now:()=>clock};
}
async function ready(f){await ensureStore(f.env);await saveState(f.env,PRIVATE_STATE);return f;}
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
  assert.equal(dailyLimit({CLOUD_PLAN_MODE:'paid-included',INCLUDED_BUDGET_CONFIRMED:'true',DAILY_BROWSER_BUDGET_MS:'99999999'}),1800000);
  assert.equal(monthlyLimit({MONTHLY_BROWSER_BUDGET_MS:'999999999'}),7200000);
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
  await saveState(f.env,PRIVATE_STATE);f.env.DAILY_BROWSER_BUDGET_MS='0';await assert.rejects(f.runner.runOne(f.env),{code:'daily-budget'});
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
  for(const path of ['/status','/login/start','/check','/maintenance']){
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
  assert.equal(result.status,'succeeded');assert.equal(f.counters.claims,1);assert.equal(f.counters.launches,1);assert.deepEqual(f.counters.restored,[PRIVATE_STATE]);
  assert.equal(f.counters.completions.length,1);assert.equal(f.counters.completions[0].result.status,'succeeded');assert.equal(f.sessions.size,0);assert.equal(f.counters.closes.length,1);
  assert.equal(reservation(f).state,'closed');assert.equal(lock(f).token,null);assert.equal(lock(f).review,0);
  assert(!f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud'").get().cipher.includes('PRIVATE-LOGIN-COOKIE'));
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
  assert(started.live_view_url.startsWith('https://live.browser.run/'));assert.equal(f.counters.claims,0);assert.equal(f.sessions.size,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM cloud_session').get().n,0);assert.equal(lock(f).review,0);assert(lock(f).token);
  f.advance(20000);const saved=await f.runner.saveLogin(f.env,started.login_id);assert.equal(saved.saved,true);assert.deepEqual(await loadState(f.env),PRIVATE_STATE);
  assert.deepEqual(f.counters.rooms,['r5']);assert.equal(f.sessions.size,0);assert.equal(f.counters.claims,0);assert.equal(f.counters.completions.length,0);
  const stored=f.sqlite.prepare("SELECT cipher FROM cloud_session WHERE id='spacecloud'").get().cipher;assert(!stored.includes('PRIVATE-LOGIN-COOKIE'));
  assert.equal(reservation(f).state,'closed');assert.equal(lock(f).token,null);
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
  const f=await ready(fixture({ENABLED:'false'}));await f.runner.scheduled(f.env);assert.equal(f.counters.claims,0);assert.equal(f.counters.launches,0);
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
