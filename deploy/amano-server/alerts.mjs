import {createHmac,createHash} from 'node:crypto';
const ENDPOINT='http://127.0.0.1:8787/v1/aligo',LINK='https://megaspot.kr/admin/#parking';
export const kstDate=(at=Date.now())=>new Date(at+9*36e5).toISOString().slice(0,10);
const requestId=key=>{const h=createHash('sha256').update('amano-alert-v1:'+key).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
export function alertKey(issue,at=Date.now()){
 if(issue.kind==='balance'||/잔액 부족/.test(issue.message))return 'balance:'+kstDate(at);
 return issue.oid?'order:'+issue.oid:'system:'+kstDate(at)+':'+createHash('sha256').update(issue.message||'unknown').digest('hex').slice(0,16);
}
export function alertMessage(issue){
 const low=issue.kind==='balance'||/잔액 부족/.test(issue.message);
 return '[메가스팟 주차권 '+(low?'잔액 부족':'자동 등록 오류')+']\n'+(issue.oid?'주문: '+issue.oid+'\n':'')+'사유: '+String(issue.message||'서버 처리 확인 필요').replace(/[\r\n\t]/g,' ').slice(0,160)+'\n자동 처리를 완료하지 못해 관리자 확인이 필요합니다.\n아마노 할인내역을 확인하기 전 같은 건을 다시 등록하지 마세요.\n'+LINK;
}
export async function notifyProblems(env,store,issues=[],upstream=fetch,at=Date.now()){
 const receivers=[...new Set((env.ALIGO_PARKING_ADMIN_RECEIVERS||'').split(',').filter(s=>/^01[016789]\d{7,8}$/.test(s)))];
 if(!receivers.length)throw Error('관리자 오류 문자 수신 번호가 없습니다.');
 const journal=store.read('alert-journal')||{};
 for(const e of Object.values(journal))if(e.status==='sending'&&at-(e.updated_at||0)>=60000)e.status='unknown';
 for(const issue of issues){for(const receiver of receivers){const key=alertKey(issue,at)+':'+receiver;if(!journal[key])journal[key]={key,receiver,message:alertMessage(issue),request_id:requestId(key),status:'queued',attempts:0,created_at:at};}}
 store.save('alert-journal',journal);
 async function rpc(path,data,id){const body=JSON.stringify({path,data,request_id:id,time:Date.now()});const r=await upstream(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','X-Megaspot-Signature':createHmac('sha256',env.ALIGO_RELAY_SECRET).update(body).digest('hex')},body,redirect:'manual',signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('문자 서버 응답 확인 필요');return r.json();}
 const messages=Object.values(journal).filter(e=>e.status==='queued'||e.status==='unknown'&&e.attempts<3&&at-(e.updated_at||0)>=60000);
 await Promise.allSettled(messages.map(async e=>{
  e.status='sending';e.attempts++;e.updated_at=at;store.save('alert-journal',journal);
  try{const r=await rpc('parking-admin/send',{receiver:e.receiver,msg:e.message},e.request_id);
   if(Number(r.result_code)!==1){e.status='failed';e.error='알리고 접수 거절 '+String(r.result_code);}
   else if(r.msg_id&&Number(r.success_cnt)===1&&Number(r.error_cnt)===0){e.status='accepted';e.mid=String(r.msg_id);delete e.error;}
   else{e.status='unknown';e.error='문자 접수 결과 확인 필요';}
  }catch{e.status='unknown';e.error='문자 접수 결과 불명 · 동일 요청 ID로만 확인';}
  store.save('alert-journal',journal);
 }));
 await Promise.allSettled(Object.values(journal).filter(e=>e.status==='accepted'&&at-(e.last_check||e.updated_at||0)>=15000).map(async e=>{
  e.last_check=at;
  try{const r=await rpc('sms/detail',{mid:e.mid,page_size:'50'},requestId('result:'+e.key+':'+at));if(Number(r.result_code)===1){const row=(r.list||[]).find(x=>String(x.receiver||'').replace(/\D/g,'')===e.receiver);if(row&&/^20\d{2}-\d{2}-\d{2} /.test(row.send_date||'')&&!/중|대기|예약|접수/.test(row.sms_state||'')){e.status=row.sms_state==='발송완료'?'delivered':'failed';e.error=e.status==='failed'?String(row.sms_state):'';}}}catch{}
  store.save('alert-journal',journal);
 }));
 return {recipients:receivers.length,items:Object.values(journal).map(e=>({key:e.key,receiver_last4:e.receiver.slice(-4),status:e.status,created_at:e.created_at,error:e.error||''})).slice(-30)};
}
