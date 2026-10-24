import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function harness() {
  const html = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const nodes = new Map();
  const node = key => {
    if (nodes.has(key)) return nodes.get(key);
    const x = { innerHTML: '', textContent: '', value: '', hidden: true, checked: false, disabled: false, dataset: {},
      clientWidth: 1000, scrollWidth: 1000, classList: { add(){}, remove(){}, toggle(){} },
      addEventListener(){}, querySelector: s => select(s), querySelectorAll: () => [], getBoundingClientRect: () => ({width:720,left:0}), focus(){} };
    nodes.set(key,x);return x;
  };
  const select = key => {
    if (/^#[\w-]+$/.test(key) && !key.startsWith('#sc-sales-')) assert(ids.has(key.slice(1)), 'admin.html must contain '+key);
    return node(key);
  };
  const statuses=[node('status-1'),node('status-2')];
  const document={querySelector:select, querySelectorAll:s=>s==='[data-sc-status]'?statuses:[],addEventListener(){},body:node('body'),hidden:false};
  const window={SF_CONFIG:{pricing:{rooms:{r1:{max:30},r2:{max:40},r3:{max:15},r4:{max:50},r5:{max:30}}}},addEventListener(){},scrollTo(){}};
  let code=readFileSync(new URL('../js/admin.js',import.meta.url),'utf8');
  code=code.replace(/  api\("\/api\/admin\/session"\)\.then\(showApp\)\.catch\([^\n]+\);/,'');
  code=code.replace(/\}\)\(\);\s*$/, 'window.testHooks={resRow,renderExternalDetail,renderSpacecloudStatus,net,BD,drawDay,drawMonth,SL,drawSales};})();');
  vm.runInNewContext(code,{window,document,sessionStorage:{removeItem(){}},location:{hash:'',pathname:'/admin'},history:{replaceState(){}},
    setTimeout(){},clearTimeout(){},setInterval(){},navigator:{},console});
  return {hooks:window.testHooks,nodes,statuses};
}
const slot={external:true,code:'SC1-123',status:'confirmed',space:'r1',date:'2026-10-24',start_min:600,end_min:720,
 customer_name:'<img src=x onerror=alert(1)>',phone:'',people:null,purpose:'',channel:'spacecloud',amount:null,
 refund_amount:0,pay_method:'spacecloud',pay_status:'unknown',synced_at:Date.parse('2026-10-24T00:00:00Z'),source_url:'https://partner.spacecloud.kr/'};

test('external detail allows explicit revenue entry while preserving escaped and unknown amounts',()=>{
 const {hooks,nodes}=harness();const row=hooks.resRow(slot,{payBtn:true});
 assert(row.includes('금액 미제공'));assert(!row.includes('0원'));assert(!row.includes('data-pay-now'));
 assert(!row.includes('<img'));assert(row.includes('&lt;img'));
 hooks.renderExternalDetail(slot);const detail=nodes.get('#dt-body').innerHTML;
 assert(detail.includes('sc-sales-save'));assert(detail.includes('실제 결제금액'));assert(detail.includes('type="date"'));assert(!detail.includes('id="dt-edit"'));assert(!detail.includes('id="dt-cancel"'));assert(!detail.includes('id="dt-pay"'));assert(!detail.includes('<img'));
 assert.equal(hooks.net({...slot,amount:123456}),0);assert.equal(hooks.net({amount:100000,refund_amount:10000,pay_status:'paid'}),90000);
});
test('day and month views render the separate external color and unknown payment label',()=>{
 const {hooks,nodes}=harness();hooks.BD.date='2026-10-24';hooks.BD.items=[slot];hooks.drawDay();
 assert(nodes.get('#bd-day').innerHTML.includes('sc-external'));assert(nodes.get('#bd-day').innerHTML.includes('금액 미제공'));
 hooks.drawMonth();assert(nodes.get('#bd-month').innerHTML.includes('sc-external'));
});
test('source errors show stale-data warnings in every visible status line without exposing feed tokens',()=>{
 const {hooks,statuses}=harness();hooks.renderSpacecloudStatus({configured:true,rooms:[{space:'r1',count:1,updated_at:1,error:'offline',stale:true}]});
 assert(statuses.every(n=>n.textContent.includes('1번룸') && n.textContent.includes('offline')));assert(statuses.every(n=>n.textContent.includes('외부 일정은 매출 제외')));
});

test('channel detail uses total sales including website orders as denominator',()=>{
 const {hooks,nodes}=harness();
 hooks.SL.data={year:'2026',years:['2026'],basis:'use',methods:[],months:[],allTime:{total:160000,n:3},total:160000,n:3,refunds:0,unpaid:{amount:0,n:0},thisMonth:{ym:'2026-10',total:160000,n:3},lastMonth:{ym:'2026-09',total:0,n:0},byMethod:{orders:10000},bySpace:{},byChannel:{spacecloud:{label:'스페이스클라우드',amount:100000,n:1},naver:{label:'네이버',amount:50000,n:1},web:{label:'홈페이지',amount:10000,n:1}},channelTotal:160000,unrecordedSpacecloud:2};
 hooks.drawSales();const text=nodes.get('#sl-channel-details').innerHTML;
 assert(text.includes('62.5%'));assert(text.includes('31.3%'));assert(text.includes('6.3%'));assert(text.includes('160,000원'));assert(nodes.get('#sl-channel-note').textContent.includes('2건'));
});
