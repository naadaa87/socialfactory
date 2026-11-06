import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SpacecloudUI,SpacecloudReadiness,TIME_RADIO_NAME,publicCalendarLayout } from '../spacecloud-ui.mjs';
import {memoFor} from '../safety.mjs';

function targetSet(visibleCount,{hiddenCount=0}={}) {
  const calls=[];
  const selected={async count(){return visibleCount;},async isVisible(){return visibleCount===1;},async scrollIntoViewIfNeeded(){calls.push('scroll');},async boundingBox(){return {x:10,y:20,width:30,height:40};},page(){return {mouse:{async click(x,y){calls.push(['click',x,y]);}}};}};
  return {calls,locator:{async count(){return visibleCount+hiddenCount;},filter(options){assert.deepEqual(options,{visible:true});return selected;}}};
}
test('responsive hidden duplicate is excluded before a unique visible click',async()=>{
  const {calls,locator}=targetSet(1,{hiddenCount:1});const ui=new SpacecloudUI(null,{});
  await ui.click(locator);assert.deepEqual(calls,['scroll',['click',25,40]]);
});
test('two visible controls or no visible control never receive input',async()=>{
  for(const count of [0,2]){const {calls,locator}=targetSet(count,{hiddenCount:1});await assert.rejects(new SpacecloudUI(null,{}).click(locator),{name:'ReviewRequired'});assert.deepEqual(calls,[]);}
});
const labelsFor=month=>{
  const start=Date.parse(month+'-01T00:00:00Z'),weekday=new Date(start).getUTCDay();
  const days=new Date(Date.parse(month+'-01T00:00:00Z')+32*86400000);days.setUTCDate(0);
  const count=Math.ceil((weekday+days.getUTCDate())/7)*7;
  return Array.from({length:count},(_,i)=>String(new Date(start+(i-weekday)*86400000).getUTCDate()).padStart(2,'0'));
};
test('a changed month heading cannot expose old month cells while the calendar request is pending',async()=>{
  let month='2026.11',settled=false;const events=[];
  const cellSet={locator(){return {async allTextContents(){events.push('read-grid');return labelsFor(settled?'2026-12':'2026-11');}};},nth(index){return {index};}};
  const controls=targetSet(1);const ui=new SpacecloudUI(null,{});
  ui.hostMonth=async()=>month;
  ui.settle=async()=>{events.push('calendar-loaded');settled=true;};
  ui.host={getByText(name){assert.equal(name,'다음달');return controls.locator;},locator(selector){assert.equal(selector,'.booking_wrap');return cellSet;},async waitForFunction(){events.push('heading-changed');month='2026.12';},async waitForLoadState(state,options){assert.equal(state,'networkidle');assert.equal(options.timeout,15000);events.push('calendar-loaded');settled=true;}};
  const cell=await ui.dateCell('2026-12-15');assert.equal(cell.index,16);
  assert.deepEqual(events,['heading-changed','calendar-loaded','read-grid']);
});
function observedPage(){const callbacks=new Map(),frame={};return {on(event,callback){callbacks.set(event,callback);},emit(event,request){callbacks.get(event)?.(request);},mainFrame(){return frame;},commit(){callbacks.get('framenavigated')?.(frame);}};}
const dataRequest=(url='https://api.spacecloud.kr/calendar',status=200)=>({url:()=>url,resourceType:()=> 'fetch',response:async()=>({status:()=>status})});
test('only Spacecloud data requests delay readiness; unrelated analytics may remain active',async()=>{
  const page=observedPage();let clock=0,finished=false;const calendar=dataRequest(),analytics=dataRequest('https://analytics.example.test/collect');
  const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;if(clock>=1000 && !finished){finished=true;page.emit('requestfinished',calendar);}},quietMs:750,timeoutMs:3000});
  state.navigate();page.commit();page.emit('request',calendar);page.emit('request',analytics);await state.settle();
  assert(clock>=1750);assert.equal(state.pending.size,0);assert.equal(state.failed,false);
});
test('a failed Spacecloud data response never exposes the old calendar as ready',async()=>{
  const page=observedPage();let clock=0;const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;}}),request=dataRequest(undefined,500);
  state.navigate();page.commit();page.emit('request',request);page.emit('requestfinished',request);await Promise.resolve();
  await assert.rejects(state.settle(),{name:'ReviewRequired'});
});
test('an unfinished Spacecloud request stops availability within the bounded readiness timeout',async()=>{
  const page=observedPage();let clock=0;const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;},timeoutMs:1000});
  state.navigate();page.commit();page.emit('request',dataRequest());await assert.rejects(state.settle(),{name:'ReviewRequired'});assert.equal(clock,1000);
});
test('navigation discards only prior-document signals, not a new calendar request',async()=>{
  const page=observedPage();let clock=0;const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;},quietMs:100});
  const old=dataRequest(),fresh=dataRequest();page.emit('request',old);state.navigate();page.commit();page.emit('request',fresh);page.emit('requestfailed',old);
  assert.equal(state.failed,false);assert.equal(state.pending.size,1);page.emit('requestfinished',fresh);await Promise.resolve();await state.settle();assert.equal(state.pending.size,0);
});

test('readiness diagnostics report HTTP status and static route words without query tokens or dynamic paths',async()=>{
  const page=observedPage();let clock=0;const reports=[];
  const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;},report:metadata=>reports.push(metadata)});
  const request=dataRequest('https://api.spacecloud.kr/v1/users/private-person-777/reservations/123456?access_token=PRIVATE_SECRET',401);
  state.navigate();page.commit();page.emit('request',request);page.emit('requestfinished',request);await Promise.resolve();
  await assert.rejects(state.settle(),{name:'ReviewRequired'});
  assert.equal(reports.length,1);assert.deepEqual(reports[0],{phase:'request-readiness',host:'api.spacecloud.kr',path:'/v1/users/[segment]/reservations/[segment]',type:'fetch',status:401,failure:'http-error',query_keys:['access_token'],prefetch:false,next_router_prefetch:false,rsc:false,navigation:false});
  assert(!JSON.stringify(reports).includes('PRIVATE_SECRET'));assert(!JSON.stringify(reports).includes('private-person'));assert(!JSON.stringify(reports).includes('123456'));
});


test('old-document requests issued during goto cannot poison the new document after commit',async()=>{
  const page=observedPage();let clock=0;const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;},quietMs:100});
  const oldLate=dataRequest(),current=dataRequest();state.navigate();page.emit('request',oldLate);page.commit();page.emit('request',current);page.emit('requestfailed',oldLate);page.emit('requestfinished',current);await Promise.resolve();
  await state.settle();assert.equal(state.failed,false);assert.equal(state.pending.size,0);
});
test('a genuine calendar abort after navigation commit remains a hard failure',async()=>{
  const page=observedPage();let clock=0;const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;}}),request=dataRequest();
  state.navigate();page.commit();page.emit('request',request);page.emit('requestfailed',request);await assert.rejects(state.settle(),{name:'ReviewRequired'});
});
test('explicit speculative prefetch aborts are irrelevant to the current visible calendar',async()=>{
  for(const headers of [{purpose:'prefetch'},{'sec-purpose':'prefetch;prerender'},{'next-router-prefetch':'1',rsc:'1'}]) {
    const page=observedPage();let clock=0;const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;},quietMs:100});
    const speculative={...dataRequest(),headers:()=>headers};state.navigate();page.commit();page.emit('request',speculative);page.emit('requestfailed',speculative);await state.settle();assert.equal(state.failed,false);
  }
});


test('time-unit radio accepts actual spacing variants while requiring the two-hour minimum',()=>{
  for(const name of ['시간 단위 예약하기(최소2시간 부터)','시간 단위 예약하기(최소 2시간 부터)','시간단위 예약하기 ( 최소 2 시간 부터 )'])assert(TIME_RADIO_NAME.test(name));
  for(const name of ['시간 단위 예약하기(최소1시간 부터)','시간 단위 예약하기(최소3시간 부터)','일 단위 예약하기(최소2시간 부터)'])assert(!TIME_RADIO_NAME.test(name));
});
test('offscreen radio is selected through its associated visible label and checked afterward',async()=>{
  const ui=new SpacecloudUI(null,{}),label={};let checked=false,settled=false;
  ui.guest={locator(selector){assert.equal(selector,'label[for="sp140492"],label:has(input[id="sp140492"])');return label;}};
  const radio={async waitFor(options){assert.deepEqual(options,{state:'attached'});},async isChecked(){return checked;},async getAttribute(name){assert.equal(name,'id');return 'sp140492';}};
  ui.click=async target=>{assert.equal(target,label);checked=true;};ui.settle=async()=>{settled=true;};
  await ui.selectPublicRadio(radio,'고객 예약 방 선택');assert(checked);assert(settled);
});
test('a radio label click that does not change the checked state fails closed',async()=>{
  const ui=new SpacecloudUI(null,{});ui.guest={locator(){return {};}};ui.click=async()=>{};
  const radio={async waitFor(){},async isChecked(){return false;},async getAttribute(){return 'unit-time';}};
  await assert.rejects(ui.selectPublicRadio(radio,'고객 시간 단위 예약 선택'),{name:'ReviewRequired'});
});
const publicSegment={date:'2026-12-15',start_min:240,end_min:360};
function slotDriver(classes){const ui=new SpacecloudUI(null,{});ui.openPublicDate=async()=>{};ui.guest={locator(){return {async getAttribute(){return classes;}};},async waitForTimeout(){}};return ui;}
test('Tailwind is-disabled variants never count as the actual disabled class on selectable slots',async()=>{
  await slotDriver('ts-row [&.is-disabled]:cursor-default [&.is-selectable]:cursor-pointer is-selectable').verifyPublic(publicSegment,[]);
  await assert.rejects(slotDriver('ts-row [&.is-disabled]:cursor-default is-selectable').verifyPublic(publicSegment,[publicSegment]),{name:'ReviewRequired'});
});
test('public blocked slots require the exact disabled class token',async()=>{
  await slotDriver('ts-row [&.is-selectable]:cursor-pointer [&.is-disabled]:cursor-default is-disabled').verifyPublic(publicSegment,[publicSegment]);
  await assert.rejects(slotDriver('ts-row [&.is-disabled]:cursor-default').verifyPublic(publicSegment,[publicSegment]),{name:'ReviewRequired'});
});

test('public comparison progress reports only fixed phases, timing and slot booleans',async()=>{
  const ui=slotDriver('ts-row [&.is-disabled]:cursor-default is-selectable'),events=[];ui.reportReview=event=>events.push(event);
  await assert.rejects(ui.verifyPublic(publicSegment,[publicSegment]),{name:'ReviewRequired'});
  const mismatch=events.filter(event=>event.event==='mismatch');assert.equal(mismatch.length,6);
  for(const event of mismatch){assert.equal(event.phase,'public-progress');assert.equal(event.step,'slots');assert([4,5].includes(event.index));assert.equal(event.expected_disabled,true);assert.equal(event.actual_disabled,false);assert.equal(event.actual_selectable,true);assert(Number.isFinite(event.elapsed_ms));}
  const serialized=JSON.stringify(events);assert(!serialized.includes(publicSegment.date));assert(!serialized.includes('spacecloud.kr'));assert(!serialized.includes('SFWEB'));
});

test('responsive calendar diagnostics contain only dimensions and fixed selector counts',()=>{
  const visible={getBoundingClientRect(){return {width:39,height:39};},style:{display:'block',visibility:'visible'}},hidden={getBoundingClientRect(){return {width:39,height:39};},style:{display:'none',visibility:'visible'}},collapsed={getBoundingClientRect(){return {width:0,height:0};},style:{display:'block',visibility:'visible'}};
  const nodes=new Map([['a.btn_month_next',[visible,hidden]],['a.btn_month_prev',[visible]],['.calendar_tit',[visible,hidden]],['.calendar_wrap',[collapsed]],['.ts-row',Array(24).fill(visible)],['h1,h2,h3,[role="heading"]',[{textContent:'PRIVATE_GUEST_NAME'},{textContent:'공간 소개'}]]]);
  const result=vm.runInNewContext('('+publicCalendarLayout.toString()+')()',{
    document:{body:{innerText:'PRIVATE_GUEST_NAME PRIVATE_PHONE 로그인 후 예약할 수 있습니다. 날짜를 선택해 주세요.'},documentElement:{clientWidth:1280,clientHeight:1100},querySelectorAll(selector){assert(nodes.has(selector));return nodes.get(selector);}},
    window:{innerWidth:1280,innerHeight:1100,getComputedStyle(element){return element.style;}}
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{client_width:1280,client_height:1100,inner_width:1280,inner_height:1100,next:{total:2,visible:1},previous:{total:1,visible:1},calendar_title:{total:2,visible:1},calendar_wrap:{total:1,visible:0},slots:{total:24,visible:24},heading_count:2,heading_markers:['공간 소개'],notice_markers:['login','login_required','date_prompt']});
  assert(!JSON.stringify(result).includes('PRIVATE_'));
});

test('public reservation verification uses the supplied anonymous context',async()=>{
  const host={setDefaultTimeout(){}},guest={setDefaultTimeout(){}};
  const ui=new SpacecloudUI({async newPage(){return host;}},{publicContext:{async newPage(){return guest;}}});
  const observed=[];ui.observe=page=>observed.push(page);
  await ui.initialize();assert.equal(ui.host,host);assert.equal(ui.guest,guest);assert.deepEqual(observed,[host,guest]);
});

test('guest source verification retains the original customer tab without navigating or creating a replacement',async()=>{
  const timeouts=[],host={setDefaultTimeout(value){timeouts.push(['host',value]);}},source={setDefaultTimeout(value){timeouts.push(['source',value]);},async goto(){assert.fail('initialize must not navigate the original customer tab');}};
  let newPages=0;
  const ui=new SpacecloudUI({async newPage(){newPages++;return host;}},{allowWrites:false,publicPage:source,publicContext:{async newPage(){assert.fail('the original customer tab must not be replaced');}}});
  const observed=[];ui.observe=page=>observed.push(page);
  await ui.initialize();assert.equal(newPages,1);assert.equal(ui.host,host);assert.equal(ui.guest,source);assert.deepEqual(observed,[host,source]);assert.deepEqual(timeouts,[['host',15000],['source',15000]]);
});

test('the observed customer login modal produces a clear guest authentication failure',async()=>{
  const ui=new SpacecloudUI(null,{});ui.guest={getByText(pattern){assert(pattern.test('로그인/회원가입해주세요.'));return {filter(options){assert.deepEqual(options,{visible:true});return {async count(){return 1;}};}};}};
  await assert.rejects(ui.assertNoGuestLoginPrompt(),{name:'ReviewRequired',message:'스페이스클라우드 고객용 로그인이 필요합니다. 관리자에서 고객 로그인을 연결해 주세요.'});
});
test('guest login verification reads the actual r5 customer calendar on the Korean date',async()=>{
  const ui=new SpacecloudUI(null,{allowWrites:false}),dates=[];
  ui.openPublicDate=async date=>{assert.equal(ui.room,'r5');dates.push(date);};
  const expectedBefore=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  assert.deepEqual(await ui.verifyGuestLogin(),{guest_ready:true});
  const expectedAfter=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  assert.equal(dates.length,1);assert([expectedBefore,expectedAfter].includes(dates[0]));
  ui.openPublicDate=async()=>{throw Object.assign(new Error('calendar unavailable'),{name:'ReviewRequired'});};
  await assert.rejects(ui.verifyGuestLogin(),{name:'ReviewRequired'});
});

test('deletion targets the unique nested confirmation rather than both visible ancestor layers',async()=>{
  const events=[],prompt='예약을 삭제하시겠습니까?';
  const node=(classes,text='',children=[])=>({classes:new Set(classes.split(' ')),text,children,visible:true});
  const question=node('',prompt),confirmButton=node('','확인'),inner=node('layer_popup confirm','',[question,confirmButton]);
  const deleteButton=node('btn_negative','예약 삭제'),outer=node('layer_popup reservation_state _popup4','',[deleteButton,inner]);
  const descendants=root=>root.children.flatMap(child=>[child,...descendants(child)]);
  const text=root=>root.text+root.children.map(text).join('');
  class Locator {
    constructor(resolve){this.resolve=resolve;}
    nodes(){return this.resolve();}
    locator(selector){return locate(()=>this.nodes().flatMap(descendants),selector);}
    filter({has,hasText}){return new Locator(()=>this.nodes().filter(item=>has?[item,...descendants(item)].some(child=>child.text===has.text):hasText.test(text(item))));}
    getByText(value){return new Locator(()=>this.nodes().flatMap(descendants).filter(item=>item.text===value));}
    async waitFor({state}){const found=this.nodes();if(state==='visible'){assert.equal(found.length,1,'strict mode: more than one visible layer');assert(found[0].visible);}else assert(!found.length || found.every(item=>!item.visible));}
  }
  function locate(resolve,selector){const classes=[...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map(match=>match[1]);return new Locator(()=>resolve().filter(item=>classes.every(name=>item.classes.has(name)) && (!selector.includes(':visible') || item.visible)));}
  const host={locator(selector){return locate(()=>[outer,...descendants(outer)],selector);},getByText(value){return {text:value};}};
  const broad=host.locator('.layer_popup:visible').filter({has:host.getByText(prompt)});
  assert.equal(broad.nodes().length,2);await assert.rejects(broad.waitFor({state:'visible'}),/strict mode/);
  inner.visible=false;
  const segment={date:'2026-12-15',start_min:240,end_min:360,marker:'SFWEB:B261215-OWNEDONLY'};
  const ui=new SpacecloudUI(null,{allowWrites:true});ui.host=host;
  ui.readOwnedDetail=async(_record,leaveOpen)=>{assert.equal(leaveOpen,true);return {...segment,name:segment.marker,memo:memoFor(segment)};};
  ui.click=async locator=>{const found=locator.nodes();assert.equal(found.length,1);if(found[0]===deleteButton){events.push('request');inner.visible=true;}else {assert.equal(found[0],confirmButton);events.push('confirm');inner.visible=false;outer.visible=false;}};
  ui.beforeWrite=async()=>events.push('lease');
  await ui.removeSegment(segment,{});assert.deepEqual(events,['request','lease','confirm']);
});
