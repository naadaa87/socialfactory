import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/parking-fixture.mjs';
import {onRequestGet} from '../functions/api/admin/parking.js';
async function get(f,query=''){return onRequestGet({env:f.env,request:f.req('/api/admin/parking?'+query,undefined,{authorization:'Bearer '+f.env.ADMIN_KEY})});}
test('기간별 결제 합계는 통합결제를 차량별 금액으로 합산하고 경계일·검색·미결제를 구분',async t=>{
 const f=await fixture(t),o=await f.purchase(f.body({vehicles:[{plate:'123가4567',plateConfirm:'123가4567',ticket:'1h'},{plate:'234나5678',plateConfirm:'234나5678',ticket:'2h'}]}));await f.cb(o);
 f.db.prepare('UPDATE orders SET paid_at=? WHERE oid=?').run('2026-11-04 23:59:59',o.oid);
 const read=async q=>(await(await get(f,q)).json());
 let r=await read('start=2026-11-04&end=2026-11-04');assert.equal(r.summary.paidVehicles,2);assert.equal(r.summary.paymentCount,1);assert.equal(r.summary.paidAmount,o.amount);
 assert.equal((await read('start=2026-11-05')).summary.paidAmount,0);
 assert.equal((await read('end=2026-11-03')).summary.paidVehicles,0);
 r=await read('q=123가4567&start=2026-11-04&end=2026-11-04');assert.equal(r.summary.paidVehicles,1);assert.equal(r.summary.paidAmount,4000);
 assert.equal((await read('basis=visit&end=2026-11-03')).summary.matchedVehicles,0);
 assert.equal((await read('basis=visit&start=2026-11-04&end=2026-11-04')).summary.matchedVehicles,2);
 await f.purchase(f.body({plate:'345다6789',plateConfirm:'345다6789'}));r=await read();assert.equal(r.summary.matchedVehicles,3);assert.equal(r.summary.paidVehicles,2);
 f.db.prepare("UPDATE orders SET status='refunded' WHERE oid=?").run(o.oid);assert.equal((await read()).summary.paidAmount,o.amount);
 f.db.prepare('UPDATE orders SET test_mode=1 WHERE oid=?').run(o.oid);assert.equal((await read()).summary.paidAmount,0);
});
test('관리자 인증 및 잘못된 조회 날짜 검증',async t=>{const f=await fixture(t);assert.equal((await onRequestGet({env:f.env,request:f.req('/api/admin/parking')})).status,401);for(const q of ['start=2026-02-30','start=2026-11-05&end=2026-11-04','basis=sql','end=bad'])assert.equal((await get(f,q)).status,400,q);assert.equal((await(await get(f)).json()).summary.paidAmount,0);});
