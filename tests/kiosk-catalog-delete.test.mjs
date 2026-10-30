import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {onRequestDelete as deleteProduct,onRequestGet as listProducts,onRequestPost as createProduct,onRequestPatch as editProduct} from '../functions/api/admin/kiosk-products.js';
import {onRequestDelete as deleteCategory,onRequestGet as listCategories,onRequestPost as createCategory,onRequestPatch as editCategory} from '../functions/api/admin/kiosk-categories.js';
import {getKioskProducts,getKioskProduct,seedKioskProducts,termsForPayment} from '../functions/_lib/kiosk-catalog.js';
import {deviceTokenHash} from '../functions/_lib/kiosk.js';
import {onRequestPost as intent} from '../functions/api/kiosk/intents.js';
import {onRequestPost as result} from '../functions/api/kiosk/result.js';

function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 const DB={prepare(sql){let args=[];const s={bind(...a){args=a;return s},async first(){return db.prepare(sql).get(...args)||null},async all(){return {results:db.prepare(sql).all(...args)}},async run(){return {meta:db.prepare(sql).run(...args)}}};return s},async batch(ss){db.exec('BEGIN');try{const r=[];for(const s of ss)r.push(await s.run());db.exec('COMMIT');return r}catch(e){db.exec('ROLLBACK');throw e}}};
 return {db,env:{DB,ADMIN_KEY:'test-admin',KIOSK_TEST:'1'}};
}
const req=(method,body,authorized=true)=>new Request('https://example.test/api/admin/kiosk-products',{method,headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer test-admin'}:{})},body:body===undefined?undefined:JSON.stringify(body)});
const base={name:'테스트 상품',basePrice:10000,discountPercent:10,durationUnit:'days',durationValue:3,group:'seat',category:'regular',image:'pass-1d.webp',sortOrder:100,active:true};
const cat={name:'임시 분류',description:'',image:'pass-1d.webp',sortOrder:100,active:true};
async function newCategory(env){return (await (await createCategory({request:req('POST',cat),env})).json()).id}

test('기존 DB에도 삭제 표를 자동 준비',async t=>{
 const f=fixture(t);f.db.exec('DROP TABLE kiosk_catalog_deleted');
 assert.equal((await listProducts({request:req('GET'),env:f.env})).status,200);
 assert(f.db.prepare("SELECT name FROM sqlite_master WHERE name='kiosk_catalog_deleted'").get());
});
test('상품·카테고리 삭제는 관리자 인증 필요, 잘못된 요청과 없는 대상 거절',async t=>{
 const {env}=fixture(t);
 for(const del of [deleteProduct,deleteCategory]){
  assert.equal((await del({request:req('DELETE',{id:'seat-2h'},false),env})).status,401);
  assert.equal((await del({request:req('DELETE',{}),env})).status,400);
  assert.equal((await del({request:req('DELETE',{id:'missing-item'}),env})).status,404);
  assert.equal((await del({request:new Request('https://example.test/api/admin/kiosk-products',{method:'DELETE',headers:{authorization:'Bearer test-admin'},body:'{' }),env})).status,400);
 }
});
test('상품 삭제는 관리자·프론트·신규 조회에서 제외하고 기본 상품 재생성 방지',async t=>{
 const {env,db}=fixture(t);await getKioskProducts(env);
 assert.equal((await deleteProduct({request:req('DELETE',{id:'seat-2h'}),env})).status,200);
 assert.equal((await deleteProduct({request:req('DELETE',{id:'seat-2h'}),env})).status,200);
 const listed=await (await listProducts({request:req('GET'),env})).json();assert(!listed.products.some(p=>p.id==='seat-2h'));
 assert(!(await getKioskProducts(env)).some(p=>p.id==='seat-2h'));
 assert.equal(await getKioskProduct(env,'seat-2h',{includeInactive:true}),null);
 await seedKioskProducts({DB:{...env.DB}}); // 새 isolate와 같은 준비 캐시로 다시 시드
 assert(!(await getKioskProducts(env)).some(p=>p.id==='seat-2h'));
 assert(db.prepare("SELECT id FROM kiosk_products WHERE id='seat-2h'").get());
 assert.equal((await editProduct({request:req('PATCH',{...base,id:'seat-2h'}),env})).status,404);
});
test('삭제 전 결제 준비 건은 승인 후 당시 조건으로 이용권 발급, 이후 신규 결제는 차단',async t=>{
 const {env,db}=fixture(t);const token='sfk_test-delete-device-long-enough';
 db.prepare("INSERT INTO kiosk_devices(id,name,status,token_hash) VALUES(1,'Fixture','active',?)").run(await deviceTokenHash(token));
 const devReq=(path,body)=>new Request('https://example.test/api/kiosk/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
 const order={productId:'seat-2h',phone:'01000000000',agreePrivacy:true};
 const it=await (await intent({request:devReq('intents',order),env})).json();
 await deleteProduct({request:req('DELETE',{id:order.productId}),env});
 assert.equal((await intent({request:devReq('intents',order),env})).status,400);
 const background=[];
 const paid=await result({request:devReq('result',{paymentKey:it.paymentKey,type:'SUCCESS',response:{paymentMethod:'CARD',card:{approvalNumber:'FIXTURE',timestamp:1}}}),env,waitUntil:p=>background.push(p)});
 await Promise.all(background);assert.equal(paid.status,200);
 const p=db.prepare('SELECT * FROM pass_payments WHERE payment_key=?').get(it.paymentKey);
 assert.equal(p.status,'paid');assert.equal((await termsForPayment(env,p)).duration.hours,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM passes WHERE payment_id=?').get(p.id).n,1);
 await deleteProduct({request:req('DELETE',{id:order.productId}),env});
 assert.equal(db.prepare('SELECT status FROM pass_payments WHERE id=?').get(p.id).status,'paid');
 assert.equal(db.prepare('SELECT status FROM passes WHERE payment_id=?').get(p.id).status,'active');
});
test('삭제 전에 스냅샷이 없던 기존 결제 조건도 보존',async t=>{
 const {env,db}=fixture(t);
 db.prepare("INSERT INTO customers(id,phone) VALUES(1,'01000000000')").run();
 db.prepare("INSERT INTO pass_payments(payment_key,customer_id,product_id,product_name,amount) VALUES('LEGACY',1,'seat-3m','기존 3개월권',297000)").run();
 await deleteProduct({request:req('DELETE',{id:'seat-3m'}),env});
 const pay=db.prepare("SELECT * FROM pass_payments WHERE payment_key='LEGACY'").get();
 assert.equal((await termsForPayment(env,pay)).duration.months,3);
 assert(db.prepare("SELECT terms FROM kiosk_payment_terms WHERE payment_key='LEGACY'").get());
});
test('카테고리는 판매 중지 상품도 남아 있으면 삭제 차단, 상품 삭제 뒤 허용',async t=>{
 const {env}=fixture(t);const category=await newCategory(env);
 const id=(await (await createProduct({request:req('POST',{...base,category,active:false}),env})).json()).id;
 const categories=await (await listCategories({request:req('GET'),env})).json();
 const c=categories.categories.find(c=>c.id===category);assert.equal(c.activeProducts,0);assert.equal(c.productCount,1);
 assert.equal((await deleteCategory({request:req('DELETE',{id:category}),env})).status,409);
 await deleteProduct({request:req('DELETE',{id}),env});
 assert.equal((await deleteCategory({request:req('DELETE',{id:category}),env})).status,200);
 assert.equal((await deleteCategory({request:req('DELETE',{id:category}),env})).status,200);
 assert(!(await (await listCategories({request:req('GET'),env})).json()).categories.some(c=>c.id===category));
 assert.equal((await editCategory({request:req('PATCH',{...cat,id:category}),env})).status,404);
 assert.equal((await createProduct({request:req('POST',{...base,category}),env})).status,400);
});
test('상품을 다른 분류로 옮기면 이전 분류 삭제 가능, 상품은 유지',async t=>{
 const {env}=fixture(t);const category=await newCategory(env);
 const id=(await (await createProduct({request:req('POST',{...base,category}),env})).json()).id;
 assert.equal((await deleteCategory({request:req('DELETE',{id:category}),env})).status,409);
 await editProduct({request:req('PATCH',{...base,id,category:'regular'}),env});
 assert.equal((await deleteCategory({request:req('DELETE',{id:category}),env})).status,200);
 assert.equal((await getKioskProduct(env,id)).category,'regular');
});

test('상품 저장 직전에 분류가 삭제되어도 고아 상품을 만들지 않음',async t=>{
 const {env,db}=fixture(t);const category=await newCategory(env);await getKioskProducts(env);
 const prepare=env.DB.prepare;
 env.DB.prepare=sql=>{const s=prepare(sql);if(sql.includes('INSERT INTO kiosk_products')&&sql.includes('SELECT ?1')){
  const run=s.run;s.run=async()=>{db.prepare("INSERT OR IGNORE INTO kiosk_catalog_deleted(kind,id) VALUES('category',?)").run(category);return run()};
 }return s};
 assert.equal((await createProduct({request:req('POST',{...base,category}),env})).status,409);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM kiosk_products WHERE category=?').get(category).n,0);
});

test('분류 삭제 직전에 상품이 추가되면 삭제를 막고 연결 보존',async t=>{
 const {env,db}=fixture(t);const category=await newCategory(env);await getKioskProducts(env);
 const prepare=env.DB.prepare;
 env.DB.prepare=sql=>{const s=prepare(sql);if(sql.includes('INSERT OR IGNORE INTO kiosk_catalog_deleted (kind,id)')&&sql.includes("SELECT 'category'")){
  const run=s.run;s.run=async()=>{db.prepare("INSERT INTO kiosk_products(id,name,price,duration_unit,duration_value,pass_group,image,category) VALUES('race-product','동시 등록',1000,'hours',2,'seat','pass-2h.webp',?)").run(category);return run()};
 }return s};
 assert.equal((await deleteCategory({request:req('DELETE',{id:category}),env})).status,409);
 assert.equal((await getKioskProduct(env,'race-product')).category,category);
});
