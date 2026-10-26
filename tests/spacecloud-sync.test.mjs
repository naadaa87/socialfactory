import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {createCode,exchange} from '../functions/_lib/spacecloud-sync.js';
import {onRequestPost as sync} from '../functions/api/spacecloud-sync.js';
import {onRequestPost as admin, onRequestGet as status} from '../functions/api/admin/spacecloud-sync.js';
import {onRequestGet as sales} from '../functions/api/admin/sales.js';
function env(){const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));const DB={prepare(sql){let args=[];const s={bind(...a){args=a;return s;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async first(){return sqlite.prepare(sql).get(...args)||null;},async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return s;},async batch(ss){sqlite.exec('BEGIN');try{const r=[];for(const s of ss)r.push(await s.run());sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};return {DB,sqlite,ADMIN_KEY:'local-admin-only'};}
const row={reservation_id:'123',venue:'소셜팩토리 건대 (초특가)',use_date:'2026-11-06',end_date:'2026-11-06',paid_at:'2026-10-25',amount:45000,refund_amount:0};
const req=(body,token)=>new Request('https://example.test/api/spacecloud-sync',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
async function linked(){const e=env();const code=await createCode(e),r=await exchange(e,code);return {e,token:r.token,code};}
test('one-use, expiring code yields a scoped token; anonymous, revoked and admin-key-rotation tokens fail',async()=>{
 const {e,token,code}=await linked();assert.equal(await exchange(e,code),null);
 assert.equal((await sync({env:e,request:req({action:'sync'},'wrong')})).status,401);
 assert.equal((await admin({env:e,request:req({action:'pair'},token)})).status,401);
 const old=await createCode(e);e.sqlite.prepare('UPDATE spacecloud_sync_device SET code_until=0').run();assert.equal(await exchange(e,old),null);
 e.ADMIN_KEY='rotated';assert.equal((await sync({env:e,request:req({action:'error',status:'login_required'},token)})).status,401);
});
test('auto sync is idempotent, updates partial/full refunds, and never restores a refund or deletes absent bookings',async()=>{
 const {e,token}=await linked();const t=Date.now()-1000;
 const call=(rows,at=t)=>sync({env:e,request:req({action:'sync',complete:true,observed_at:at,rows},token)});
 assert.equal((await call([row])).status,200);await call([row]);assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sales').get().n,1);
 await call([{...row,refund_amount:10000}],t+1);assert.equal(e.sqlite.prepare('SELECT refund_amount n FROM spacecloud_sales').get().n,10000);
 await call([row],t+2);assert.equal(e.sqlite.prepare('SELECT refund_amount n FROM spacecloud_sales').get().n,10000);
 assert.equal(e.sqlite.prepare("SELECT COUNT(*) n FROM spacecloud_sync_audit WHERE action='review'").get().n,1);
 await call([{...row,refund_amount:45000}],t+3);await call([row],t);await call([],t+4);
 assert.equal(e.sqlite.prepare('SELECT refund_amount n FROM spacecloud_sales').get().n,45000);assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sales').get().n,1);
 const result=await(await sales({env:e,request:new Request('https://example.test/api/admin/sales?year=2026',{headers:{authorization:'Bearer local-admin-only'}})})).json();assert.equal(result.total,0);
});
test('only complete recent snapshots write; invalid batches cannot partially add sales; login expiry preserves existing data',async()=>{
 const {e,token}=await linked();const good={action:'sync',complete:true,observed_at:Date.now(),rows:[row]};
 for(const body of [{...good,complete:false},{...good,observed_at:Date.now()-700000},{...good,rows:[row,{...row,reservation_id:'124',amount:-1}]},{...good,rows:[row,row]}])assert.equal((await sync({env:e,request:req(body,token)})).status,400);
 assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sales').get().n,0);
 await sync({env:e,request:req(good,token)});await sync({env:e,request:req({action:'error',status:'login_required'},token)});
 assert.equal(e.sqlite.prepare('SELECT status FROM spacecloud_sync_device').get().status,'login_required');assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sales').get().n,1);
 await admin({env:e,request:req({action:'revoke'},'local-admin-only')});assert.equal((await sync({env:e,request:req(good,token)})).status,401);
});
test('after-settlement separate cancellation is queued for review rather than guessed or double deducted',async()=>{
 const {e,token}=await linked();await sync({env:e,request:req({action:'sync',complete:true,observed_at:Date.now(),rows:[{...row,after_settlement_refund:10000}]},token)});
 assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sales').get().n,0);assert.equal(e.sqlite.prepare('SELECT status FROM spacecloud_sync_device').get().status,'review');
 const r=await status({env:e,request:new Request('https://example.test/',{headers:{authorization:'Bearer local-admin-only'}})});const j=await r.json();assert.equal(j.review.length,1);assert(!JSON.stringify(j).includes('token_hash'));
});
