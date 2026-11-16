import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/parking-fixture.mjs';
import {onRequestGet} from '../functions/api/admin/parking.js';
import {writeFileSync} from 'node:fs';
function entries(bytes){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),out={};let p=0;while(view.getUint32(p,true)===0x04034b50){const n=view.getUint16(p+26,true),extra=view.getUint16(p+28,true),size=view.getUint32(p+18,true),name=new TextDecoder().decode(bytes.slice(p+30,p+30+n)),start=p+30+n+extra;out[name]=new TextDecoder().decode(bytes.slice(start,start+size));p=start+size;}return out;}
const req=(f,q,authorized=true)=>onRequestGet({env:f.env,request:f.req('/api/admin/parking?'+q,undefined,authorized?{authorization:'Bearer '+f.env.ADMIN_KEY}:{})});
test('엑셀은 동일 조회 조건·통합 결제 환불·수식·문자 보존·빈 결과·인증을 지원',async t=>{
 const f=await fixture(t),o=await f.purchase(f.body({vehicles:[{plate:'123가4567',plateConfirm:'123가4567',ticket:'1h'},{plate:'234나5678',plateConfirm:'234나5678',ticket:'2h'}]}));await f.cb(o);
 f.db.prepare('UPDATE orders SET paid_at=?,buyer_name=? WHERE oid=?').run('2026-11-04 11:00:00','=HYPERLINK("https://example.com")',o.oid);f.db.prepare('UPDATE payapp_payments SET refunded_amount=? WHERE oid=?').run(3000,o.oid);
 assert.equal((await req(f,'export=xlsx',false)).status,401);assert.equal((await req(f,'export=xlsx&start=bad')).status,400);
 const r=await req(f,'export=xlsx&start=2026-11-04&end=2026-11-04&q=123가4567');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/spreadsheetml/);assert.equal(r.headers.get('cache-control'),'no-store');
 const bytes=new Uint8Array(await r.arrayBuffer()),x=entries(bytes);assert.equal(Object.keys(x).length,8);assert.match(x['xl/workbook.xml'],/조회 요약/);assert.match(x['xl/worksheets/sheet2.xml'],/010-1234-5678/);assert.match(x['xl/worksheets/sheet2.xml'],/=HYPERLINK/);assert.doesNotMatch(x['xl/worksheets/sheet2.xml'],/<f>/);assert.match(x['xl/worksheets/sheet3.xml'],/<f>F2-G2<\/f><v>9000<\/v>/);assert.equal((x['xl/worksheets/sheet3.xml'].match(/<row /g)||[]).length,2);assert.match(x['xl/worksheets/sheet1.xml'],/<f>B12-B13<\/f><v>9000<\/v>/);
 if(process.env.PARKING_EXPORT_SAMPLE)writeFileSync(process.env.PARKING_EXPORT_SAMPLE,bytes);
 const empty=entries(new Uint8Array(await(await req(f,'export=xlsx&start=2026-11-05')).arrayBuffer()));assert.match(empty['xl/worksheets/sheet1.xml'],/<f>B12-B13<\/f><v>0<\/v>/);assert.equal((empty['xl/worksheets/sheet2.xml'].match(/<row /g)||[]).length,1);
});
test('엑셀은 화면의 200대 제한 없이 전체 조회 차량을 출력',async t=>{
 const f=await fixture(t),o=await f.purchase();await f.cb(o);
 // Same validated payment structure, copied into distinct synthetic orders.
 for(let i=0;i<201;i++){
  const oid='SF'+String(i).padStart(16,'0'),mul=String(9000+i);
  for(const [table,changes]of [['orders',{oid,tid:mul}],['payapp_payments',{oid,mul_no:mul,nonce:'export-'+i,request_id:crypto.randomUUID()}],['parking_orders',{oid,payment_oid:oid}]]){
   const row={...f.db.prepare('SELECT * FROM '+table+' WHERE oid=?').get(o.oid),...changes};delete row.id;
   const keys=Object.keys(row);f.db.prepare('INSERT INTO '+table+' ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]));
  }
 }
 const normal=await(await req(f,'')).json();assert.equal(normal.results.length,200);assert.equal(normal.summary.paidVehicles,202);
 const x=entries(new Uint8Array(await(await req(f,'export=xlsx')).arrayBuffer()));assert.equal((x['xl/worksheets/sheet2.xml'].match(/<row /g)||[]).length,203);assert.equal((x['xl/worksheets/sheet3.xml'].match(/<row /g)||[]).length,203);
});
