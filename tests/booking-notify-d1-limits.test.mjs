import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {prepareBookings,kstTimestamp} from '../functions/_lib/booking.js';
import {ensureBookingNotifications,runBookingNotifications} from '../functions/_lib/booking-notify.js';

// Node's SQLite binding cannot lower SQLITE_LIMIT_COMPOUND_SELECT. Replay the
// actual D1 operations in Python's SQLite with the production limit instead.
// Nothing here copies or parses the notification query from its source file.
const replayUnderD1Limit=String.raw`
import json, sqlite3, sys
data=json.load(sys.stdin)
db=sqlite3.connect(':memory:',isolation_level=None)
db.row_factory=sqlite3.Row
if not hasattr(db,'setlimit'):
    raise RuntimeError('Python 3.11+ sqlite3.setlimit is required for the D1 SQL limit regression test')
db.setlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT,5)
assert db.getlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT)==5
try:
    db.execute(' UNION ALL '.join(['SELECT 1']*6))
except sqlite3.OperationalError as error:
    assert 'too many terms in compound SELECT' in str(error)
else:
    raise AssertionError('The SQLite connection did not enforce the compound SELECT limit')
db.executescript(data['schema'])
for index,step in enumerate(data['steps']):
    try:
        cursor=db.execute(step['sql'],step.get('args',[]))
        if step['mode']=='first': cursor.fetchone()
        elif step['mode']=='all': cursor.fetchall()
    except sqlite3.Error as error:
        if step.get('error')==str(error): continue
        raise AssertionError(f"Runtime D1 operation {index} ({step['mode']}) failed: {error}") from error
    if 'error' in step:
        raise AssertionError(f'Runtime operation {index} unexpectedly succeeded during replay')
rows=db.execute('SELECT code,kind,version,recipient,last4,state,message_id FROM booking_notifications ORDER BY code,kind,version,recipient').fetchall()
print(json.dumps({'limit':db.getlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT),'operations':len(data['steps']),'notifications':[dict(row) for row in rows]}))
`;

function fixture(t) {
  const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(schema);t.after(()=>sqlite.close());
  const steps=[];
  const execute=(sql,args,mode)=>{
    const entry={sql,args:[...args],mode};steps.push(entry);
    try {
      if(mode==='exec'){sqlite.exec(sql);return;}
      const statement=sqlite.prepare(sql);
      if(mode==='first')return statement.get(...args)||null;
      if(mode==='all')return {results:statement.all(...args)};
      return {meta:statement.run(...args)};
    }catch(error){entry.error=error.message;throw error;}
  };
  const DB={prepare(sql){let args=[];const q={bind(...values){args=values;return q;},
    async first(){return execute(sql,args,'first');},async all(){return execute(sql,args,'all');},async run(){return execute(sql,args,'run');}};return q;},
    async batch(statements){execute('BEGIN',[],'exec');try{const result=[];for(const q of statements)result.push(await q.run());execute('COMMIT',[],'exec');return result;}catch(error){execute('ROLLBACK',[],'exec');throw error;}}};
  const now=Date.now(),at=kstTimestamp(now),start=kstTimestamp(now-30*60000);
  return {sqlite,schema,steps,at,now,env:{DB,BOOKING_NOTIFY_START:start,BOOKING_NOTIFY_STAFF:'01011112222,01033334444',
    BOOKING_NOTIFY_CUSTOMER:'0',BOOKING_NOTIFY_LIVE:'1',ALIGO_API_KEY:'test-only-key',ALIGO_USER_ID:'test-only-user',ALIGO_SENDER:'021234567'}};
}

async function seed(f,{code,status='confirmed',payment='paid',provider='paid',refund=0,sync=null,age=0},index) {
  const date=new Date(f.now+(index+5)*86400000+9*3600000).toISOString().slice(0,10);
  const updated=kstTimestamp(f.now-age),paid=provider==='paid'||provider==='partial_refund'||provider==='refunded'||provider==='review';
  const mul=String(10000+index),DB=f.env.DB;
  await DB.prepare(`INSERT INTO booking_requests(code,submission_id,fingerprint,created_at,updated_at,status,room,date,start_min,end_min,people,customer_name,phone,purpose,amount,consent,notice_version,payment_status,payment_id,paid_at,refund_amount)
    VALUES(?,?,?, ?,?,?, 'r1',?,600,720,6,'테스트 예약자','01012345678','meeting',40000,1,'test',?,?,?,?)`)
    .bind(code,code,'test-'+code,updated,updated,status,date,payment,mul,paid?updated:null,refund).run();
  if(provider)await DB.prepare(`INSERT INTO booking_payapp_requests(code,kind,label,amount,token,mul_no,status,paid_at,refund_amount,provider_state)
    VALUES(?,'room','D1 SQL limit fixture',40000,?,?,?, ?,?,?)`)
    .bind(code,'token-'+code,mul,provider,paid?updated:null,refund,paid?'4':null).run();
  if(sync)await DB.prepare(`INSERT INTO spacecloud_blocks(code,room,date,start_min,end_min,marker,access_token,state,created_at,updated_at)
    VALUES(?,'r1',?,600,720,?,?,?, ?,?)`)
    .bind(code,date,'SFWEB:'+code,'access-'+code,sync,f.now-age,f.now-age).run();
  if(payment==='paid_verifying')await DB.prepare('INSERT INTO spacecloud_payment_checks(code,after_ms) VALUES(?,?)').bind(code,f.now-age).run();
}

test('booking notification runtime SQL executes under D1 compound SELECT limit 5 and preserves all operator event types',async t=>{
  const f=fixture(t);await prepareBookings(f.env);await ensureBookingNotifications(f.env);
  const events=[
    {code:'B-D1-CONFIRMED',kind:'confirmed'},
    {code:'B-D1-PARTIAL',kind:'partial',payment:'refund_pending',provider:'partial_refund',refund:10000},
    {code:'B-D1-CANCELLED',kind:'cancelled',status:'cancelled',payment:'refunded',provider:'refunded',refund:40000},
    {code:'B-D1-REVIEW',kind:'review',status:'payment_review',payment:'review',provider:'review'},
    {code:'B-D1-DELAY',kind:'paid_delay',status:'awaiting_payment',payment:'paid_verifying',sync:'blocked',age:3*60000},
    {code:'B-D1-SYNC',kind:'sync_issue',status:'awaiting_payment',payment:'sync_pending',provider:null,sync:'pending',age:6*60000}
  ];
  for(const [index,event] of events.entries())await seed(f,event,index);
  await f.env.DB.prepare('INSERT INTO booking_integration_health(id,unavailable,incident_at,checked_at) VALUES(1,1,?,?)').bind(f.now-60000,f.now).run();
  // A lifecycle notice queued before payment must be discarded after confirmation.
  await f.env.DB.prepare("INSERT INTO booking_notifications(code,kind,version,recipient,last4) VALUES('B-D1-CONFIRMED','received',0,'customer','5678')").run();
  const sent=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://apis.aligo.in/send/');
    assert.equal(options.method,'POST');sent.push(new URLSearchParams(options.body));
    return Response.json({result_code:1,msg_id:String(sent.length),success_cnt:1,error_cnt:0});
  });
  const result=await runBookingNotifications(f.env);
  assert.equal(result.accepted,14);assert.equal(result.failed,0);assert.equal(result.unknown,0);
  assert.equal((await runBookingNotifications(f.env)).accepted,0);assert.equal(sent.length,14);
  const expected=f.sqlite.prepare('SELECT code,kind,version,recipient,last4,state,message_id FROM booking_notifications ORDER BY code,kind,version,recipient').all();
  for(const {code,kind} of [...events,{code:'spacecloud-system',kind:'sync_outage'}]) {
    const notices=expected.filter(row=>row.code===code&&row.kind===kind);
    assert.equal(notices.length,2,code);assert(notices.every(row=>row.state==='accepted'),code);
  }
  assert.equal(expected.find(row=>row.kind==='received').state,'skipped');
  const replay=spawnSync('python3',['-c',replayUnderD1Limit],{input:JSON.stringify({schema:f.schema,steps:f.steps}),encoding:'utf8',maxBuffer:4*1024*1024});
  assert.ifError(replay.error);
  assert.equal(replay.status,0,replay.stderr||replay.stdout);
  const checked=JSON.parse(replay.stdout);
  assert.equal(checked.limit,5);assert.equal(checked.operations,f.steps.length);
  assert.deepEqual(checked.notifications,JSON.parse(JSON.stringify(expected)));
});
