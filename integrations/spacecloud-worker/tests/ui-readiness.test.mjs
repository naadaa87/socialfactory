import test from 'node:test';
import assert from 'node:assert/strict';
import { SpacecloudUI,SpacecloudReadiness } from '../spacecloud-ui.mjs';

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
function observedPage(){const callbacks=new Map();return {on(event,callback){callbacks.set(event,callback);},emit(event,request){callbacks.get(event)?.(request);}};}
const dataRequest=(url='https://api.spacecloud.kr/calendar',status=200)=>({url:()=>url,resourceType:()=> 'fetch',response:async()=>({status:()=>status})});
test('only Spacecloud data requests delay readiness; unrelated analytics may remain active',async()=>{
  const page=observedPage();let clock=0,finished=false;const calendar=dataRequest(),analytics=dataRequest('https://analytics.example.test/collect');
  const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;if(clock>=1000 && !finished){finished=true;page.emit('requestfinished',calendar);}},quietMs:750,timeoutMs:3000});
  state.navigate();page.emit('request',calendar);page.emit('request',analytics);await state.settle();
  assert(clock>=1750);assert.equal(state.pending.size,0);assert.equal(state.failed,false);
});
test('a failed Spacecloud data response never exposes the old calendar as ready',async()=>{
  const page=observedPage();let clock=0;const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;}}),request=dataRequest(undefined,500);
  state.navigate();page.emit('request',request);page.emit('requestfinished',request);await Promise.resolve();
  await assert.rejects(state.settle(),{name:'ReviewRequired'});
});
test('an unfinished Spacecloud request stops availability within the bounded readiness timeout',async()=>{
  const page=observedPage();let clock=0;const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;},timeoutMs:1000});
  state.navigate();page.emit('request',dataRequest());await assert.rejects(state.settle(),{name:'ReviewRequired'});assert.equal(clock,1000);
});
test('navigation discards only prior-document signals, not a new calendar request',async()=>{
  const page=observedPage();let clock=0;const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;},quietMs:100});
  const old=dataRequest(),fresh=dataRequest();page.emit('request',old);state.navigate();page.emit('request',fresh);page.emit('requestfailed',old);
  assert.equal(state.failed,false);assert.equal(state.pending.size,1);page.emit('requestfinished',fresh);await Promise.resolve();await state.settle();assert.equal(state.pending.size,0);
});

test('readiness diagnostics report HTTP status and static route words without query tokens or dynamic paths',async()=>{
  const page=observedPage();let clock=0;const reports=[];
  const state=new SpacecloudReadiness(page,{now:()=>clock,pause:async ms=>{clock+=ms;},report:metadata=>reports.push(metadata)});
  const request=dataRequest('https://api.spacecloud.kr/v1/users/private-person-777/reservations/123456?access_token=PRIVATE_SECRET',401);
  state.navigate();page.emit('request',request);page.emit('requestfinished',request);await Promise.resolve();
  await assert.rejects(state.settle(),{name:'ReviewRequired'});
  assert.equal(reports.length,1);assert.deepEqual(reports[0],{phase:'request-readiness',host:'api.spacecloud.kr',path:'/v1/users/[segment]/reservations/[segment]',type:'fetch',status:401,failure:'http-error'});
  assert(!JSON.stringify(reports).includes('PRIVATE_SECRET'));assert(!JSON.stringify(reports).includes('private-person'));assert(!JSON.stringify(reports).includes('123456'));
});
