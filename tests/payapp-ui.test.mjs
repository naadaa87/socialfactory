import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../js/shop.js',import.meta.url),'utf8');
const order={oid:'SF261103120000ABCD',provider:'payapp',status:'pending',statusLabel:'결제 대기',productName:'모의 이용권',amount:8000,qty:2,payMethod:'카드',buyerName:'모의 구매자',buyerPhone:'010-1234-5678',payurl:'https://payapp.kr/sample'};
async function fixture(results){
 const elements=new Map(),queue=[],store=new Map();let n=0;
 const el=s=>{if(!elements.has(s))elements.set(s,{hidden:true,textContent:'',events:{},addEventListener(k,f){this.events[k]=f}});return elements.get(s)};
 const context={document:{querySelector(s){if(s==='[data-shop-page="complete"]'||s.startsWith('[data-oc-'))return el(s);return null},querySelectorAll(){return []}},navigator:{userAgent:'test'},location:{search:'?oid='+order.oid+'&t=token'},URL,sessionStorage:{getItem:k=>store.get(k)||null,removeItem:k=>store.delete(k)},setTimeout:f=>{queue.push(f);return queue.length},clearTimeout:()=>queue.splice(0),fetch:async url=>{if(url==='/api/shop/products')return {status:200,json:async()=>({pay:{ready:true,provider:'payapp'}})};const value=results[Math.min(n++,results.length-1)];if(value==='network')throw Error('network');return {status:200,json:async()=>({order:value})}}};
 vm.runInNewContext(source,context);const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};await flush();
 return {el,queue,flush,async next(){queue.shift()?.();await flush()}};
}
test('복귀 직후 pending을 실패로 오인하지 않고 승인 통보 후 자동 완료 표시',async()=>{
 const f=await fixture([order,{...order,status:'paid',statusLabel:'결제 완료',payurl:null}]);assert.equal(f.el('[data-oc-pending]').hidden,false);assert.equal(f.el('[data-oc-fail]').hidden,true);assert.equal(f.el('[data-oc-resume]').href,order.payurl);assert.equal(f.queue.length,1);await f.next();assert.equal(f.el('[data-oc-done]').hidden,false);assert.equal(f.el('[data-oc-pending]').hidden,true);assert.equal(f.queue.length,0);
});
test('네트워크 오류를 결제 실패로 표시하지 않고 중복 결제 없이 재조회',async()=>{
 const f=await fixture(['network',{...order,status:'paid'}]);assert.equal(f.el('[data-oc-fail]').hidden,true);assert.match(f.el('[data-oc-lead]').textContent,/재결제하지/);await f.next();assert.equal(f.el('[data-oc-done]').hidden,false);
});
test('장기 대기는 자동 조회를 멈추고 확인 버튼/문의 안내 유지',async()=>{
 const f=await fixture([order]);for(let n=0;n<14;n++)await f.next();assert.equal(f.queue.length,0);assert.match(f.el('[data-oc-pending-note]').textContent,/재결제하지/);f.el('[data-oc-refresh]').events.click();await f.flush();assert.equal(f.queue.length,1);
});
test('환불 금액 표시 및 외부 주소로 결제 이어가기 차단',async()=>{
 const f=await fixture([{...order,refundedAmount:3000,payurl:'https://evil.test/pay'}]);assert.equal(f.el('[data-oc-refund]').textContent,'3,000원');assert.equal(f.el('[data-oc-resume]').hidden,true);
});
