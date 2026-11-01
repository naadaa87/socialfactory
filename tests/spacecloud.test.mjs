import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { parseCalendar, calendarRows, validateFeedConfig, loadSpacecloud, readFeedConfig, saveFeedConfig,
  mergeCalendarRows, filterExternal } from '../functions/_lib/spacecloud.js';
import { onRequestGet as getReservations, onRequestPost as createReservation, onRequestPatch as updateReservation } from '../functions/api/admin/reservations.js';
import { onRequestGet as getDashboard } from '../functions/api/admin/dashboard.js';
import { onRequestGet as getSettings, onRequestPost as configure } from '../functions/api/admin/spacecloud.js';
import { calendarReservationId, attachCalendarPayments } from '../functions/_lib/spacecloud-sales.js';
import { onRequestPost as importHistory } from '../functions/api/admin/spacecloud-history.js';

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
test('date-bounded calendar rows only hash and return days visible in the requested month', async () => {
  const events = parseCalendar(calendar(
    event('oct','20261031T230000','20261101T010000'),
    event('dec','20261201T100000','20261201T120000')));
  const october = await calendarRows(events, 'r1', 1, { from:'2026-10-01', to:'2026-10-31' });
  const november = await calendarRows(events, 'r1', 1, { from:'2026-11-01', to:'2026-11-30' });
  assert.deepEqual(october.map(r => r.date), ['2026-10-31']);
  assert.deepEqual(november.map(r => r.date), ['2026-11-01']);
  assert.equal(october[0].end_min, 1440);
  assert.equal(november[0].start_min, 0);
  assert.equal((await calendarRows(events, 'r1', 1)).length, 3);
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

test('calendar booking links display imported payments once without changing revenue or allowing duplicate manual entry', async()=>{
 const e=env();const original=globalThis.fetch;
 globalThis.fetch=async()=>response(calendar(event('linked','20261024T100000','20261024T120000')));
 try{
  e.sqlite.exec("INSERT INTO spacecloud_sales(reservation_id,use_date,end_date,paid_at,amount,refund_amount,space) VALUES('123','2026-10-24','2026-10-24','2026-10-20',40000,10000,'r1')");
  const req=new Request('https://test.invalid/api/admin/reservations?from=2026-10-24&to=2026-10-24',{headers});
  const data=await(await getReservations({request:req,env:e})).json();
  assert.equal(data.results.length,1);assert.equal(data.results[0].amount,null);
  assert.deepEqual(data.results[0].payment,{reservation_id:'123',amount:40000,refund_amount:10000,paid_at:'2026-10-20',use_date:'2026-10-24',end_date:'2026-10-24'});
  const sourceCode=data.results[0].code;
  const denied=await createReservation({env:e,request:new Request('https://test.invalid/api/admin/reservations',{method:'POST',headers,body:JSON.stringify({sourceCode,amount:40000,paid_at:'2026-10-20'})})});
  assert.equal(denied.status,400);assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,0);
  const {onRequestGet:sales}=await import('../functions/api/admin/sales.js');
  const total=await(await sales({env:e,request:new Request('https://test.invalid/api/admin/sales?year=2026',{headers})})).json();
  assert.equal(total.total,30000);assert.equal(total.n,1);
  assert.equal(calendarReservationId('https://partner.spacecloud.kr/reservation/123'),'123');
  for(const bad of ['https://evil.test/reservation/123','https://partner.spacecloud.kr/reservation/123?other=1','https://partner.spacecloud.kr/reservation/nope'])assert.equal(calendarReservationId(bad),null);
  const {payment, ...calendarRow}=data.results[0];
  const mismatch=await attachCalendarPayments(e,[{...calendarRow,date:'2026-10-25'}]);
  assert.equal(mismatch[0].payment_conflict,true);assert.equal(mismatch[0].payment,undefined);
 }finally{globalThis.fetch=original;e.sqlite.close();}
});

test('verified completed HOST bookings restore missing past slots without adding revenue twice', async()=>{
 const e=env(), original=globalThis.fetch;
 globalThis.fetch=async()=>response(calendar());
 try {
  e.sqlite.exec("INSERT INTO spacecloud_sales(reservation_id,use_date,end_date,paid_at,amount,refund_amount,space) VALUES('987654321','2026-10-24','2026-10-24','2026-10-18',54321,0,'r1')");
  const item={reservation_id:'987654321',venue:'소셜팩토리 건대 (초특가)',status:'USEDC',space:'r1',date:'2026-10-24',start_min:540,end_min:960};
  const call=(action,rows=[item])=>importHistory({env:e,request:new Request('https://test.invalid/api/admin/spacecloud-history',{method:'POST',headers,body:JSON.stringify({action,rows})})});
  assert.equal((await (await call('preview')).json()).new_count,1);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_calendar_history').get().n,0);
  assert.equal((await call('commit')).status,200);
  assert.equal((await (await call('commit')).json()).new_count,0);
  const r=await(await getReservations({env:e,request:new Request('https://test.invalid/api/admin/reservations?from=2026-10-24&to=2026-10-24',{headers})})).json();
  assert.equal(r.results.length,1);assert.equal(r.results[0].start_min,540);assert.equal(r.results[0].end_min,960);
  assert.equal(r.results[0].payment.amount,54321);assert.equal(r.results[0].historical,true);
  globalThis.fetch=async()=>response(calendar(event('same-id','20261024T090000','20261024T160000').replace('/reservation/123','/reservation/987654321')));
  await loadSpacecloud(e,{force:true});
  const live=await(await getReservations({env:e,request:new Request('https://test.invalid/api/admin/reservations?from=2026-10-24&to=2026-10-24',{headers})})).json();
  assert.equal(live.results.length,1);assert.equal(live.results[0].historical,undefined);
  const {onRequestGet:getSales}=await import('../functions/api/admin/sales.js');
  const sales=await(await getSales({env:e,request:new Request('https://test.invalid/api/admin/sales?year=2026',{headers})})).json();
  assert.equal(sales.total,54321);assert.equal(sales.n,1);
  assert.equal((await call('commit',[{...item,reservation_id:'999'}])).status,409);
  assert.equal((await call('commit',[{...item,venue:'다른 매장'}])).status,409);
 } finally {globalThis.fetch=original;e.sqlite.close();}
});

test('a previously seen paid calendar booking remains after the feed drops it; vanished future slots do not',async()=>{
 const e=env();let body=calendar(event('keep','20261024T100000','20261024T120000'));
 const fetcher=async()=>response(body),before=Date.parse('2026-10-23T00:00:00Z'),after=Date.parse('2026-10-25T00:00:00Z');
 e.sqlite.exec("INSERT INTO spacecloud_sales(reservation_id,use_date,end_date,paid_at,amount,refund_amount,space) VALUES('123','2026-10-24','2026-10-24','2026-10-20',40000,0,'r1')");
 await loadSpacecloud(e,{fetcher,force:true,now:before});body=calendar();
 const past=await loadSpacecloud(e,{fetcher,force:true,now:after});
 assert.equal(past.results.length,1);assert.equal(past.results[0].historical,true);
 const e2=env();body=calendar(event('cancelled-before-use','20261024T100000','20261024T120000'));
 await loadSpacecloud(e2,{fetcher,force:true,now:before});body=calendar();
 const removed=await loadSpacecloud(e2,{fetcher,force:true,now:before+600000});
 assert.equal(removed.results.length,0);
 assert.equal(e2.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_calendar_history').get().n,0);
 e.sqlite.close();e2.sqlite.close();
});
test('date-bounded history preserves a past paid booking only in its month', async () => {
  const e = env(); let body = calendar(event('paid-past','20261024T100000','20261024T120000'));
  const fetcher = async () => response(body);
  const before = Date.parse('2026-10-23T00:00:00Z'), after = Date.parse('2026-10-25T00:00:00Z');
  e.sqlite.exec("INSERT INTO spacecloud_sales(reservation_id,use_date,end_date,paid_at,amount,refund_amount,space) VALUES('123','2026-10-24','2026-10-24','2026-10-20',40000,0,'r1')");
  await loadSpacecloud(e,{fetcher,force:true,now:before}); body = calendar();
  const october = await loadSpacecloud(e,{fetcher,force:true,now:after,from:'2026-10-01',to:'2026-10-31'});
  const november = await loadSpacecloud(e,{fetcher,now:after+1000,from:'2026-11-01',to:'2026-11-30'});
  assert.equal(october.results.length, 1);
  assert.equal(october.results[0].historical, true);
  assert.equal(november.results.length, 0);
  e.sqlite.close();
});

test('host-added bookings without a payment ID survive expiry individually with stable codes and no revenue', async () => {
  const e=env(), before=Date.parse('2026-10-31T00:00:00Z'), after=Date.parse('2026-11-01T00:00:00Z');
  const manual=(uid,start,end)=>event(uid,start,end).replace(/URL:[^\r]+\r\n/,'');
  let body=calendar(manual('host-added-one','20261031T150000','20261031T170000'),
    manual('host-added-two','20261031T180000','20261031T200000'));
  const fetcher=async()=>response(body);
  const live=await loadSpacecloud(e,{fetcher,force:true,now:before});
  assert.equal(live.results.length,2);
  body=calendar();
  const past=await loadSpacecloud(e,{fetcher,force:true,now:after,from:'2026-10-01',to:'2026-10-31'});
  assert.deepEqual(past.results.map(r=>r.code).sort(),live.results.map(r=>r.code).sort());
  assert(past.results.every(r=>r.historical&&r.amount===null&&r.pay_status==='unknown'&&r.source_url===''));
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,0);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sales').get().n,0);
  assert.equal((await loadSpacecloud(e,{fetcher,now:after+1000,from:'2026-11-01',to:'2026-11-30'})).results.length,0);
  // A returning feed must not double either anonymous booking or collapse both into one.
  body=calendar(manual('host-added-one','20261031T150000','20261031T170000'));
  const returned=await loadSpacecloud(e,{fetcher,force:true,now:after+2000});
  assert.equal(returned.results.length,2);
  assert.equal(new Set(returned.results.map(r=>r.code)).size,2);
  e.sqlite.close();
});

test('host-added future cancellation, rescheduling and changed feed links do not resurrect old slots', async () => {
  const e=env(), now=Date.parse('2026-10-30T00:00:00Z');
  let body=calendar(event('host-added','20261031T150000','20261031T170000').replace(/URL:[^\r]+\r\n/,''));
  const fetcher=async()=>response(body);
  await loadSpacecloud(e,{fetcher,force:true,now});
  body=calendar(event('host-added','20261101T150000','20261101T170000').replace(/URL:[^\r]+\r\n/,''));
  await loadSpacecloud(e,{fetcher,force:true,now:now+1000});
  body=calendar();
  assert.equal((await loadSpacecloud(e,{fetcher,force:true,now:now+2000})).results.length,0);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_calendar_history').get().n,0);
  body=calendar(event('host-added','20261031T150000','20261031T170000').replace(/URL:[^\r]+\r\n/,''));
  await loadSpacecloud(e,{fetcher,force:true,now:now+3000});
  e.SPACECLOUD_ICAL_FEEDS=JSON.stringify({r1:url(99)});body=calendar();
  assert.equal((await loadSpacecloud(e,{fetcher,force:true,now:Date.parse('2026-11-02T00:00:00Z')})).results.length,0);
  e.sqlite.close();
});

test('upgrade salvages host-added events from the last good cache before its first replacement', async () => {
  const e=env(), before=Date.parse('2026-10-31T00:00:00Z'), after=Date.parse('2026-11-01T00:00:00Z');
  let body=calendar(event('old-cache-only','20261031T150000','20261031T170000').replace(/URL:[^\r]+\r\n/,''));
  const fetcher=async()=>response(body);
  const live=await loadSpacecloud(e,{fetcher,force:true,now:before});
  // Simulate the old implementation, which never archived manual calendar entries.
  e.sqlite.exec('DELETE FROM spacecloud_calendar_history');body=calendar();
  const past=await loadSpacecloud(e,{fetcher,force:true,now:after});
  assert.equal(past.results.length,1);
  assert.equal(past.results[0].code,live.results[0].code);
  e.sqlite.close();
});

test('rotating upstream UIDs keep booking codes stable and do not multiply current or historical manual events', async()=>{
 const e=env(),before=Date.parse('2026-10-30T00:00:00Z'),after=Date.parse('2026-11-01T00:00:00Z');
 let sequence=0,empty=false;
 const fetcher=async()=>response(empty?calendar():calendar(
   event('random-paid-'+(++sequence),'20261031T100000','20261031T120000'),
   event('random-manual-'+sequence,'20261031T150000','20261031T170000').replace(/URL:[^\r]+\r\n/,'')
 ));
 const first=await loadSpacecloud(e,{fetcher,force:true,now:before});
 for(let n=1;n<=3;n++){
  const again=await loadSpacecloud(e,{fetcher,force:true,now:before+n*600000});
  assert.deepEqual(again.results.map(r=>r.code),first.results.map(r=>r.code));
 }
 assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_calendar_history').get().n,2);
 // Previously deployed versions persisted every random UID. Read those legacy
 // records by the same logical identity too, without deleting historical data.
 e.sqlite.exec("INSERT INTO spacecloud_calendar_history SELECT space,'legacy-random-copy',reservation_id,config_hash,start_ms,end_ms,title,source,recorded_at FROM spacecloud_calendar_history WHERE reservation_id='' LIMIT 1");
 empty=true;
 const past=await loadSpacecloud(e,{fetcher,force:true,now:after});
 assert.equal(past.results.length,2);
 assert.deepEqual(past.results.map(r=>r.code).sort(),first.results.map(r=>r.code).sort());
 e.sqlite.close();
});

test('explicit past cancellations and host-verified removals suppress archived copies',async()=>{
 const e=env(),before=Date.parse('2026-10-30T00:00:00Z'),after=Date.parse('2026-11-01T00:00:00Z');
 let body=calendar(event('live','20261031T100000','20261031T120000'));
 const fetcher=async()=>response(body);
 await loadSpacecloud(e,{fetcher,force:true,now:before});
 e.sqlite.exec("INSERT INTO spacecloud_calendar_history SELECT space,'legacy-copy',reservation_id,config_hash,start_ms,end_ms,title,source,recorded_at FROM spacecloud_calendar_history LIMIT 1");
 body=calendar(event('new-random-cancel','20261031T100000','20261031T120000','STATUS:CANCELLED\r\n'));
 assert.equal((await loadSpacecloud(e,{fetcher,force:true,now:after})).results.length,0);
 body=calendar(event('restored','20261031T100000','20261031T120000'));
 assert.equal((await loadSpacecloud(e,{fetcher,force:true,now:after+1000})).results.length,1);
 e.sqlite.exec("INSERT OR IGNORE INTO spacecloud_calendar_history SELECT space,'legacy-copy',reservation_id,config_hash,start_ms,end_ms,title,source,recorded_at FROM spacecloud_calendar_history WHERE source='feed' LIMIT 1");
 e.sqlite.exec("UPDATE spacecloud_calendar_history SET source='host_cancelled' WHERE uid='legacy-copy'");
 body=calendar();
 assert.equal((await loadSpacecloud(e,{fetcher,force:true,now:after+2000})).results.length,0);
 e.sqlite.close();
});

test('removed future calendar-backed payments disappear from schedules while their financial records remain',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-01T08:00:00Z')});
 const e=env(),original=globalThis.fetch;
 const code='SC1-0123456789abcdef';
 e.sqlite.exec(`INSERT INTO reservations(code,status,space,date,start_min,end_min,customer_name,channel,amount,pay_method,pay_status,paid_at,memo)
 VALUES('${code}','confirmed','r1','2026-11-08',600,840,'예약 일정','spacecloud',40000,'spacecloud','paid','2026-11-01','외부 일정 연결: ${code}')`);
 const req=new Request('https://test.invalid/api/admin/reservations?from=2026-11-01&to=2026-11-30',{headers});
 try{
  globalThis.fetch=async()=>response(calendar(event('volatile','20261108T100000','20261108T140000').replace(/URL:[^\r]+\r\n/,'')));
  assert.equal((await(await getReservations({env:e,request:req})).json()).results.length,1);
  globalThis.fetch=async()=>response(calendar());await loadSpacecloud(e,{force:true});
  assert.equal((await(await getReservations({env:e,request:req})).json()).results.length,0);
  assert.equal(e.sqlite.prepare('SELECT amount FROM reservations').get().amount,40000);
  const {onRequestGet:sales}=await import('../functions/api/admin/sales.js');
  const total=await(await sales({env:e,request:new Request('https://test.invalid/api/admin/sales?year=2026',{headers})})).json();
  assert.equal(total.total,40000);
  globalThis.fetch=async()=>response(calendar(event('new-id','20261108T100000','20261108T140000').replace(/URL:[^\r]+\r\n/,'')));
  await loadSpacecloud(e,{force:true,from:'2026-10-01',to:'2026-10-31'});
  assert.equal((await(await getReservations({env:e,request:req})).json()).results.length,1);
  globalThis.fetch=async()=>{throw Error('offline')};await loadSpacecloud(e,{force:true});
  assert.equal((await(await getReservations({env:e,request:req})).json()).results.length,1);
  globalThis.fetch=async()=>response(calendar());await loadSpacecloud(e,{force:true});
  globalThis.fetch=async()=>{throw Error('offline')};await loadSpacecloud(e,{force:true});
  assert.equal((await(await getReservations({env:e,request:req})).json()).results.length,0);
  t.mock.timers.tick(8*86400000);
  // Crossing the original end time must not resurrect a cancelled paid slot.
  assert.equal((await(await getReservations({env:e,request:req})).json()).results.length,0);
 }finally{globalThis.fetch=original;e.sqlite.close();}
});

test('reconciliation keeps local/past bookings, requires a healthy room feed, and uses unfiltered source rows',()=>{
 const now=Date.parse('2026-11-01T08:00:00Z');
 const linked={code:'SC1-0123456789abcdef',space:'r1',date:'2026-11-08',start_min:600,end_min:840,customer_name:'예약 일정',channel:'spacecloud',status:'confirmed'};
 const info={configured:true,rooms:[{space:'r1',updated_at:now,error:null,stale:false}]};
 const same={...linked,external:true,code:'SC1-fedcba9876543210'};
 assert.equal(mergeCalendarRows([linked],[],{info,now}).length,0);
 assert.equal(mergeCalendarRows([linked],[],{info,now,sourceRows:[same]}).length,1);
 for(const changed of [{code:'R1'},{channel:'phone'},{date:'2026-10-31'}]) assert.equal(mergeCalendarRows([{...linked,...changed}],[],{info,now}).length,1);
 for(const changed of [{configured:false},{error:'offline'},{rooms:[]},{rooms:[{space:'r1',updated_at:now,error:'offline'}]},{rooms:[{space:'r1',updated_at:now,stale:true}]}])assert.equal(mergeCalendarRows([linked],[],{info:{...info,...changed},now}).length,1);
 assert.equal(mergeCalendarRows([linked],[],{now}).length,1);
});

test('uses the Workers-supported manual redirect policy and refuses redirected feeds', async()=>{
 const e=env();let calls=0;
 const fetcher=async(u,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response('',{status:302,headers:{location:'https://untrusted.invalid/private'}});};
 const data=await loadSpacecloud(e,{fetcher,force:true,now:3000000});
 assert.equal(calls,1);assert.equal(data.results.length,0);assert(data.info.rooms[0].error.includes('HTTP 302'));
});

test('SpaceCloud actual revenue is idempotent and included in totals, channel shares and dashboard', async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-25T03:00:00Z')});
 const e=env(); const original=globalThis.fetch;
 globalThis.fetch=async()=>response(calendar(event('revenue','20261024T100000','20261024T120000')));
 try {
  const feed=await loadSpacecloud(e); const sourceCode=feed.results[0].code;
  const post=body=>createReservation({request:new Request('https://test.invalid/api/admin/reservations',{method:'POST',headers,body:JSON.stringify(body)}),env:e});
  assert.equal((await post({sourceCode,amount:123.5,paid_at:'2026-10-20'})).status,400);
  assert.equal((await post({sourceCode,amount:100000})).status,400);
  const first=await post({sourceCode,amount:100000,paid_at:'2026-10-20',space:'r5',channel:'naver'});
  assert.equal(first.status,200);const data=await first.json();assert.equal(data.item.channel,'spacecloud');assert.equal(data.item.space,'r1');
  const again=await(await post({sourceCode,amount:900000,paid_at:'2026-10-20'})).json();assert(again.already);assert.equal(again.item.amount,100000);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,1);
  e.sqlite.exec("INSERT INTO reservations (code,status,space,date,start_min,end_min,customer_name,channel,amount,pay_method,pay_status,paid_at) VALUES ('NAVER1','confirmed','r2','2026-10-24',600,720,'네이버 고객','naver',50000,'card_online','paid','2026-10-22')");
  e.sqlite.exec("INSERT INTO orders (oid,status,product_id,product_name,qty,amount,buyer_name,buyer_phone,pay_method,device,test_mode,paid_at) VALUES ('WEB1','paid','cowork-day','이용권',1,10000,'홈페이지','01012345678','card','pc',0,'2026-10-23')");
  const {onRequestGet:getSales}=await import('../functions/api/admin/sales.js');
  const query=async tail=>(await getSales({request:new Request('https://test.invalid/api/admin/sales?year=2026'+tail,{headers}),env:e})).json();
  const sales=await query('');assert.equal(sales.total,160000);assert.equal(sales.byChannel.spacecloud.amount,100000);assert.equal(sales.byChannel.naver.amount,50000);assert.equal(sales.byChannel.web.amount,10000);assert.equal(sales.unrecordedSpacecloud,0);
  assert.equal(Object.values(sales.byChannel).reduce((n,x)=>n+x.amount,0),sales.total);
  assert.equal((await query('&orders=0')).total,150000);assert.equal((await query('&basis=paid')).total,160000);
  const dash=await(await getDashboard({request:new Request('https://test.invalid/api/admin/dashboard',{headers}),env:e})).json();assert.equal(dash.month.byChannel.spacecloud.amount,100000);
  e.sqlite.exec("UPDATE reservations SET refund_amount=20000,pay_status='refunded' WHERE channel='spacecloud'");
  assert.equal((await query('')).byChannel.spacecloud.amount,80000);
 } finally {globalThis.fetch=original;e.sqlite.close();}
});

test('multi-day calendar slots cannot accidentally book the full payment on every date',async()=>{
 const e=env();const original=globalThis.fetch;globalThis.fetch=async()=>response(calendar(event()));
 try {const rows=await loadSpacecloud(e);const result=await createReservation({env:e,request:new Request('https://test.invalid/api/admin/reservations',{method:'POST',headers,body:JSON.stringify({sourceCode:rows.results[0].code,amount:100000,paid_at:'2026-10-20'})})});assert.equal(result.status,400);assert.equal(e.sqlite.prepare('SELECT COUNT(*) AS n FROM reservations').get().n,0);}
 finally{globalThis.fetch=original;e.sqlite.close();}
});

test('settlement import previews without writes, rejects ambiguity, and totals gross less refund once', async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-25T03:00:00Z')});
  const {onRequestPost:importSales}=await import('../functions/api/admin/spacecloud-import.js');
  const {onRequestGet:sales}=await import('../functions/api/admin/sales.js');
  const e=env(null);const call=async(action,rows)=>importSales({env:e,request:new Request('https://example.test/api/admin/spacecloud-import',{method:'POST',headers,body:JSON.stringify({action,rows})})});
  const row={reservation_id:'1234',venue:'소셜팩토리 건대 (초특가)',use_date:'2026-10-19',end_date:'2026-10-19',paid_at:'2026-10-18',amount:20000,refund_amount:2000};
  assert.equal((await (await call('preview',[row])).json()).total,18000);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sales').get().n,0);
  await call('commit',[row]);await call('commit',[row]);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sales').get().n,1);
  const d=await (await sales({env:e,request:new Request('https://example.test/api/admin/sales?year=2026',{headers})})).json();
  assert.equal(d.total,18000);assert.equal(d.byChannel.spacecloud.amount,18000);assert.equal(d.thisMonth.total,18000);
  const dash=await(await getDashboard({env:e,request:new Request('https://example.test/api/admin/dashboard',{headers})})).json();assert.equal(dash.month.total,18000);
  for(const changed of [{amount:21000},{venue:'다른 지점'},{refund_amount:20001},{paid_at:'2026-02-30'}]) assert.equal((await call('commit',[{...row,...changed}])).status,409);
  assert.equal((await call('commit',[row,row])).status,409);
  assert.equal(e.sqlite.prepare('SELECT amount FROM spacecloud_sales').get().amount,20000);
  const anonymous=await importSales({env:e,request:new Request('https://example.test/',{method:'POST'})});assert.equal(anonymous.status,401);
});

test('settlement linked to a calendar-backed manual sale does not count twice',async()=>{
  const {onRequestPost:importSales}=await import('../functions/api/admin/spacecloud-import.js');
  const {onRequestGet:sales}=await import('../functions/api/admin/sales.js');
  const e=env();const raw=calendar(event('linked','20261024T100000','20261024T120000'));
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>response(raw);
  try{
    const [source]= (await loadSpacecloud(e)).results;
    await createReservation({env:e,request:new Request('https://example.test/',{method:'POST',headers,body:JSON.stringify({sourceCode:source.code,amount:20000,paid_at:'2026-10-23'})})});
    const row={reservation_id:'123',venue:'소셜팩토리 건대 (초특가)',use_date:'2026-10-24',end_date:'2026-10-24',paid_at:'2026-10-23',amount:20000,refund_amount:0};
    const r=await importSales({env:e,request:new Request('https://example.test/',{method:'POST',headers,body:JSON.stringify({action:'commit',rows:[row]})})});assert.equal(r.status,200);
    const d=await(await sales({env:e,request:new Request('https://example.test/?year=2026',{headers})})).json();assert.equal(d.total,20000);assert.equal(d.n,1);assert.equal(d.unrecordedSpacecloud,0);
    assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,1);
  }finally{globalThis.fetch=originalFetch;}
});

test('pre-settlement payment and later settlement share one ID; future use is counted by paid month',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-25T03:00:00Z')});
 const {onRequestPost:importSales}=await import('../functions/api/admin/spacecloud-import.js');
 const {onRequestGet:sales}=await import('../functions/api/admin/sales.js');
 const e=env(null);const row={reservation_id:'999',venue:'소셜팩토리 건대 (초특가)',use_date:'2026-11-06',end_date:'2026-11-06',paid_at:'2026-10-24',amount:45000,refund_amount:0};
 const call=(rows,source)=>importSales({env:e,request:new Request('https://example.test/',{method:'POST',headers,body:JSON.stringify({action:'commit',rows,source})})});
 await call([row],'host-draft');await call([row],'settlement-xlsx');
 const get=async basis=>(await(await sales({env:e,request:new Request('https://example.test/?year=2026'+(basis?'&basis='+basis:''),{headers})})).json());
 const paid=await get();assert.equal(paid.basis,'paid');assert.equal(paid.total,45000);assert.equal(paid.n,1);assert.equal(paid.months[9].total,45000);assert.equal(paid.months[10].total,0);
 const use=await get('use');assert.equal(use.months[9].total,0);assert.equal(use.months[10].total,45000);
 const d=await(await getDashboard({env:e,request:new Request('https://example.test/',{headers})})).json();assert.equal(d.month.total,45000);
 assert.equal((await call([{...row,refund_amount:45000}],'host-draft')).status,409);
 assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sales').get().n,1);
});

test('an explicitly relinked replacement payment counts once and preserves original payment and refund evidence', async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-01T08:00:00Z')});
 const e=env(null);
 const {onRequestGet:getSales}=await import('../functions/api/admin/sales.js');
 const query=async()=>(await(await getSales({env:e,request:new Request('https://test.invalid/api/admin/sales?year=2026',{headers})})).json());
 e.sqlite.exec(`INSERT INTO reservations(code,status,space,date,start_min,end_min,customer_name,channel,amount,pay_method,pay_status,paid_at)
 VALUES('OLD1','confirmed','r1','2026-11-08',600,840,'예약 일정','spacecloud',40000,'spacecloud','paid','2026-11-01'),
 ('NEW2','confirmed','r2','2026-11-08',600,780,'예약 일정','spacecloud',55000,'spacecloud','paid','2026-11-01')`);
 assert.equal((await query()).total,95000);
 const link=()=>e.sqlite.exec("INSERT INTO reservation_payment_relinks(original_code,replacement_code,note) VALUES('OLD1','NEW2','관리자 확인: 같은 예약의 대체 결제 기록') ON CONFLICT(original_code) DO NOTHING");
 link();link();
 const result=await query();assert.equal(result.total,55000);assert.equal(result.n,1);
 assert.equal(result.bySpace.r1.amount,0);assert.equal(result.bySpace.r2.amount,55000);
 assert.equal(result.byChannel.spacecloud.amount,55000);assert.equal(result.thisMonth.total,55000);
 const dash=await(await getDashboard({env:e,request:new Request('https://test.invalid/api/admin/dashboard',{headers})})).json();
 assert.equal(dash.month.total,55000);assert.equal(dash.month.reservationsN,1);
 assert.deepEqual({...e.sqlite.prepare("SELECT amount,refund_amount,paid_at FROM reservations WHERE code='OLD1'").get()},
  {amount:40000,refund_amount:0,paid_at:'2026-11-01'});
 assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,2);
 // A later settlement link to the original must not reintroduce its amount.
 e.sqlite.exec("INSERT INTO spacecloud_sales(reservation_id,use_date,end_date,paid_at,amount,refund_amount,space,linked_code) VALUES('999','2026-11-08','2026-11-08','2026-11-01',40000,0,'r1','OLD1')");
 assert.equal((await query()).total,55000);
 e.sqlite.exec("UPDATE reservations SET refund_amount=10000,pay_status='refunded' WHERE code='NEW2'");
 const refunded=await query();assert.equal(refunded.total,45000);assert.equal(refunded.refunds,10000);
 e.sqlite.close();
});

test('verified host-added amounts can be registered and edited beside unrelated same-day imports, without duplicates',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-01T08:00:00Z')});
 const e=env({r3:url(3)}),original=globalThis.fetch;
 const raw=calendar(event('changing-uid','20261030T220000','20261031T000000').replace(/URL:[^\r]+\r\n/,''));
 globalThis.fetch=async()=>response(raw);
 try{
  e.sqlite.exec("INSERT INTO spacecloud_sales(reservation_id,use_date,end_date,paid_at,amount,refund_amount,space) VALUES('888','2026-10-30','2026-10-30','2026-10-25',50000,0,'r3')");
  const source=(await loadSpacecloud(e)).results[0];
  const post=body=>createReservation({env:e,request:new Request('https://test.invalid/api/admin/reservations',{method:'POST',headers,body:JSON.stringify(body)})});
  const body={sourceCode:source.code,amount:30000,paid_at:'2026-10-30'};
  const created=await post(body);assert.equal(created.status,200);
  assert.equal((await(await post(body)).json()).already,true);
  const saved=(await created.json()).item;
  const updated=await updateReservation({env:e,request:new Request('https://test.invalid/api/admin/reservations',{method:'PATCH',headers,body:JSON.stringify({...saved,action:'update',amount:35000})})});
  assert.equal(updated.status,200);assert.equal((await updated.json()).item.amount,35000);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,1);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM spacecloud_sales').get().n,1);
  const {onRequestGet:sales}=await import('../functions/api/admin/sales.js');
  const total=await(await sales({env:e,request:new Request('https://test.invalid/api/admin/sales?year=2026',{headers})})).json();
  assert.equal(total.total,85000);assert.equal(total.n,2);
  // A copied slot under a legacy code is recognized rather than charged again.
  e.sqlite.prepare("UPDATE reservations SET code='SC3-0000000000000000'").run();
  assert.equal((await(await post(body)).json()).already,true);
  assert.equal(e.sqlite.prepare('SELECT COUNT(*) n FROM reservations').get().n,1);
  // Ordinary unverified entries keep the existing same-day ambiguity check.
  assert.equal((await post({space:'r3',date:'2026-10-30',start_min:600,end_min:720,customer_name:'다른 예약',channel:'spacecloud',amount:10000,pay_method:'spacecloud',paid_at:'2026-10-30'})).status,400);
 }finally{globalThis.fetch=original;e.sqlite.close();}
});
