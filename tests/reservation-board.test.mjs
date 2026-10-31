import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { displayName, boardRows, readBoard } from '../functions/_lib/reservation-board.js';
import { onRequestGet } from '../functions/api/admin/reservation-board.js';
import { mergeCalendarRows } from '../functions/_lib/spacecloud.js';
import { roomSchedule, formatTime, isOutdated } from '../js/reservation-board-model.mjs';

const date='2026-10-30', at=t=>Date.parse(date+'T'+t+':00+09:00');
const base={code:'R-1',status:'confirmed',space:'r1',date,start_min:840,end_min:960,customer_name:'김민수',channel:'web'};
function environment() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){let args=[]; const q={bind(...values){args=values;return q;},
    async all(){return {results:sqlite.prepare(sql).all(...args)};},
    async first(){return sqlite.prepare(sql).get(...args)||null;},
    async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return q;}};
  return {DB,sqlite,ADMIN_KEY:'prototype-test-only-not-real'};
}
function insert(env,changes={}) {
  const r={...base,...changes};
  env.sqlite.prepare(`INSERT INTO reservations(code,status,space,date,start_min,end_min,customer_name,channel,pay_method,phone,memo,amount)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.code,r.status,r.space,r.date,r.start_min,r.end_min,r.customer_name,r.channel,'bank_blank','010-1234-5678','내부 메모',90000);
}
test('display names never pass composite calendar titles, contact numbers or internal notes to a monitor',()=>{
  assert.equal(displayName('김민수'),'김○수');assert.equal(displayName('이준'),'이○');
  assert.equal(displayName('최정*'),'최정○');
  for(const title of ['투자N 모임 010-1234-5678','01012345678','스페이스클라우드 예약 #123456','김민수 / 비밀번호 1234','<img onerror=alert(1)>','','a@b.com']) assert.equal(displayName(title),'예약 고객');
});
test('all supported names use the same masking without classifying personal or organization names',()=>{
  for(const [name,masked] of [['투자N','투○N'],['ABC','A○C'],['이름123','이○○○3'],['John Doe','J○○○○○e'],['김','○'],['Li','L○'],['최정*','최정○'],['Kim*','Kim○']]) {
    assert.equal(displayName(name),masked);
    assert.notEqual(masked,name);
  }
  const rows=boardRows([{...base,space:'r5',customer_name:'투자N',start_min:900,end_min:1020}],date);
  assert.equal(rows[0].name,'투○N');
  assert.equal(roomSchedule(rows,'r5',at('14:00')).next.name,'투○N');
  assert.equal(roomSchedule(rows,'r5',at('15:00')).current[0].name,'투○N');
});
test('today projection clips overnight reservations and excludes cancelled, other rooms and invalid time slots',()=>{
  const rows=boardRows([base,{...base,code:'prev',date:'2026-10-29',start_min:1380,end_min:1500},
    {...base,code:'next',start_min:1380,end_min:1500},{...base,code:'cancel',status:'cancelled'},
    {...base,code:'unknown',space:'other'},{...base,code:'ended',date:'2026-10-29'},
    {...base,code:'bad',start_min:NaN},{...base,code:'reverse',end_min:500},base],date);
  assert.equal(rows.length,3);
  assert.equal(rows[0].start,at('00:00'));assert.equal(rows[0].end,at('01:00'));assert(rows[0].continued);
  assert.equal(rows[2].end,at('00:00')+86400000);assert(rows[2].continues);
  assert.equal(formatTime(rows[2].end,date),'24:00');
});
test('manual SpaceCloud booking covering its calendar slot displays once; overlapping genuine bookings remain visible',async()=>{
  const e=environment();insert(e,{channel:'spacecloud'});insert(e,{code:'R-2',start_min:900,end_min:1020});
  insert(e,{code:'other',space:'other'});insert(e,{code:'overnight',date:'2026-10-29',start_min:1380,end_min:1500});
  const report=await readBoard(e,{today:date,now:at('14:25'),mergeRows:mergeCalendarRows,
    loadExternal:async()=>({results:[{...base,code:'SC-1',external:true}],info:{rooms:[{space:'r1',stale:false,checked_at:1000,updated_at:1000},{space:'r2',error:'secret feed URL'}]}})});
  assert.equal(report.reservations.length,3);assert.equal(report.unassigned,1);
  assert.equal(report.rooms[0].calendar,'ok');assert.equal(report.rooms[1].calendar,'stale');assert.equal(report.rooms[2].calendar,'missing');
  const serialized=JSON.stringify(report);
  for(const privateField of ['김민수','010-1234','내부 메모','"amount":','"source_url":','"channel":','"code":','secret feed URL']) assert(!serialized.includes(privateField),privateField);
  const schedule=roomSchedule(report.reservations,'r1',at('15:15'));assert.equal(schedule.current.length,2);
});
test('current/next boundary is end-exclusive and disconnected or previous-day data becomes unavailable',()=>{
  const rows=[{room:'r1',name:'김○수',start:at('14:00'),end:at('16:00')},{room:'r1',name:'이○진',start:at('16:00'),end:at('18:00')}];
  assert.equal(roomSchedule(rows,'r1',at('15:59')).next.name,'이○진');
  assert.deepEqual(roomSchedule(rows,'r1',at('16:00')).current.map(x=>x.name),['이○진']);
  assert.equal(roomSchedule(rows,'r1',at('18:00')).current.length,0);
  const data={date,generated_at:at('14:00')};
  assert(!isOutdated(data,at('14:02'),at('14:00')));assert(isOutdated(data,at('14:04'),at('14:00')));
  assert(isOutdated({...data,generated_at:at('00:00')+86400000},at('00:00')+86400000,at('00:00')+86400000));
});
test('API requires administrator authentication and never returns private reservation fields',async()=>{
  const e=environment();insert(e);
  const url='https://socialfactory.co.kr/api/admin/reservation-board';
  const anonymous=await onRequestGet({request:new Request(url),env:e});assert.equal(anonymous.status,401);
  const authenticated=await onRequestGet({request:new Request(url,{headers:{authorization:'Bearer '+e.ADMIN_KEY}}),env:e});
  assert.equal(authenticated.status,200);assert.equal(authenticated.headers.get('cache-control'),'no-store');
  const result=await authenticated.json();assert.equal(result.rooms.length,5);
  assert(!JSON.stringify(result).includes('010-1234'));assert(!JSON.stringify(result).includes('memo'));
});
