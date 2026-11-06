import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const code=readFileSync(new URL('../js/booking-status.js',import.meta.url),'utf8');
const response=j=>({ok:true,status:200,json:async()=>j});
const pending={ok:true,code:'BTEST',kind:'room',label:'소셜팩토리 3번룸',amount:20000,status:'pending',booking:{room:'r3',date:'2099-11-06',start_min:600,end_min:720,people:3,status:'awaiting_payment'},sync:{state:'blocked',fresh:false},can_start_payment:true,can_pay:false,can_cancel:true};
function harness(fetcher){
  const nodes=new Map(),timers=new Map(),navigations=[];let serial=0;
  function node(id){
    if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,disabled:false,checked:false,children:[],events:{},addEventListener(type,fn){this.events[type]=fn;},append(...els){this.children.push(...els);},replaceChildren(...els){this.children=[...els];},reportValidity(){return node('payment-agree').checked;}});
    return nodes.get(id);
  }
  const context={document:{getElementById:node,createElement:()=>node(Symbol())},window:{confirm:()=>true},location:{search:'?code=BTEST&t=private-token',assign:value=>navigations.push(value)},URLSearchParams,URL,AbortController,fetch:fetcher,setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),console};
  vm.runInNewContext(code,context);
  return {nodes,navigations,timers,context,node,async flush(){await new Promise(resolve=>setImmediate(resolve));},async poll(){const task=[...timers].find(([,t])=>t.ms===2000);assert(task,'poll scheduled');timers.delete(task[0]);task[1].fn();await this.flush();}};
}

test('opening a ready status page never starts checkout without explicit consent and submit',async()=>{
  let posts=0;const h=harness(async(url,options)=>{if(options.method==='POST')posts++;return response({...pending,can_pay:true});});
  await h.flush();
  assert.equal(h.node('payment-consent').hidden,false);assert.equal(h.node('booking-cancel').hidden,false);assert.equal(posts,0);assert.deepEqual(h.navigations,[]);
});

test('checkout waits for a fresh verification, then continues only the submitted checkout',async()=>{
  const calls=[];let gets=0,posts=0;
  const h=harness(async(url,options)=>{
    calls.push({url,body:options.body && JSON.parse(options.body)});
    if(options.method==='POST')return response(++posts===1?{ok:true,pending:true,message:'최신 일정 확인 중'}:{ok:true,url:'https://payapp.kr/verified-checkout'});
    return response({...pending,can_pay:++gets>1});
  });
  await h.flush();h.node('payment-agree').checked=true;
  h.node('payment-consent').events.submit({preventDefault(){}});await h.flush();
  assert.equal(posts,1);assert.deepEqual(h.navigations,[]);assert.equal(h.node('payment-open').disabled,true);
  await h.poll();
  assert.equal(posts,2);assert.deepEqual(h.navigations,['https://payapp.kr/verified-checkout']);
  assert.equal(calls.filter(c=>c.body).every(c=>c.body.code==='BTEST' && c.body.t==='private-token' && c.body.consent===true),true);
});

test('withdrawing consent during verification prevents automatic checkout',async()=>{
  let posts=0,gets=0;
  const h=harness(async(url,options)=>options.method==='POST'?(posts++,response({ok:true,pending:true})):response({...pending,can_pay:++gets>1}));
  await h.flush();h.node('payment-agree').checked=true;h.node('payment-consent').events.submit({preventDefault(){}});await h.flush();
  h.node('payment-agree').checked=false;h.node('payment-agree').events.change();
  await h.poll();assert.equal(posts,1);assert.deepEqual(h.navigations,[]);assert.equal(h.node('payment-open').disabled,false);
});

test('an explicit unpaid cancellation waits for external time release instead of claiming completion',async()=>{
  let cancelled=false;const requests=[];
  const h=harness(async(url,options)=>{
    requests.push({url,body:options.body && JSON.parse(options.body)});
    if(url==='/api/booking/cancel'){cancelled=true;return response({ok:true,pending:true});}
    return response(cancelled?{...pending,status:'releasing',can_start_payment:false,can_cancel:false,sync:{state:'releasing'}}:pending);
  });
  await h.flush();h.node('booking-cancel').events.click();await h.flush();
  assert.equal(cancelled,true);assert.equal(h.node('payment-consent').hidden,true);assert.equal(h.node('booking-cancel').hidden,true);
  assert(h.node('payment-title').textContent.includes('처리하고 있습니다'));assert(!h.node('payment-title').textContent.includes('취소되었습니다'));
  const sent=requests.find(r=>r.url==='/api/booking/cancel').body;assert.deepEqual(sent,{code:'BTEST',t:'private-token'});
});

test('uncertain sync results hide payment, and errors never expose parser details',async()=>{
  const h=harness(async()=>response({...pending,status:'sync_review',can_pay:false,can_start_payment:false,can_cancel:false,sync:{state:'review'}}));
  await h.flush();assert.equal(h.node('payment-consent').hidden,true);assert.equal(h.node('booking-cancel').hidden,true);assert.equal([...h.timers.values()].some(t=>t.ms===2000),false);
  h.context.fetch=async()=>({ok:false,json:async()=>{throw new SyntaxError('Unexpected token INTERNAL');}});h.node('payment-reload').events.click();await h.flush();
  assert(!h.node('payment-message').textContent.includes('INTERNAL'));assert(h.node('payment-message').textContent.includes('추가 결제 없이'));
});

test('checkout refuses an unexpected payment origin even after the user submits',async()=>{
  const h=harness(async(url,options)=>options.method==='POST'?response({ok:true,url:'https://payapp.kr.evil.test/checkout'}):response({...pending,can_pay:true}));
  await h.flush();h.node('payment-agree').checked=true;h.node('payment-consent').events.submit({preventDefault(){}});await h.flush();
  assert.deepEqual(h.navigations,[]);assert.equal(h.node('payment-open').disabled,false);assert(h.node('payment-message').textContent.includes('결제 연결'));
});

test('verified payment waits for the final calendar check without offering another payment or cancellation',async()=>{
  let checks=0,posts=0;
  const h=harness(async(url,options)=>{
    if(options.method==='POST')posts++;
    return response(++checks===1?{...pending,status:'paid_verifying',booking:{...pending.booking,payment_status:'paid_verifying'},can_pay:false,can_start_payment:false,can_cancel:false,sync:{state:'blocked'}}:{...pending,status:'paid',booking:{...pending.booking,status:'confirmed'},can_pay:false,can_start_payment:false,can_cancel:false});
  });
  await h.flush();assert.equal(h.node('payment-consent').hidden,true);assert.equal(h.node('booking-cancel').hidden,true);
  assert(h.node('payment-title').textContent.includes('최종 일정을 확인'));assert(!h.node('payment-title').textContent.includes('예약이 확정되었습니다'));
  await h.poll();assert.equal(h.node('payment-title').textContent,'예약이 확정되었습니다');assert.equal(posts,0);assert.deepEqual(h.navigations,[]);
});
