import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {getKioskProducts,getKioskCategories,seedKioskProducts} from '../functions/_lib/kiosk-catalog.js';
import {readKioskUi,saveKioskUi} from '../functions/_lib/kiosk-ui.js';

function database(t) {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  t.after(()=>sqlite.close());
  let calls=0,failBatch=false;
  const DB={prepare(sql){
    let args=[];
    const execute=kind=>kind==='all'?{results:sqlite.prepare(sql).all(...args)}:kind==='first'?(sqlite.prepare(sql).get(...args)||null):{meta:sqlite.prepare(sql).run(...args)};
    return {bind(...v){args=v;return this},_run:()=>execute('run'),async run(){calls++;return execute('run')},async all(){calls++;return execute('all')},async first(){calls++;return execute('first')}};
  },async batch(stmts){
    calls++;if(failBatch){failBatch=false;throw new Error('fixture DB unavailable')}
    sqlite.exec('BEGIN');try{const rows=stmts.map(s=>s._run());sqlite.exec('COMMIT');return rows}catch(e){sqlite.exec('ROLLBACK');throw e}
  }};
  return {env:{DB},sqlite,get calls(){return calls},reset(){calls=0},failNextBatch(){failBatch=true}};
}
async function catalog(env) {
  await seedKioskProducts(env);
  return Promise.all([getKioskProducts(env),getKioskCategories(env),readKioskUi(env)]);
}
test('카탈로그는 최초 5회·다음 3회 DB 호출, 이후 어드민 변경값도 즉시 조회',async t=>{
  const f=database(t);await catalog(f.env);assert.equal(f.calls,5);
  f.reset();await catalog(f.env);assert.equal(f.calls,3);
  f.sqlite.prepare("UPDATE kiosk_products SET price=4500 WHERE id='seat-2h'").run();
  f.sqlite.prepare("UPDATE kiosk_categories SET name='바뀐 분류' WHERE id='day'").run();
  await saveKioskUi(f.env,{categoryLayout:'grid',productLayout:'grid'});
  f.reset();const [products,categories,layout]=await catalog(f.env);
  assert.equal(f.calls,3);assert.equal(products.find(p=>p.id==='seat-2h').price,4500);
  assert.equal(categories.find(c=>c.id==='day').name,'바뀐 분류');assert.equal(layout.productLayout,'grid');
});
test('초기화 실패는 다음 요청에서 재시도하고 다른 DB의 초기화를 생략하지 않음',async t=>{
  const a=database(t);a.failNextBatch();await assert.rejects(catalog(a.env));
  assert.equal(a.sqlite.prepare('SELECT COUNT(*) n FROM kiosk_products').get().n,0);
  await catalog(a.env);assert.equal(a.sqlite.prepare('SELECT COUNT(*) n FROM kiosk_products').get().n,7);
  const b=database(t);await catalog(b.env);assert.equal(b.calls,5);
});

const source=readFileSync(new URL('../toss-front-plugin/app.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../toss-front-plugin/ui.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const payload=(layout='list')=>({ok:true,layout:{categoryLayout:layout,productLayout:layout},products:[{id:'seat-2h',name:'2시간권',price:4000,category:'day'}]});
async function plugin({sdkResult='SUCCESS',intentFields={}}={}) {
  const pages=[],catalogRequests=[],reports=[],storage=new Map([['sf_kiosk_token','fixture-token']]);
  const nativePayment=deferred();let payments=0;
  const template={openToast(){}};
  for(const method of ['renderIdlePage','renderSelectPage','renderSelectGridPage','renderInputPage','renderAgreementPage','renderOrderPage','renderResultPage'])template[method]=params=>pages.push({method,params});
  const window={SF_PLUGIN:{apiBase:'https://fixture.invalid'},TossFrontSDK:{template,storage:{async get({key}){return {value:storage.get(key)||null}},async set({key,value}){storage.set(key,value)},async remove({key}){storage.delete(key)}},payment:{requestPayment(){payments++;return nativePayment.promise}}}};
  vm.runInNewContext(ui+'\n'+source,{window,URL,AbortController,setTimeout,clearTimeout,console:{log(){},error(){}},location:{hostname:'fixture.invalid',href:'https://fixture.invalid/index.html'},fetch:async url=>{
    const path=new URL(url).pathname;
    if(path==='/api/kiosk/products'){const d=deferred();catalogRequests.push(d);return new Response(JSON.stringify(await d.promise))}
    if(path==='/api/kiosk/intents')return new Response(JSON.stringify({ok:true,paymentKey:'FIXTURE-KEY',amount:4000,productName:'2시간권',payment:{tax:364,supplyValue:3636},preview:{endsText:'10월 27일 20:54'},...intentFields}));
    if(path==='/api/kiosk/result'){const d=deferred();reports.push(d);return new Response(JSON.stringify(await d.promise))}
    throw new Error('Unexpected fixture request '+path);
  }});
  await tick();
  return {pages,catalogRequests,reports,storage,get current(){return pages.at(-1)},get payments(){return payments},
    async toOrder(catalog=payload()){this.current.params.primaryButton.onClick();catalogRequests.at(-1).resolve(catalog);await tick();this.current.params.options[0].onClick();this.current.params.options[0].onClick();this.current.params.onSubmit('01000000000');await this.current.params.onSubmit(['privacy'])},
    finishNative(){nativePayment.resolve({type:sdkResult,response:{mock:true}})}};
}
test('할인 상품 결제 확인에서도 업로드 이미지와 할인 종류·할인율·금액을 유지',async()=>{
  for(const friend of [false,true]){
    const h=await plugin({intentFields:{amount:3600,listPrice:4000}});
    const catalog=payload();Object.assign(catalog.products[0],{friend,price:3600,listPrice:4000,image:'pass-2h.webp',imageUrl:'https://fixture.invalid/api/kiosk/product-images/seat-2h?v=5'});
    await h.toOrder(catalog);
    const order=h.current.params.order;
    assert.equal(h.current.method,'renderOrderPage');
    assert.equal(order.items[0].imageUrl,catalog.products[0].imageUrl);
    assert.equal(order.discounts[0].label,friend?'친구 동반 10% 할인':'상품 10% 할인');
    assert.equal(order.discounts[0].value,400);
    assert.equal(order.summary.totalAmount,3600);
  }
});
test('느린 상품 응답 중에도 즉시 준비 화면, 뒤로가면 늦은 응답이 화면을 덮지 않음',async()=>{
  const h=await plugin();h.current.params.primaryButton.onClick();
  assert.equal(h.current.params.title,'이용권을 불러오고 있어요');assert.equal(h.current.params.options.length,0);
  h.current.params.onBack();assert.equal(h.current.method,'renderIdlePage');
  h.catalogRequests[0].resolve(payload());await tick();assert.equal(h.current.method,'renderIdlePage');
});
test('이전 구매 요청이 늦게 끝나도 새 구매의 상품·레이아웃을 덮지 않음',async()=>{
  const h=await plugin();h.current.params.primaryButton.onClick();h.current.params.onBack();h.current.params.primaryButton.onClick();
  h.catalogRequests[1].resolve(payload('grid'));await tick();assert.equal(h.current.method,'renderSelectGridPage');
  h.catalogRequests[0].resolve(payload('list'));await tick();h.current.params.options[0].onClick();
  assert.equal(h.current.method,'renderSelectGridPage');
});
test('승인 전에는 성공을 표시하지 않고 승인 직후에는 서버 저장을 기다리지 않고 완료 안내',async()=>{
  const h=await plugin();await h.toOrder();assert.equal(h.current.method,'renderOrderPage');
  const confirm=h.current.params.onClick;confirm();confirm();
  assert.equal(h.current.params.title,'결제를 진행하고 있어요');await tick();assert.equal(h.payments,1);
  assert(!h.pages.some(p=>p.method==='renderResultPage'&&p.params.status==='success'));
  h.finishNative();await tick();
  assert.equal(h.current.method,'renderSelectPage');
  assert.equal(h.current.params.title,'결제가 완료됐어요');assert.equal(h.current.params.options.length,0);
  assert(h.storage.has('sf_kiosk_pending'));assert.equal(h.current.params.onTimeout,undefined);
  h.reports[0].resolve({ok:true,pass:{productName:'2시간권',endsText:'10월 27일 20:54'}});await tick();await tick();
  assert.equal(h.current.params.title,'10월 27일\n20:54까지 이용');assert(!h.storage.has('sf_kiosk_pending'));
  const orderIndex=h.pages.findIndex(p=>p.method==='renderOrderPage');
  assert(!h.pages.slice(orderIndex+1).some(p=>p.method==='renderOrderPage'));
});
test('결제 취소는 성공 안내 없이 오류 결과로 표시',async()=>{
  const h=await plugin({sdkResult:'CANCELED'});await h.toOrder();h.current.params.onClick();await tick();h.finishNative();await tick();
  assert.equal(h.current.params.status,'error');assert.equal(h.current.params.title,'결제를 취소했어요');
  assert(!h.pages.some(p=>p.method==='renderResultPage'&&p.params.status==='success'));
  h.reports[0].resolve({ok:true});await tick();
});

test('승인 후 서버 저장 실패는 결제 성공 안내를 유지하고 복구 기록을 남김',async()=>{
  const h=await plugin();await h.toOrder();h.current.params.onClick();await tick();h.finishNative();await tick();
  h.reports[0].resolve({ok:false,message:'fixture persistence failure'});await tick();await tick();
  assert.equal(h.current.params.status,'success');assert.equal(h.current.params.title,'결제는 완료됐어요');
  assert.equal(h.current.params.buttons.length,1);assert(h.storage.has('sf_kiosk_pending'));
});
test('승인 여부가 불확실한 시간 초과는 성공 표시 없이 복구 기록 유지',async()=>{
  const h=await plugin({sdkResult:'TIMEOUT'});await h.toOrder();h.current.params.onClick();await tick();h.finishNative();await tick();
  assert.equal(h.current.params.status,'error');assert(h.storage.has('sf_kiosk_pending'));
  assert(!h.pages.some(p=>p.method==='renderResultPage'&&p.params.status==='success'));
  h.reports[0].resolve({ok:true});await tick();
});
