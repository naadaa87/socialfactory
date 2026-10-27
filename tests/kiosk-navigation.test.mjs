import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../toss-front-plugin/app.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../toss-front-plugin/ui.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture({failFirstPendingRead=false,deferInitialPending=false,failPendingRemove=false}={}) {
  let releaseInitialPending, paymentReads=0;
  const initialPending = new Promise(resolve=>{releaseInitialPending=resolve});
  const pages=[],requests=[],reads=new Map(),storage=new Map([['sf_kiosk_token','fixture-token']]);
  const template={openToast(){}};
  for(const method of ['renderIdlePage','renderInputPage','renderSelectPage','renderSelectGridPage','renderAgreementPage','renderOrderPage','renderResultPage','renderOnboardingPage'])template[method]=params=>pages.push({method,params});
  const window={SF_PLUGIN:{apiBase:'https://fixture.invalid'},TossFrontSDK:{template,storage:{
    async get({key}){reads.set(key,(reads.get(key)||0)+1);if(deferInitialPending&&key==='sf_kiosk_pending'&&reads.get(key)===1)return initialPending;if(failFirstPendingRead&&key==='sf_kiosk_pending'&&reads.get(key)===1)throw new Error('temporary bridge error');return {value:storage.get(key)||null}},
    async set({key,value}){storage.set(key,value)},async remove({key}){if(failPendingRemove&&key==='sf_kiosk_pending')throw new Error('fixture remove error');storage.delete(key)}
  },payment:{async requestPayment(){return {type:'SUCCESS',response:{mock:true}}},async getPayment(){paymentReads++;return null},async requestPaymentCancel(){return {type:'SUCCESS',response:{mock:true}}}}}};
  vm.runInNewContext(ui+'\n'+source,{window,URL,AbortController,setTimeout,clearTimeout,console:{log(){},error(){}},location:{hostname:'fixture.invalid',href:'https://fixture.invalid/index.html'},fetch:async(url,opts)=>{
    const path=new URL(url).pathname;
    if(path==='/api/kiosk/logs')return new Response(JSON.stringify({ok:true}));
    if(path==='/api/kiosk/products'){requests.push({path});return new Response(JSON.stringify({ok:true,products:[{id:'seat-2h',name:'2시간권',price:4000,category:'day'}],layout:{categoryLayout:'list',productLayout:'list'}}))}
    return new Promise(resolve=>requests.push({path,body:JSON.parse(opts.body||'{}'),resolve:data=>resolve(new Response(JSON.stringify({ok:true,...data})))}));
  }});await tick();
  return {pages,requests,reads,storage,releaseInitialPending,get paymentReads(){return paymentReads},get current(){return pages.at(-1)},
    resolve(path,data){const req=requests.find(r=>r.path===path&&r.resolve);assert(req,'unresolved '+path);req.resolve(data);req.resolve=null},
    async toCategories(){this.current.params.primaryButton.onClick();await tick()},
    async toPhone(){await this.toCategories();this.current.params.options[0].onClick();this.current.params.options[0].onClick()},
    async toAgreement(){await this.toPhone();this.current.params.onSubmit('01000000000')},
    async toStaffList(){await this.toCategories();this.current.params.navbarButton.onClick();this.current.params.onSubmit('1234');this.resolve('/api/kiosk/staff',{staffToken:'fixture-staff',payments:[{paymentKey:'fixture-key',productName:'2시간권',amount:4000,phoneMasked:'010-****-0000'}]});await tick()}
  };
}
test('조회 입력·뒤로가기 반복은 빈 복구 상태를 SDK에서 다시 읽지 않음',async()=>{
  const h=await fixture();
  for(let i=0;i<5;i++){h.current.params.secondaryButton.onClick();h.current.params.onBack();await tick()}
  assert.equal(h.reads.get('sf_kiosk_pending'),1);assert.equal(h.reads.get('sf_kiosk_error_logs'),1);
});
test('SDK 저장소 읽기 실패는 빈 상태로 캐시하지 않고 다음 진입에 재시도',async()=>{
  const h=await fixture({failFirstPendingRead:true});
  for(let i=0;i<3;i++){h.current.params.secondaryButton.onClick();h.current.params.onBack();await tick()}
  assert.equal(h.reads.get('sf_kiosk_pending'),2);
});
test('전화번호·동의·직원 PIN 뒤로가기는 직전 상품 화면을 재조회 없이 복원',async()=>{
  const h=await fixture();await h.toPhone();h.current.params.onBack();
  assert.match(h.current.params.title,/이용권/);assert.equal(h.current.params.options[0].subtitle,'4,000원');
  h.current.params.options[0].onClick();h.current.params.onSubmit('01000000000');
  assert.equal(h.current.method,'renderAgreementPage');assert.equal(typeof h.current.params.onBack,'function');
  h.current.params.onBack();assert.equal(h.current.method,'renderInputPage');h.current.params.onBack();h.current.params.onBack();
  h.current.params.navbarButton.onClick();h.current.params.onBack();assert.equal(h.current.method,'renderSelectPage');
  assert.equal(h.requests.filter(r=>r.path==='/api/kiosk/products').length,1);
});
test('조회 중 뒤로간 뒤 늦게 도착한 결과를 무시하고 다음 조회는 서버에서 다시 읽음',async()=>{
  const h=await fixture();h.current.params.secondaryButton.onClick();h.current.params.onSubmit('01000000000');
  assert.equal(h.current.params.title,'이용권을 확인하고 있어요');h.current.params.onBack();
  h.resolve('/api/kiosk/lookup',{active:true,endsText:'10월 27일 20:54',phoneMasked:'010-****-0000'});await tick();assert.equal(h.current.method,'renderInputPage');
  h.current.params.onSubmit('01000000000');h.resolve('/api/kiosk/lookup',{active:true,endsText:'10월 28일 20:54',phoneMasked:'010-****-0000'});await tick();
  assert.match(h.current.params.title,/28일/);assert.equal(h.requests.filter(r=>r.path==='/api/kiosk/lookup').length,2);
});
test('결제 준비 중 중복 동의를 막고 뒤로간 뒤 도착한 금액 확인 화면은 표시하지 않음',async()=>{
  const h=await fixture();await h.toAgreement();const submit=h.current.params.onSubmit;submit(['privacy']);submit(['privacy']);
  assert.equal(h.requests.filter(r=>r.path==='/api/kiosk/intents').length,1);h.current.params.onBack();
  h.resolve('/api/kiosk/intents',{paymentKey:'fixture-key',amount:4000,preview:{endsText:'10월 27일 20:54'}});await tick();
  assert.equal(h.current.method,'renderAgreementPage');assert(!h.pages.some(p=>p.method==='renderOrderPage'));
});
test('직원 확인 중 뒤로간 뒤 늦은 응답은 PIN 화면을 덮지 않음',async()=>{
  const h=await fixture();await h.toCategories();h.current.params.navbarButton.onClick();h.current.params.onSubmit('1234');
  assert.equal(h.current.params.title,'직원 정보를 확인하고 있어요');h.current.params.onBack();
  h.resolve('/api/kiosk/staff',{staffToken:'fixture-staff',payments:[]});await tick();assert.equal(h.current.params.top.subtitle,'매장 직원 전용');
});
test('취소 확인의 뒤로가기는 이미 인증받은 목록을 재요청 없이 복원',async()=>{
  const h=await fixture();await h.toStaffList();assert.equal(h.current.params.options.length,1);
  h.current.params.options[0].onClick();h.current.params.onBack();assert.equal(h.current.params.options.length,1);
  assert.equal(h.requests.filter(r=>r.path==='/api/kiosk/staff').length,1);assert.equal(h.reads.get('sf_kiosk_pending_cancel'),1);
});

async function approveInFixture(h) {
  await h.toAgreement();h.current.params.onSubmit(['privacy']);
  h.resolve('/api/kiosk/intents',{paymentKey:'fixture-approved',amount:4000,productName:'2시간권',payment:{tax:364,supplyValue:3636},preview:{endsText:'10월 27일 20:54'}});await tick();
  h.current.params.onClick();await tick();
}
test('쓰기 전에 시작한 늦은 SDK 읽기가 새 결제 복구 상태를 덮지 않음',async()=>{
  const h=await fixture({deferInitialPending:true});await approveInFixture(h);
  h.releaseInitialPending({value:null});await tick();
  h.resolve('/api/kiosk/result',{ok:false,message:'fixture report error'});await tick();await tick();
  h.current.params.buttons[0].onClick();await tick();
  assert.equal(h.paymentReads,1);assert(h.storage.has('sf_kiosk_pending'));assert.equal(h.reads.get('sf_kiosk_pending'),1);
});
test('SDK 삭제 실패를 빈 상태로 캐시하지 않아 다음 진입에서 실제 복구 기록을 다시 읽음',async()=>{
  const h=await fixture({failPendingRemove:true});await approveInFixture(h);
  h.resolve('/api/kiosk/result',{pass:{productName:'2시간권',endsText:'10월 27일 20:54'}});await tick();await tick();
  h.current.params.buttons[0].onClick();await tick();
  assert(h.storage.has('sf_kiosk_pending'));assert.equal(h.paymentReads,1);assert.equal(h.reads.get('sf_kiosk_pending'),2);
});
