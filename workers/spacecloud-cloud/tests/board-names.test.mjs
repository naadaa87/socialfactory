import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {enrichBoardNames} from '../board-names.mjs';
import {reservationBoardName,validBoardName} from '../../../functions/_lib/reservation-board-name.js';
const now=Date.parse('2026-11-16T03:00:00Z');
const state={origins:[{origin:'https://partner.spacecloud.kr',localStorage:[{name:'spacecloud__userInfo',value:JSON.stringify({accessToken:'PRIVATE_AUTH'})}]}]};
function fixture(){const sqlite=new DatabaseSync(':memory:');return {sqlite,env:{STATE_DB:{prepare(sql){let args=[];const q={bind(...v){args=v;return q;},async run(){return sqlite.prepare(sql).run(...args);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};}};return q;}}}};}
const snapshots=(ids=['123'])=>[{space:'r1',events:ids.map(id=>({id,date:'2026-11-16',kind:'reservation',title:'김**'}))}];
const detail=(id,name='김민수')=>({id,space:{space_name:'소셜팩토리 건대 (초특가)',product_name:'1번룸 (최대 36명)'},user_info:{name,phone:'PRIVATE_PHONE',email:'PRIVATE_EMAIL'}});
test('known reservation name fields use the requested format, including a parenthetical organization',()=>{
 for(const [raw,wanted] of [['김민수','김○수'],['남궁민수','남○○수'],['가나다라마','가나다○○'],['가나다라마바사','가나다○○'],['김민수(고객 단체)','김○수']])assert.equal(reservationBoardName(raw),wanted);
 assert.equal(reservationBoardName('김민수 / 010-1234-5678'),null);
 assert(!validBoardName('김민수'));assert(!validBoardName('ABC○○GH'));assert(validBoardName('김○수'));
});
test('only masked names are cached and sent; polling within the refresh interval reuses them',async()=>{
 const {env,sqlite}=fixture();let calls=0;
 const fetcher=async(url,options)=>{calls++;assert.equal(url,'https://api.spacecloud.kr/partner/reservations/123');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'PRIVATE_AUTH');return Response.json(detail('123','김민수(고객 단체)'));};
 const first=snapshots();await enrichBoardNames(env,first,state,{fetcher,now});assert.equal(first[0].events[0].board_name,'김○수');assert.equal(first[0].events[0].title,'김**');
 const second=snapshots();await enrichBoardNames(env,second,state,{fetcher,now:now+5000});assert.equal(calls,1);assert.equal(second[0].events[0].board_name,'김○수');
 const stored=JSON.stringify(sqlite.prepare('SELECT * FROM cloud_board_names').all())+JSON.stringify(first);
 for(const secret of ['김민수','고객 단체','PRIVATE_PHONE','PRIVATE_EMAIL','PRIVATE_AUTH'])assert(!stored.includes(secret),secret);
});
test('a name-only edit replaces the cached mask at ten seconds without changing the calendar title',async()=>{
 const {env}=fixture();let name='김민수',calls=0;
 const fetcher=async()=>{calls++;return Response.json(detail('123',name));};
 await enrichBoardNames(env,snapshots(),state,{fetcher,now});name='박영희';
 const latest=snapshots();await enrichBoardNames(env,latest,state,{fetcher,now:now+10000});
 assert.equal(calls,2);assert.equal(latest[0].events[0].board_name,'박○희');assert.equal(latest[0].events[0].title,'김**');
});
test('legacy day-long caches expire under the new policy without resetting stored names',async()=>{
 const {env,sqlite}=fixture();await enrichBoardNames(env,snapshots(),state,{now,fetcher:async()=>Response.json(detail('123'))});
 sqlite.prepare('UPDATE cloud_board_names SET retry_at=?').run(now+86400000);
 const latest=snapshots();let calls=0;
 await enrichBoardNames(env,latest,state,{now:now+10000,fetcher:async()=>{calls++;return Response.json(detail('123','박영희'));}});
 assert.equal(calls,1);assert.equal(latest[0].events[0].board_name,'박○희');
});
test('failed refreshes preserve the last name and wait a minute before retrying',async()=>{
 const {env}=fixture();await enrichBoardNames(env,snapshots(),state,{now,fetcher:async()=>Response.json(detail('123'))});
 let calls=0;const failing=async()=>{calls++;throw Error('offline');};
 const first=snapshots();await enrichBoardNames(env,first,state,{now:now+10000,fetcher:failing});assert.equal(first[0].events[0].board_name,'김○수');
 await enrichBoardNames(env,snapshots(),state,{now:now+20000,fetcher:failing});assert.equal(calls,1);
 const latest=snapshots();await enrichBoardNames(env,latest,state,{now:now+70000,fetcher:async()=>Response.json(detail('123','박영희'))});
 assert.equal(latest[0].events[0].board_name,'박○희');
});
test('today names take priority and an overflow rotates through older checks',async()=>{
 const {env}=fixture();const rows=snapshots(Array.from({length:8},(_,i)=>String(100+i)));
 rows[0].events.unshift({id:'900',date:'2026-11-17',kind:'reservation',title:'김**'});
 let requested=[];const fetcher=async url=>{const id=url.split('/').pop();requested.push(id);return Response.json(detail(id));};
 await enrichBoardNames(env,rows,state,{now,fetcher});assert.equal(requested.length,6);assert(!requested.includes('900'));
 requested=[];await enrichBoardNames(env,rows,state,{now:now+10000,fetcher});
 assert.deepEqual(requested.slice(0,2),['106','107']);
});
test('upcoming names refresh less often and become fast when the booking day starts',async()=>{
 const {env}=fixture(),rows=snapshots();rows[0].events[0].date='2026-11-17';let name='김민수',calls=0;
 const fetcher=async()=>{calls++;return Response.json(detail('123',name));};
 await enrichBoardNames(env,rows,state,{now:Date.parse('2026-11-16T23:59:45+09:00'),fetcher});name='박영희';
 await enrichBoardNames(env,rows,state,{now:Date.parse('2026-11-16T23:59:55+09:00'),fetcher});assert.equal(calls,1);
 await enrichBoardNames(env,rows,state,{now:Date.parse('2026-11-17T00:00:00+09:00'),fetcher});assert.equal(calls,2);assert.equal(rows[0].events[0].board_name,'박○희');
});
test('an overnight reservation still visible today gets its detail name refreshed',async()=>{
 const {env}=fixture(),rows=snapshots();rows[0].events[0].date='2026-11-15';rows[0].events[0].end_min=1500;
 await enrichBoardNames(env,rows,state,{now,fetcher:async()=>Response.json(detail('123'))});
 assert.equal(rows[0].events[0].board_name,'김○수');
});
test('unrelated venue, room or reservation ID cannot supply a display name',async()=>{
 for(const change of [{id:'999'},{space:{space_name:'다른 공간',product_name:'1번룸 (최대 36명)'}},{space:{space_name:'소셜팩토리 건대 (초특가)',product_name:'2번룸 (최대 40명)'}}]){
  const {env}=fixture(),rows=snapshots();await enrichBoardNames(env,rows,state,{now,fetcher:async()=>Response.json({...detail('123'),...change})});assert.equal(rows[0].events[0].board_name,undefined);
 }
});
test('missing or failed details keep schedules unchanged and throttle retries',async()=>{
 const {env}=fixture();let calls=0;const fetcher=async()=>{calls++;throw Error('PRIVATE_NETWORK_ERROR');};
 const rows=snapshots();await enrichBoardNames(env,rows,state,{fetcher,now});assert.equal(rows[0].events[0].board_name,undefined);assert.equal(rows[0].events[0].title,'김**');
 await enrichBoardNames(env,snapshots(),state,{fetcher,now:now+10000});assert.equal(calls,1);
});
test('provider rate limits pause all detail lookups for Retry-After',async()=>{
 const {env}=fixture();let calls=0;const fetcher=async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'180'}});};
 await enrichBoardNames(env,snapshots(['1','2','3']),state,{now,fetcher});assert(calls<=2);const initial=calls;
 await enrichBoardNames(env,snapshots(['4']),state,{now:now+120000,fetcher});assert.equal(calls,initial);
});
test('only nearby actual reservations are queried and each audit reads at most six details',async()=>{
 const {env}=fixture();let calls=0;const rows=snapshots(Array.from({length:10},(_,i)=>String(100+i)));
 rows[0].events.push({id:'900',date:'2026-11-15',kind:'reservation',title:'과거'},{id:'901',date:'2026-12-16',kind:'reservation',title:'미래'},{id:'902',date:'2026-11-16',title:'수기 예약'});
 await enrichBoardNames(env,rows,state,{now,fetcher:async url=>{calls++;return Response.json(detail(url.split('/').pop()));}});assert.equal(calls,6);assert.equal(rows[0].events.filter(e=>e.board_name).length,6);
});

test('the host API uppercase name and space fields are read without retaining the detail response',async()=>{
 const {env}=fixture(),rows=snapshots();
 await enrichBoardNames(env,rows,state,{now,fetcher:async()=>Response.json({ID:'123',SPACE:{SPACE_NAME:'소셜팩토리 건대 (초특가)',PRODUCT_NAME:'1번룸 (최대 36명)'},USER_INFO:{NAME:'김민수',PHONE:'PRIVATE_PHONE'}})});
 assert.equal(rows[0].events[0].board_name,'김○수');assert(!JSON.stringify(rows).includes('PRIVATE_PHONE'));
});
