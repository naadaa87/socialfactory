import { QueueClient } from '../../integrations/spacecloud-worker/queue.mjs';
import { SpacecloudUI } from '../../integrations/spacecloud-worker/spacecloud-ui.mjs';
import { executeJob } from '../../integrations/spacecloud-worker/safety.mjs';
import { ensureStore,problem,loadState,saveState,loadPublicState,savePublicState,onlySpacecloudState,lockRunner,assertLock,unlockRunner,reserveBudget,settleBudget,budgetStatus,paidIncluded } from './store.mjs';

const HOME='https://partner.spacecloud.kr/reservation-calendar?product=140492&space=82026';
const GUEST_HOME='https://www.spacecloud.kr/auth/login?source=detail-page';
const LOGIN_MS=300000,CLEANUP_MS=60000;
const accountLabel=env=>env.SPACECLOUD_ACCOUNT_LABEL || '소셜팩토리 건대 (초특가)';
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'}});
function equal(a,b){if(typeof a!=='string' || typeof b!=='string')return false;let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;}
function controlAllowed(request,env){const token=String(env.CLOUD_ADMIN_TOKEN || '');return token.length>=32 && equal(request.headers.get('authorization') || '','Bearer '+token);}
function wakeAllowed(request,env){const token=String(env.SPACECLOUD_WORKER_TOKEN || '');return token.length>=32 && equal(request.headers.get('authorization') || '','Bearer '+token);}
function guestDiagnostic(value) {
  const result={};
  for(const [key,allowed] of [['phase',['public-progress','request-readiness']],['step',['goto','ready','room','time','month','date','slots']],['type',['document','xhr','fetch']]])if(allowed.includes(value?.[key]))result[key]=value[key];
  const events=['layout','mismatch',...['navigate','settle','attached','checked','identity','label','layout','read','click','changed','candidates','visible','compare'].flatMap(name=>[name+'-before',name+'-after'])];
  if(events.includes(value?.event))result.event=value.event;
  for(const key of ['elapsed_ms','attempt','status','client_width','client_height','inner_width','inner_height','heading_count','index'])if(Number.isFinite(value?.[key]) && value[key]>=0 && value[key]<=1e9)result[key]=value[key];
  for(const key of ['matches','expected_disabled','actual_disabled','actual_selectable','prefetch','next_router_prefetch','rsc','navigation'])if(typeof value?.[key]==='boolean')result[key]=value[key];
  return result;
}
function configured(env){
  if(!env.BROWSER)throw problem('browser-binding','클라우드 브라우저 연결이 필요합니다.',503);
  if(!(paidIncluded(env) || (env.CLOUD_PLAN_MODE!=='paid-included' && env.CLOUD_PLAN_CONFIRMED_FREE==='true')))
    throw problem('cost-not-confirmed','요금제와 포함 사용량 확인 전에는 클라우드 브라우저를 실행하지 않습니다.',503);
  if(env.LOGIN_CLEANUP_SCHEDULED!=='true')throw problem('cleanup-not-scheduled','브라우저 자동 종료 스케줄을 먼저 연결해야 합니다.',503);
  if(String(env.SESSION_ENCRYPTION_KEY || '').length<32)throw problem('encryption-key','로그인 암호화 키를 먼저 설정해야 합니다.',503);
}
function queueConfig(env){const origin=new URL(env.API_ORIGIN);if(origin.protocol!=='https:' || origin.origin!==env.API_ORIGIN || origin.username || origin.password)throw problem('api-origin','홈페이지 API 주소를 확인해 주세요.',503);if(String(env.SPACECLOUD_WORKER_TOKEN || '').length<32)throw problem('queue-token','홈페이지 연결 토큰을 먼저 설정해야 합니다.',503);return {origin:origin.origin,token:env.SPACECLOUD_WORKER_TOKEN};}
function reservationRow(row){return {id:row.budget_id,day:new Date(row.started_at).toISOString().slice(0,10),month:new Date(row.started_at).toISOString().slice(0,7),started_at:row.started_at,reserved_ms:row.reserved_ms};}
async function budgetFor(env,row){const budget=await env.STATE_DB.prepare('SELECT * FROM cloud_budget_reservations WHERE id=?1').bind(row.budget_id).first();if(!budget)throw problem('missing-budget','브라우저 사용량 기록을 확인해야 합니다.',503);return {...reservationRow(row),...budget};}

export function createRunner({launch,connect,Queue=QueueClient,Driver=SpacecloudUI,execute=executeJob,now=()=>Date.now(),setDeadline=setTimeout,clearDeadline=clearTimeout}={}) {
  const bounded=(promise,ms=5000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(problem('remote-timeout','클라우드 브라우저 응답을 확인하지 못했습니다.',503)),ms);Promise.resolve(promise).then(resolve,reject).finally(()=>clearTimeout(timer));});
  async function closeRemote(env,sessionId,browser) {
    let closed=false;
    try {
      // connect().close() only disconnects; the typed binding explicitly terminates the remote Chrome.
      await bounded(env.BROWSER.closeSession(sessionId));
    } catch {}
    try {if(browser)await bounded(browser.close(),2000);}catch{}
    for(let attempt=0;attempt<4;attempt++){
      try {const remaining=await bounded(env.BROWSER.getSession(sessionId),2000);if(!remaining || remaining.status==='closed'){closed=true;break;}}
      catch(error){if(error?.status===404 || error?.statusCode===404 || /^BrowserBindingError: Session not found \(status=404\)$/.test(String(error?.message || ''))){closed=true;break;}}
      if(attempt<3)await new Promise(resolve=>setTimeout(resolve,200));
    }
    return closed;
  }
  async function finishRecorded(env,table,row,{browser,state='closed'}={}) {
    const closed=await closeRemote(env,row.session_id,browser),budget=await budgetFor(env,row);
    await settleBudget(env,budget,{closed,now:now()});
    await env.STATE_DB.prepare(`UPDATE ${table} SET state=?2 WHERE id=?1 AND state='active'`).bind(row.id,closed?state:'review').run();
    await unlockRunner(env,row.lock_token,{review:!closed});
    return closed;
  }
  async function maintenance(env) {
    await ensureStore(env);
    for(const table of ['cloud_login','cloud_guest_login','cloud_browser_runs']){
      const {results}=await env.STATE_DB.prepare(`SELECT * FROM ${table} WHERE state='active' AND expires_at<=?1 LIMIT 5`).bind(now()).all();
      for(const row of results || [])await finishRecorded(env,table,row,{state:'expired'});
    }
    // An orphaned expired lock is uncertain; it must never silently authorize another browser.
    await env.STATE_DB.prepare("UPDATE cloud_runner_lock SET review=1 WHERE id=1 AND token IS NOT NULL AND expires_at<=?1").bind(now()).run();
  }
  async function runBrowser(env,{kind='run',job,queue,storageState,publicStorageState,token,budget,activeMs}={}) {
    let browser,context,sessionId,closed=false,recorded=false,timer,leaseTimer,deadlineReached=false,launchAttempted=false,leaseLost=false,beating=false;
    const started=budget.started_at,expires=started+activeMs;
    const live=()=>{if(leaseLost || deadlineReached || now()>=expires)throw problem('browser-deadline','안전 실행시간이나 작업 임대를 넘겨 추가 변경을 중단했습니다.');};
    const heartbeat=async()=>{live();await assertLock(env,token,now());if(job)await queue.heartbeat(job);};
    const timeout=new Promise((_,reject)=>{timer=setDeadline(()=>{deadlineReached=true;if(sessionId)void closeRemote(env,sessionId,browser);reject(problem('browser-deadline','클라우드 브라우저 실행시간을 넘겨 자동 종료합니다.'));},Math.max(1,expires-now()));});
    try {
      // The deadline already exists before the first browser acquisition or initialization await.
      const work=(async()=>{
        live();launchAttempted=true;browser=await launch(env.BROWSER,{keep_alive:60000});sessionId=browser.sessionId();
        if(!sessionId)throw problem('session-id','클라우드 브라우저 식별자를 확인하지 못했습니다.',503);
        if(deadlineReached || now()>=expires){await closeRemote(env,sessionId,browser);throw problem('browser-deadline','늦게 도착한 클라우드 브라우저를 종료했습니다.');}
        live();
        await env.STATE_DB.prepare(`INSERT INTO cloud_browser_runs(id,session_id,lock_token,budget_id,started_at,expires_at) VALUES(?1,?2,?3,?1,?4,?5)`)
          .bind(budget.id,sessionId,token,started,expires).run();recorded=true;
        live();context=await browser.newContext({storageState,locale:'ko-KR',timezoneId:'Asia/Seoul',viewport:{width:1600,height:1100}});
        live();
        if(job)leaseTimer=setInterval(async()=>{if(beating || leaseLost)return;beating=true;try{await heartbeat();}catch{leaseLost=true;}finally{beating=false;}},20000);
        // Customer login is a separately saved profile, never the host profile.
        const publicContext=kind==='run'?await browser.newContext({storageState:publicStorageState,locale:'ko-KR',timezoneId:'Asia/Seoul',viewport:{width:1600,height:1100}}):undefined;
        live();
        const driver=new Driver(context,{allowWrites:kind==='run' && env.ALLOW_WRITES==='true',accountLabel:accountLabel(env),publicContext});
      driver.reportReview=diagnostic=>console.error('spacecloud-cloud','job-review',diagnostic);
        await driver.initialize();live();
        if(kind==='check'){
          const rooms=[];for(const room of ['r1','r2','r3','r4','r5']){await heartbeat();await driver.openRoom(room);live();await driver.hostMonth();rooms.push(room);}
          live();await saveState(env,await context.storageState({indexedDB:true}));return {ok:true,read_only:true,rooms};
        }
        const result=await execute(job,driver,heartbeat);live();
        await saveState(env,await context.storageState({indexedDB:true}));live();
        if(result.status==='succeeded'){
          await savePublicState(env,await publicContext.storageState({indexedDB:true}));live();
        }
        await queue.complete(job,result);
        return {ok:true,code:job.code,status:result.status};
      })();
      return await Promise.race([work,timeout]);
    } catch(error) {
      if(job){try{await queue.complete(job,{status:'review',message:'클라우드 처리 결과 확인이 필요합니다. 외부 시간 확보를 유지합니다.'});}catch{}}
      throw error;
    } finally {
      clearDeadline(timer);clearInterval(leaseTimer);
      if(sessionId)closed=await closeRemote(env,sessionId,browser);
      else if(!launchAttempted)closed=true;
      if(recorded)await env.STATE_DB.prepare("UPDATE cloud_browser_runs SET state=?2 WHERE id=?1 AND state='active'").bind(budget.id,closed?'closed':'review').run();
      await settleBudget(env,budget,{closed,notStarted:!launchAttempted,now:now()});
      await unlockRunner(env,token,{review:!closed});
    }
  }
  async function runOne(env,{check=false}={}) {
    await ensureStore(env);await maintenance(env);configured(env);
    if(!check && (env.ENABLED!=='true' || env.ALLOW_WRITES!=='true'))throw problem('runner-disabled','자동 연동은 아직 활성화하지 않았습니다.',503);
    const storageState=await loadState(env);if(!storageState)throw problem('login-required','클라우드 전용 브라우저에 먼저 로그인해 주세요.',503);
    const publicStorageState=check?null:await loadPublicState(env);
    if(!check && !publicStorageState)throw problem('guest-login-required','고객 예약 화면을 확인하려면 클라우드 게스트 로그인을 먼저 연결해 주세요.',503);
    const qconfig=check?null:queueConfig(env),token=await lockRunner(env,{duration:240000,now:now()});
    if(!token)throw problem('runner-busy','다른 클라우드 작업을 처리하고 있습니다.');
    const activeMs=Math.max(30000,Math.min(120000,Number(env.RUN_BUDGET_MS)||90000));
    let budget,job,delegated=false;
    try {
      budget=await reserveBudget(env,activeMs+CLEANUP_MS,{now:now()});
      // Do not lease a website booking before login and budget are known to be ready.
      const queue=check?null:new Queue(qconfig);
      if(!check){job=await queue.claim();if(!job){await settleBudget(env,budget,{closed:true,notStarted:true,now:now()});await unlockRunner(env,token);return {ok:true,idle:true};}}
      delegated=true;return await runBrowser(env,{kind:check?'check':'run',job,queue,storageState,publicStorageState,token,budget,activeMs});
    } catch(error) {
      // Delegation is explicit. Missing metadata never proves a browser was not acquired.
      if(!delegated){if(budget)await settleBudget(env,budget,{closed:true,notStarted:true,now:now()});await unlockRunner(env,token);}
      throw error;
    }
  }
  async function startLogin(env,{guest=false}={}) {
    const table=guest?'cloud_guest_login':'cloud_login';
    await ensureStore(env);await maintenance(env);configured(env);
    const token=await lockRunner(env,{duration:LOGIN_MS+CLEANUP_MS+60000,now:now()});if(!token)throw problem('runner-busy','진행 중인 클라우드 작업이나 로그인을 먼저 완료해 주세요.');
    let budget,browser,sessionId,id,recorded=false,acquireAttempted=false,timer,deadlineReached=false;
    try {
      budget=await reserveBudget(env,LOGIN_MS+CLEANUP_MS,{now:now()});
      const expires=budget.started_at+LOGIN_MS;
      const setupExpires=budget.started_at+30000;
      const live=()=>{if(deadlineReached || now()>=setupExpires)throw problem('login-expired','로그인 화면 준비시간이 지났습니다. 다시 진행해 주세요.');};
      const timeout=new Promise((_,reject)=>{timer=setDeadline(()=>{deadlineReached=true;if(sessionId)void closeRemote(env,sessionId,browser);reject(problem('login-expired','로그인 화면 준비시간을 넘겨 자동 종료합니다.'));},Math.max(1,setupExpires-now()));});
      const work=(async()=>{
        live();acquireAttempted=true;
        // Setup is capped at 30s; a lost acquisition then idles out within the reserved 360s.
        const session=await env.BROWSER.acquire({keepAlive:240000,targets:true});sessionId=session.sessionId;
        if(!sessionId)throw problem('session-id','클라우드 로그인 화면을 열지 못했습니다.',503);
        if(deadlineReached || now()>=setupExpires){await closeRemote(env,sessionId,browser);throw problem('login-expired','늦게 도착한 로그인 브라우저를 종료했습니다.');}
        live();id=crypto.randomUUID();
        await env.STATE_DB.prepare(`INSERT INTO ${table}(id,session_id,lock_token,budget_id,started_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)`)
          .bind(id,sessionId,token,budget.id,budget.started_at,expires).run();recorded=true;
        live();browser=await connect(env.BROWSER,sessionId);live();
        const context=browser.contexts()[0];
        if(!context)throw problem('persistent-context','유지되는 클라우드 로그인 화면을 확인하지 못했습니다.',503);
        live();const page=await context.newPage();await page.goto(guest?GUEST_HOME:HOME,{waitUntil:'domcontentloaded'});live();
        const cdp=await context.newCDPSession(page);
        const liveView=await cdp.send('Cloudflare.getLiveView',{mode:guest?'full':'tab',expiresInMs:Math.max(60000,expires-now())});live();
        if(typeof liveView.devtoolsFrontendUrl!=='string' || !liveView.devtoolsFrontendUrl.startsWith('https://live.browser.run/'))throw problem('login-view','로그인 화면 연결을 확인하지 못했습니다.',503);
        await browser.close();browser=null;
        return {ok:true,purpose:guest?'guest':'host',login_id:id,sessionId,expires_at:expires,live_view_url:liveView.devtoolsFrontendUrl,
          instructions:guest?'새 창에서 스페이스클라우드 게스트 계정에 로그인한 뒤 로그인 저장을 눌러 주세요. 비밀번호를 채팅에 보내지 마세요.':'새 창에서 스페이스클라우드 호스트 계정에 로그인한 뒤 로그인 저장을 눌러 주세요. 비밀번호를 채팅에 보내지 마세요.'};
      })();
      return await Promise.race([work,timeout]);
    } catch(error) {
      const closed=sessionId?await closeRemote(env,sessionId,browser):!acquireAttempted;
      if(recorded)await env.STATE_DB.prepare(`UPDATE ${table} SET state=?2 WHERE id=?1`).bind(id,closed?'failed':'review').run();
      if(budget)await settleBudget(env,budget,{closed,notStarted:!acquireAttempted,now:now()});
      await unlockRunner(env,token,{review:!closed});throw error;
    } finally {clearDeadline(timer);}
  }
  async function saveLogin(env,id,{cancel=false,guest=false}={}) {
    await ensureStore(env);configured(env);
    const table=guest?'cloud_guest_login':'cloud_login';
    const row=await env.STATE_DB.prepare(`SELECT * FROM ${table} WHERE id=?1 AND state='active'`).bind(id).first();
    if(!row)throw problem('login-session','유효한 클라우드 로그인 화면이 없습니다.');
    let browser,saved=false,timer,deadlineReached=false;
    try {
      if(row.expires_at<=now())throw problem('login-expired','로그인 화면의 유효시간이 지났습니다. 다시 열어 주세요.');
      await assertLock(env,row.lock_token,now());
      if(cancel)return {ok:true,purpose:guest?'guest':'host',cancelled:true};
      const expires=Math.min(row.expires_at,now()+30000);
      const live=()=>{if(guest && (deadlineReached || now()>=expires))throw problem('login-expired','게스트 로그인 확인시간을 넘겼습니다. 다시 연결해 주세요.');};
      const work=async()=>{
        live();browser=await connect(env.BROWSER,row.session_id);
        if(guest && (deadlineReached || now()>=expires)){await closeRemote(env,row.session_id,browser);live();}
        const prefix=guest?'https://www.spacecloud.kr/':'https://partner.spacecloud.kr/';
        const contexts=browser.contexts(),context=contexts.find(c=>c.pages().some(p=>p.url().startsWith(prefix)));
        if(!context)throw problem(guest?'guest-login-required':'login-required',guest?'스페이스클라우드 게스트 로그인을 완료해 주세요.':'스페이스클라우드 호스트 로그인을 완료해 주세요.');
        let verificationContext=context;
        if(guest){
          const captured=onlySpacecloudState(await context.storageState({indexedDB:true}));live();
          verificationContext=await browser.newContext({storageState:captured,locale:'ko-KR',timezoneId:'Asia/Seoul',viewport:{width:1600,height:1100}});live();
        }
        const driver=new Driver(verificationContext,{allowWrites:false,accountLabel:accountLabel(env),...(guest?{publicContext:verificationContext}:{})});
        if(guest)driver.reportReview=diagnostic=>console.error('spacecloud-cloud','guest-login-review',guestDiagnostic(diagnostic));
        await driver.initialize();live();
        if(guest){const verified=await driver.verifyGuestLogin();live();if(verified?.guest_ready!==true)throw problem('guest-login-required','고객 예약 화면의 로그인 완료를 확인하지 못했습니다.',503);}
        else {await driver.openRoom('r5');await driver.hostMonth();}
        const state=await verificationContext.storageState({indexedDB:true});live();
        if(guest)await savePublicState(env,state);else await saveState(env,state);
        live();saved=true;
        return {ok:true,purpose:guest?'guest':'host',saved:true,message:guest?'클라우드 게스트 로그인 상태를 별도로 암호화하여 저장했습니다.':'클라우드 로그인 상태를 암호화하여 저장했습니다.'};
      };
      if(!guest)return await work();
      const timeout=new Promise((_,reject)=>{timer=setDeadline(()=>{deadlineReached=true;void closeRemote(env,row.session_id,browser);reject(problem('login-expired','게스트 로그인 확인시간을 넘겨 자동 종료합니다.'));},Math.max(1,expires-now()));});
      return await Promise.race([work(),timeout]);
    } finally {
      clearDeadline(timer);
      const closed=await finishRecorded(env,table,row,{browser,state:cancel?'cancelled':saved?'saved':'failed'});
      if(!closed)throw problem('close-unconfirmed','클라우드 브라우저 종료를 확인하지 못했습니다. 새 작업을 보류합니다.',503);
    }
  }
  async function viewGuestLogin(env,id) {
    await ensureStore(env);configured(env);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw problem('login-session','유효한 클라우드 로그인 화면이 없습니다.');
    const row=await env.STATE_DB.prepare("SELECT * FROM cloud_guest_login WHERE id=?1 AND state='active'").bind(id).first();
    if(!row)throw problem('login-session','유효한 클라우드 게스트 로그인 화면이 없습니다.');
    const live=async()=>{
      // Cloudflare requires a minimum 60-second connection deadline. Never renew
      // this login or issue a link extending its existing browser reservation.
      if(row.expires_at-now()<65000)throw problem('login-expired','기존 로그인 화면의 유효시간이 얼마 남지 않았습니다. 열려 있는 화면에서 로그인을 완료해 주세요.');
      await assertLock(env,row.lock_token,now());
    };
    let browser;
    try {
      await live();browser=await bounded(connect(env.BROWSER,row.session_id),5000);await live();
      const context=browser.contexts()[0],pages=context?.pages() || [];
      const page=pages.find(page=>page.url().startsWith('https://www.spacecloud.kr/')) || pages[0];
      if(!context || !page)throw problem('login-view','기존 게스트 로그인 화면을 확인하지 못했습니다.',503);
      const cdp=await bounded(context.newCDPSession(page),5000);await live();
      const view=await bounded(cdp.send('Cloudflare.getLiveView',{mode:'full',expiresInMs:row.expires_at-now()-5000}),5000);await live();
      if(typeof view.devtoolsFrontendUrl!=='string' || !view.devtoolsFrontendUrl.startsWith('https://live.browser.run/'))throw problem('login-view','로그인 화면 연결을 확인하지 못했습니다.',503);
      return {ok:true,purpose:'guest',login_id:id,expires_at:row.expires_at,live_view_url:view.devtoolsFrontendUrl};
    } finally {
      // Persistent connect().close() only detaches this transport. The user's
      // existing login, browser, lock and budget reservation remain untouched.
      if(browser)try{await bounded(browser.close(),2000);}catch{}
    }
  }
  async function status(env){await ensureStore(env);const session=await env.STATE_DB.prepare("SELECT updated_at FROM cloud_session WHERE id='spacecloud'").first(),publicSession=await env.STATE_DB.prepare("SELECT updated_at FROM cloud_session WHERE id='spacecloud_public'").first(),lock=await env.STATE_DB.prepare('SELECT expires_at,review FROM cloud_runner_lock WHERE id=1').first();return {ok:true,enabled:env.ENABLED==='true',allow_writes:env.ALLOW_WRITES==='true',login_saved:!!session,session_updated_at:session?.updated_at || null,public_login_saved:!!publicSession,public_session_updated_at:publicSession?.updated_at || null,budget:await budgetStatus(env),runner:{busy:lock.expires_at>now(),review:!!lock.review}};}
  async function providerStatus(env){
    await ensureStore(env);
    const row=await env.STATE_DB.prepare('SELECT state,expires_at,session_id FROM cloud_login ORDER BY started_at DESC,rowid DESC LIMIT 1').first();
    if(!row)return {ok:true,state:null,expires_at:null,provider_exists:false,status:null,provider_keys:[]};
    try {
      const session=await env.BROWSER.getSession(row.session_id);
      return {ok:true,state:row.state,expires_at:row.expires_at,provider_exists:!!session,
        status:session?.status ? String(session.status).slice(0,80) : null,provider_keys:session && typeof session==='object'?Object.keys(session):[]};
    }catch(error){return {ok:true,state:row.state,expires_at:row.expires_at,provider_exists:null,status:null,provider_keys:[],
      error:{name:String(error?.name || 'Error').slice(0,80),status:error?.status || error?.statusCode || null,code:String(error?.code || '').slice(0,80),message:String(error?.message || '').slice(0,200)}};}
  }
  return {
    maintenance,runOne,startLogin,saveLogin,status,
    startGuestLogin:env=>startLogin(env,{guest:true}),
    saveGuestLogin:(env,id,options={})=>saveLogin(env,id,{...options,guest:true}),
    viewGuestLogin,
    async fetch(request,env){
      const url=new URL(request.url);
      if(url.pathname==='/health' && request.method==='GET')return response({ok:true,service:'spacecloud-cloud',enabled:env.ENABLED==='true'});
      if(!controlAllowed(request,env) && !(url.pathname==='/run' && wakeAllowed(request,env)))return response({ok:false,error:'unauthorized'},401);
      const origin=request.headers.get('origin');if(origin && origin!==url.origin)return response({ok:false,error:'origin'},403);
      try {
        if(url.pathname==='/status' && request.method==='GET')return response(await status(env));
        if(url.pathname==='/login/provider' && request.method==='GET')return response(await providerStatus(env));
        if(request.method!=='POST')return response({ok:false,error:'method'},405);
        let body={};const text=await request.text();if(text.length>4096)return response({ok:false,error:'too-large'},413);if(text)body=JSON.parse(text);
        // A Pages request may disconnect quickly. Only Cron performs browser writes.
        if(url.pathname==='/run'){
          if(env.ENABLED!=='true' || env.ALLOW_WRITES!=='true')throw problem('runner-disabled','자동 연동은 아직 활성화하지 않았습니다.',503);
          configured(env);await ensureStore(env);
          if(!await loadState(env))throw problem('login-required','클라우드 전용 브라우저에 먼저 로그인해 주세요.',503);
          if(!await loadPublicState(env))throw problem('guest-login-required','고객 예약 화면을 확인하려면 클라우드 게스트 로그인을 먼저 연결해 주세요.',503);
          return response({ok:true,scheduled:true,message:'상시 클라우드 스케줄에서 예약 작업을 처리합니다.'},202);
        }
        if(url.pathname==='/check')return response(await runOne(env,{check:true}));
        if(url.pathname==='/login/start')return response(await startLogin(env));
        if(['/login/save','/login/cancel'].includes(url.pathname))return response(await saveLogin(env,String(body?.login_id || ''),{cancel:url.pathname==='/login/cancel'}));
        if(url.pathname==='/guest-login/start')return response(await startLogin(env,{guest:true}));
        if(url.pathname==='/guest-login/view')return response(await viewGuestLogin(env,String(body?.login_id || '')));
        if(['/guest-login/save','/guest-login/cancel'].includes(url.pathname))return response(await saveLogin(env,String(body?.login_id || ''),{cancel:url.pathname==='/guest-login/cancel',guest:true}));
        if(url.pathname==='/maintenance'){await maintenance(env);return response({ok:true});}
        return response({ok:false,error:'not-found'},404);
      } catch(error){return response({ok:false,error:error.code || 'cloud-error',message:error.code?error.message:'클라우드 작업을 완료하지 못했습니다. 새 결제를 보류하고 연결을 확인해 주세요.'},error.status || 503);}
    },
    async scheduled(env){
      // Never tie unpaid PayApp expiry to Chrome login, browser locks or budget.
      // This authenticated website action cannot lease work or launch a browser.
      try {await new Queue(queueConfig(env)).maintenance();}
      catch(error){console.error('spacecloud-cloud','website-maintenance',error.code || 'operation-failed');}
      try {await maintenance(env);}
      catch(error){console.error('spacecloud-cloud','browser-maintenance',error.code || 'operation-failed');return;}
      if(env.ENABLED==='true' && env.ALLOW_WRITES==='true'){
        try{await runOne(env);}catch(error){console.error('spacecloud-cloud',error.code || 'operation-failed');}
      }
    }
  };
}
