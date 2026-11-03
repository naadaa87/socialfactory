import {randomToken,sha256Hex,readCookie,phoneDigits,safeEqual} from './auth.js';
import {kstNow} from './admin.js';
import {fromMs,toMs} from './kiosk.js';
import {guestSmsConfig,sendGuestSms} from './guest-sms.js';
export const GUEST_SCHEMA=[
 `CREATE TABLE IF NOT EXISTS guest_otp_challenges(id TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,phone TEXT NOT NULL,phone_hash TEXT NOT NULL,code_hash TEXT NOT NULL,ip_hash TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending')`,
 `CREATE INDEX IF NOT EXISTS idx_guest_otp_phone ON guest_otp_challenges(phone_hash,created_at)`,
 `CREATE INDEX IF NOT EXISTS idx_guest_otp_ip ON guest_otp_challenges(ip_hash,created_at)`,
 `CREATE TABLE IF NOT EXISTS guest_order_sessions(token_hash TEXT PRIMARY KEY,phone TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL)`
];
export const guestReady=env=>!!env.DB && env.GUEST_OTP_ENABLED==='1' && !!env.SESSION_SECRET && guestSmsConfig(env).configured;
export const guestCookie=(request,name,value,seconds)=>`${name}=${value}; Path=/api/; Max-Age=${seconds}; HttpOnly; SameSite=Strict${new URL(request.url).protocol==='https:'?'; Secure':''}`;
export async function ensureGuest(env){await env.DB.batch(GUEST_SCHEMA.map(q=>env.DB.prepare(q)));}
const hash=async(env,value)=>{
 const enc=new TextEncoder(),key=await crypto.subtle.importKey('raw',enc.encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
};
export const maskGuestPhone=p=>p.slice(0,3)+'-****-'+p.slice(-4);
const add=(now,seconds)=>fromMs(toMs(now)+seconds*1000);
export async function getGuest(request,env){
 let token;try{token=readCookie(request,'sf_guest')}catch{return null}if(!token || token.length<40 || !env.DB || !env.SESSION_SECRET)return null;
 return env.DB.prepare('SELECT phone,expires_at FROM guest_order_sessions WHERE token_hash=? AND expires_at>?').bind(await sha256Hex(token),kstNow()).first().catch(()=>null);
}
export const ownsGuestOrder=(g,o)=>!!g && o.member_id==null && typeof o.created_at==='string' && o.created_at>=fromMs(toMs(kstNow())-90*864e5) && phoneDigits(o.buyer_phone)===g.phone;
export async function requestGuestCode(request,env,phone){
 if(!guestReady(env))return {status:503,data:{ok:false,error:'not-ready',message:'휴대폰 인증을 준비하고 있습니다. 카카오톡으로 문의해 주세요.'}};
 if(typeof phone!=='string' || !/^[0-9 -]+$/.test(phone) || !/^01[016789]\d{7,8}$/.test(phoneDigits(phone)))return {status:400,data:{ok:false,error:'phone',message:'구매에 사용한 휴대폰 번호를 입력해 주세요.'}};
 await ensureGuest(env);
 const now=kstNow(),number=phoneDigits(phone),id=randomToken(24),browser=randomToken(),phoneHash=await hash(env,'phone|'+number),ip=String(request.headers.get('cf-connecting-ip')||'unknown');
 const ipHash=await hash(env,'ip|'+ip),a=new Uint32Array(1);do{crypto.getRandomValues(a)}while(a[0]>=4294000000);
 const code=String(a[0]%1000000).padStart(6,'0'),dailyLimit=Math.max(1,Math.min(1000,parseInt(env.GUEST_OTP_DAILY_LIMIT,10)||200));
 const inserted=await env.DB.prepare(`INSERT INTO guest_otp_challenges(id,browser_hash,phone,phone_hash,code_hash,ip_hash,created_at,expires_at)
 SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM guest_otp_challenges WHERE phone_hash=? AND created_at>?)
 AND (SELECT COUNT(*) FROM guest_otp_challenges WHERE phone_hash=? AND created_at>?)<5
 AND (SELECT COUNT(*) FROM guest_otp_challenges WHERE ip_hash=? AND created_at>?)<10
 AND (SELECT COUNT(*) FROM guest_otp_challenges WHERE created_at>?)<?`).bind(id,await sha256Hex(browser),number,phoneHash,await hash(env,'code|'+id+'|'+code),ipHash,now,add(now,300),phoneHash,add(now,-60),phoneHash,add(now,-3600),ipHash,add(now,-3600),now.slice(0,10)+' 00:00:00',dailyLimit).run();
 if(!inserted.meta.changes)return {status:429,data:{ok:false,error:'rate-limit',message:'잠시 후 다시 요청해 주세요. 인증 문자는 1분 간격으로 받을 수 있고, 반복 요청은 제한됩니다.'}};
 let delivery='accepted';
 try{await sendGuestSms(env,number,code)}catch(e){
  if(e.confirmedFailure){await env.DB.prepare("UPDATE guest_otp_challenges SET status='failed' WHERE id=?").bind(id).run();return {status:502,data:{ok:false,error:'send-failed',message:'인증 문자를 보내지 못했습니다. 잠시 후 다시 시도하거나 카카오톡으로 문의해 주세요.'}}}
  delivery='unconfirmed';
 }
 await env.DB.prepare('UPDATE guest_otp_challenges SET status=? WHERE id=?').bind(delivery==='accepted'?'sent':'unknown',id).run();
 await env.DB.batch([env.DB.prepare('DELETE FROM guest_order_sessions WHERE expires_at<=?').bind(now),env.DB.prepare('DELETE FROM guest_otp_challenges WHERE created_at<?').bind(add(now,-86400))]);
 return {status:delivery==='accepted'?200:202,cookie:guestCookie(request,'sf_guest_challenge',browser,600),data:{ok:true,challenge:id,expiresAt:add(now,300),resendAfter:60,delivery,message:delivery==='accepted'?'인증번호를 보냈습니다. 5분 안에 입력해 주세요.':'발송 결과를 확인 중입니다. 인증 문자가 도착했다면 입력해 주세요. 중복 요청하지 말고 잠시 기다려 주세요.'}};
}
export async function verifyGuestCode(request,env,body){
 if(!guestReady(env))return {status:503,data:{ok:false,error:'not-ready'}};
 if(!body || !/^[A-Za-z0-9_-]{32}$/.test(body.challenge||'') || !/^\d{6}$/.test(body.code||''))return {status:400,data:{ok:false,error:'invalid',message:'문자로 받은 인증번호 6자리를 입력해 주세요.'}};
 const browser=readCookie(request,'sf_guest_challenge');if(!browser)return {status:400,data:{ok:false,error:'invalid',message:'인증번호를 새로 요청해 주세요.'}};
 await ensureGuest(env);const now=kstNow(),browserHash=await sha256Hex(browser),row=await env.DB.prepare('SELECT * FROM guest_otp_challenges WHERE id=? AND browser_hash=?').bind(body.challenge,browserHash).first();
 const invalid=()=>({status:400,data:{ok:false,error:'invalid-code',message:'인증번호가 맞지 않거나 만료되었습니다. 다시 확인하거나 새 인증번호를 요청해 주세요.'}});
 if(!row || !['sent','unknown'].includes(row.status)||row.expires_at<=now||row.attempts>=5)return invalid();
 const counted=await env.DB.prepare("UPDATE guest_otp_challenges SET attempts=attempts+1 WHERE id=? AND browser_hash=? AND attempts<5 AND status IN ('sent','unknown') AND expires_at>?").bind(row.id,browserHash,now).run();
 if(!counted.meta.changes || !safeEqual(await hash(env,'code|'+row.id+'|'+body.code),row.code_hash))return invalid();
 const token=randomToken(),tokenHash=await sha256Hex(token),expires=add(now,1800);
 await env.DB.batch([
  env.DB.prepare("INSERT INTO guest_order_sessions(token_hash,phone,created_at,expires_at) SELECT ?,phone,?,? FROM guest_otp_challenges WHERE id=? AND browser_hash=? AND code_hash=? AND status IN ('sent','unknown') AND attempts<=5 AND expires_at>?").bind(tokenHash,now,expires,row.id,browserHash,row.code_hash,now),
  env.DB.prepare("UPDATE guest_otp_challenges SET status='verified',code_hash='' WHERE id=? AND EXISTS(SELECT 1 FROM guest_order_sessions WHERE token_hash=?)").bind(row.id,tokenHash)
 ]);
 const session=await env.DB.prepare('SELECT phone FROM guest_order_sessions WHERE token_hash=?').bind(tokenHash).first();if(!session)return invalid();
 return {status:200,cookie:guestCookie(request,'sf_guest',token,1800),data:{ok:true,maskedPhone:maskGuestPhone(session.phone),expiresAt:expires}};
}

export async function cleanupGuest(env){const now=kstNow();await env.DB.batch([env.DB.prepare('DELETE FROM guest_order_sessions WHERE expires_at<=?').bind(now),env.DB.prepare('DELETE FROM guest_otp_challenges WHERE created_at<?').bind(add(now,-86400))]);}
