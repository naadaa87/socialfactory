import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function harness(handler){
  const html=readFileSync(new URL('../admin.html',import.meta.url),'utf8'),ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
  const nodes=new Map(),calls=[];let salesLoads=0;
  const $=s=>{assert(ids.has(s.slice(1)),s+' exists in markup');if(!nodes.has(s))nodes.set(s,{value:s==='#ts-filter'?'all':'',innerHTML:'',textContent:'',hidden:true,disabled:false,checked:false,files:[],events:{},focus(){},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(s);};
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const A={$,esc,num:n=>String(n),won:n=>String(n)+'원',guard:()=>false,LOAD:{sales(){salesLoads++;}},async api(path,opt){calls.push({path,body:opt?.body});return handler(opt?.body,path);}};
  const window={SF_ADMIN:A};vm.runInNewContext(readFileSync(new URL('../js/admin-toss-sales.js',import.meta.url),'utf8'),{window,Date,Set,Error,JSON,console});
  const submit=()=>$('#ts-history-form').events.submit({preventDefault(){}});
  const ready=(rows)=>({rows:rows.map(p=>({payment_id:p.id,paid_at:p.approvedAt,source_type:'CARD',amount:12000,refund_amount:0,result:'new',counted:true})),changed:rows.length});
  return {$,calls,A,submit,ready,get salesLoads(){return salesLoads;}};
}
const empty=()=>({apiReady:false,webhookReady:false,summary:{n:0,total:0},lastWebhook:null,rows:[],webhookUrl:'https://example.test/api/toss-place/webhook'});
const payment={id:'640000000000000001',merchantId:42,approvedAt:'2026-11-05T09:00:00+09:00'};

test('connection panel distinguishes configuration from actual receipt and wraps existing sales loader',async()=>{
  const f=harness(()=>empty());f.A.LOAD.sales();await new Promise(setImmediate);
  assert.equal(f.salesLoads,1);assert(f.$('#ts-status').textContent.includes('연결 필요'));assert(f.$('#ts-times').textContent.includes('아직 없음'));
  assert.equal(f.$('#ts-webhook-url').textContent,'https://example.test/api/toss-place/webhook');
});

test('fetches all pages for preview, commits only on explicit action, and reloading uses existing totals',async()=>{
  let commits=0;
  const f=harness(b=>{
    if(!b)return empty();
    if(b.action==='fetch')return {payments:b.page===1?[payment]:[{...payment,id:'2'}],nextPage:b.page===1?2:null};
    if(b.action==='preview')return f.ready(b.payments);
    if(b.action==='commit'){commits++;return f.ready(b.payments);}
  });
  await f.submit();assert.equal(commits,0);assert.equal(f.$('#ts-commit').hidden,false);assert(f.$('#ts-preview').innerHTML.includes(payment.id));
  await f.$('#ts-commit').events.click();assert.equal(commits,1);assert.equal(f.$('#ts-commit').hidden,true);assert(f.$('#ts-import-status').textContent.includes('반영 완료'));assert(f.salesLoads>0);
});

test('failed later page cannot commit a partial preview and selected dates invalidate old preview',async()=>{
  const f=harness(b=>{
    if(b.action==='fetch'){if(b.page===2)throw Error('조회 실패');return {payments:[payment],nextPage:2};}
  });
  await f.submit();assert.equal(f.$('#ts-commit').hidden,true);assert(f.$('#ts-import-status').textContent.includes('조회 실패'));assert(!f.calls.some(c=>c.body?.action==='commit'));
  f.$('#ts-from').events.change();assert.equal(f.$('#ts-preview').innerHTML,'');
});

test('blocked transactions prevent commit and untrusted provider text is escaped',async()=>{
  const f=harness(b=>{
    if(b.action==='fetch')return {payments:[payment],nextPage:null};
    return {rows:[{payment_id:payment.id,paid_at:'<img onerror=x>',source_type:'CARD',amount:12000,refund_amount:0,result:'blocked',reason:'<script>x</script>'}]};
  });
  await f.submit();assert.equal(f.$('#ts-commit').hidden,true);assert(!f.$('#ts-preview').innerHTML.includes('<script>'));assert(f.$('#ts-preview').innerHTML.includes('&lt;script&gt;'));
});

const ledgerRow=(id,state='included',extra={})=>({payment_id:id,paid_at:'2026-11-05 10:00:00',source_type:'CARD',amount:12000,refund_amount:0,disposition:state,...extra});
const tick=()=>new Promise(setImmediate);
const editLabel=(f,id)=>f.$('#ts-recent').events.click({target:{closest:selector=>selector==='[data-ts-label-id]'?{dataset:{tsLabelId:id}}:null}});
test('manual name and memo can be edited or cleared without changing revenue decisions; original labels and escaped text remain visible',async()=>{
  let row=ledgerRow('1','exclude',{product_items:[{title:'금액 입력',quantity:1}],manual_product_name:'',manual_memo:''});
  const f=harness(b=>{if(!b)return {...empty(),rows:[row]};assert.equal(b.action,'label');row={...row,manual_product_name:b.productName,manual_memo:b.memo};return {ok:true};});
  f.A.LOAD.sales();await tick();editLabel(f,'1');
  assert.equal(f.$('#ts-label-form').hidden,false);assert(f.$('#ts-label-original').innerHTML.includes('금액 입력'));assert(f.$('#ts-label-reference').textContent.includes('12000원'));
  f.$('#ts-label-name').value=' 메가스팟 <script>x</script> ';f.$('#ts-label-memo').value='주차 <img>\n2시간';
  await f.$('#ts-label-form').events.submit({preventDefault(){}});
  assert.equal(f.calls.find(c=>c.body?.action==='label').body.paymentId,'1');
  const html=f.$('#ts-recent').innerHTML;assert(html.includes('직접 입력'));assert(html.includes('금액 입력'));assert(html.includes('토스 원본 상품정보'));
  assert(html.includes('&lt;script&gt;'));assert(html.includes('&lt;img&gt;'));assert(!html.includes('<script>'));assert(html.includes('다시 합산'));
  assert.equal(f.salesLoads,1);assert.equal(f.$('#ts-label-form').hidden,true);
  editLabel(f,'1');assert.equal(f.$('#ts-label-name').value,'메가스팟 <script>x</script>');
  f.$('#ts-label-name').value='';f.$('#ts-label-memo').value='';await f.$('#ts-label-form').events.submit({preventDefault(){}});
  assert(!f.$('#ts-recent').innerHTML.includes('직접 입력'));assert(f.$('#ts-recent').innerHTML.includes('금액 입력'));
  assert(!f.calls.some(c=>['commit','review'].includes(c.body?.action)));
});

test('failed label save keeps edits available and cancel or ledger reload discards unsaved edits',async()=>{
  const f=harness(b=>{if(!b)return {...empty(),rows:[ledgerRow('1')]};throw Error('저장 실패');});
  f.A.LOAD.sales();await tick();editLabel(f,'1');f.$('#ts-label-memo').value='구분 메모';
  await f.$('#ts-label-form').events.submit({preventDefault(){}});assert.equal(f.$('#ts-label-form').hidden,false);assert.equal(f.$('#ts-label-memo').value,'구분 메모');assert.match(f.$('#ts-label-status').textContent,/저장 실패/);
  f.$('#ts-label-cancel').events.click();assert.equal(f.$('#ts-label-form').hidden,true);
  editLabel(f,'1');assert.equal(f.$('#ts-label-memo').value,'');f.$('#ts-refresh').events.click();await tick();assert.equal(f.$('#ts-label-form').hidden,true);
  const saves=f.calls.filter(c=>c.body).length;await f.$('#ts-label-form').events.submit({preventDefault(){}});assert.equal(f.calls.filter(c=>c.body).length,saves);
});
test('users can select multiple ordinary sales, choose parking exclusion and save one reviewed batch',async()=>{
  let rows=[ledgerRow('1'),ledgerRow('2','exclude'),ledgerRow('3','review'),ledgerRow('4','duplicate'),ledgerRow('5','review',{source_type:'EXTERNAL'})];
  const f=harness(b=>{if(!b)return {...empty(),rows};if(b.action==='review'){rows=rows.map(r=>b.paymentIds.includes(r.payment_id)?{...r,disposition:'exclude',review_note:b.note}:r);return {ok:true};}});
  f.A.LOAD.sales();await tick();
  assert(f.$('#ts-recent').innerHTML.includes('매출에서 제외'));assert(f.$('#ts-recent').innerHTML.includes('다시 합산'));
  assert(!f.$('#ts-recent').innerHTML.includes('data-ts-select="4"'));assert(!f.$('#ts-recent').innerHTML.includes('data-ts-select="5"'));
  f.$('#ts-select-all').checked=true;f.$('#ts-select-all').events.change.call(f.$('#ts-select-all'));
  assert(f.$('#ts-selection').textContent.includes('3건'));assert.equal(f.$('#ts-exclude-selected').disabled,false);
  f.$('#ts-exclude-selected').events.click();assert.equal(f.$('#ts-review-form').hidden,false);
  f.$('#ts-reason').value='주차 결제';f.$('#ts-review-note').value='메가스팟 방문 차량';
  await f.$('#ts-review-form').events.submit({preventDefault(){}});
  const saved=f.calls.find(c=>c.body?.action==='review').body;
  assert.deepEqual(Array.from(saved.paymentIds),['1','3']);assert.equal(saved.decision,'exclude');assert.match(saved.note,/주차 결제.*메가스팟/);
  assert(f.$('#ts-review-status').textContent.includes('2건'));assert.equal(f.$('#ts-review-form').hidden,true);assert.equal(f.$('#ts-select-all').checked,false);
  assert(f.salesLoads>1);
});

test('exclusion requires a reason and failed saves keep the review open; an excluded row can be restored',async()=>{
  let fail=true;
  const f=harness(b=>{if(!b)return {...empty(),rows:[ledgerRow('1')]};if(fail)throw Error('저장 실패');return {ok:true};});
  f.A.LOAD.sales();await tick();
  const click=decision=>f.$('#ts-recent').events.click({target:{closest:()=>({dataset:{tsId:'1',tsDecision:decision}})}});
  click('exclude');f.$('#ts-reason').value='기타';f.$('#ts-review-note').value='짧';
  await f.$('#ts-review-form').events.submit({preventDefault(){}});assert(!f.calls.some(c=>c.body?.action==='review'));
  f.$('#ts-review-note').value='다른 매장 결제';await f.$('#ts-review-form').events.submit({preventDefault(){}});
  assert.equal(f.$('#ts-review-form').hidden,false);assert.match(f.$('#ts-review-status').textContent,/저장 실패/);
  fail=false;f.$('#ts-review-cancel').events.click();
  // Refresh to the excluded state before using its restore action.
  f.A.api=async(path,opt)=>{f.calls.push({path,body:opt?.body});return opt?{ok:true}:{...empty(),rows:[ledgerRow('1','exclude')]};};
  f.A.LOAD.sales();await tick();click('include');assert.equal(f.$('#ts-reason').required,false);
  await f.$('#ts-review-form').events.submit({preventDefault(){}});
  assert.equal(f.calls.at(-2).body.decision,'include');assert.equal(f.$('#ts-review-form').hidden,true);
});

test('changing ledger filter clears selection and late responses cannot replace the requested page',async()=>{
  let release;
  const f=harness((b,path)=>{
    if(path.includes('filter=exclude'))return {...empty(),rows:[ledgerRow('9','exclude')],total:1};
    return new Promise(r=>{release=r;});
  });
  f.A.LOAD.sales();f.$('#ts-filter').value='exclude';f.$('#ts-filter').events.change();await tick();
  assert(f.$('#ts-recent').innerHTML.includes('data-ts-id="9"'));
  release({...empty(),rows:[ledgerRow('1')],total:51});await tick();
  assert(!f.$('#ts-recent').innerHTML.includes('data-ts-id="1"'));assert(f.$('#ts-page').textContent.includes('1 / 1'));
});

test('product labels, variants and quantities are escaped and missing product names stay explicit',async()=>{
  const f=harness(()=>({...empty(),rows:[ledgerRow('1','included',{product_items:[{title:'메가스팟 <img onerror=x>',variant:'<script>1호</script>',quantity:2,options:['주차권'],category:'대관'}]}),ledgerRow('2','included',{product_items:[]}),ledgerRow('3')]}));
  f.A.LOAD.sales();await tick();const html=f.$('#ts-recent').innerHTML;
  assert(html.includes('상품명 · 수량'));assert(html.includes('메가스팟 &lt;img'));assert(!html.includes('<script>'));assert(html.includes('× 2'));assert(html.includes('주차권'));
  assert(html.includes('상품명 없음'));assert(html.includes('상품정보 미조회'));
});

test('product refresh follows every cursor and refreshes labels without committing or reviewing payments',async()=>{
  const f=harness(b=>{
    if(!b)return {...empty(),rows:[ledgerRow('1','exclude',{product_items:[{title:'주차권',quantity:1}]})]};
    assert.equal(b.action,'refresh-products');return b.after?{processed:1,updated:1,missing:0,nextCursor:null}:{processed:25,updated:25,missing:0,nextCursor:'25'};
  });
  await f.$('#ts-products-refresh').events.click();
  assert.deepEqual(f.calls.filter(c=>c.body).map(c=>c.body.after),['','25']);assert(f.$('#ts-product-status').textContent.includes('26건'));
  assert(f.$('#ts-recent').innerHTML.includes('주차권'));assert(f.$('#ts-recent').innerHTML.includes('다시 합산'));
  assert(!f.calls.some(c=>['commit','review'].includes(c.body?.action)));
});
