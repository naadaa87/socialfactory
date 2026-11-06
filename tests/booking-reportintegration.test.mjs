import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {ensurePayappSales,payappSource} from '../functions/_lib/payapp-sales.js';
import {ensureTossSales} from '../functions/_lib/toss-sales.js';
import {onRequestGet as sales} from '../functions/api/admin/sales.js';
import {onRequestGet as dashboard} from '../functions/api/admin/dashboard.js';

const day=new Date(Date.now()+9*3600000).toISOString().slice(0,10),ym=day.slice(0,7),year=day.slice(0,4),at=day+' 12:00:00';
function fixture(t){
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
  let tail=Promise.resolve();
  const DB={prepare(sql){let args=[];const q={bind(...values){args=values;return q;},async all(){return {results:db.prepare(sql).all(...args)};},async first(){return db.prepare(sql).get(...args)||null;},async run(){return {meta:db.prepare(sql).run(...args)};}};return q;},batch(statements){const result=tail.then(async()=>{db.exec('BEGIN');try{const out=[];for(const q of statements)out.push(await q.run());db.exec('COMMIT');return out;}catch(error){db.exec('ROLLBACK');throw error;}});tail=result.catch(()=>{});return result;}};
  const env={DB,ADMIN_KEY:'report-admin',PAYAPP_USERID:'seller',PAYAPP_LINKKEY:'legacy-key',PAYAPP_LINKVAL:'legacy-value',PAYAPP_REQUESTKEY:'legacy-request',PAYAPP_ENABLED:'1',TOSS_PLACE_MERCHANT_ID:'42'};
  const request=path=>new Request('https://example.test'+path,{headers:{authorization:'Bearer report-admin'}});
  const summary=async(extra='')=>{const response=await sales({env,request:request('/api/admin/sales?year='+year+extra)});assert.equal(response.status,200);return response.json();};
  const dash=async()=>{const response=await dashboard({env,request:request('/api/admin/dashboard')});assert.equal(response.status,200);return response.json();};
  return {db,env,summary,dash};
}
function invoice(f,code,{kind='office',mul='200001',amount=100000,refund=0,status='paid',paid=at}={}){
  f.db.prepare(`INSERT INTO booking_payapp_requests(code,kind,label,amount,token,mul_no,status,paid_at,refund_amount) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(code,kind,'새 홈페이지 '+kind,amount,'test-token-'+code,mul,status,paid,refund);
}
function room(f,code,{amount=80000,refund=20000,paid=day}={}){
  f.db.prepare(`INSERT INTO reservations(code,status,space,date,start_min,end_min,customer_name,channel,amount,pay_method,pay_status,paid_at,refund_amount)
    VALUES(?,'confirmed','r3',?,600,720,'보고서 테스트','web',?,'card_online',?,?,?)`).run(code,day,amount,refund?'refunded':'paid',paid,refund);
}
function common(f,mul,{amount=100000,refund=0,seller='seller'}={}){
  f.db.prepare(`INSERT INTO payapp_sales(seller_id,mul_no,product_name,state,amount,refund_amount,paid_at,origin,review_state)
    VALUES(?,?,?,'paid',?,?,?,'webhook','include')`).run(seller,mul,'공통 통보 '+mul,amount,refund,at);
}
async function seedMixed(f){
  await ensurePayappSales(f.env);await ensureTossSales(f.env);
  invoice(f,'OFFICE-MIXED',{mul:'200101',amount:100000});
  invoice(f,'ROOM-MIXED',{kind:'room',mul:'200102',amount:80000,refund:20000,status:'partial_refund'});room(f,'ROOM-MIXED');
  common(f,'200101',{amount:100000});common(f,'200102',{amount:80000,refund:20000});
  common(f,'100001',{amount:15000,refund:2000});common(f,'999999',{amount:300000,seller:'other-seller'});
  f.db.prepare(`INSERT INTO orders(oid,status,product_id,product_name,amount,buyer_name,buyer_phone,paid_at,test_mode,pg_method)
    VALUES('LEGACY-WEB','paid','cowork-2h','기존 홈페이지 주문',6000,'기존 고객','',?,0,'payapp:1')`).run(at);
  f.db.exec(`INSERT INTO payapp_payments(oid,mul_no,nonce,request_id,request_hash,refunded_amount) VALUES('LEGACY-WEB','100002','n','r','h',1000)`);
  common(f,'100002',{amount:6000,refund:1000});
  room(f,'MANUAL-CARD',{amount:9000,refund:0});
  f.db.prepare(`INSERT INTO toss_payments(merchant_id,payment_id,order_id,state,source_type,payment_method,amount,refund_amount,approval_no,transaction_id,paid_at,provider_updated,origin)
    VALUES('42','300001','300001','APPROVED','CARD','CARD',7000,500,'TOSS-APPROVAL','TOSS-TX',?,1,'webhook')`).run(at);
}

test('initializing booking sales preserves the existing production PayApp payment and refund schemas',async t=>{
  const f=fixture(t),before=f.db.prepare('PRAGMA table_info(payapp_refunds)').all().map(x=>x.name);
  f.db.exec('DROP TABLE booking_payapp_refunds;DROP TABLE booking_payapp_requests;');
  f.db.prepare(`INSERT INTO orders(oid,status,product_id,product_name,amount,buyer_name,buyer_phone,test_mode) VALUES('OLD-PAYMENT','paid','x','과거 결제',10000,'test','',0)`).run();
  f.db.exec(`INSERT INTO payapp_payments(oid,mul_no,nonce,request_id,request_hash) VALUES('OLD-PAYMENT','700001','n','old-r','h');INSERT INTO payapp_refunds(mul_no,oid,amount) VALUES('700002','OLD-PAYMENT',1000);`);
  await ensurePayappSales(f.env);
  assert.deepEqual(f.db.prepare('PRAGMA table_info(payapp_refunds)').all().map(x=>x.name),before);
  assert.equal(f.db.prepare("SELECT amount FROM payapp_refunds WHERE mul_no='700002'").get().amount,1000);
  assert(f.db.prepare("SELECT name FROM sqlite_master WHERE name='booking_payapp_requests'").get());
});

test('room and office common PayApp notifications cannot duplicate booked revenue or office invoices',async t=>{
  const f=fixture(t);await ensurePayappSales(f.env);
  const compact=ym.replace('-','')+'01120000',utc=new Date(Date.parse(ym+'-01T00:30:00+09:00')).toISOString();
  invoice(f,'OFFICE-PAID',{mul:'210001',amount:100000,paid:compact});
  invoice(f,'OFFICE-PARTIAL',{mul:'210002',amount:200000,refund:50000,status:'partial_refund',paid:utc});
  invoice(f,'OFFICE-FULL',{mul:'210003',amount:100000,refund:100000,status:'refunded'});
  invoice(f,'ROOM-PAID',{kind:'room',mul:'210004',amount:80000,refund:20000,status:'partial_refund'});room(f,'ROOM-PAID');
  for(const [mul,amount,refund] of [['210001',100000,0],['210002',200000,50000],['210003',100000,100000],['210004',80000,20000]])common(f,mul,{amount,refund});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM '+payappSource(f.env,true)).get().n,0);
  const result=await f.summary(),month=result.months.find(m=>m.ym===ym),dash=(await f.dash()).month;
  assert.equal(result.total,310000);assert.equal(result.allTime.total,310000);assert.equal(result.n,4);assert.equal(result.refunds,170000);
  assert.equal(month.byMethod.office_payapp,250000);assert.equal(month.count.office_payapp,3);assert.equal(month.byMethod.card_online,60000);assert.equal(month.byMethod.payapp_direct,0);
  assert.equal(result.bySpace.office.amount,250000);assert.equal(result.byChannel.web.amount,310000);assert.equal(result.thisMonth.total,310000);
  assert.equal(dash.office,250000);assert.equal(dash.officeN,3);assert.equal(dash.officeGross,400000);assert.equal(dash.officeRefunds,150000);assert.equal(dash.payapp,0);assert.equal(dash.total,310000);
  const filtered=await f.summary('&provider=payapp');assert.equal(filtered.total,310000);assert.equal(filtered.refunds,170000);assert.equal(filtered.byMethod.booking_room,60000);assert.equal(filtered.byMethod.office_payapp,250000);
});

test('production Toss, legacy website orders and approved direct PayApp sales remain intact beside new bookings',async t=>{
  const f=fixture(t);await seedMixed(f);
  const result=await f.summary(),dash=(await f.dash()).month;
  assert.equal(result.total,193500);assert.equal(result.allTime.total,193500);assert.equal(result.thisMonth.total,193500);
  assert.equal(result.byMethod.orders,5000);assert.equal(result.byMethod.payapp_direct,13000);assert.equal(result.byMethod.toss_terminal,6500);assert.equal(result.byMethod.office_payapp,100000);assert.equal(result.byMethod.card_online,69000);
  assert.equal(dash.total,193500);assert.equal(dash.terminal,6500);assert.equal(dash.payapp,13000);assert.equal(dash.office,100000);
  const filtered=await f.summary('&provider=payapp');assert.equal(filtered.total,178000);assert.equal(filtered.byMethod.orders,5000);assert.equal(filtered.byMethod.payapp_direct,13000);assert.equal(filtered.byMethod.booking_room,60000);assert.equal(filtered.byMethod.office_payapp,100000);
  assert(!('toss_terminal' in filtered.byMethod));assert.equal(filtered.n,4);
});

test('orders=0 excludes office invoice amounts, refunds and years while preserving rooms and existing direct/terminal sales',async t=>{
  const f=fixture(t);await seedMixed(f);
  invoice(f,'OFFICE-HISTORY',{mul:'220001',amount:50000,refund:10000,status:'partial_refund',paid:'2001-01-01 12:00:00'});
  const result=await f.summary('&orders=0');
  assert.equal(result.total,88500);assert.equal(result.allTime.total,88500);assert.equal(result.thisMonth.total,88500);assert.equal(result.n,4);
  assert(!result.methods.some(m=>m.key==='office_payapp'));assert(!('office_payapp' in result.byMethod));assert(!result.years.includes('2001'));
  assert.equal(result.bySpace.office.amount,0);assert.equal(result.byMethod.card_online,69000);assert.equal(result.byMethod.payapp_direct,13000);assert.equal(result.byMethod.toss_terminal,6500);
  assert.equal(result.refunds,22500);
});

test('an unconfirmed room payment is excluded from direct sales and is not yet booked income',async t=>{
  const f=fixture(t);await ensurePayappSales(f.env);
  invoice(f,'ROOM-VERIFYING',{kind:'room',mul:'230001',amount:50000});common(f,'230001',{amount:50000});
  invoice(f,'OFFICE-PENDING',{mul:'230002',amount:100000,status:'pending',paid:null});common(f,'230002',{amount:100000});
  assert.equal((await f.summary()).total,0);assert.equal((await f.summary('&provider=payapp')).total,0);assert.equal((await f.dash()).month.total,0);
  room(f,'ROOM-VERIFYING',{amount:50000,refund:0});assert.equal((await f.summary()).total,50000);assert.equal((await f.summary('&provider=payapp')).total,50000);
});
