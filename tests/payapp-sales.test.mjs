import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {onRequestGet as get,onRequestPost as post} from '../functions/api/admin/payapp-sales.js';
import {onRequestPost as feedback} from '../functions/api/pay/payapp/sales-feedback.js';
import {onRequestGet as sales} from '../functions/api/admin/sales.js';
import {onRequestGet as dashboard} from '../functions/api/admin/dashboard.js';
import {ensurePayappSales,payappTime} from '../functions/_lib/payapp-sales.js';
import {kstStamp} from '../functions/_lib/payapp.js';
const day=new Date(Date.now()+9*36e5).toISOString().slice(0,10),year=day.slice(0,4),at=day+' 12:00:00';
const sale=(x={})=>({sellerId:'seller',mulNo:'119000001',productName:'공간대여',state:'paid',amount:15000,refundAmount:0,paidAt:at,requestedAt:at,approvalNo:'01234567',method:'payapp:1',...x});
function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 const DB={prepare(sql){let a=[];const q={bind(...args){a=args;return q;},async first(){return db.prepare(sql).get(...a)||null;},async all(){return {results:db.prepare(sql).all(...a)};},async run(){return {meta:{changes:Number(db.prepare(sql).run(...a).changes)}};}};return q;},async batch(qs){db.exec('BEGIN');try{const out=[];for(const q of qs)out.push(await q.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const env={DB,ADMIN_KEY:'admin',PAYAPP_USERID:'seller',PAYAPP_LINKKEY:'key',PAYAPP_LINKVAL:'value',PAYAPP_REQUESTKEY:'request',PAYAPP_ENABLED:'1'};
 const req=(path,body,auth=true)=>new Request('https://example.test'+path,{method:body?'POST':'GET',headers:auth?{authorization:'Bearer admin'}:{},...(body?{body:JSON.stringify(body)}:{})});
 const save=rows=>post({env,request:req('/api/admin/payapp-sales',{action:'import',rows})});
 const review=(id,decision='include')=>post({env,request:req('/api/admin/payapp-sales',{action:'review',mulNo:id,decision,note:'소셜팩토리 확인'})});
 const list=async(q='')=>(await(await get({env,request:req('/api/admin/payapp-sales'+q)})).json());
 const summary=async(provider='all')=>(await(await sales({env,request:req('/api/admin/sales?year='+year+'&provider='+provider)})).json());
 const send=async(extra={},auth=true)=>{const responsedate=kstStamp(),f={userid:'seller',linkkey:'key',linkval:'value',responsedate,hash:createHash('sha256').update('seller'+responsedate+'request').digest('hex'),goodname:'공간대여',price:'15000',mul_no:'119000001',pay_state:'4',pay_date:at,reqdate:at,pay_type:'1',payauthcode:'01234567',recvphone:'private-phone',card_num:'private-card',...extra};if(!auth)f.hash='wrong';return feedback({env,request:new Request('https://example.test/api/pay/payapp/sales-feedback',{method:'POST',body:new URLSearchParams(f)})});};
 return {db,env,req,save,review,list,summary,send};
}
test('imports require authentication and a configured seller; invalid batches never partly write',async t=>{
 const f=fixture(t);assert.equal((await post({env:f.env,request:f.req('/api/admin/payapp-sales',{action:'import',rows:[sale()]},false)})).status,401);
 for(const rows of [[],[sale(),sale()],[sale(),sale({mulNo:'2',sellerId:'foreign'})],[sale({amount:-1})],[sale({refundAmount:16000})],[sale({paidAt:'2026-02-30 12:00:00'})]])assert.equal((await f.save(rows)).status,400);
 assert.equal((await f.list()).total,0);assert.equal(payappTime('20261103123456'),'2026-11-03 12:34:56');
});
test('direct sales wait for review; exclusion survives reimport and approval replay; explicit inclusion updates totals once',async t=>{
 const f=fixture(t);await f.save([sale()]);assert.equal((await f.summary()).total,0);assert.equal((await f.list()).rows[0].disposition,'review');
 await f.review(sale().mulNo,'exclude');await f.save([sale()]);await f.send();assert.equal((await f.list()).rows[0].disposition,'exclude');assert.equal((await f.summary()).total,0);
 await f.review(sale().mulNo);assert.equal((await f.summary()).total,15000);assert.equal((await f.summary('payapp')).total,15000);
 const d=await(await dashboard({env:f.env,request:f.req('/api/admin/dashboard')})).json();assert.equal(d.month.payapp,15000);assert.equal(d.month.total,15000);
 for(const table of ['orders','passes','reservations','notification_jobs'])assert.equal(f.db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0);
});
test('website orders appear before common connection and common notifications never duplicate their sales',async t=>{
 const f=fixture(t);await ensurePayappSales(f.env);
 f.db.prepare("INSERT INTO orders(oid,status,product_id,product_name,amount,buyer_name,buyer_phone,paid_at,test_mode,pg_method) VALUES('SF1','paid','cowork-2h','홈페이지 이용권',15000,'test','',?,0,'payapp:1')").run(at);
 f.db.exec("INSERT INTO payapp_payments(oid,mul_no,nonce,request_id,request_hash) VALUES('SF1','119000001','n','r','h')");
 assert.equal((await f.list()).total,1);assert.equal((await f.list()).rows[0].disposition,'website');assert.equal((await f.summary('payapp')).total,15000);
 await f.send();assert.equal((await f.list()).total,1);assert.equal((await f.summary()).total,15000);assert.equal((await f.summary('payapp')).total,15000);
 assert.equal((await f.review('119000001')).status,400);assert.equal((await f.list('?filter=website')).total,1);
});
test('PayApp filter excludes manually classified online cards and non-PayApp website orders',async t=>{
 const f=fixture(t);await f.save([sale()]);await f.review(sale().mulNo);
 f.db.prepare("INSERT INTO reservations(code,status,space,date,start_min,end_min,customer_name,amount,pay_method,pay_status,paid_at) VALUES('R1','confirmed','r3',?,600,660,'test',9000,'card_online','paid',?)").run(day,day);
 f.db.prepare("INSERT INTO orders(oid,status,product_id,product_name,amount,buyer_name,buyer_phone,paid_at,test_mode) VALUES('OLD','paid','x','다른 결제사',8000,'test','',?,0)").run(at);
 assert.equal((await f.summary()).total,32000);assert.equal((await f.summary('payapp')).total,15000);
 assert.equal((await f.summary('payapp')).months.reduce((n,m)=>n+m.total,0),15000);
});
test('confirmed reservation duplicates remain visible in the PayApp breakdown without inflating overall or dashboard sales',async t=>{
 const f=fixture(t);await f.save([sale()]);await f.review(sale().mulNo,'duplicate');
 f.db.prepare("INSERT INTO reservations(code,status,space,date,start_min,end_min,customer_name,amount,pay_method,pay_status,paid_at) VALUES('R1','confirmed','r3',?,600,660,'test',15000,'card_online','paid',?)").run(day,day);
 assert.equal((await f.summary()).total,15000);assert.equal((await f.summary('payapp')).total,15000);
 assert.equal((await f.list('?filter=duplicate')).total,1);
 const d=await(await dashboard({env:f.env,request:f.req('/api/admin/dashboard')})).json();assert.equal(d.month.total,15000);assert.equal(d.month.payapp,0);
});
test('common notification authenticates, strips private fields, and monotonic partial/full refunds tolerate retries and late approvals',async t=>{
 const f=fixture(t);assert.equal((await f.send({},false)).status,403);assert.equal((await f.send({userid:'other'})).status,403);assert.equal((await f.send()).status,200);
 await f.review('119000001');
 const partial={pay_state:'70',mul_no:'119000002',orig_mul_no:'119000001',price:'3000',orig_price:'15000'};
 assert.equal((await f.send(partial)).status,200);assert.equal((await f.send(partial)).status,200);assert.equal((await f.summary()).total,12000);
 assert.equal((await f.send({...partial,price:'4000'})).status,400);
 assert.equal((await f.send({...partial,mul_no:'119000003',price:'2000'})).status,200);assert.equal((await f.summary('payapp')).total,10000);
 await f.send({pay_state:'64'});await f.send();assert.equal((await f.summary()).total,0);assert.equal((await f.list()).rows[0].refund_amount,15000);
 const stored=JSON.stringify(f.db.prepare('SELECT * FROM payapp_sales').get());assert(!stored.includes('private-phone'));assert(!stored.includes('private-card'));
});
test('immutable transactions, seller isolation and pagination apply to the entire PayApp ledger',async t=>{
 const f=fixture(t),rows=Array.from({length:55},(_,i)=>sale({mulNo:String(119000000+i)}));await f.save(rows);
 const first=await f.list(),second=await f.list('?page=2');assert.equal(first.total,55);assert.equal(first.rows.length,50);assert.equal(second.rows.length,5);
 assert.equal((await f.save([sale({mulNo:rows[0].mulNo,amount:100})])).status,400);
 await f.review(rows[0].mulNo,'exclude');assert.equal((await f.list('?filter=exclude')).total,1);assert.equal((await f.list('?filter=review')).total,54);
 f.env.PAYAPP_USERID='other';assert.equal((await f.list()).total,0);assert.equal((await f.review(rows[0].mulNo)).status,400);
});
function activateGu(env){Object.assign(env,{PAYAPP_GU_USERID:'guspacedev',PAYAPP_GU_LINKKEY:'gu-key',PAYAPP_GU_LINKVAL:'gu-value',PAYAPP_GU_REQUESTKEY:'gu-request',PAYAPP_ACTIVE_ACCOUNT:'gu'});}
function signedGu(extra={}){const responsedate=kstStamp();return {userid:'guspacedev',linkkey:'gu-key',linkval:'gu-value',responsedate,hash:createHash('sha256').update('guspacedev'+responsedate+'gu-request').digest('hex'),goodname:'신규 법인 공간대여',price:'15000',mul_no:'119000001',pay_state:'4',pay_date:at,reqdate:at,pay_type:'1',payauthcode:'76543210',...extra};}
const deliver=(f,fields)=>feedback({env:f.env,request:new Request('https://example.test/api/pay/payapp/sales-feedback',{method:'POST',body:new URLSearchParams(fields)})});
const reviewSeller=(f,sellerId,mulNo,decision='include')=>post({env:f.env,request:f.req('/api/admin/payapp-sales',{action:'review',sellerId,mulNo,decision,note:'법인별 매출 확인'})});
test('merchant switch retains old sales and authenticated refunds while separating new sales with the same transaction number',async t=>{
 const f=fixture(t);assert.equal((await f.save([sale()])).status,200);assert.equal((await f.review('119000001')).status,200);
 activateGu(f.env);assert.equal((await f.list()).total,1);assert.equal((await f.summary()).total,15000);
 const oldPartial={pay_state:'70',mul_no:'119000002',orig_mul_no:'119000001',price:'3000',orig_price:'15000'};
 assert.equal((await f.send(oldPartial)).status,200);assert.equal((await f.summary()).total,12000);
 assert.equal((await deliver(f,signedGu())).status,200);
 const list=await f.list();assert.equal(list.total,2);assert.deepEqual(new Set(list.rows.map(r=>r.seller_id)),new Set(['seller','guspacedev']));
 assert.equal((await f.review('119000001')).status,400);assert.equal((await reviewSeller(f,'guspacedev','119000001')).status,200);
 assert.equal((await f.summary('payapp')).total,27000);
 assert.equal((await f.send({pay_state:'64'})).status,200);assert.equal((await f.summary()).total,15000);
 assert.equal((await deliver(f,signedGu({...oldPartial,price:'2000'}))).status,200);assert.equal((await f.summary()).total,13000);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM payapp_sales_refunds').get().n,2);
 assert.equal((await deliver(f,signedGu({userid:'seller'}))).status,403);
 await f.send();assert.equal((await f.summary()).total,13000);
 assert.equal((await f.list('?sellerId=guspacedev')).total,1);assert.equal((await f.list('?sellerId=seller')).total,1);
 assert.equal((await get({env:f.env,request:f.req('/api/admin/payapp-sales?sellerId=foreign')})).status,400);
 const d=await(await dashboard({env:f.env,request:f.req('/api/admin/dashboard')})).json();assert.equal(d.month.payapp,13000);
});
test('website deduplication includes the merchant identity and mixed-account imports remain atomic',async t=>{
 const f=fixture(t);activateGu(f.env);await ensurePayappSales(f.env);
 f.db.prepare("INSERT INTO orders(oid,status,product_id,product_name,amount,buyer_name,buyer_phone,paid_at,test_mode,pg_method) VALUES('SF1','paid','cowork-2h','구 법인 홈페이지',15000,'test','',?,0,'payapp:1')").run(at);
 f.db.exec("INSERT INTO payapp_payments(oid,mul_no,nonce,request_id,request_hash,merchant_account,merchant_userid) VALUES('SF1','119000001','n','r','h','blank','seller')");
 assert.equal((await f.save([sale(),sale({sellerId:'guspacedev',approvalNo:'76543210'})])).status,200);
 let rows=(await f.list()).rows;assert.equal(rows.length,2);assert.equal(rows.find(r=>r.seller_id==='seller').disposition,'website');assert.equal(rows.find(r=>r.seller_id==='guspacedev').disposition,'review');
 assert.equal((await reviewSeller(f,'guspacedev','119000001')).status,200);assert.equal((await f.summary('payapp')).total,30000);
 assert.equal((await reviewSeller(f,'seller','119000001')).status,400);
 f.db.prepare("INSERT INTO booking_payapp_requests(code,kind,label,amount,token,mul_no,merchant_account,merchant_userid) VALUES('OF-OLD','office','구 법인 청구',10000,'token','119000003','blank','seller')").run();
 assert.equal((await f.save([sale({sellerId:'guspacedev',mulNo:'119000003',amount:10000})])).status,200);assert.equal((await reviewSeller(f,'guspacedev','119000003')).status,200);
 assert.equal((await f.summary('payapp')).total,40000);
 assert.equal((await f.save([sale({sellerId:'guspacedev',mulNo:'119000004'}),sale({sellerId:'foreign',mulNo:'119000005'})])).status,400);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM payapp_sales WHERE mul_no IN ('119000004','119000005')").get().n,0);
});
test('old sales and refunds remain available when new payment configuration is incomplete or disabled',async t=>{
 const f=fixture(t);await f.save([sale()]);await f.review('119000001');
 f.env.PAYAPP_ACTIVE_ACCOUNT='gu';f.env.PAYAPP_ENABLED='0';
 assert.equal((await f.list()).total,1);assert.equal((await f.summary()).total,15000);
 assert.equal((await f.save([sale({sellerId:'guspacedev'})])).status,400);
 assert.equal((await f.send({pay_state:'64'})).status,200);assert.equal((await f.summary()).total,0);
});
