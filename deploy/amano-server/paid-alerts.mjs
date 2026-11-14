import {notifyProblems} from './alerts.mjs';

const TICKETS={'1h':'1시간권','2h':'2시간권','3h':'3시간권',daily:'일일권'};
const PROFILE={namespace:'socialfactory-paid',path:'socialfactory-paid-admin/send',
 receiverKey:'SOCIALFACTORY_PARKING_PAID_ADMIN_RECEIVERS',formatMessage:issue=>issue.message};
let busy=false;
const paidStore=store=>({read:key=>store.read('socialfactory-paid-'+key),
 save:(key,value)=>store.save('socialfactory-paid-'+key,value)});

export function paidAlertReceivers(env) {
 const allowed=(env.ALIGO_PARKING_ADMIN_RECEIVERS||'').split(',').map(s=>s.trim());
 return [...new Set((env.SOCIALFACTORY_PARKING_PAID_ADMIN_RECEIVERS||'').split(',')
  .map(s=>s.trim()).filter(s=>/^01[016789]\d{7,8}$/.test(s)&&allowed.includes(s)))];
}

export function paidAlertStatus(env,store) {
 const receipts=Object.values(paidStore(store).read('alert-journal')||{});
 return {paid_alerts_enabled:env.SOCIALFACTORY_PARKING_PAID_ADMIN_ENABLED==='1'&&paidAlertReceivers(env).length>0,
  paid_alert_receivers:paidAlertReceivers(env).map(s=>s.slice(-4)),
  paid_alert_last_run:paidStore(store).read('last-run'),
  paid_notifications:receipts.slice(-40).map(e=>({oid:e.key.split(':')[2],
   receiver_last4:e.receiver.slice(-4),status:e.status,error:e.error||'',created_at:e.created_at}))};
}

export function paymentMessage(payment) {
 const lines=payment.vehicles.map(p=>'- '+p.plate+' · '+TICKETS[p.ticket]+' · '+
  Number(p.price).toLocaleString('ko-KR')+'원');
 return '[소셜팩토리 주차권 결제 완료]\n주문: '+payment.oid+'\n결제일시: '+
  payment.paid_at+'\n이용일: '+payment.vehicles[0].date+'\n차량 '+lines.length+
  '대\n'+lines.join('\n')+'\n합계: '+Number(payment.amount).toLocaleString('ko-KR')+
  '원\n차량별 아마노 등록 상태를 관리자에서 확인해 주세요.\nhttps://socialfactory.co.kr/admin#parking';
}

export async function runPaidAlerts({env,store,site,oid,upstream=fetch}) {
 if (env.SOCIALFACTORY_PARKING_PAID_ADMIN_ENABLED!=='1') return {ok:true,enabled:false};
 if (busy) return {ok:true,busy:true};
 busy=true;
 const state=paidStore(store);
 try {
  const since=env.SOCIALFACTORY_PARKING_PAID_ADMIN_SINCE;
  if (!/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(since||'')) throw Error('알림 시작일 확인 필요');
  const feed=await site(oid?'payment':'payments',{since,...(oid?{oid}:{after:state.read('cursor')})});
  if (!feed.ok || !Array.isArray(feed.payments)) throw Error('결제 조회 확인 필요');
  // Every candidate was revalidated against the current payment/refund ledger.
  const issues=feed.payments.map(p=>({oid:p.oid,message:paymentMessage(p)}));
  const notices=await notifyProblems({...env,
   SOCIALFACTORY_PARKING_PAID_ADMIN_RECEIVERS:paidAlertReceivers(env).join(',')},
   state,issues,upstream,Date.now(),PROFILE);
  if (!oid && feed.next) state.save('cursor',feed.next);
  const result={ok:true,checked:feed.payments.length,finished_at:new Date().toISOString()};
  state.save('last-run',result);
  return {...result,notifications:notices.items.map(e=>({oid:e.key.split(':')[2],
   receiver_last4:e.receiver_last4,status:e.status,error:e.error}))};
 } catch {
  const result={ok:false,error:'관리자 결제 문자 연결 확인 필요',finished_at:new Date().toISOString()};
  state.save('last-run',result);
  return result;
 } finally { busy=false; }
}
