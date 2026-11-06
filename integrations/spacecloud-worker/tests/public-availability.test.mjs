import test from 'node:test';
import assert from 'node:assert/strict';
import {PUBLIC_AVAILABILITY_MODE,PUBLIC_AVAILABILITY_PRODUCTS,publicAvailabilityURL,parsePublicAvailability,readPublicAvailability} from '../public-availability.mjs';
import {SpacecloudUI} from '../spacecloud-ui.mjs';

const scope={room:'r5',date:'2026-12-15'},segment={date:scope.date,start_min:240,end_min:360};
const day=(date,unavailable=[])=>({year:date.slice(0,4),month:date.slice(5,7),day:date.slice(8),wday:'TUE',hday:'N',available:true,
  times:Array.from({length:24},(_,hour)=>({hour,price:5000,is_nowpay_quick:false,available:!unavailable.includes(hour)}))});
const month=()=>({year:'2026',month:'12',days:[day('2026-11-30',[4,5]),day('2026-12-15'),day('2027-01-01',[4,5])]});
const response=(data=month(),{status=200,headers={}}={})=>new Response(typeof data==='string'?data:JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const snapshot=(unavailable=[])=>({room:scope.room,date:scope.date,day_available:true,hours:Array.from({length:24},(_,hour)=>!unavailable.includes(hour))});
function apiDriver(read){const ui=new SpacecloudUI(null,{publicAvailabilityMode:PUBLIC_AVAILABILITY_MODE});ui.room='r5';ui.readPublicAvailability=read;ui.waitPublicPropagation=async()=>{};return ui;}

test('the fixed public product/type mappings generate only the observed anonymous endpoint',()=>{
  assert.equal(PUBLIC_AVAILABILITY_MODE,'public-api-v1');
  assert.deepEqual(Object.values(PUBLIC_AVAILABILITY_PRODUCTS).map(v=>[v.product,v.type]),[[140236,245094],[140235,245092],[140486,245511],[140487,245513],[140492,245523]]);
  assert.equal(publicAvailabilityURL('r5','2026-01-02'),'https://api.spacecloud.kr/products/140492/prices?reservation_type_id=245523&year=2026&month=01');
  for(const room of ['__proto__','constructor','r6','https://other.invalid'])assert.throws(()=>publicAvailabilityURL(room,scope.date),{name:'ReviewRequired'});
  for(const date of ['2026-02-30','2026-1-01','2026-12-15?token=x',undefined])assert.throws(()=>publicAvailabilityURL('r5',date),{name:'ReviewRequired'});
});
test('surrounding month/year days and padded fields cannot select the wrong date',()=>{
  const data=month();data.days[1].day='15';data.days[1].times.reverse();
  const parsed=parsePublicAvailability(data,scope);assert.equal(parsed.day_available,true);assert.deepEqual(parsed.hours,Array(24).fill(true));
  assert.deepEqual(Object.keys(parsed),['room','date','day_available','hours']);assert(!JSON.stringify(parsed).includes('price'));
  const january={year:2027,month:1,days:[day('2026-12-31',[4,5]),day('2027-01-01')]};
  assert.deepEqual(parsePublicAvailability(january,{room:'r1',date:'2027-01-01'}).hours,Array(24).fill(true));
});
test('missing, duplicate, impossible or out-of-range date identities are rejected',()=>{
  const mutations=[
    data=>{data.month='11';},data=>{data.year='2025';},data=>{data.days.splice(1,1);},data=>{data.days.push(structuredClone(data.days[1]));},
    data=>{data.days[0].day='31';},data=>{data.days[0]=day('2026-10-30');},data=>{data.days[1].available='Y';},data=>{data.days=[];}
  ];
  for(const mutate of mutations){const data=month();mutate(data);assert.throws(()=>parsePublicAvailability(data,scope),{name:'ReviewRequired'});}
});
test('all 24 unique integer hours and actual boolean availability are required',()=>{
  const mutations=[
    times=>times.pop(),times=>times.push({...times[0]}),times=>{times[23].hour=22;},times=>{times[0].hour=24;},times=>{times[0].hour='0';},
    times=>{times[0].hour=0.5;},times=>{times[0].available='N';},times=>{delete times[0].available;},times=>{times[0]=null;}
  ];
  for(const mutate of mutations){const data=month();mutate(data.days[1].times);assert.throws(()=>parsePublicAvailability(data,scope),{name:'ReviewRequired'});}
});
test('each read sends a new credential-free GET without redirects or cached fallback',async()=>{
  let calls=0;
  const fetcher=async(url,options)=>{calls++;assert.equal(url,publicAvailabilityURL(scope.room,scope.date));assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.credentials,'omit');assert.equal(options.cache,'no-store');
    const headers=new Headers(options.headers);assert.equal(headers.get('authorization'),null);assert.equal(headers.get('cookie'),null);assert.equal(headers.get('cache-control'),'no-cache, no-store');assert(options.signal instanceof AbortSignal);return response();};
  await readPublicAvailability(scope,{fetcher});await readPublicAvailability(scope,{fetcher});assert.equal(calls,2);
});
test('HTTP errors, redirects, stale cache and malformed payloads fail closed without retries',async()=>{
  const cases=[()=>response({}, {status:401}),()=>response({}, {status:403}),()=>response({}, {status:503}),()=>response({}, {status:302,headers:{Location:'https://other.invalid'}}),
    ()=>response(month(),{headers:{Age:'1'}}),()=>response(month(),{headers:{Warning:'110 - stale'}}),()=>response(month(),{headers:{'CF-Cache-Status':'STALE'}}),
    ()=>response(month(),{headers:{'content-type':'text/html'}}),()=>response('{invalid'),()=>response(month(),{headers:{'content-length':'999999'}}),()=>response(' '.repeat(262145))];
  for(const build of cases){let calls=0;await assert.rejects(readPublicAvailability(scope,{fetcher:async()=>{calls++;return build();}}),{name:'ReviewRequired'});assert.equal(calls,1);}
  let calls=0;await assert.rejects(readPublicAvailability(scope,{fetcher:async()=>{calls++;throw new Error('PRIVATE_RAW_FAILURE');}}),error=>error.name==='ReviewRequired' && !error.message.includes('PRIVATE_RAW_FAILURE'));assert.equal(calls,1);
});
test('the six-second maximum also bounds a fetch or response body that ignores abort',async()=>{
  let signal;
  await assert.rejects(readPublicAvailability(scope,{timeoutMs:5,fetcher:async(_,options)=>{signal=options.signal;return new Promise(()=>{});}}),{name:'ReviewRequired'});assert(signal.aborted);
  await assert.rejects(readPublicAvailability(scope,{timeoutMs:5,fetcher:async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}})}),{name:'ReviewRequired'});
});
test('public API mode initializes only the host page and never accesses a guest context or page',async()=>{
  const observed=[],host={setDefaultTimeout(){}},guest=new Proxy({}, {get(){assert.fail('public API mode must not touch the guest page');}});let calls=0;
  const ui=new SpacecloudUI({async newPage(){calls++;return host;}},{publicAvailabilityMode:PUBLIC_AVAILABILITY_MODE,publicPage:guest,publicContext:{async newPage(){assert.fail('no guest page may be created');}}});
  ui.observe=page=>observed.push(page);await ui.initialize();assert.equal(calls,1);assert.equal(ui.guest,undefined);assert.deepEqual(observed,[host]);
});
test('public verification observes target hours becoming blocked and released while allowing legitimate adjacent occupancy',async()=>{
  let calls=0;const ui=apiDriver(async()=>{calls++;return snapshot(calls===1?[3,6]:[3,4,5,6]);});
  await ui.verifyPublic(segment,[segment]);assert.equal(calls,2);
  ui.readPublicAvailability=async()=>snapshot([3,5,6]);
  await ui.verifyPublic(segment,[{...segment,start_min:300}]);
});
test('public propagation mismatches get at most three independent reads and transport failures get no retry',async()=>{
  let calls=0,pauses=0;const ui=apiDriver(async()=>{calls++;return snapshot();});ui.waitPublicPropagation=async()=>{pauses++;};
  await assert.rejects(ui.verifyPublic(segment,[segment]),{name:'ReviewRequired'});assert.equal(calls,3);assert.equal(pauses,2);
  calls=0;ui.readPublicAvailability=async()=>{calls++;throw Object.assign(new Error('unavailable'),{name:'ReviewRequired'});};
  await assert.rejects(ui.verifyPublic(segment,[segment]),{name:'ReviewRequired'});assert.equal(calls,1);
});
test('preflight blocks pending holds and unavailable dates without accepting truthy values',async()=>{
  const ui=apiDriver(async()=>snapshot([5]));await assert.rejects(ui.assertPublicAvailable(segment),{name:'ReviewRequired'});
  ui.readPublicAvailability=async()=>snapshot();await ui.assertPublicAvailable(segment);
  ui.readPublicAvailability=async()=>({...snapshot(),day_available:false});await assert.rejects(ui.assertPublicAvailable(segment),{name:'ReviewRequired'});
  ui.readPublicAvailability=async()=>{const value=snapshot();value.hours[4]='Y';return value;};await assert.rejects(ui.assertPublicAvailable(segment),{name:'ReviewRequired'});
});
test('the final host submit is bracketed by lease checks and a fresh public preflight',async()=>{
  for(const blocked of [false,true]){
    const events=[],values=new Map(),ui=new SpacecloudUI(null,{allowWrites:true,publicAvailabilityMode:PUBLIC_AVAILABILITY_MODE});
    ui.host={getByText(){return 'open';},locator(selector){return {selector,async waitFor(){},async selectOption(){},async isChecked(){return false;},async fill(value){values.set(selector,value);},async inputValue(){return values.get(selector);}};}};
    ui.click=async target=>{if(target?.selector==='a#_addExternalSchedule')events.push('submit');};ui.chooseFormDate=async()=>{};
    ui.beforeWrite=async()=>events.push('lease');ui.assertPublicAvailable=async()=>{events.push('public');if(blocked)throw Object.assign(new Error('pending hold'),{name:'ReviewRequired'});};
    const operation=ui.createSegment({...segment,marker:'SFWEB:B261215-PREFLIGHT'});
    if(blocked){await assert.rejects(operation,{name:'ReviewRequired'});assert.deepEqual(events,['lease','public']);}
    else {await operation;assert.deepEqual(events,['lease','public','lease','submit']);}
  }
});
