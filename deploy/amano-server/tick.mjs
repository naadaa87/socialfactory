import {createHmac} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {amanoStore} from './server.mjs';
import {notifyProblems} from './alerts.mjs';
import {notifySocialfactoryProblems,socialfactoryStore} from './socialfactory.mjs';
export async function runAmanoTick(env,{report,upstream=fetch,storeFactory=amanoStore}={}){
 const secret=env.ALIGO_RELAY_SECRET;if(String(secret||'').length<32)throw Error('Missing server authentication');
 const payload={action:report?'report':'cycle',...(report?{date:report}:{}),time:Date.now()},body=JSON.stringify(payload);let handled=false;
 try{
  const r=await upstream('http://127.0.0.1:8790/v1/amano',{method:'POST',headers:{'Content-Type':'application/json','X-Megaspot-Signature':createHmac('sha256',secret).update(body).digest('hex')},body,redirect:'manual',signal:AbortSignal.timeout(230000)});
  const d=await r.json();handled=d.alerts_handled===true;if(!r.ok)throw Error('Amano cycle failed HTTP '+r.status);
  return {ok:d.ok,operating:d.operating,processed:d.processed,waiting:d.waiting,issues:d.issues,report_status:d.report?.status,socialfactory:d.socialfactory};
 }catch{
  if(!handled){
   const store=storeFactory(env.AMANO_STATE_DIR||'/var/lib/megaspot-amano',secret),issuesFor=s=>{const active=Object.entries(s.read('operations')||{}).filter(([,e])=>!['completed','review'].includes(e.phase));return active.length?active.map(([oid])=>({oid,kind:'registration',message:'서버 처리 응답을 확인하지 못했습니다. 기존 할인 이력을 확인해 주세요.'})):[{kind:'system',message:'아마노 서버 처리기에 연결하지 못했습니다. 서비스 상태를 확인해 주세요.'}];};
   try{await notifyProblems(env,store,issuesFor(store),upstream);}catch{}
   if(socialfactoryStore(store).read('settings')?.enabled)await notifySocialfactoryProblems(env,store,issuesFor(socialfactoryStore(store)),upstream);
  }
  return {ok:false,error:'Amano scheduled operation failed; administrator alert outcome requires review.'};
 }
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 const result=await runAmanoTick(process.env,{report:process.argv.find(s=>s.startsWith('--report='))?.split('=')[1]});
 if(result.error){console.error(result.error);process.exitCode=1;}else console.log(JSON.stringify(result));
}
