import {kstDate} from './alerts.mjs';
export const VERIFICATION_DATE='2026-11-05';
export function recordVerification(store,oid,proof){
 if(!proof.free_confirmed||!proof.free_first_verified||proof.site_status!=='applied'||!proof.history_ids?.length)throw Error('실주문 검증 근거 부족');
 const key='verification-'+proof.date,report=store.read(key)||{date:proof.date,status:'waiting',completed:0,orders:[]};
 if(report.orders.some(r=>r.oid===oid))return report;
 report.completed++;report.status='verified';report.orders.push({oid,...proof});report.orders=report.orders.slice(0,10);report.updated_at=new Date().toISOString();store.save(key,report);return report;
}
export function finishVerification(store,date=kstDate()){
 const key='verification-'+date,report=store.read(key)||{date,status:'waiting',completed:0,orders:[]};
 const operations=Object.values(store.read('operations')||{}).filter(o=>String(o.updated_at||'').slice(0,10)===date);
 report.closed_at=new Date().toISOString();report.issues=operations.filter(o=>o.phase==='review').length;
 const seen=store.read('observation-'+date)||{order_ids:[],waiting_ids:[]};report.orders_seen=seen.order_ids.length;report.waiting_observed=seen.waiting_ids.length;
 if(!report.completed)report.status=report.issues?'issues_without_verified_order':report.orders_seen?'no_verified_order':'no_order';
 report.note=report.completed?'실제 주문 처리와 무료 1시간 우선 적용 검증 기록 있음':'실주문 검증 완료 기록 없음. 주문 없음·입차 전·등록 문제를 구분해 확인할 것';store.save(key,report);return report;
}
