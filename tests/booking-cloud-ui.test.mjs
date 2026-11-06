import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const code = readFileSync(new URL('../js/booking.js', import.meta.url), 'utf8');
const pricing = {rooms:{r1:{max:36,wdEarly:15000,wdStd:20000,hdEarly:20000,hdStd:30000},r3:{max:16,wdEarly:10000,wdStd:15000,hdEarly:15000,hdStd:20000}}, holidays:['2026-12-25']};
function harness(fetcher = async () => ({ok:true,status:200,json:async()=>({ok:true,blocked:[]})}),search='',clock) {
  const nodes = new Map();
  function node(key='') {
    if(nodes.has(key)) return nodes.get(key);
    const x={value:'',checked:false,hidden:false,disabled:false,required:false,textContent:'',options:[],children:[],events:{},attributes:{},max:'16',
      addEventListener(type,fn){this.events[type]=fn;},dispatchEvent(event){return this.events[event.type]?.(event);},click(){if(!this.disabled)this.events.click?.();},setAttribute(k,v){this.attributes[k]=v;},appendChild(el){this.children.push(el);if(key==='start_min'||key==='end_min')this.options.push(el);},focus(){this.focused=true;},scrollIntoView(){},
      get selectedOptions(){return this.options.filter(o=>o.value===String(this.value));},
      set innerHTML(v){this._html=v;this.children=[];this.options=[];this.value='';},get innerHTML(){return this._html||'';}};
    Object.defineProperty(x,'value',{get(){return this._value||'';},set(v){this._value=String(v);},configurable:true});
    nodes.set(key,x);return x;
  }
  const keys=['date','start_min','end_min','people','name','phone','email','company','purpose','purpose_detail','requests','consent','conditions','website'];
  const fields=Object.fromEntries(keys.map(key=>[key,node(key)]));
  fields.purpose.options=['','meeting','education','seminar','study','workshop','shooting','other'].map(value=>({value}));
  fields.purpose_detail.maxLength=200;fields.requests.maxLength=1000;
  fields.people.value='1';fields.start_min.selectedOptions;
  const radios=['r1','r2','r3','r4','r5'].map(key=>({...node('radio-'+key),value:key,checked:key==='r3'}));
  const form=node('form');form.elements=fields;form.reportValidity=()=>true;
  form.querySelector=s=>s==='[name=room]:checked'?radios.find(r=>r.checked):radios.find(r=>s.includes('value="'+r.value+'"'));
  const root={querySelector:s=>s==='[data-booking-form]'?form:node(s),querySelectorAll:s=>s==='[name=room]'?radios:[]};
  node('[data-booking-success]').hidden=true;
  const document={querySelector:()=>root,createElement:tag=>{const x=node(Symbol(tag));x.value='';return x;}};
  let n=0;
  const window={SF_CONFIG:{pricing},SF_BOOKING_RATES:pricing,location:{search},crypto:{randomUUID:()=>`test-request-${++n}`}};
  const instrumented=code.replace(/\}\)\(\);\s*$/, 'window.hooks={quote,overlaps,dateIsReal,hm,dateTime,loadAvailability,selectedMinutes,availability,submitEvent:form.events};})();');
  const ClockDate=clock===undefined?Date:class extends Date {constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
  vm.runInNewContext(instrumented,{window,document,fetch:fetcher,AbortController,URLSearchParams,Date:ClockDate,Event,console,setTimeout,clearTimeout});
  return {hooks:window.hooks,fields,nodes,form,radios};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('pricing URL fills an available overnight interval once, preserves excess people, and never submits or accepts a URL amount',async()=>{
  const calls=[];
  const h=harness(async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({ok:true,blocked:[],step_minutes:60})};},'?room=r3&date=2099-11-06&start_min=1380&end_min=1560&people=99&purpose=other&purpose_detail=%3Cb%3Etest%3C%2Fb%3E&requests='+encodeURIComponent('x'.repeat(1100))+'&amount=1&consent=true');
  await flush();assert.equal(h.fields.start_min.value,'1380');assert.equal(h.fields.end_min.value,'1560');assert.equal(h.fields.people.value,'99');
  assert.equal(h.nodes.get('[data-start-time-grid]').children.find(button=>button.value==='1380').attributes['aria-pressed'],'true');
  assert.equal(h.fields.purpose.value,'other');assert.equal(h.fields.purpose_detail.required,true);assert.equal(h.fields.purpose_detail.value,'<b>test</b>');assert.equal(h.fields.requests.value.length,1000);
  assert.equal(h.fields.consent.checked,false);assert.equal(h.nodes.get('[data-submit]').disabled,true);assert(h.nodes.get('[data-schedule-error]').textContent.includes('최대 16명'));
  assert.notEqual(h.nodes.get('[data-summary-amount]').textContent,'1원');assert(calls.every(call=>!call.options?.method));
  h.fields.start_min.value='600';h.fields.start_min.events.change();h.fields.end_min.value='720';await h.hooks.loadAvailability();
  assert.equal(h.fields.start_min.value,'600');assert.equal(h.fields.end_min.value,'720','initial interval must not overwrite later choices');
});

test('blocked, incomplete, short or invalid-step URL intervals clear both times without substituting a two-hour booking',async()=>{
  for(const query of ['start_min=600&end_min=840','start_min=600','start_min=600&end_min=660','start_min=630&end_min=750','start_min=NaN&end_min=720']){
    const h=harness(async()=>({ok:true,json:async()=>({ok:true,blocked:[{start_min:780,end_min:840}],step_minutes:60})}),'?room=r3&date=2099-11-06&'+query);
    await flush();assert.equal(h.fields.start_min.value,'',query);assert.equal(h.fields.end_min.value,'',query);assert(h.nodes.get('[data-schedule-error]').textContent.includes('다시 선택'),query);assert.equal(h.nodes.get('[data-submit]').disabled,true);
    assert(h.nodes.get('[data-start-time-grid]').children.every(button=>button.attributes['aria-pressed']==='false'));
  }
});

test('changing the date during the first availability request permanently discards URL time preferences',async()=>{
  const pending=[];
  const h=harness(()=>new Promise(resolve=>pending.push(resolve)),'?room=r3&date=2099-11-06&start_min=600&end_min=720');
  h.fields.date.value='2099-11-07';h.fields.date.events.change();
  pending[1]({ok:true,json:async()=>({ok:true,blocked:[],step_minutes:60})});await flush();
  pending[0]({ok:true,json:async()=>({ok:true,blocked:[],step_minutes:60})});await flush();
  assert.equal(h.fields.start_min.value,'');assert.equal(h.fields.end_min.value,'');
  h.fields.date.value='2099-11-06';const back=h.hooks.loadAvailability();pending[2]({ok:true,json:async()=>({ok:true,blocked:[],step_minutes:60})});await back;
  assert.equal(h.fields.start_min.value,'');assert.equal(h.fields.end_min.value,'');
});

test('30-minute pricing handles midnight, weekend overnight rules, and holiday boundaries',()=>{
  const {hooks}=harness();
  assert.equal(hooks.quote(pricing,'r3','2026-11-06',690,750),12500,'11:30 crosses from morning to afternoon');
  assert.equal(hooks.quote(pricing,'r3','2026-11-06',1410,1470),12500,'Friday 23:30 to Saturday 00:30 uses weekday midnight');
  assert.equal(hooks.quote(pricing,'r3','2026-11-07',1410,1470),17500,'Saturday night and Sunday morning both use holiday rates');
  assert.equal(hooks.quote(pricing,'r3','2026-12-25',720,840),40000,'configured holiday uses holiday afternoon');
  assert.equal(hooks.quote(pricing,'r3','2026-02-30',600,720),null);
  assert.equal(hooks.dateTime('2026-11-06',1500),'2026.11.07 01:00');
});

test('overlap blocks overnight conflicts but permits adjacent boundaries',()=>{
  const {hooks}=harness();
  assert.equal(hooks.overlaps(1380,1500,[{start_min:1470,end_min:1560}]),true);
  assert.equal(hooks.overlaps(0,120,[{start_min:-30,end_min:30}]),true);
  assert.equal(hooks.overlaps(600,720,[{start_min:720,end_min:840}]),false);
  assert.equal(hooks.overlaps(720,840,[{start_min:600,end_min:720}]),false);
});

test('a slow prior availability response cannot replace the newly selected date',async()=>{
  const pending=[];
  const h=harness(()=>new Promise(resolve=>pending.push(resolve)));
  h.fields.date.value='2099-11-06';const first=h.hooks.loadAvailability();
  h.fields.date.value='2099-11-07';const second=h.hooks.loadAvailability();
  pending[1]({ok:true,json:async()=>({ok:true,blocked:[{start_min:600,end_min:720}],message:'new date'})});await second;
  pending[0]({ok:true,json:async()=>({ok:true,blocked:[{start_min:100,end_min:200}],message:'old date'})});await first;
  assert.equal(h.hooks.availability.blocked[0].start_min,600);
  assert.equal(h.nodes.get('[data-availability-message]').textContent,'new date');
});

test('availability failure keeps submission disabled and shows a retry action',async()=>{
  const h=harness(async()=>{throw new Error('network offline');});
  h.fields.date.value='2099-11-06';await h.hooks.loadAvailability();
  assert.equal(h.nodes.get('[data-submit]').disabled,true);
  assert.equal(h.nodes.get('[data-retry-availability]').hidden,false);
  assert.equal(h.nodes.get('[data-booking-success]').hidden,true,'success is never opened by failure');
  assert.equal(h.form.hidden,false);
});

test('automatic synchronization offers whole-hour times and keeps half-hour conflicts blocked',async()=>{
  const h=harness(async()=>({ok:true,status:200,json:async()=>({ok:true,step_minutes:60,blocked:[{start_min:630,end_min:690}]})}));
  h.fields.date.value='2099-11-06';await h.hooks.loadAvailability();
  const times=h.fields.start_min.options.filter(o=>o.value!=='');
  assert.equal(times.length,24);assert(times.every(o=>Number(o.value)%60===0));
  assert.equal(times.find(o=>o.value==='600').disabled,true,'an upstream half-hour event still blocks overlapping whole-hour requests');
  h.fields.start_min.value='720';h.fields.start_min.events.change();
  assert(h.fields.end_min.options.filter(o=>o.value!=='').every(o=>Number(o.value)%60===0));
  assert(h.nodes.get('[data-time-step]').textContent.includes('1시간 단위'));
});

test('the visible time grid disables occupied and too-short starts and synchronizes both controls and summary',async()=>{
  const h=harness(async()=>({ok:true,json:async()=>({ok:true,blocked:[{start_min:600,end_min:720}],step_minutes:60})}));
  h.fields.date.value='2099-11-06';await h.hooks.loadAvailability();
  const buttons=h.nodes.get('[data-start-time-grid]').children,at=minute=>buttons.find(button=>button.value===String(minute)),status=minute=>at(minute).children[1].textContent;
  assert.equal(buttons.length,24);assert(buttons.every(button=>button.type==='button'));
  assert.equal(at(600).disabled,true);assert.equal(status(600),'예약 마감');assert.equal(at(660).disabled,true);
  assert.equal(at(540).disabled,true);assert.equal(status(540),'2시간 확보 불가');assert.equal(at(480).disabled,false);
  at(600).click();assert.equal(h.fields.start_min.value,'');
  at(480).click();assert.equal(h.fields.start_min.value,'480');assert.equal(h.fields.end_min.value,'600');assert.equal(at(480).attributes['aria-pressed'],'true');assert(at(480).className.includes('is-selected'));
  assert(h.nodes.get('[data-summary-time]').textContent.includes('08:00'));assert(h.nodes.get('[data-summary-time]').textContent.includes('10:00'));
  const blockedEnd=h.fields.end_min.options.find(option=>option.value==='660');assert(blockedEnd.disabled);assert(blockedEnd.textContent.includes('예약 마감'));
  h.fields.start_min.value='720';h.fields.start_min.events.change();assert.equal(at(720).attributes['aria-pressed'],'true');assert.equal(at(480).attributes['aria-pressed'],'false');
});

test('half-hour grids and next-day collisions use full interval values without rounding or wrapping',async()=>{
  let blocked=[];const h=harness(async()=>({ok:true,json:async()=>({ok:true,blocked,step_minutes:30})}));
  h.fields.date.value='2099-11-06';await h.hooks.loadAvailability();
  const grid=()=>h.nodes.get('[data-start-time-grid]').children;
  assert.equal(grid().length,48);grid().find(button=>button.value==='1380').click();
  assert.equal(h.fields.end_min.value,'1500');assert(h.fields.end_min.selectedOptions[0].textContent.includes('다음 날 01:00'));
  blocked=[{start_min:1470,end_min:1560}];await h.hooks.loadAvailability();
  const late=grid().find(button=>button.value==='1380');assert.equal(late.disabled,true);assert.equal(late.children[1].textContent,'2시간 확보 불가');assert.equal(h.fields.start_min.value,'');
});

test('loading, failed and closed booking states never leave an active time button',async()=>{
  const pending=[];const h=harness(()=>new Promise((resolve,reject)=>pending.push({resolve,reject})));
  h.fields.date.value='2099-11-06';const loading=h.hooks.loadAvailability();
  let buttons=h.nodes.get('[data-start-time-grid]').children;assert(buttons.length);assert(buttons.every(button=>button.disabled));buttons[0].click();assert.equal(h.fields.start_min.value,'');
  pending[0].reject(new Error('offline'));await loading;assert(h.nodes.get('[data-start-time-grid]').children.every(button=>button.disabled));
  const retry=h.hooks.loadAvailability();pending[1].resolve({ok:true,json:async()=>({ok:true,booking_open:false,blocked:[],step_minutes:60})});await retry;
  buttons=h.nodes.get('[data-start-time-grid]').children;assert.equal(buttons.length,24);assert(buttons.every(button=>button.disabled && button.children[1].textContent==='예약 준비 중'));assert.equal(h.fields.start_min.disabled,true);
});

test('today labels past starts and room/date changes clear previous choices immediately',async()=>{
  const fixed=Date.parse('2026-11-06T03:15:00Z'),h=harness(async()=>({ok:true,json:async()=>({ok:true,blocked:[],step_minutes:60})})),today=harness(async()=>({ok:true,json:async()=>({ok:true,blocked:[],step_minutes:60})}),'',fixed);
  today.fields.date.value='2026-11-06';await today.hooks.loadAvailability();
  const past=today.nodes.get('[data-start-time-grid]').children.find(button=>button.value==='720');assert.equal(past.disabled,true);assert.equal(past.children[1].textContent,'지난 시간');
  h.fields.date.value='2099-11-06';await h.hooks.loadAvailability();h.nodes.get('[data-start-time-grid]').children.find(button=>button.value==='600').click();
  h.fields.date.value='2099-11-07';h.fields.date.events.change();assert.equal(h.fields.start_min.value,'');assert.equal(h.fields.end_min.value,'');await flush();assert.equal(h.fields.start_min.value,'');
  h.nodes.get('[data-start-time-grid]').children.find(button=>button.value==='600').click();h.radios.forEach(radio=>radio.checked=radio.value==='r1');h.radios[0].events.change();
  assert.equal(h.fields.start_min.value,'');assert.equal(h.fields.end_min.value,'');await flush();assert(h.nodes.get('[data-start-time-grid]').children.every(button=>button.attributes['aria-pressed']==='false'));
});

test('non-JSON upstream failures show a customer message without parser or network details',async()=>{
  const h=harness(async()=>({ok:false,status:404,json:async()=>{throw new SyntaxError('Unexpected token < API html internal error');}}));
  h.fields.date.value='2099-11-06';await h.hooks.loadAvailability();
  const text=h.nodes.get('[data-availability-message]').textContent;
  assert(text.includes('일정을 확인할 수 없습니다'));assert(!text.includes('Unexpected'));assert(!text.includes('internal'));
  assert.equal(h.nodes.get('[data-submit]').disabled,true);
});

test('uncertain network submission reuses its identifier on retry and never invents success',async()=>{
  const posts=[];
  const h=harness(async(url,options)=>{
    if(options?.method==='POST'){posts.push(JSON.parse(options.body));throw new Error('offline');}
    return {ok:true,status:200,json:async()=>({ok:true,blocked:[]})};
  });
  h.fields.date.value='2099-11-06';await h.hooks.loadAvailability();
  h.fields.start_min.value='600';h.fields.start_min.events.change();h.fields.end_min.value='720';
  Object.assign(h.fields.name,{value:'테스트'});h.fields.phone.value='010-1234-5678';h.fields.purpose.value='meeting';h.fields.consent.checked=true;h.fields.conditions.checked=true;
  await h.form.events.submit({preventDefault(){}});await flush();
  await h.form.events.submit({preventDefault(){}});
  assert.equal(posts.length,2);assert.equal(posts[0].submissionId,posts[1].submissionId);
  assert.equal(h.form.hidden,false);assert.equal(h.nodes.get('[data-submit-error]').hidden,false);
  assert(h.nodes.get('[data-submit-error]').textContent.includes('같은 내용'));
});

test('new public pages provide complete input and communicate the actual approval process',()=>{
  const booking=readFileSync(new URL('../booking.html',import.meta.url),'utf8');
  const shop=readFileSync(new URL('../shop.html',import.meta.url),'utf8');
  for(const name of ['room','date','start_min','end_min','people','name','phone','company','email','purpose','purpose_detail','requests','consent','conditions']) assert(booking.includes(`name="${name}"`),name);
  assert(booking.includes('<option value="meeting">회의</option>'));assert(!booking.includes('</option value='));
  assert(booking.includes('예약 신청 단계'));assert(booking.includes('페이앱 결제'));assert(booking.includes('data-submit'));
  assert(!shop.includes('/product/locker-month'));assert(!shop.includes('js/shop.js'));assert(shop.includes('현장 무인 키오스크 결제'));assert(shop.includes('id="policy"'));assert(shop.includes('/booking'));
});
