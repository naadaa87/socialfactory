import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const row=(extra={})=>({mul_no:'119000001',product_name:'공간대여',amount:15000,refund_amount:0,paid_at:'2026-11-03 10:30:39',state:'paid',method:'payapp:1',disposition:'review',...extra});
const response=rows=>({rows,total:rows.length,pageSize:50,configured:true,lastWebhook:null,webhookUrl:'https://example.test/api/pay/payapp/sales-feedback'});
const tick=()=>new Promise(setImmediate);
function fixture(handler){
 const ids=new Set([...readFileSync(new URL('../admin.html',import.meta.url),'utf8').matchAll(/id="([^"]+)"/g)].map(m=>m[1])),nodes=new Map(),calls=[];let prior=0;
 const $=s=>{assert(ids.has(s.slice(1)));if(!nodes.has(s))nodes.set(s,{value:s==='#pa-filter'?'all':'',textContent:'',innerHTML:'',hidden:true,disabled:false,events:{},focus(){},addEventListener(k,fn){this.events[k]=fn;}});return nodes.get(s);};
 const A={$,esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),num:String,won:n=>n+'원',guard:()=>false,LOAD:{sales(){prior++;}},async api(path,opt){calls.push({path,body:opt?.body});return handler(opt?.body,path);}};
 vm.runInNewContext(readFileSync(new URL('../js/admin-payapp-sales.js',import.meta.url),'utf8'),{window:{SF_ADMIN:A},Set,JSON});
 return {$,A,calls,get prior(){return prior;},click(id,decision){$('#pa-rows').events.click({target:{closest:()=>({dataset:{paId:id,paDecision:decision}})}});}};
}
test('PayApp panel filters requests, escapes labels, and keeps website payment controls read-only',async()=>{
 const f=fixture(()=>response([row({product_name:'<script>title</script>'}),row({mul_no:'2',disposition:'website'})]));f.A.LOAD.sales();await tick();
 assert.equal(f.prior,1);assert(f.$('#pa-rows').innerHTML.includes('&lt;script&gt;'));assert(!f.$('#pa-rows').innerHTML.includes('data-pa-id="2"'));
 f.$('#pa-filter').value='exclude';f.$('#pa-filter').events.change();await tick();assert.equal(f.calls.at(-1).path,'/api/admin/payapp-sales?page=1&filter=exclude');
 assert(f.$('#pa-status').textContent.includes('아직 없음'));assert(!f.calls.some(c=>c.body));
});
test('review preserves edits on failure and stores explicit reservation duplicate decisions without issuing orders',async()=>{
 let fail=true;const f=fixture(b=>{if(!b)return response([row()]);if(fail)throw Error('저장 실패');return {ok:true};});
 f.A.LOAD.sales();await tick();f.click('119000001','duplicate');f.$('#pa-note').value='기존 예약에 포함';
 await f.$('#pa-review-form').events.submit({preventDefault(){}});assert.equal(f.$('#pa-review-form').hidden,false);assert.equal(f.$('#pa-note').value,'기존 예약에 포함');assert.match(f.$('#pa-review-status').textContent,/저장 실패/);
 fail=false;await f.$('#pa-review-form').events.submit({preventDefault(){}});assert.equal(f.$('#pa-review-form').hidden,true);assert.equal(f.calls.find(c=>c.body).body.decision,'duplicate');assert(f.prior>1);
 assert(f.calls.every(c=>!c.body||c.body.action==='review'));
});
test('history import validates JSON and refreshes saved data without automatically including direct sales',async()=>{
 const f=fixture(b=>b?{ok:true,changed:1}:response([row()]));f.$('#pa-json').value='invalid';await f.$('#pa-import-form').events.submit({preventDefault(){}});assert(!f.calls.length);
 f.$('#pa-json').value=JSON.stringify([row()]);await f.$('#pa-import-form').events.submit({preventDefault(){}});
 assert.equal(f.calls.find(c=>c.body).body.action,'import');assert(!f.calls.some(c=>c.body?.action==='review'));assert.equal(f.$('#pa-json').value,'');assert(f.$('#pa-review-status').textContent.includes('확인 후 합산'));
});
