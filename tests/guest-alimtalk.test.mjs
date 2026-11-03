import test from 'node:test';import assert from 'node:assert/strict';import {approvedWebsiteTemplate,sendAligo} from '../functions/_lib/aligo.js';import {TEMPLATES,buildMessage} from '../functions/_lib/notify.js';import {sendGuestSms} from '../functions/_lib/guest-sms.js';
const vars={이용권:'2시간권',금액:'4,000',시작:'11월 6일 14:00',만료:'11월 6일 16:00',주문번호:'SF261103180000DEMO',주문토큰:'example-private-token',__orderLink:'https://socialfactory.co.kr/order-complete?oid=SF261103180000DEMO&t=example-private-token'};
function settings(){return {ALIGO_API_KEY:'dummy-api-key',ALIGO_USER_ID:'dummy-user',ALIGO_SENDER:'0212345678',ALIGO_SENDER_KEY:crypto.randomUUID()}};
test('홈페이지 구매 템플릿에 주문 링크·안내 버튼을 치환하고 대체문자에도 링크 포함',()=>{
 const m=buildMessage('website_purchase',vars),b=m.buttons.button;assert.equal(b[0].name,'내 주문 확인·시간 변경');assert.equal(b[0].linkMo,vars.__orderLink);assert.equal(b[0].linkPc,vars.__orderLink);assert.equal(b[1].linkMo,'https://socialfactory.co.kr/guide');assert(!m.fallbackText.includes('#{'));assert(m.fallbackText.includes(vars.__orderLink));
 assert(buildMessage('purchase',vars).fallbackText.includes(vars.__orderLink));
});
test('검수 중에는 사용하지 않고 승인된 본문·버튼이 정확히 일치한 뒤에만 자동 사용',async t=>{
 const env=settings(),tpl=TEMPLATES.website_purchase;let status='REQ',changed=false,calls=0,clock=Date.now();t.mock.method(Date,'now',()=>clock);
 t.mock.method(globalThis,'fetch',async(url,o)=>{calls++;assert.equal(url,'https://kakaoapi.aligo.in/akv10/template/list/');assert.equal(new URLSearchParams(o.body).get('tpl_code'),'UN_2929');return new Response(JSON.stringify({code:0,list:[{templtCode:'UN_2929',inspStatus:status,status:'A',templtContent:changed?'wrong':tpl.text,buttons:tpl.buttons.button}]}))});
 assert.equal(await approvedWebsiteTemplate(env,tpl),false);status='APR';assert.equal(await approvedWebsiteTemplate(env,tpl),false);assert.equal(calls,1);clock+=300001;assert.equal(await approvedWebsiteTemplate(env,tpl),true);changed=true;clock+=300001;assert.equal(await approvedWebsiteTemplate(env,tpl),false);
});
test('승인 조회 실패·변경된 링크는 사용하지 않고 임의 중계로 인증정보를 보내지 않음',async t=>{
 const env=settings();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('network')});assert.equal(await approvedWebsiteTemplate(env,TEMPLATES.website_purchase),false);assert.equal(calls,1);
 const bad={...settings(),ALIGO_RELAY_URL:'https://evil.test',ALIGO_RELAY_SECRET:'x'.repeat(43)};assert.equal(await approvedWebsiteTemplate(bad,TEMPLATES.website_purchase),false);assert.equal(calls,1);
});
test('알리고 전송은 모든 알림에 대체문자 본문·제목을 함께 전달',async t=>{
 const env=settings(),forms=[];t.mock.method(globalThis,'fetch',async(_,o)=>{forms.push(new URLSearchParams(o.body));return new Response(JSON.stringify({code:0,info:{mid:'fake',scnt:1,fcnt:0}}))});
 for(const kind of ['purchase','expire_soon','renewal','refund','website_purchase']){
  const v={...vars,기존종료일시:'11월 5일 16:00',최종종료일시:'11월 6일 16:00',환불금액:'4,000',처리일시:'11월 3일 18:00'};const msg=buildMessage(kind,v);await sendAligo(env,{phone:'01000000000'},msg,TEMPLATES[kind]);
 }
 for(const f of forms){assert.equal(f.get('failover'),'Y');assert(f.get('fsubject_1'));assert(f.get('fmessage_1').includes('소셜팩토리'));assert(!f.get('fmessage_1').includes('#{'))}
});
test('인증 SMS는 전용 중계·발신자와 테스트 모드를 고정하며 문자·키를 응답에 노출하지 않음',async t=>{
 const env={...settings(),ALIGO_RELAY_URL:'https://relay.naranhistory.com/socialfactory/aligo/send',ALIGO_RELAY_SECRET:'a'.repeat(43)};let body;
 t.mock.method(globalThis,'fetch',async(url,o)=>{assert.equal(url,'https://relay.naranhistory.com/socialfactory/aligo/sms');assert.equal(o.headers.Authorization,'Bearer '+env.ALIGO_RELAY_SECRET);body=new URLSearchParams(o.body);return new Response(JSON.stringify({result_code:1,msg_id:'mock',success_cnt:1,error_cnt:0}))});
 const r=await sendGuestSms(env,'01000000000','123456',{test:true});assert.equal(body.get('testmode_yn'),'Y');assert.equal(body.get('receiver'),'01000000000');assert.equal(body.get('msg_type'),'SMS');assert(!JSON.stringify(r).includes('123456'));assert(!JSON.stringify(r).includes(env.ALIGO_API_KEY));
});
