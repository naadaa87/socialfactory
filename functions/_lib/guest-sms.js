const DIRECT='https://apis.aligo.in/send/';
const RELAY='https://relay.naranhistory.com/socialfactory/aligo/sms';
export function guestSmsConfig(env){
 const key=String(env.ALIGO_SMS_API_KEY||env.ALIGO_API_KEY||''),user=String(env.ALIGO_SMS_USER_ID||env.ALIGO_USER_ID||''),sender=String(env.ALIGO_SMS_SENDER||env.ALIGO_SENDER||'').replace(/\D/g,'');
 const relay=String(env.ALIGO_RELAY_URL||'').replace(/\/+$/,''),secret=String(env.ALIGO_RELAY_SECRET||'');
 const validRelay=relay==='https://relay.naranhistory.com/socialfactory/aligo/send' && /^[A-Za-z0-9_-]{43,128}$/.test(secret);
 return {key,user,sender,secret,url:relay||secret?RELAY:DIRECT,configured:!!(key&&user&&/^\d{8,16}$/.test(sender)&&(!(relay||secret)||validRelay))};
}
export async function sendGuestSms(env,phone,code,{test=false}={}){
 if(!/^\d{6}$/.test(code))throw Object.assign(new Error('sms-config'),{confirmedFailure:true});
 return sendAligoSms(env,phone,'[소셜팩토리] 인증번호 '+code+' (5분 이내 입력)',{test});
}
export async function sendAligoSms(env,phone,message,{test=false}={}){
 const c=guestSmsConfig(env);
 const bytes=[...message].reduce((count,char)=>count+(char.charCodeAt(0)<128?1:2),0);
 if(!c.configured || !/^01[016789]\d{7,8}$/.test(phone) || !message || bytes>90)throw Object.assign(new Error('sms-config'),{confirmedFailure:true});
 const form=new URLSearchParams({key:c.key,user_id:c.user,sender:c.sender,receiver:phone,msg:message,msg_type:'SMS',testmode_yn:test?'Y':'N'});
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),10000);
 try{
  let r,data;try{r=await fetch(c.url,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8',...(c.url===RELAY?{Authorization:'Bearer '+c.secret}:{})},body:form,signal:ctrl.signal});data=await r.json()}catch{throw new Error('sms-unconfirmed')}
  if(!r.ok || data.result_code===undefined)throw new Error('sms-unconfirmed');
  if(Number(data.result_code)!==1)throw Object.assign(new Error('sms-rejected'),{confirmedFailure:true,providerCode:Number(data.result_code)});
  if(!test && (!data.msg_id || Number(data.success_cnt)!==1 || Number(data.error_cnt)!==0))throw new Error('sms-unconfirmed');
  return {test,messageId:String(data.msg_id||'')};
 }finally{clearTimeout(timer)}
}
