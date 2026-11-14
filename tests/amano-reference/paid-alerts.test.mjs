import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {relayRequest,relayLedger} from '../../deploy/amano-server/aligo-relay.mjs';
import {runPaidAlerts,paidAlertStatus,paymentMessage} from '../../deploy/amano-server/paid-alerts.mjs';

function fixture(t) {
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const ledger=relayLedger(db),memory={},store={
  read:key=>memory[key]?structuredClone(memory[key]):null,
  save:(key,value)=>memory[key]=structuredClone(value)};
 const env={ALIGO_RELAY_SECRET:'local-shared-relay-secret-at-least-32-characters',
  ALIGO_PARKING_ADMIN_RECEIVERS:'01011112222,01033334444',
  SOCIALFACTORY_PARKING_PAID_ADMIN_RECEIVERS:'01011112222,01033334444',
  SOCIALFACTORY_PARKING_PAID_ADMIN_ENABLED:'1',SOCIALFACTORY_PARKING_PAID_ADMIN_SINCE:'2026-11-14 00:00:00',
  ALIGO_API_KEY:'local-api',ALIGO_USERID:'local-user',ALIGO_SENDER_KEY:'local-sender',ALIGO_SENDER:'0212345678'};
 let delivered=false,uncertain=false,seq=100;
 const sent=[],requests=[],midPhones={};
 const upstream=async(url,options)=>{
  assert.equal(url,'http://127.0.0.1:8787/v1/aligo');requests.push(JSON.parse(options.body));
  return relayRequest(new Request(url,options),env,ledger,async(provider,opts)=>{
   const data=new URLSearchParams(opts.body);
   if(provider.endsWith('/sms_list/'))return Response.json({result_code:1,list:delivered?
    [{receiver:midPhones[data.get('mid')],sms_state:'발송완료',send_date:'2026-11-14 21:00:00'}]:[]});
   assert.equal(provider,'https://apis.aligo.in/send/');sent.push(data);
   if(uncertain)throw Error('Response lost');
   const mid=String(seq++);midPhones[mid]=data.get('receiver');
   return Response.json({result_code:1,msg_id:mid,success_cnt:1,error_cnt:0});
  });
 };
 const payment={oid:'SF261114210000ABCD',amount:34000,qty:2,paid_at:'2026-11-14 21:00:00',vehicles:[
  {plate:'123가4567',date:'2026-11-14',ticket:'1h',price:4000,status:'applied'},
  {plate:'45나6789',date:'2026-11-14',ticket:'daily',price:30000,status:'applied'}]};
 let payments=[payment];
 const site=async(action,data)=>{
  assert.equal(data.since,'2026-11-14 00:00:00');
  return {ok:true,payments:action==='payment'?payments.filter(p=>p.oid===data.oid):
   data.after?payments.filter(p=>p.paid_at>data.after.paid_at||p.paid_at===data.after.paid_at&&p.oid>data.after.oid):payments,
   next:payments.length?{paid_at:payments.at(-1).paid_at,oid:payments.at(-1).oid}:null};
 };
 return {env,store,memory,sent,requests,upstream,site,payment,
  setPayments:value=>payments=value,delivered:()=>delivered=true,uncertain:()=>uncertain=true};
}

test('오늘 결제 소급 발송과 실시간 콜백이 겹쳐도 통합 결제당 두 관리자에게 각 한 번만 전송·도착 확인',async t=>{
 const f=fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);
 const first=await runPaidAlerts(f);assert.equal(first.checked,1);assert.equal(f.sent.length,2);
 assert(f.sent.every(p=>p.get('msg').includes('차량 2대')&&p.get('msg').includes('34,000원')));
 assert(f.sent.every(p=>p.get('title')==='소셜팩토리 주차권 결제 알림'));
 assert.deepEqual(f.sent.map(p=>p.get('receiver')).sort(),['01011112222','01033334444']);
 await runPaidAlerts({...f,oid:f.payment.oid});await runPaidAlerts(f);assert.equal(f.sent.length,2);
 f.delivered();now+=20000;await runPaidAlerts(f);
 const status=paidAlertStatus(f.env,f.store);assert(status.paid_notifications.every(p=>p.status==='delivered'));
 assert.deepEqual(status.paid_alert_receivers,['2222','4444']);
 assert(!JSON.stringify(status).includes('01011112222'));assert.equal(f.memory['socialfactory-alert-journal'],undefined);
});

test('전송 불명은 고정 요청 ID를 유지해 중계의 영속 선점 뒤 문자를 재발송하지 않음',async t=>{
 const f=fixture(t);let now=Date.now();t.mock.method(Date,'now',()=>now);f.uncertain();
 await runPaidAlerts(f);now+=61000;await runPaidAlerts(f);now+=61000;await runPaidAlerts(f);
 assert.equal(f.sent.length,2);assert.equal(new Set(f.requests.map(r=>r.request_id)).size,2);
 assert(paidAlertStatus(f.env,f.store).paid_notifications.every(p=>p.status==='unknown'));
});

test('결제일 커서는 새 결제를 계속 처리하고 이미 즉시 발송한 결제도 중복 전송하지 않음',async t=>{
 const f=fixture(t);await runPaidAlerts({...f,oid:f.payment.oid});assert.equal(f.sent.length,2);
 await runPaidAlerts(f);assert.equal(f.sent.length,2);
 const next={...f.payment,oid:'SF261114210001EFGH',paid_at:'2026-11-14 21:00:01'};
 f.setPayments([f.payment,next]);await runPaidAlerts(f);assert.equal(f.sent.length,4);
 await runPaidAlerts(f);assert.equal(f.sent.length,4);
});

test('허용되지 않은 번호·중지·현재 환불된 결제에는 신규 문자를 발송하지 않음',async t=>{
 const f=fixture(t);f.env.SOCIALFACTORY_PARKING_PAID_ADMIN_RECEIVERS='01099998888';
 assert.equal((await runPaidAlerts(f)).ok,false);assert.equal(f.sent.length,0);
 f.env.SOCIALFACTORY_PARKING_PAID_ADMIN_ENABLED='0';assert.equal((await runPaidAlerts(f)).enabled,false);
 f.env.SOCIALFACTORY_PARKING_PAID_ADMIN_ENABLED='1';f.setPayments([]);await runPaidAlerts(f);assert.equal(f.sent.length,0);
});

test('최대 10대 결제 문자는 LMS 한도 안에서 전체 차량을 표시',()=>{
 const vehicles=Array.from({length:10},(_,i)=>({plate:'123가'+String(1000+i),date:'2026-11-14',ticket:'daily',price:30000}));
 const text=paymentMessage({oid:'SF261114210001EFGH',amount:300000,paid_at:'2026-11-14 21:00:01',vehicles});
 assert(text.includes('차량 10대'));assert(text.includes('123가1009'));assert(text.length<=600);assert(Buffer.byteLength(text,'utf8')<=2000);
});

test('동시에 들어온 결제 알림 요청은 하나의 발송 루틴만 진행',async t=>{
 const f=fixture(t);let release;const gate=new Promise(resolve=>release=resolve);
 const first=runPaidAlerts({...f,site:async(...args)=>{await gate;return f.site(...args);}});
 assert.equal((await runPaidAlerts(f)).busy,true);release();await first;assert.equal(f.sent.length,2);
});
