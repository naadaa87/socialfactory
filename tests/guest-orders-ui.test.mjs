import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../js/guest-orders.js',import.meta.url),'utf8');
async function render(results){
 const nodes=new Map(),calls=[];
 function node(selector){if(!nodes.has(selector))nodes.set(selector,{hidden:false,textContent:'',innerHTML:'',disabled:false,events:{},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(selector);}
 const root={querySelector:node};
 vm.runInNewContext(source,{document:{querySelector:()=>root},setInterval(){},fetch:async(url,options)=>{
  calls.push({url,options});return {status:200,json:async()=>url.endsWith('/session')?{verified:true,ready:true}:{ok:true,maskedPhone:'010-****-5678',results}};
 }});
 await new Promise(resolve=>setImmediate(resolve));return {html:node('[data-guest-rows]').innerHTML,calls,node};
}
test('phone-verified lookup renders room/office status recovery and keeps legacy destinations without opening checkout',async()=>{
 const h=await render([
  {kind:'room',oid:'B-1',statusLabel:'결제 대기',product_name:'5번룸 <예약>',amount:16000,date:'2099-12-15',start_min:1380,end_min:1500,people:6,detail_url:'/booking-status?code=B-1&t=hold-token'},
  {kind:'office',oid:'OF-1',statusLabel:'부분 환불',product_name:'독립사무실',amount:275000,detail_url:'/booking-status?code=OF-1&t=office-token'},
  {oid:'SF-PARKING',statusLabel:'결제 완료',product_id:'parking-2h',product_name:'2시간 주차권',amount:8000,start_date:'2099-12-15 10:00'},
  {oid:'SF-LEGACY',statusLabel:'결제 완료',product_id:'cowork-2h',product_name:'기존 2시간권',amount:4000,start_date:'2099-12-15 10:00'}
 ]);
 assert.match(h.html,/href="\/booking-status\?code=B-1&amp;t=hold-token"/);assert.match(h.html,/href="\/booking-status\?code=OF-1&amp;t=office-token"/);
 assert.match(h.html,/2099-12-15 23:00 → 익일 01:00 · 6명/);assert.match(h.html,/5번룸 &lt;예약&gt;/);assert.match(h.html,/예약·결제 상태 확인/);assert.match(h.html,/독립사무실 청구·결제 확인/);
 assert.match(h.html,/href="\/parking-order\?oid=SF-PARKING"/);assert.match(h.html,/href="\/order-complete\?oid=SF-LEGACY"/);
 assert.equal(h.html.includes('/order-complete?oid=B-1'),false);assert.equal(h.html.includes('/order-complete?oid=OF-1'),false);assert.equal(h.node('[data-guest-auth]').hidden,true);
 assert.deepEqual(h.calls.map(c=>c.options.method),['GET','GET']);assert.equal(h.calls.some(c=>c.url.includes('payment-status')),false);
});
test('unlinked room requests and invalid recovery destinations offer contact instead of unusable legacy details',async()=>{
 const h=await render([{kind:'room',oid:'B-MANUAL',statusLabel:'예약 신청 접수',product_name:'1번룸',amount:12000,date:'2099-12-15',start_min:600,end_min:720,people:2,detail_url:null},
  {kind:'office',oid:'OF-BAD',statusLabel:'결제 대기',product_name:'독립사무실',amount:10000,detail_url:'https://payapp.kr/external-direct-payment'}]);
 assert.equal(h.html.includes('<a '),false);assert.equal(h.html.includes('payapp.kr'),false);assert.equal(h.html.includes('order-complete'),false);assert.match(h.html,/접수번호로 담당자에게 진행 상태를 문의해 주세요/);
});
