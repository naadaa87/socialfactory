import test from 'node:test';
import assert from 'node:assert/strict';
import { boardRequest } from '../js/board-request.mjs';
import { ROOM_IDS, boardAvailability, validBoardSnapshot } from '../js/reservation-board-model.mjs';

const now=Date.parse('2026-10-30T20:00:00+09:00');
const snapshot=()=>({ok:true,date:'2026-10-30',generated_at:now,reservations:[],rooms:ROOM_IDS.map(id=>({id,calendar:'ok'}))});

test('a transport ignoring abort still times out and receives an aborted signal',async()=>{
  let signal;
  await assert.rejects(boardRequest('/schedule',{timeoutMs:15,fetcher:(_url,init)=>{signal=init.signal;return new Promise(()=>{});}}),{code:'timeout'});
  assert.equal(signal.aborted,true);
});
test('deadline includes JSON decoding and ignores a late successful response',async()=>{
  let finish;
  const result=boardRequest('/schedule',{timeoutMs:15,fetcher:async()=>({ok:true,json:()=>new Promise(resolve=>{finish=resolve;})})});
  await assert.rejects(result,{code:'timeout'});
  finish(snapshot());
  await assert.rejects(result,{code:'timeout'});
});
test('HTTP authentication and server errors survive non-JSON error pages',async()=>{
  for(const status of [401,503]) await assert.rejects(boardRequest('/schedule',{fetcher:async()=>({ok:false,status,json(){throw new Error('html');}})}),{code:'http',status});
});
test('successful JSON is returned and malformed success responses fail',async()=>{
  assert.deepEqual(await boardRequest('/schedule',{fetcher:async()=>({ok:true,json:async()=>snapshot()})}),snapshot());
  await assert.rejects(boardRequest('/schedule',{fetcher:async()=>({ok:true,json:async()=>{throw new SyntaxError('invalid JSON');}})}),SyntaxError);
});
test('empty confirmed data is ready while loading and failed reads remain distinct',()=>{
  assert.equal(boardAvailability(null,now,0),'loading');
  assert.equal(boardAvailability(null,now,0,{failed:true}),'error');
  assert.equal(boardAvailability(snapshot(),now,now),'ready');
});
test('recent last-known schedules survive a transient error but expire after three minutes or midnight',()=>{
  assert.equal(boardAvailability(snapshot(),now+60000,now,{failed:true}),'ready');
  assert.equal(boardAvailability(snapshot(),now+180001,now,{failed:true}),'error');
  assert.equal(boardAvailability({...snapshot(),date:'2026-10-29'},now,now),'error');
});
test('invalid snapshots cannot reach the renderer or falsely declare no reservations',()=>{
  assert(validBoardSnapshot(snapshot()));
  for(const bad of [null,{}, {...snapshot(),ok:false},{...snapshot(),rooms:[null]},
    {...snapshot(),rooms:[...snapshot().rooms.slice(1),{id:'r2',calendar:'ok'}]},
    {...snapshot(),reservations:[null]}, {...snapshot(),reservations:[{room:'r1',name:'고객',start:now,end:now}]},
    {...snapshot(),generated_at:'not-a-time'}]) assert.equal(validBoardSnapshot(bad),false);
});
