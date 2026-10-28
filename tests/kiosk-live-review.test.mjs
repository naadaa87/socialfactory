import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../toss-front-plugin/app.js',import.meta.url),'utf8');
const ui=readFileSync(new URL('../toss-front-plugin/ui.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(opt={}) {
  const storage=new Map([['sf_kiosk_token','fixture-token'],...Object.entries(opt.initial||{})]);
  const pages=[],requests=[],toasts=[];
  let payments=0,cancels=0;
  const template={openToast(p){toasts.push(p)}};
  for(const m of ['renderIdlePage','renderInputPage','renderSelectPage','renderSelectGridPage','renderAgreementPage','renderOrderPage','renderResultPage','renderOnboardingPage']) template[m]=params=>pages.push({method:m,params});
  const sdk={template,storage:{
    async get({key}){if(opt.failRead===key)throw Error('bridge read failed');return {value:storage.get(key)||null}},
    async set({key,value}){if(opt.failWrite===key)throw Error('bridge write failed');storage.set(key,value)},
    async remove({key}){storage.delete(key)}
  },payment:{
    requestPayment(){payments++;if(opt.paymentThrows)throw Error('bridge lost');return Promise.resolve(opt.paymentResult||{type:'CANCELED'})},
    async getPayment(){return null},
    requestPaymentCancel(){cancels++;if(opt.cancelThrows)throw Error('bridge lost');return Promise.resolve(opt.cancelResult||{type:'TIMEOUT'})},
    async getPaymentCancel(){return opt.cancelRecovery||{type:'TIMEOUT'}}
  }};
  const window={TossFrontSDK:sdk,SF_PLUGIN:{apiBase:'https://fixture.invalid'}};
  vm.runInNewContext(ui+'\n'+source,{window,URL,AbortController,setTimeout,clearTimeout,console:{log(){},error(){}},location:{hostname:'fixture.invalid',href:'https://fixture.invalid/index.html'},fetch:async(url,opts)=>{
    const path=new URL(url).pathname,body=JSON.parse(opts?.body||'{}');requests.push({path,body});
    let data={ok:true},status=200;
    if(path.endsWith('/products'))data={ok:true,products:[{id:'seat-2h',name:'2시간권',price:4000,category:'day'}],layout:{categoryLayout:'list',productLayout:'list'}};
    if(path.endsWith('/intents'))data={ok:true,paymentKey:'NEW-KEY',amount:4000,productName:'2시간권',payment:{tax:363,supplyValue:3637},preview:{endsText:'10월 28일 20:54'}};
    if(path.endsWith('/staff'))data={ok:true,staffToken:'staff-fixture',payments:[{paymentKey:'CANCEL-KEY',productName:'2시간권',amount:4000,phoneMasked:'010-****-0000'}]};
    if(path.endsWith('/refund')){
      if(opt.staffExpired){data={ok:false,error:'staff-auth',message:'관리 화면에 다시 들어가 주세요.'};status=401}
      else data=body.stage==='start'?{ok:true,params:{paymentKey:body.paymentKey}}:{ok:true,status:'refunded'};
    }
    return new Response(JSON.stringify(data),{status});
  }});
  await tick();
  return {storage,pages,requests,toasts,get current(){return pages.at(-1)},get payments(){return payments},get cancels(){return cancels},
    async toOrder(){this.current.params.primaryButton.onClick();await tick();this.current.params.options[0].onClick();this.current.params.options[0].onClick();this.current.params.onSubmit('01000000000');await this.current.params.onSubmit(['privacy'])},
    async toRefund(){this.current.params.primaryButton.onClick();await tick();this.current.params.navbarButton.onClick();await this.current.params.onSubmit('1234');this.current.params.options[0].onClick()},
    async submit(){this.current.params.onClick();await tick();await tick()},
    async cancel(){this.current.params.options[0].onClick();await tick();await tick()}
  };
}
for(const failure of ['failRead','failWrite']) test('결제 복구 저장소 '+failure+' 시 카드 요청 전 차단',async()=>{
  const h=await fixture({[failure]:'sf_kiosk_pending'});await h.toOrder();await h.submit();
  assert.equal(h.payments,0);assert.equal(h.current.params.title,'결제를 시작하지 않았어요');
  assert(!h.requests.some(r=>r.path.endsWith('/result')));
});
test('미확인 결제가 있으면 새 결제로 덮어쓰지 않음',async()=>{
  const pending=JSON.stringify({paymentKey:'OLD-KEY',at:Date.now()});
  const h=await fixture({initial:{sf_kiosk_pending:pending}});await h.toOrder();await h.submit();
  assert.equal(h.payments,0);assert.equal(h.storage.get('sf_kiosk_pending'),pending);assert.match(h.current.params.description,/이전 거래/);
});
test('SDK가 동기 예외로 응답을 잃어도 결제 복구 기록 유지',async()=>{
  const h=await fixture({paymentThrows:true});await h.toOrder();await h.submit();
  assert.equal(h.payments,1);assert(h.storage.has('sf_kiosk_pending'));assert.equal(h.current.params.status,'error');
  assert.equal(h.requests.find(r=>r.path.endsWith('/result')).body.type,'TIMEOUT');
});
test('명시적으로 닫은 결제는 복구 기록을 지우고 다음 구매 허용',async()=>{
  const h=await fixture();await h.toOrder();await h.submit();assert(!h.storage.has('sf_kiosk_pending'));
  h.current.params.buttons[0].onClick();await tick();await h.toOrder();await h.submit();assert.equal(h.payments,2);
});
test('취소 복구 정보 쓰기 실패 시 카드 취소창을 열지 않음',async()=>{
  const h=await fixture({failWrite:'sf_kiosk_pending_cancel'});await h.toRefund();await h.cancel();assert.equal(h.cancels,0);
});
for(const cancelThrows of [false,true]) test('취소 '+(cancelThrows?'예외':'TIMEOUT')+'는 기록 유지, 재진입해 미확인이면 중복 취소 차단',async()=>{
  const h=await fixture({cancelThrows});await h.toRefund();await h.cancel();
  assert.equal(h.storage.get('sf_kiosk_pending_cancel'),'CANCEL-KEY');assert.equal(h.current.params.title,'취소 결과를 확인하고 있어요');
  h.current.params.onTimeout();await tick();await h.toRefund();await h.cancel();
  assert.equal(h.cancels,1);assert.equal(h.storage.get('sf_kiosk_pending_cancel'),'CANCEL-KEY');
});
test('지난 취소 SUCCESS를 직원 인증 후 서버에 재전송하고 목록에서 제거',async()=>{
  const h=await fixture({initial:{sf_kiosk_pending_cancel:'CANCEL-KEY'},cancelRecovery:{type:'SUCCESS',response:{card:{approvalNumber:'FIXTURE'}}}});
  h.current.params.primaryButton.onClick();await tick();h.current.params.navbarButton.onClick();await h.current.params.onSubmit('1234');
  assert(!h.storage.has('sf_kiosk_pending_cancel'));assert.equal(h.current.params.options.length,0);
  assert.equal(h.requests.filter(r=>r.path.endsWith('/refund')&&r.body.stage==='result').length,1);assert.equal(h.cancels,0);
});
test('직원 토큰 만료는 PIN 재입력으로 처리하고 단말기 연결 유지',async()=>{
  const h=await fixture({staffExpired:true});await h.toRefund();await h.cancel();
  assert.equal(h.current.method,'renderInputPage');assert.equal(h.current.params.top.subtitle,'매장 직원 전용');
  assert.equal(h.storage.get('sf_kiosk_token'),'fixture-token');assert(!h.pages.some(p=>p.method==='renderOnboardingPage'));
});
