import {runPaidAlerts,paidAlertStatus} from './paid-alerts.mjs';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {runCycle} from './worker.mjs';
import {notifyProblems} from './alerts.mjs';
const ALERT_PROFILE={brand:'소셜팩토리',link:'https://socialfactory.co.kr/admin#parking',namespace:'socialfactory',path:'socialfactory-admin/send',receiverKey:'SOCIALFACTORY_PARKING_ADMIN_RECEIVERS'};
export function socialfactoryAlertReceivers(env){const allowed=(env.ALIGO_PARKING_ADMIN_RECEIVERS||'').split(',').map(s=>s.trim());return [...new Set((env.SOCIALFACTORY_PARKING_ADMIN_RECEIVERS||'').split(',').map(s=>s.trim()).filter(s=>/^01[016789]\d{7,8}$/.test(s)&&allowed.includes(s)))];}
export function socialfactoryAlertStatus(env,store){return {error_alerts_enabled:socialfactoryAlertReceivers(env).length>0&&String(env.ALIGO_RELAY_SECRET||'').length>=32,error_alert_receivers:socialfactoryAlertReceivers(env).map(s=>s.slice(-4)),error_alert_status:store.read('alert-status'),error_notifications:Object.values(store.read('alert-journal')||{}).map(e=>({kind:e.key.includes(':balance:')?'balance':e.key.includes(':order:')?'registration':'system',receiver_last4:e.receiver.slice(-4),status:e.status,error:e.error||'',created_at:e.created_at})).slice(-30)};}
export async function notifySocialfactoryProblems(env,store,issues=[],upstream=fetch,at=Date.now()){
 const sf=socialfactoryStore(store);
 try{if(String(env.ALIGO_RELAY_SECRET||'').length<32)throw Error();const result=await notifyProblems({...env,SOCIALFACTORY_PARKING_ADMIN_RECEIVERS:socialfactoryAlertReceivers(env).join(',')},sf,issues,upstream,at,ALERT_PROFILE);sf.save('alert-status',{ok:true,checked_at:new Date(at).toISOString()});return result;}
 catch{sf.save('alert-status',{ok:false,error:'관리자 오류 문자 연결 확인 필요',checked_at:new Date(at).toISOString()});return {ok:false};}
}
const URL='https://socialfactory.co.kr/api/parking/automation/server';
export const socialfactoryStore=store=>({read:k=>store.read('socialfactory-'+k),save:(k,v)=>store.save('socialfactory-'+k,v)});
export async function socialfactorySite(secret,action,data={},upstream=fetch){
 if(String(secret||'').length<32)throw Error('소셜팩토리 서버 연결 키 확인 필요');
 const body=JSON.stringify({action,...data,time:Date.now()});const r=await upstream(URL,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'SocialfactoryParking/1.0 (+https://socialfactory.co.kr)','X-Socialfactory-Signature':createHmac('sha256',secret).update(body).digest('hex')},body,redirect:'manual',signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error('소셜팩토리 주차 API 응답 확인 필요 HTTP '+r.status);const j=await r.json();if(!j.ok)throw Error('소셜팩토리 주차 API 처리 확인 필요');return j;
}
export async function socialfactoryControl(request,env,store,clientFactory,busy=()=>false,processOrders){
 const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}}),secret=env.SOCIALFACTORY_RELAY_SECRET;
 if(request.method!=='POST'||String(secret||'').length<32)return json({ok:false},403);
 const raw=await request.text();if(raw.length>4000)return json({ok:false},413);const sig=request.headers.get('X-Socialfactory-Signature')||'',wanted=createHmac('sha256',secret).update(raw).digest('hex');
 if(!/^[a-f0-9]{64}$/.test(sig)||!timingSafeEqual(Buffer.from(sig),Buffer.from(wanted)))return json({ok:false},403);
 let b;try{b=JSON.parse(raw);}catch{return json({ok:false},400);}if(!b||!Number.isFinite(b.time)||Math.abs(Date.now()-b.time)>60000)return json({ok:false},403);
 const sf=socialfactoryStore(store),configured=!!store.read('credentials');
 if(b.action==='status')return json({ok:true,configured,shared_account:true,adapter_ready:true,enabled:sf.read('settings')?.enabled===true,busy:busy(),last_run:sf.read('last-run'),...socialfactoryAlertStatus(env,sf),...paidAlertStatus(env,store)});
 if(b.action==='paid-notices'){
  if(b.oid!==undefined&&!/^SF[A-Z0-9]{16}$/.test(b.oid))return json({ok:false},400);
  return json(await runPaidAlerts({env,store,oid:b.oid,site:(action,data)=>socialfactorySite(secret,action,data)}));
 }
 if(b.action==='process'){
  if(!/^SF[A-Z0-9]{16}$/.test(b.oid||''))return json({ok:false},400);
  if(!processOrders)return json({ok:false},503);
  return json(await processOrders(b.oid));
 }
 if(b.action==='check'){if(!configured)return json({ok:false,error:'기존 아마노 계정 연결 필요'},409);if(busy())return json({ok:true,configured,busy:true});try{await clientFactory(store.read('credentials')).login();return json({ok:true,configured:true});}catch{return json({ok:false,error:'아마노 연결 확인 필요'},502);}}
 if(b.action==='settings'){
  if(b.enabled===true&&(!configured||b.confirm_policy!==true))return json({ok:false,error:'기존 계정과 주문별 차감 한도 확인 필요'},409);
  sf.save('settings',{enabled:b.enabled===true,updated_at:new Date().toISOString()});return json({ok:true,enabled:b.enabled===true});
 }
 return json({ok:false},400);
}
export async function runSocialfactory({env,store,clientFactory,run=runCycle,site,paymentOid}){
 const sf=socialfactoryStore(store);
 const callSite=site||((action,data)=>socialfactorySite(env.SOCIALFACTORY_RELAY_SECRET,action,
  action==='orders'&&paymentOid?{...data,payment_oid:paymentOid}:data));
 const paidTask=runPaidAlerts({env,store,site:callSite,oid:paymentOid});
 if(!sf.read('settings')?.enabled){await paidTask;return {ok:true,enabled:false,processed:0};}
 let result;
 try{if(String(env.SOCIALFACTORY_RELAY_SECRET||'').length<32||!store.read('credentials'))throw Error();result=await run({site:callSite,client:clientFactory(store.read('credentials')),store:sf,isEnabled:()=>sf.read('settings')?.enabled===true});}
 catch{result={ok:false,error:'소셜팩토리 아마노 자동 등록 확인 필요',finished_at:new Date().toISOString(),processed:0};sf.save('last-run',result);}
 await notifySocialfactoryProblems(env,store,result.ok===false?[...(result.issues||[]),{kind:'system',message:result.error||'소셜팩토리 자동 등록 처리 결과 확인 필요'}]:result.issues||[]);
 await paidTask;
 return result;
}
