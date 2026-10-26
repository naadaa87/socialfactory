import {json,randomToken,sha256Hex} from './auth.js';
import {isIsoDate} from './admin.js';
import {ensureSpacecloudSales} from './spacecloud-sales.js';
export async function ensureSync(env){
 await ensureSpacecloudSales(env);
 try{await env.DB.prepare('ALTER TABLE spacecloud_sales ADD COLUMN sync_seen INTEGER NOT NULL DEFAULT 0').run();}catch(e){if(!/duplicate column/i.test(e.message))throw e;}
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS spacecloud_sync_device (
 id INTEGER PRIMARY KEY CHECK(id=1), code_hash TEXT, code_until INTEGER, token_hash TEXT, token_until INTEGER,
 enabled INTEGER NOT NULL DEFAULT 0, last_attempt INTEGER, last_success INTEGER, status TEXT, message TEXT, counts TEXT
 )`).run();
 await env.DB.prepare(`CREATE TABLE IF NOT EXISTS spacecloud_sync_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,reservation_id TEXT NOT NULL,observed_at INTEGER NOT NULL,
 before_refund INTEGER,after_refund INTEGER,action TEXT NOT NULL,reason TEXT, created_at TEXT DEFAULT (datetime('now','+9 hours'))
 )`).run();
}
export async function syncDevice(request,env){
 if(!env.DB)return null;
 const token=(request.headers.get('authorization')||'').replace(/^Bearer\s+/i,'');if(!/^sfs_[A-Za-z0-9_-]{40,}$/.test(token))return null;
 await ensureSync(env);
 return env.DB.prepare('SELECT * FROM spacecloud_sync_device WHERE id=1 AND enabled=1 AND token_hash=?1 AND token_until>?2').bind(await sha256Hex(token+'|'+env.ADMIN_KEY),Date.now()).first();
}
export async function createCode(env){
 await ensureSync(env);const code=randomToken(18);
 await env.DB.prepare(`INSERT INTO spacecloud_sync_device(id,code_hash,code_until,status) VALUES(1,?1,?2,'pairing')
 ON CONFLICT(id) DO UPDATE SET code_hash=excluded.code_hash,code_until=excluded.code_until`).bind(await sha256Hex(code),Date.now()+600000).run();return code;
}
export async function exchange(env,code){
 if(typeof code!=='string'||!/^[-\w]{24}$/.test(code))return null;await ensureSync(env);
 const hash=await sha256Hex(code),token='sfs_'+randomToken(32),until=Date.now()+180*86400000;
 const result=await env.DB.prepare(`UPDATE spacecloud_sync_device SET code_hash=NULL,code_until=NULL,token_hash=?1,token_until=?2,enabled=1,status='connected',message='연결 완료'
 WHERE id=1 AND code_hash=?3 AND code_until>?4`).bind(await sha256Hex(token+'|'+env.ADMIN_KEY),until,hash,Date.now()).run();
 return Number(result.meta?.changes)?{token,expires_at:until}:null;
}
export async function markSync(env,status,message,counts=null,success=false){
 await env.DB.prepare(`UPDATE spacecloud_sync_device SET last_attempt=?1,status=?2,message=?3,counts=?4,
 last_success=CASE WHEN ?5=1 THEN ?1 ELSE last_success END WHERE id=1`).bind(Date.now(),status,message,JSON.stringify(counts),success?1:0).run();
}
export function validRows(rows){
 if(!Array.isArray(rows)||rows.length>5000)throw Error('수집 건수가 잘못되었습니다.');
 const ids=new Set();return rows.map(x=>{
 if(!x||x.venue!=='소셜팩토리 건대 (초특가)'||typeof x.reservation_id!=='string'||!/^\d{1,16}$/.test(x.reservation_id)||ids.has(x.reservation_id))throw Error('중복 예약번호 또는 다른 공간이 있습니다.');ids.add(x.reservation_id);
 for(const k of ['use_date','end_date','paid_at'])if(!isIsoDate(x[k]))throw Error('예약 날짜를 확인할 수 없습니다.');
 if(x.end_date<x.use_date)throw Error('이용 종료일이 잘못되었습니다.');
 for(const k of ['amount','refund_amount'])if(!Number.isSafeInteger(x[k])||x[k]<0||x[k]>100000000)throw Error('결제/취소금액이 잘못되었습니다.');
 if(!Number.isSafeInteger(x.after_settlement_refund||0)||(x.after_settlement_refund||0)<0)throw Error('정산 후 취소금액 오류');
 if(x.refund_amount>x.amount)throw Error('취소금액이 결제금액보다 큽니다.');
 return {reservation_id:String(x.reservation_id),venue:x.venue,use_date:x.use_date,end_date:x.end_date,paid_at:x.paid_at,amount:x.amount,refund_amount:x.refund_amount,after_settlement_refund:Number(x.after_settlement_refund||0)};
 });
}
