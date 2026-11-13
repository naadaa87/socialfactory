import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function harness(fetchImpl) {
  const html = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const nodes = new Map(), intervals=[], timers=new Map();let timerId=0;
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
  code=code.replace(/\}\)\(\);\s*$/, 'window.testHooks={resRow,renderExternalDetail,renderSpacecloudStatus,net,BD,loadBoard,drawDay,drawMonth,SL,drawSales,pollScheduleUpdates,setPollView:view=>{CUR=view;app.hidden=false;}};})();');
  vm.runInNewContext(code,{window,document,sessionStorage:{removeItem(){}},location:{hash:'',pathname:'/admin'},history:{replaceState(){}},
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},setInterval(fn,ms){intervals.push({fn,ms});},navigator:{},console,fetch:fetchImpl,AbortController});
  return {hooks:window.testHooks,nodes,statuses,intervals,document,timers};
}
const slot={external:true,code:'SC1-123',status:'confirmed',space:'r1',date:'2026-10-24',start_min:600,end_min:720,
 customer_name:'<img src=x onerror=alert(1)>',phone:'',people:null,purpose:'',channel:'spacecloud',amount:null,
 refund_amount:0,pay_method:'spacecloud',pay_status:'unknown',synced_at:Date.parse('2026-10-24T00:00:00Z'),source_url:'https://partner.spacecloud.kr/'};

test('unknown external detail retains manual fallback and escapes untrusted titles',()=>{
 const {hooks,nodes}=harness();const row=hooks.resRow(slot,{payBtn:true});
 assert(row.includes('금액 확인 필요'));assert(!row.includes('0원'));assert(!row.includes('data-pay-now'));
 assert(!row.includes('<img'));assert(row.includes('&lt;img'));
 hooks.renderExternalDetail(slot);const detail=nodes.get('#dt-body').innerHTML;
 assert(detail.includes('sc-sales-save'));assert(detail.includes('실제 결제금액'));assert(detail.includes('type="date"'));assert(!detail.includes('id="dt-edit"'));assert(!detail.includes('id="dt-cancel"'));assert(!detail.includes('id="dt-pay"'));assert(!detail.includes('<img'));
 assert.equal(hooks.net({...slot,amount:123456}),0);assert.equal(hooks.net({amount:100000,refund_amount:10000,pay_status:'paid'}),90000);
});
test('matched external detail shows gross, refund and net but no duplicate registration button',()=>{
 const {hooks,nodes}=harness();const matched={...slot,payment:{reservation_id:'123',amount:40000,refund_amount:10000,paid_at:'2026-10-20',use_date:'2026-10-24',end_date:'2026-10-24'}};
 assert(hooks.resRow(matched).includes('40,000원'));
 hooks.renderExternalDetail(matched);const detail=nodes.get('#dt-body').innerHTML;
 assert(detail.includes('40,000원'));assert(detail.includes('10,000원'));assert(detail.includes('30,000원'));
 assert(detail.includes('2026-10-20'));assert(!detail.includes('sc-sales-save'));assert.equal(hooks.net(matched),0);
});
test('day and month views render the separate external color and unknown payment label',()=>{
 const {hooks,nodes}=harness();hooks.BD.date='2026-10-24';hooks.BD.items=[slot];hooks.drawDay();
 assert(nodes.get('#bd-day').innerHTML.includes('sc-external'));assert(nodes.get('#bd-day').innerHTML.includes('금액 확인 필요'));
 hooks.drawMonth();assert(nodes.get('#bd-month').innerHTML.includes('sc-external'));
});
test('rapid month navigation aborts the old request and ignores its late result', async () => {
 const requests=[];
 const {hooks,nodes}=harness((url,opt)=>new Promise(resolve=>requests.push({url,opt,resolve})));
 hooks.BD.mode='month'; hooks.BD.date='2026-10-01'; hooks.loadBoard();
 assert.equal(requests.length,1);
 hooks.BD.date='2026-11-01'; hooks.loadBoard();
 assert.equal(requests.length,2);
 assert.equal(requests[0].opt.signal.aborted,true);
 assert(nodes.get('#bd-month').innerHTML.includes('불러오는 중'));
 const response=results=>({ok:true,json:async()=>({ok:true,results,spacecloud:{configured:false,rooms:[]}})});
 requests[1].resolve(response([])); await new Promise(setImmediate);
 assert(nodes.get('#bd-sum-title').textContent.includes('11월'));
 requests[0].resolve(response([slot])); await new Promise(setImmediate);
 assert(nodes.get('#bd-sum-title').textContent.includes('11월'));
 assert.equal(hooks.BD.items.length,0);
});
test('polling and focus share a slow initial month request without cancelling it',async()=>{
 const requests=[];
 const h=harness((url,opt)=>{
  if(url.includes('version=1'))return Promise.resolve({ok:true,json:async()=>({ok:true,calendar:{last_success:1,status:'success'}})});
  return new Promise(resolve=>requests.push({opt,resolve}));
 });
 h.hooks.setPollView('board');h.hooks.BD.mode='month';h.hooks.BD.date='2026-11-13';
 const initial=h.hooks.loadBoard();
 const polled=h.hooks.pollScheduleUpdates(true);await new Promise(setImmediate);
 assert.equal(requests.length,1);assert.equal(requests[0].opt.signal.aborted,false);
 h.hooks.BD.date='2026-11-01';assert.equal(h.hooks.loadBoard(),initial);
 requests[0].resolve({ok:true,json:async()=>({ok:true,results:[{...slot,date:'2026-11-13'}]})});
 await Promise.all([initial,polled]);
 assert(h.nodes.get('#bd-month').innerHTML.includes('data-day="2026-11-13"'));
 assert(!h.nodes.get('#bd-month').innerHTML.includes('불러오는 중'));
 assert.equal(h.hooks.BD.pending,null);assert.equal(h.timers.size,0);
});
test('a hung monthly request times out with a retry and late data cannot replace a retry',async()=>{
 const requests=[];const h=harness((url,opt)=>new Promise(resolve=>requests.push({opt,resolve})));
 h.hooks.BD.mode='month';h.hooks.BD.date='2026-11-01';
 const initial=h.hooks.loadBoard();[...h.timers.values()].find(t=>t.ms===25000).fn();await initial;
 assert(requests[0].opt.signal.aborted);assert(h.nodes.get('#bd-month').innerHTML.includes('다시 불러오기'));
 assert(!h.nodes.get('#bd-month').innerHTML.includes('불러오는 중'));assert.equal(h.hooks.BD.pending,null);
 const retry=h.hooks.loadBoard();requests[1].resolve({ok:true,json:async()=>({ok:true,results:[]})});await retry;
 requests[0].resolve({ok:true,json:async()=>({ok:true,results:[slot]})});await new Promise(setImmediate);
 assert.equal(h.hooks.BD.items.length,0);assert(h.nodes.get('#bd-month').innerHTML.includes('data-day="2026-11-30"'));
});
test('background timeout keeps the already displayed month available',async()=>{
 let hung=false;const h=harness(()=>hung?new Promise(()=>{}):Promise.resolve({ok:true,json:async()=>({ok:true,results:[]})}));
 h.hooks.BD.mode='month';h.hooks.BD.date='2026-11-01';await h.hooks.loadBoard();
 const calendar=h.nodes.get('#bd-month').innerHTML;hung=true;
 const refresh=h.hooks.loadBoard();[...h.timers.values()].find(t=>t.ms===25000).fn();await refresh;
 assert.equal(h.nodes.get('#bd-month').innerHTML,calendar);assert.equal(h.hooks.BD.pending,null);
});
test('source errors show stale-data warnings in every visible status line without exposing feed tokens',()=>{
 const {hooks,statuses}=harness();hooks.renderSpacecloudStatus({configured:true,rooms:[{space:'r1',count:1,updated_at:1,error:'offline',stale:true}]});
 assert(statuses.every(n=>n.textContent.includes('1번룸') && n.textContent.includes('offline')));assert(statuses.every(n=>n.textContent.includes('자동 수집 금액은 매출 화면에서 한 번만 집계')));
});

test('channel detail uses total sales including website orders as denominator',()=>{
 const {hooks,nodes}=harness();
 hooks.SL.data={year:'2026',years:['2026'],basis:'use',methods:[],months:[],allTime:{total:160000,n:3},total:160000,n:3,refunds:0,unpaid:{amount:0,n:0},thisMonth:{ym:'2026-10',total:160000,n:3},lastMonth:{ym:'2026-09',total:0,n:0},byMethod:{orders:10000},bySpace:{},byChannel:{spacecloud:{label:'스페이스클라우드',amount:100000,n:1},naver:{label:'네이버',amount:50000,n:1},web:{label:'홈페이지',amount:10000,n:1}},channelTotal:160000,unrecordedSpacecloud:2};
 hooks.drawSales();const text=nodes.get('#sl-channel-details').innerHTML;
 assert(text.includes('62.5%'));assert(text.includes('31.3%'));assert(text.includes('6.3%'));assert(text.includes('160,000원'));assert(nodes.get('#sl-channel-note').textContent.includes('2건'));
});

test('five-second checks refresh only changed schedules and never duplicate an in-flight request',async()=>{
 const calls=[];let release,version=1;
 const h=harness((url)=>{
  calls.push(url);
  if(url.includes('version=1'))return new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({ok:true,calendar:{last_success:version,status:'success'}})});});
  return Promise.resolve({ok:true,json:async()=>({ok:true,results:[],spacecloud:{configured:false,rooms:[]}})});
 });
 h.hooks.setPollView('board');h.hooks.BD.date='2026-11-13';
 assert(h.intervals.some(i=>i.ms===5000));
 const first=h.hooks.pollScheduleUpdates(false);h.hooks.pollScheduleUpdates(false);
 assert.equal(calls.length,1);release();await first;
 assert.equal(calls.filter(u=>u.includes('/reservations?')).length,1);
 const same=h.hooks.pollScheduleUpdates(false);release();await same;
 assert.equal(calls.filter(u=>u.includes('/reservations?')).length,1);
 version=2;const changed=h.hooks.pollScheduleUpdates(false);release();await changed;
 assert.equal(calls.filter(u=>u.includes('/reservations?')).length,2);
 h.document.hidden=true;const count=calls.length;h.hooks.pollScheduleUpdates(false);assert.equal(calls.length,count);
 h.document.hidden=false;const focused=h.hooks.pollScheduleUpdates(true);release();await focused;
 assert.equal(calls.filter(u=>u.includes('/reservations?')).length,3);
});
test('a hung source-version check releases the polling lock after timeout',async()=>{
 let calls=0;const h=harness(()=>{calls++;return new Promise(()=>{});});
 h.hooks.setPollView('board');
 const check=h.hooks.pollScheduleUpdates(false);
 [...h.timers.values()].find(t=>t.ms===20000).fn();await check;
 h.hooks.pollScheduleUpdates(false);assert.equal(calls,2);
});
