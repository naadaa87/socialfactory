import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { parseCalendar, calendarRows, validateFeedConfig, loadSpacecloud, readFeedConfig, saveFeedConfig,
  mergeCalendarRows, filterExternal } from '../functions/_lib/spacecloud.js';
import { onRequestGet as getReservations, onRequestPost as createReservation } from '../functions/api/admin/reservations.js';
import { onRequestGet as getDashboard } from '../functions/api/admin/dashboard.js';
import { onRequestGet as getSettings, onRequestPost as configure } from '../functions/api/admin/spacecloud.js';

const url = id => `https://api.spacecloud.kr/partner/reservations/ical?product_id=${id}&ical_uid=exampletoken`;
const event = (uid = 'one', start = '20261024T230000', end = '20261025T010000', extra = '') =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;TZID=Asia/Seoul:${start}\r\nDTEND;TZID=Asia/Seoul:${end}\r\nSUMMARY:예약 일정\r\nURL:https://partner.spacecloud.kr/reservation/123\r\n${extra}END:VEVENT\r\n`;
const calendar = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('')}END:VCALENDAR\r\n`;
function env(config = { r1: url(1) }) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const db = { prepare(sql) {
    let args = []; const statement = {
      bind(...values) { args = values; return statement; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async run() { return { meta: sqlite.prepare(sql).run(...args) }; }
    }; return statement;
  }, async batch(stmts) {
    sqlite.exec('BEGIN'); try { const results = []; for (const s of stmts) results.push(await s.run()); sqlite.exec('COMMIT'); return results; }
    catch(e) { sqlite.exec('ROLLBACK'); throw e; }
  }};
  return { DB: db, sqlite, ADMIN_KEY: 'test-only-admin-key-not-live', SESSION_SECRET: 'test-only-config-encryption-key',
    SPACECLOUD_ICAL_FEEDS: config ? JSON.stringify(config) : undefined };
}
const response = text => new Response(text, { status: 200 });
const headers = { authorization: 'Bearer test-only-admin-key-not-live', 'content-type': 'application/json' };

// Primary feed format, time handling and safety boundaries.
test('Korea wall time and UTC convert consistently, with overnight events split into daily slots', async () => {
  const a = parseCalendar(calendar(event()));
  const b = parseCalendar(calendar(event().replace('DTSTART;TZID=Asia/Seoul:20261024T230000', 'DTSTART:20261024T140000Z').replace('DTEND;TZID=Asia/Seoul:20261025T010000', 'DTEND:20261024T160000Z')));
  assert.equal(a[0].start, b[0].start); assert.equal(a[0].end, b[0].end);
  const rows = await calendarRows(a, 'r1', 1234);
  assert.deepEqual(rows.map(r => [r.date, r.start_min, r.end_min]), [['2026-10-24',1380,1440], ['2026-10-25',0,60]]);
  assert.equal(new Set(rows.map(r => r.code)).size, 2);
  assert.notEqual(rows[0].code, (await calendarRows(a, 'r2', 1234))[0].code);
  assert(rows.every(r => r.amount === null && r.pay_status === 'unknown' && r.external));
});
test('date-only exclusive end, folded/escaped titles, and cancellation', async () => {
  const raw = event('all').replace('DTSTART;TZID=Asia/Seoul:20261024T230000','DTSTART;VALUE=DATE:20261024').replace('DTEND;TZID=Asia/Seoul:20261025T010000','DTEND;VALUE=DATE:20261026').replace('SUMMARY:예약 일정','SUMMARY:예약\\, 일\r\n 정\\n다음');
  const events = parseCalendar(calendar(raw)); assert.equal(events[0].title,'예약, 일정\n다음');
  assert.equal((await calendarRows(events, 'r1', 1)).length,2);
  assert.equal(parseCalendar(calendar(event('cancel',undefined,undefined,'STATUS:CANCELLED\r\n'))).length,0);
  assert.deepEqual(parseCalendar(calendar()),[]);
});
test('malformed calendars, duplicate UIDs, unsupported recurrence, invalid dates and URL injection fail safely', () => {
  for (const text of ['<html>error</html>',calendar(event(),event()),calendar(event('one',undefined,undefined,'RRULE:FREQ=DAILY\r\n')),
    calendar(event('one','20260230T230000')),calendar(event().replace('TZID=Asia/Seoul','TZID=Europe/Paris')),calendar(event().replace(/DTEND[^\r]+\r\n/,''))]) assert.throws(()=>parseCalendar(text));
  for(const bad of ['https://evil.invalid/','http://api.spacecloud.kr/partner/reservations/ical?product_id=1&ical_uid=x',url(1)+'&another=secret','https://api.spacecloud.kr.evil.invalid/partner/reservations/ical?product_id=1&ical_uid=x']) assert.throws(()=>validateFeedConfig({r1:bad}));
  assert.throws(()=>validateFeedConfig({r6:url(1)}));
});
test('snapshots are idempotent; cache TTL, failed/malformed fetch, disappearance and valid empty feeds work', async () => {
  const e=env();let calls=0,body=calendar(event('one','20261024T100000','20261024T120000')),fails=false;
  const fetcher=async()=>{calls++;if(fails)throw new Error('do not log private URL');return response(body);};
  const options={fetcher,now:1000000};
  const a=await loadSpacecloud(e,options),b=await loadSpacecloud(e,{...options,now:1001000});
  assert.equal(calls,1);assert.equal(a.results[0].code,b.results[0].code);
  await loadSpacecloud(e,{...options,force:true,now:1002000});assert.equal(calls,2);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM spacecloud_calendar_cache').get().n,1);
  fails=true;const failed=await loadSpacecloud(e,{...options,force:true,now:1003000});
  assert.equal(failed.results.length,1);assert(failed.info.rooms[0].error);assert.equal(failed.info.rooms[0].updated_at,1002000);
  fails=false;body='broken';assert.equal((await loadSpacecloud(e,{...options,force:true,now:1004000})).results.length,1);
  body=calendar();const empty=await loadSpacecloud(e,{...options,force:true,now:1005000});assert.equal(empty.results.length,0);assert.equal(empty.info.rooms[0].error,null);
});
test('per-room feed failures preserve other rooms and changed URLs cannot expose old-room snapshots', async()=>{
 const e=env({r1:url(1),r2:url(2)});const fetcher=async u=>u===url(1)?response(calendar(event('same','20261024T100000','20261024T110000'))):Promise.reject(new Error('offline'));
 const a=await loadSpacecloud(e,{fetcher,now:2000000});assert.equal(a.results.length,1);assert(a.info.rooms.find(r=>r.space==='r2').error);
 e.SPACECLOUD_ICAL_FEEDS=JSON.stringify({r1:url(99)});const b=await loadSpacecloud(e,{fetcher,force:true,now:2001000});assert.equal(b.results.length,0);
});
test('settings are encrypted, read without URL disclosure, and can be recovered after secret rotation', async()=>{
 const e=env(null);await saveFeedConfig(e,{r1:url(1),r2:url(2)});
 const raw=e.sqlite.prepare('SELECT payload FROM spacecloud_calendar_settings').get().payload;
 assert(!raw.includes('exampletoken')&&!raw.includes('product_id'));
 assert.equal((await readFeedConfig(e)).length,2);await saveFeedConfig(e,{r1:'',r3:url(3)});assert.equal((await readFeedConfig(e)).length,3);
 const req=new Request('https://test.invalid/api/admin/spacecloud',{headers});const originalFetch=globalThis.fetch;globalThis.fetch=async()=>response(calendar());let result;try { result=await (await getSettings({request:req,env:e})).json(); } finally { globalThis.fetch=originalFetch; } assert.deepEqual(result.rooms,['r1','r2','r3']);assert(!JSON.stringify(result).includes('exampletoken'));
 e.SESSION_SECRET='rotated-test-secret';await assert.rejects(()=>readFeedConfig(e));
 await saveFeedConfig(e,Object.fromEntries([1,2,3,4,5].map(n=>['r'+n,url(n)])));assert.equal((await readFeedConfig(e)).length,5);
});
test('manually accounted SpaceCloud slots are not displayed twice; payment filters exclude unknown amounts', async()=>{
 const rows=await calendarRows(parseCalendar(calendar(event('a','20261024T100000','20261024T120000'))),'r1',1);
 const manual=[{code:'R1',space:'r1',date:'2026-10-24',start_min:600,end_min:720,status:'confirmed',channel:'spacecloud',amount:100000}];
 assert.equal(mergeCalendarRows(manual,rows).length,1);assert.equal(mergeCalendarRows([{...manual[0],status:'cancelled'}],rows).length,2);
 assert.equal(filterExternal(rows,new URLSearchParams({pstatus:'paid'})).length,0);assert.equal(filterExternal(rows,new URLSearchParams({space:'r2'})).length,0);
 assert.equal(filterExternal(rows,new URLSearchParams({from:'2026-10-24',to:'2026-10-24'})).length,1);
});
test('admin endpoints reject anonymous requests before fetching feeds or accepting configuration', async()=>{
 const e=env();for(const handler of [getSettings,getReservations,getDashboard,configure]){
  const r=await handler({request:new Request('https://test.invalid/api/admin/spacecloud',{method:handler===configure?'POST':'GET'}),env:e});assert.equal(r.status,401);
 }
});
test('live API path merges external schedules but writes no payment/reservation rows and warns about conflicts', async()=>{
 const e=env();const oldFetch=globalThis.fetch;globalThis.fetch=async()=>response(calendar(event('a','20261024T100000','20261024T120000')));
 try{
  const req=new Request('https://test.invalid/api/admin/reservations?from=2026-10-24&to=2026-10-24',{headers});
  const data=await(await getReservations({request:req,env:e})).json();assert.equal(data.results.length,1);assert(data.results[0].external);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,0);
  const clash=await createReservation({request:new Request('https://test.invalid/api/admin/reservations',{method:'POST',headers,body:JSON.stringify({space:'r1',date:'2026-10-24',start_min:660,end_min:720,customer_name:'테스트',channel:'phone',amount:10000,pay_method:'bank_blank'})}),env:e});assert.equal(clash.status,409);
  const dash=await(await getDashboard({request:new Request('https://test.invalid/api/admin/dashboard',{headers}),env:e})).json();assert.equal(dash.month.total,0);
 }finally{globalThis.fetch=oldFetch;}
});
