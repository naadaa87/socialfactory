// Fixed-IP relay for Cloudflare Pages, behind the existing relay.naranhistory.com TLS host.
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
const FIELDS={
  'socialfactory-paid-admin/send':['receiver','msg'],
  'socialfactory-paid-admin/status':[],
  'socialfactory-admin/status':[],
  'socialfactory-admin/send':['receiver','msg'],
  'parking-admin/status':[],
  'parking-admin/send':['receiver','msg'],
  'parking-paid/send':['receiver','msg'],
  'template/list':['tpl_code'],
  'history/detail':['mid','page','limit'],
  'sms/detail':['mid','page','page_size'],
  'alimtalk/send':['tpl_code','receiver_1','recvname_1','subject_1','message_1','button_1','fsubject_1','fmessage_1']
};
const PARKING_SMS = new Set(['UN_2583','UN_2586','UN_2587','UN_2588','UN_2589','UN_2591','UN_2592','UN_3966']);
export function relayLedger(db){
  db.exec('CREATE TABLE IF NOT EXISTS relay_requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,response TEXT,created_at INTEGER NOT NULL)');
  db.exec("CREATE INDEX IF NOT EXISTS relay_requests_mid ON relay_requests(CAST(json_extract(response,'$.info.mid') AS TEXT))");
  db.exec('CREATE TABLE IF NOT EXISTS relay_sms_mids(mid TEXT PRIMARY KEY,parent_mid TEXT NOT NULL)');
  return {
    get:id=>db.prepare('SELECT * FROM relay_requests WHERE id=?').get(id),
    ownsMid:mid=>!!db.prepare("SELECT id FROM relay_requests WHERE CAST(json_extract(response,'$.info.mid') AS TEXT)=? LIMIT 1").get(String(mid)),
    ownsSmsMid:mid=>!!db.prepare('SELECT mid FROM relay_sms_mids WHERE mid=?').get(String(mid)),
    rememberSms:(mid,parent)=>db.prepare('INSERT OR IGNORE INTO relay_sms_mids(mid,parent_mid) VALUES(?,?)').run(String(mid),String(parent)),
    claim(id,hash){try{db.prepare('INSERT INTO relay_requests(id,hash,created_at) VALUES(?,?,?)').run(id,hash,Date.now());return true;}catch{return false;}},
    complete:(id,response)=>db.prepare('UPDATE relay_requests SET response=? WHERE id=?').run(JSON.stringify(response),id)
  };
}
export async function relayRequest(request,env,ledger,upstream=fetch){
  if(new URL(request.url).pathname!=='/v1/aligo' || request.method!=='POST')return json({error:'Not found'},404);
  if(!env.ALIGO_RELAY_SECRET || env.ALIGO_RELAY_SECRET.length<32)return json({error:'Relay unavailable'},503);
  const raw=await request.text();if(raw.length>16000)return json({error:'Payload too large'},413);
  const actual=request.headers.get('X-Megaspot-Signature') || '',expected=createHmac('sha256',env.ALIGO_RELAY_SECRET).update(raw).digest('hex');
  if(!/^[a-f0-9]{64}$/.test(actual) || !timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return json({error:'Unauthorized'},401);
  let v;try{v=JSON.parse(raw);}catch{return json({error:'Invalid JSON'},400);}
  if(!Number.isFinite(v.time) || Math.abs(Date.now()-v.time)>60000 || !/^[a-f0-9-]{36}$/.test(v.request_id || ''))return json({error:'Expired request'},400);
  if(!Object.hasOwn(FIELDS,v.path) || !v.data || typeof v.data!=='object' || Array.isArray(v.data))return json({error:'Unsupported operation'},400);
  if(!env.ALIGO_API_KEY || !env.ALIGO_USERID || !env.ALIGO_SENDER_KEY || !env.ALIGO_SENDER)return json({error:'Provider not configured'},503);
  const adminReceivers=[...new Set((env.ALIGO_PARKING_ADMIN_RECEIVERS||'').split(',').map(s=>s.trim()).filter(s=>/^01[016789]\d{7,8}$/.test(s)))];
  const socialfactoryReceivers=[...new Set((env.SOCIALFACTORY_PARKING_ADMIN_RECEIVERS||'').split(',').map(s=>s.trim()).filter(s=>adminReceivers.includes(s)))];
  const paidReceivers=[...new Set((env.SOCIALFACTORY_PARKING_PAID_ADMIN_RECEIVERS||'').split(',').map(s=>s.trim()).filter(s=>adminReceivers.includes(s)))];
  if(v.path==='socialfactory-paid-admin/status')return json({ready:!!paidReceivers.length,receiver_last4:paidReceivers.map(s=>s.slice(-4))});
  if(v.path==='socialfactory-admin/status')return json({ready:!!socialfactoryReceivers.length,receiver_last4:socialfactoryReceivers.map(s=>s.slice(-4))});
  if(v.path==='parking-admin/status')return json({ready:!!adminReceivers.length,receivers:adminReceivers});
  const paidAdminSMS=v.path==='socialfactory-paid-admin/send',socialfactorySMS=v.path==='socialfactory-admin/send'||paidAdminSMS,adminSMS=v.path==='parking-admin/send'||socialfactorySMS,customerSMS=v.path==='parking-paid/send',directSMS=adminSMS||customerSMS;
  const sending=directSMS||v.path==='alimtalk/send';
  const data=Object.fromEntries(FIELDS[v.path].filter(k=>v.data[k]!=null).map(k=>[k,String(v.data[k])]));
  if(['history/detail','sms/detail'].includes(v.path) && !/^\d{1,30}$/.test(data.mid || ''))return json({error:'Invalid message ID'},400);
  if(v.path==='history/detail' && !ledger.ownsMid(data.mid))return json({error:'Message not owned by this relay'},403);
  if(v.path==='sms/detail' && !ledger.ownsSmsMid(data.mid))return json({error:'SMS not owned by this relay'},403);
  if(['template/list','alimtalk/send'].includes(v.path) && !(env.ALIGO_TEMPLATE_CODES || 'UN_2584').split(',').map(s=>s.trim()).includes(data.tpl_code))return json({error:'Template not allowed'},403);
  const hash=createHash('sha256').update(JSON.stringify([v.path,data,env.ALIGO_USERID,env.ALIGO_SENDER_KEY])).digest('hex');
  const staffMessage=paidAdminSMS?paidReceivers.includes(data.receiver)&&data.msg?.startsWith('[소셜팩토리 주차권 결제 완료]\n')&&data.msg.endsWith('https://socialfactory.co.kr/admin#parking')&&Buffer.byteLength(data.msg,'utf8')<=2000:socialfactorySMS?socialfactoryReceivers.includes(data.receiver)&&/^\[소셜팩토리 주차권 (?:자동 등록 오류|잔액 부족)\]\n/.test(data.msg||'')&&data.msg.endsWith('https://socialfactory.co.kr/admin#parking'):/^\[메가스팟 주차권 (?:결제 완료|관리자 알림 시험|자동 등록 오류|잔액 부족|검증 완료|검증 확인 필요)\]\n/.test(data.msg||'')&&data.msg.endsWith('https://megaspot.kr/admin/#parking');
  if(adminSMS && (!adminReceivers.includes(data.receiver)||!staffMessage||data.msg.length>600))return json({error:'Unapproved staff recipient/message'},403);
  if(customerSMS && (!/^01[016789]\d{7,8}$/.test(data.receiver||'')||!data.msg.startsWith('[메가스팟 주차권 결제 완료]\n')||data.msg.length>900||/#\{/.test(data.msg)||!data.msg.endsWith('https://pf.kakao.com/_LnxbmX/chat')))return json({error:'Invalid parking payment notice'},400);
  if(sending){
    if(!directSMS && (!/^01[016789]\d{7,8}$/.test(data.receiver_1 || '') || !data.message_1 || data.message_1.length>1000 || !data.subject_1))return json({error:'Invalid recipient/message'},400);
    if(PARKING_SMS.has(data.tpl_code) && (!data.fmessage_1 || data.fmessage_1.length>900 || /#\{/.test(data.fmessage_1)))return json({error:'Parking SMS fallback required'},400);
    const old=ledger.get(v.request_id);
    if(old){if(old.hash!==hash)return json({error:'Request ID reused'},409);return old.response?json(JSON.parse(old.response)):json({error:'Delivery outcome requires review'},409);}
    // Durable reservation survives process restarts and uncertain HTTP outcomes.
    if(!ledger.claim(v.request_id,hash))return json({error:'Delivery outcome requires review'},409);
    // Parking fallback is explicitly authorized. Other templates retain their own policy.
    const parking=PARKING_SMS.has(data.tpl_code);
    if(!parking){delete data.fmessage_1;delete data.fsubject_1;}
    Object.assign(data,directSMS?{sender:env.ALIGO_SENDER,msg_type:'LMS',title:paidAdminSMS?'소셜팩토리 주차권 결제 알림':socialfactorySMS?'소셜팩토리 주차권 관리자 알림':customerSMS?'메가스팟 주차권 결제 완료':'메가스팟 주차권 관리자 알림',testmode_yn:'N'}:{sender:env.ALIGO_SENDER,failover:parking?'Y':'N',testMode:'N'});
  }
  const smsQuery=v.path==='sms/detail';
  const body=new URLSearchParams((smsQuery||directSMS)?{...data,key:env.ALIGO_API_KEY,user_id:env.ALIGO_USERID}:{...data,apikey:env.ALIGO_API_KEY,userid:env.ALIGO_USERID});
  if(['template/list','alimtalk/send'].includes(v.path))body.set('senderkey',env.ALIGO_SENDER_KEY);
  try{
    const response=await upstream(smsQuery?'https://apis.aligo.in/sms_list/':directSMS?'https://apis.aligo.in/send/':'https://kakaoapi.aligo.in/akv10/'+v.path+'/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(9000),redirect:'error'});
    if(!response.ok)throw Error('Upstream unavailable');
    const result=await response.json();
    if(v.path==='history/detail' && Number(result.code)===0){for(const x of result.list||[]){if(x.type==='AT' && /^\d+$/.test(String(x.smid||'')) && Number(x.smid)>0)ledger.rememberSms(x.smid,data.mid);}}
    if(v.path==='template/list' && Array.isArray(result.list))result.list=result.list.filter(t=>t.templtCode===data.tpl_code);
    if(directSMS && Number(result.result_code)===1 && result.msg_id)ledger.rememberSms(result.msg_id,result.msg_id);
    if(sending)ledger.complete(v.request_id,result);
    return json(result);
  }catch{return json({error:'Upstream outcome unknown; do not retry sending'},502);}
}
if(process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url){
  for(const k of ['ALIGO_API_KEY','ALIGO_USERID','ALIGO_SENDER_KEY','ALIGO_SENDER','ALIGO_RELAY_SECRET'])if(!process.env[k])throw Error('Missing server setting: '+k);
  const dbPath=process.env.ALIGO_RELAY_DB || './data/aligo-relay.sqlite';mkdirSync(dirname(dbPath),{recursive:true});const ledger=relayLedger(new DatabaseSync(dbPath));
  createServer(async(req,res)=>{
    try{
      let body='';for await(const chunk of req){body+=chunk;if(body.length>16000){res.writeHead(413);res.end();return;}}
      const response=await relayRequest(new Request('http://relay.local'+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body})}),process.env,ledger);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    }catch{res.writeHead(500);res.end('Relay unavailable');}
  }).listen(Number(process.env.PORT || 8787),'127.0.0.1');
}
