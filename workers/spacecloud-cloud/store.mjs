const encoder=new TextEncoder(),decoder=new TextDecoder();
export const schema=[
  `CREATE TABLE IF NOT EXISTS cloud_session (id TEXT PRIMARY KEY, cipher TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cloud_budget (id INTEGER PRIMARY KEY CHECK(id=1), day TEXT NOT NULL DEFAULT '', month TEXT NOT NULL DEFAULT '',
    day_ms INTEGER NOT NULL DEFAULT 0, month_ms INTEGER NOT NULL DEFAULT 0,last_id TEXT)`,
  `INSERT OR IGNORE INTO cloud_budget(id) VALUES(1)`,
  `CREATE TABLE IF NOT EXISTS cloud_budget_reservations (id TEXT PRIMARY KEY, day TEXT NOT NULL, month TEXT NOT NULL,reserved_ms INTEGER NOT NULL,
    charged_ms INTEGER,started_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'reserved', closed_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS idx_cloud_budget_started ON cloud_budget_reservations(started_at)`,
  `CREATE TABLE IF NOT EXISTS cloud_runner_lock (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT, expires_at INTEGER NOT NULL DEFAULT 0, review INTEGER NOT NULL DEFAULT 0)`,
  `INSERT OR IGNORE INTO cloud_runner_lock(id) VALUES(1)`,
  `CREATE TABLE IF NOT EXISTS cloud_login (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, lock_token TEXT NOT NULL,
    budget_id TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active')`,
  `CREATE TABLE IF NOT EXISTS cloud_guest_login (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, lock_token TEXT NOT NULL,
    budget_id TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active')`,
  `CREATE TABLE IF NOT EXISTS cloud_browser_runs (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,lock_token TEXT NOT NULL,
    budget_id TEXT NOT NULL,started_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'active')`
];
const initialized=new WeakMap();
export async function ensureStore(env) {
  if(!env.STATE_DB)throw problem('state-db','클라우드 저장소 연결이 필요합니다.',503);
  if(!initialized.has(env.STATE_DB)){const task=env.STATE_DB.batch(schema.map(sql=>env.STATE_DB.prepare(sql)));initialized.set(env.STATE_DB,task);task.catch(()=>initialized.delete(env.STATE_DB));}
  await initialized.get(env.STATE_DB);
}
export const problem=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const b64=bytes=>{let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);};
const unb64=text=>Uint8Array.from(atob(text),x=>x.charCodeAt(0));
async function keyFor(secret){if(typeof secret!=='string' || secret.length<32)throw problem('encryption-key','로그인 암호화 키를 설정해야 합니다.',503);return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode(secret)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
export async function encryptState(value,secret){const iv=crypto.getRandomValues(new Uint8Array(12)),key=await keyFor(secret),plain=encoder.encode(JSON.stringify(value));if(plain.length>1500000)throw problem('state-size','로그인 상태 크기를 확인해야 합니다.',503);const data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode('SF-SC-CLOUD-v1')},key,plain);return JSON.stringify({v:1,iv:b64(iv),data:b64(new Uint8Array(data))});}
export async function decryptState(cipher,secret){try{const value=JSON.parse(cipher);if(value.v!==1)throw Error();const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(value.iv),additionalData:encoder.encode('SF-SC-CLOUD-v1')},await keyFor(secret),unb64(value.data));return JSON.parse(decoder.decode(plain));}catch{throw problem('session-unreadable','저장된 클라우드 로그인 상태를 확인해야 합니다.',503);}}
async function loadStoredState(env,id){const row=await env.STATE_DB.prepare('SELECT cipher FROM cloud_session WHERE id=?1').bind(id).first();return row?decryptState(row.cipher,env.SESSION_ENCRYPTION_KEY):null;}
export const loadState=env=>loadStoredState(env,'spacecloud');
export const loadPublicState=env=>loadStoredState(env,'spacecloud_public');
const spacecloudHost=host=>{const clean=String(host || '').replace(/^\./,'').toLowerCase();return clean==='spacecloud.kr' || clean.endsWith('.spacecloud.kr');};
export function onlySpacecloudState(state){return {cookies:(state?.cookies || []).filter(cookie=>spacecloudHost(cookie.domain)),origins:(state?.origins || []).filter(origin=>{try{const url=new URL(origin.origin);return url.protocol==='https:' && spacecloudHost(url.hostname);}catch{return false;}})};}
async function saveStoredState(env,id,state){const cipher=await encryptState(onlySpacecloudState(state),env.SESSION_ENCRYPTION_KEY);await env.STATE_DB.prepare(`INSERT INTO cloud_session(id,cipher,updated_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET cipher=excluded.cipher,updated_at=excluded.updated_at`).bind(id,cipher,Date.now()).run();}
export const saveState=(env,state)=>saveStoredState(env,'spacecloud',state);
export const savePublicState=(env,state)=>saveStoredState(env,'spacecloud_public',state);
export const paidIncluded=env=>env.CLOUD_PLAN_MODE==='paid-included' && env.INCLUDED_BUDGET_CONFIRMED==='true';
const configuredNumber=(value,fallback)=>value!==undefined && value!=='' && Number.isFinite(Number(value))?Number(value):fallback;
export const dailyLimit=env=>Math.max(0,Math.min(paidIncluded(env)?2700000:540000,configuredNumber(env.DAILY_BROWSER_BUDGET_MS,paidIncluded(env)?2700000:540000)));
export const monthlyLimit=env=>Math.max(0,Math.min(7200000,configuredNumber(env.MONTHLY_BROWSER_BUDGET_MS,7200000)));
export const rollingLimit=env=>Math.max(0,Math.min(7200000,configuredNumber(env.ROLLING_32D_BROWSER_BUDGET_MS,7200000)));
export async function lockRunner(env,{duration=120000,now=Date.now()}={}){
  const token=crypto.randomUUID();
  const result=await env.STATE_DB.prepare(`UPDATE cloud_runner_lock SET token=?1,expires_at=?2 WHERE id=1 AND review=0 AND token IS NULL`).bind(token,now+duration).run();
  return Number(result.meta?.changes)?token:null;
}
export async function assertLock(env,token,now=Date.now()){const row=await env.STATE_DB.prepare('SELECT token,expires_at,review FROM cloud_runner_lock WHERE id=1').first();if(!row || row.token!==token || row.review || row.expires_at<=now)throw problem('runner-lock','클라우드 작업 잠금이 만료되었습니다. 추가 변경을 중단합니다.');}
export async function unlockRunner(env,token,{review=false}={}){await env.STATE_DB.prepare(`UPDATE cloud_runner_lock SET token=NULL,expires_at=0,review=?2 WHERE id=1 AND token=?1`).bind(token,review?1:0).run();}
export async function reserveBudget(env,milliseconds,{now=Date.now()}={}){
  const amount=Math.ceil(milliseconds),day=new Date(now).toISOString().slice(0,10),month=day.slice(0,7),id=crypto.randomUUID();
  if(!Number.isSafeInteger(amount) || amount<1 || amount>dailyLimit(env))throw problem('daily-budget','오늘의 무료 브라우저 사용 예산이 부족합니다.',429);
  if(new Date(now+amount+5000).toISOString().slice(0,10)!==day)throw problem('budget-window','사용량 집계 날짜가 바뀌는 시간입니다. 잠시 후 다시 진행해 주세요.',429);
  const result=await env.STATE_DB.batch([
    env.STATE_DB.prepare(`UPDATE cloud_budget SET day=?1,month=?2,
      day_ms=CASE WHEN day=?1 THEN day_ms ELSE 0 END+?3,
      month_ms=CASE WHEN month=?2 THEN month_ms ELSE 0 END+?3,last_id=?4
      WHERE id=1 AND (CASE WHEN day=?1 THEN day_ms ELSE 0 END)+?3<=?5
        AND (CASE WHEN month=?2 THEN month_ms ELSE 0 END)+?3<=?6
        AND (SELECT COALESCE(SUM(COALESCE(charged_ms,reserved_ms)),0) FROM cloud_budget_reservations WHERE started_at>=?7)+?3<=?8`)
      .bind(day,month,amount,id,dailyLimit(env),monthlyLimit(env),now-32*86400000,rollingLimit(env)),
    env.STATE_DB.prepare(`INSERT INTO cloud_budget_reservations(id,day,month,reserved_ms,started_at)
      SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM cloud_budget WHERE id=1 AND last_id=?1)`).bind(id,day,month,amount,now)
  ]);
  if(!Number(result[1]?.meta?.changes))throw problem('daily-budget','오늘의 무료 브라우저 사용 예산을 모두 사용했습니다. 새 결제를 열지 않습니다.',429);
  return {id,day,month,reserved_ms:amount,started_at:now};
}
// Only an explicit remote-closed acknowledgement permits unused budget to be credited.
export async function settleBudget(env,reservation,{closed=true,notStarted=false,now=Date.now()}={}){
  const charged=notStarted?0:closed?Math.min(reservation.reserved_ms,Math.max(0,now-reservation.started_at)+5000):reservation.reserved_ms;
  const refund=reservation.reserved_ms-charged;
  await env.STATE_DB.batch([
    env.STATE_DB.prepare(`UPDATE cloud_budget SET day_ms=MAX(0,day_ms-CASE WHEN day=?2 THEN ?4 ELSE 0 END),
      month_ms=MAX(0,month_ms-CASE WHEN month=?3 THEN ?4 ELSE 0 END)
      WHERE id=1 AND EXISTS(SELECT 1 FROM cloud_budget_reservations WHERE id=?1 AND state='reserved')`).bind(reservation.id,reservation.day,reservation.month,refund),
    env.STATE_DB.prepare(`UPDATE cloud_budget_reservations SET state=?2,charged_ms=?3,closed_at=?4 WHERE id=?1 AND state='reserved'`).bind(reservation.id,closed?'closed':'review',charged,closed?now:null)
  ]);
}
export async function budgetStatus(env){const day=new Date().toISOString().slice(0,10),month=day.slice(0,7),row=await env.STATE_DB.prepare('SELECT * FROM cloud_budget WHERE id=1').first(),rolling=await env.STATE_DB.prepare('SELECT COALESCE(SUM(COALESCE(charged_ms,reserved_ms)),0) used_ms FROM cloud_budget_reservations WHERE started_at>=?1').bind(Date.now()-32*86400000).first();return {utc_day:day,utc_month:month,daily_limit_ms:dailyLimit(env),monthly_limit_ms:monthlyLimit(env),rolling_32d_limit_ms:rollingLimit(env),rolling_32d_reserved_ms:Number(rolling?.used_ms || 0),daily_reserved_ms:row?.day===day?Number(row.day_ms):0,monthly_reserved_ms:row?.month===month?Number(row.month_ms):0};}
