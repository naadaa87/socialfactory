import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function harness(handler){
  const html=readFileSync(new URL('../admin.html',import.meta.url),'utf8'),ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
  const nodes=new Map(),calls=[];let salesLoads=0;
  const $=s=>{assert(ids.has(s.slice(1)),s+' exists in markup');if(!nodes.has(s))nodes.set(s,{value:'',innerHTML:'',textContent:'',hidden:true,disabled:false,files:[],events:{},addEventListener(type,fn){this.events[type]=fn;}});return nodes.get(s);};
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const A={$,esc,num:n=>String(n),won:n=>String(n)+'원',guard:()=>false,LOAD:{sales(){salesLoads++;}},async api(path,opt){calls.push({path,body:opt?.body});return handler(opt?.body);}};
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
