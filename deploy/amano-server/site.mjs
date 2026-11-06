import {createHmac} from 'node:crypto';
const URL='https://megaspot.kr/api/parking/automation/server';
export async function parkingSite(secret,action,data={},upstream=fetch){
 if(String(secret||'').length<32)throw Error('Missing site authentication');
 const body=JSON.stringify({action,...data,time:Date.now()});
 const r=await upstream(URL,{method:'POST',headers:{'Content-Type':'application/json','User-Agent':'MegaspotParking/1.0 (+https://megaspot.kr)','X-Megaspot-Signature':createHmac('sha256',secret).update(body).digest('hex')},body,redirect:'manual',signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error('메가스팟 서버 API 응답 확인 필요 HTTP '+r.status);
 const result=await r.json();if(!result.ok)throw Error('메가스팟 서버 API 처리 확인 필요');return result;
}
