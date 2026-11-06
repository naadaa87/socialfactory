import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {createHmac} from 'node:crypto';
import {relayRequest,relayLedger} from '../../deploy/amano-server/aligo-relay.mjs';
import {notifyProblems} from '../../deploy/amano-server/alerts.mjs';
import {notifySocialfactoryProblems,runSocialfactory,socialfactoryStore,socialfactoryControl} from '../../deploy/amano-server/socialfactory.mjs';
import {runAmanoTick} from '../../deploy/amano-server/tick.mjs';
import {DISCOUNTS} from '../../deploy/amano-server/client.mjs';
function fixture(t){
 const data={credentials:{username:'local-account',passwordHash:'a'.repeat(64)},settings:{enabled:true},'socialfactory-settings':{enabled:true}},store={read:k=>data[k]?structuredClone(data[k]):null,save:(k,v)=>data[k]=structuredClone(v)};
 const env={ALIGO_RELAY_SECRET:'local-megaspot-signature-at-least-32-characters',SOCIALFACTORY_RELAY_SECRET:'local-socialfactory-signature-at-least-32-characters',ALIGO_PARKING_ADMIN_RECEIVERS:'01011112222,01033334444',SOCIALFACTORY_PARKING_ADMIN_RECEIVERS:'01011112222',ALIGO_API_KEY:'local-key',ALIGO_USERID:'local-user',ALIGO_SENDER_KEY:'local-sender-key',ALIGO_SENDER:'0212345678'};
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const ledger=relayLedger(db),sends=[],requests=[],midPhones={};let unknown=false,delivered=false,seq=100;
 const provider=async(url,opts)=>{const b=new URLSearchParams(opts.body);if(url==='https://apis.aligo.in/sms_list/')return Response.json({result_code:1,list:delivered?[{receiver:midPhones[b.get('mid')],send_date:'2026-11-06 15:00:00',sms_state:'발송완료'}]:[]});assert.equal(url,'https://apis.aligo.in/send/');sends.push(b);if(unknown)throw Error('Response lost after send');const mid=String(seq++);midPhones[mid]=b.get('receiver');return Response.json({result_code:1,msg_id:mid,success_cnt:1,error_cnt:0});};
 const upstream=async(url,opts)=>{assert.equal(url,'http://127.0.0.1:8787/v1/aligo');requests.push(JSON.parse(opts.body));return relayRequest(new Request(url,opts),env,ledger,provider);};
 const signed=async(path,b,secret=env.ALIGO_RELAY_SECRET)=>{const body=JSON.stringify({path,data:b,request_id:crypto.randomUUID(),time:Date.now()});return relayRequest(new Request('http://localhost/v1/aligo',{method:'POST',headers:{'X-Megaspot-Signature':createHmac('sha256',secret).update(body).digest('hex')},body}),env,ledger,provider);};
 return {data,store,env,sends,requests,upstream,signed,unknown:()=>unknown=true,delivered:()=>delivered=true};
}
test('실제 알림 처리기와 중계 API가 연결되어 지정 관리자에게 소셜팩토리 오류를 한 번만 접수·전달 확인',async t=>{
 const f=fixture(t),at=Date.now(),issue={oid:'SF261106120000ABCD',kind:'registration',message:'아마노 할인 등록 결과 확인 필요'};
 await notifySocialfactoryProblems(f.env,f.store,[issue],f.upstream,at);await notifySocialfactoryProblems(f.env,f.store,[{...issue,message:'기존 처리 결과 확인 필요'}],f.upstream,at+5000);
 assert.equal(f.sends.length,1);assert.equal(f.sends[0].get('receiver'),'01011112222');assert.equal(f.sends[0].get('title'),'소셜팩토리 주차권 관리자 알림');assert.match(f.sends[0].get('msg'),/^\[소셜팩토리 주차권 자동 등록 오류\]/);assert(f.sends[0].get('msg').endsWith('https://socialfactory.co.kr/admin#parking'));
 f.delivered();await notifySocialfactoryProblems(f.env,f.store,[],f.upstream,at+20000);assert.equal(Object.values(f.data['socialfactory-alert-journal'])[0].status,'delivered');assert.equal(f.data['alert-journal'],undefined);
});
test('잔액 부족은 한국 날짜별 1회이며 두 브랜드 요청 ID·원장이 충돌하지 않음',async t=>{
 const f=fixture(t),at=Date.parse('2026-11-06T18:00:00+09:00'),issue={oid:'SF261106120000ABCD',kind:'balance',message:'아마노 잔액 부족: 필요 3000원, 현재 0원'};
 await notifySocialfactoryProblems(f.env,f.store,[issue],f.upstream,at);await notifySocialfactoryProblems(f.env,f.store,[{...issue,oid:'SF261106120000EFGH'}],f.upstream,at+5000);assert.equal(f.sends.length,1);assert.match(f.sends[0].get('msg'),/잔액 부족/);
 await notifyProblems(f.env,f.store,[issue],f.upstream,at);assert.equal(f.sends.length,3);assert.equal(new Set(f.requests.filter(r=>r.path.endsWith('/send')).map(r=>r.request_id)).size,3);assert(Object.values(f.data['alert-journal']).every(e=>e.message.startsWith('[메가스팟')));
 await notifySocialfactoryProblems(f.env,f.store,[issue],f.upstream,at+86400000);assert.equal(f.sends.length,4);
});
test('응답 불명은 같은 요청 ID로만 확인하며 중계가 이미 선점한 문자를 다시 보내지 않음',async t=>{
 const f=fixture(t),at=Date.now();f.unknown();await notifySocialfactoryProblems(f.env,f.store,[{oid:'SF261106120000ABCD',message:'등록 오류'}],f.upstream,at);await notifySocialfactoryProblems(f.env,f.store,[],f.upstream,at+61000);await notifySocialfactoryProblems(f.env,f.store,[],f.upstream,at+122000);assert.equal(f.sends.length,1);assert.equal(new Set(f.requests.map(r=>r.request_id)).size,1);assert.equal(Object.values(f.data['socialfactory-alert-journal'])[0].status,'unknown');
});
test('소셜팩토리 전용 중계는 서명·허용 번호·브랜드·오류 종류·고정 관리자 링크를 모두 검사',async t=>{
 const f=fixture(t),msg='[소셜팩토리 주차권 자동 등록 오류]\n등록 확인 필요\nhttps://socialfactory.co.kr/admin#parking';
 for(const data of [{receiver:'01033334444',msg},{receiver:'01011112222',msg:msg.replace('자동 등록 오류','결제 완료')},{receiver:'01011112222',msg:msg.replace('소셜팩토리','메가스팟')},{receiver:'01011112222',msg:msg+'?token=private'}])assert.equal((await f.signed('socialfactory-admin/send',data)).status,403);
 assert.equal((await f.signed('socialfactory-admin/send',{receiver:'01011112222',msg},'wrong')).status,401);f.env.SOCIALFACTORY_PARKING_ADMIN_RECEIVERS='01099998888';assert.equal((await f.signed('socialfactory-admin/send',{receiver:'01099998888',msg})).status,403);assert.equal(f.sends.length,0);
});
test('정상·입차 대기는 문자를 새로 보내지 않고 서버 예외와 연결 설정 누락은 관리자에게 알림',async t=>{
 const f=fixture(t);t.mock.method(globalThis,'fetch',f.upstream);const base={env:f.env,store:f.store,clientFactory:()=>({})};await runSocialfactory({...base,run:async()=>({ok:true,processed:0,waiting:2,issues:[]})});assert.equal(f.sends.length,0);
 await runSocialfactory({...base,run:async()=>{throw Error('private credential');}});assert.equal(f.sends.length,1);assert(!f.sends[0].get('msg').includes('private credential'));assert.equal(f.data['socialfactory-last-run'].ok,false);
 f.data.credentials=null;await runSocialfactory(base);assert.equal(f.sends.length,1);
});
test('문자 설정·발송 오류는 정상 등록 결과를 바꾸지 않고 상태 화면에서 확인 가능',async t=>{
 const f=fixture(t);f.env.SOCIALFACTORY_PARKING_ADMIN_RECEIVERS='01099998888';let network=0;t.mock.method(globalThis,'fetch',async()=>{network++;throw Error('forbidden');});const r=await runSocialfactory({env:f.env,store:f.store,clientFactory:()=>({}),run:async()=>({ok:true,processed:1,issues:[]})});assert.equal(r.processed,1);assert.equal(network,0);assert.equal(f.data['socialfactory-alert-status'].ok,false);
 const body=JSON.stringify({action:'status',time:Date.now()}),response=await socialfactoryControl(new Request('http://localhost/v1/socialfactory-amano',{method:'POST',headers:{'X-Socialfactory-Signature':createHmac('sha256',f.env.SOCIALFACTORY_RELAY_SECRET).update(body).digest('hex')},body}),f.env,f.store,()=>({})),status=await response.json();assert.equal(status.error_alerts_enabled,false);assert.deepEqual(status.error_alert_receivers,[]);assert(!JSON.stringify(status).includes('01099998888'));
});
test('등록 서버가 응답하지 않아도 독립 주기 실행기가 소셜팩토리 진행 주문의 오류를 알리고 중복을 막음',async t=>{
 const f=fixture(t);socialfactoryStore(f.store).save('operations',{SF261106120000ABCD:{phase:'request_6'}});const upstream=(url,opts)=>url.includes(':8790')?Promise.reject(Error('server down')):f.upstream(url,opts);
 const r=await runAmanoTick(f.env,{upstream,storeFactory:()=>f.store});assert.equal(r.ok,false);assert.equal(f.sends.length,3);const sf=f.sends.filter(b=>b.get('title').startsWith('소셜팩토리'));assert.equal(sf.length,1);assert.match(sf[0].get('msg'),/SF261106120000ABCD/);await runAmanoTick(f.env,{upstream,storeFactory:()=>f.store});assert.equal(f.sends.length,3);
});
test('서버가 이미 오류 알림을 처리한 응답에는 주기 실행기가 중복 알림을 생성하지 않음',async t=>{
 const f=fixture(t),r=await runAmanoTick(f.env,{upstream:async()=>Response.json({ok:false,alerts_handled:true},{status:502}),storeFactory:()=>f.store});assert.equal(r.ok,false);assert.equal(f.sends.length,0);
});
for(const kind of ['balance','registration'])test('아마노 실제 처리기의 '+kind+' 오류가 등록 보류와 관리자 문자 중계까지 이어짐',async t=>{
 const f=fixture(t),date=new Date(Date.now()+9*36e5).toISOString().slice(0,10),entry={id:'NIGHT-1',plate:'123가4567',entryAt:date+'T00:00:00',cardType:'0',out:false},item={oid:'SF261106120000ABCD',plate:entry.plate,visit_date:date,ticket:'2h',hours:2,price:8000};let issue=null,registrations=0;
 const site=async(action,params)=>{if(action==='orders')return {ok:true,operating:true,date,items:issue?[]:[item]};if(action==='issue'){issue=params;return {ok:true};}throw Error('Should not claim or complete a failed registration');};
 const client={credentials:{username:'local-account'},login:async()=>{},entries:async()=>[entry],detail:async()=>{if(kind==='registration')throw Error('아마노 입차 상세 조회 응답 확인 필요');return {entry,types:Object.entries(DISCOUNTS).map(([id,v])=>({id,...v})),discounts:[],balance:0};},register:async()=>registrations++};
 t.mock.method(globalThis,'fetch',f.upstream);const result=await runSocialfactory({env:f.env,store:f.store,clientFactory:()=>client,site});assert.equal(result.processed,0);assert.equal(result.issues[0].kind,kind);assert.equal(registrations,0);assert.equal(issue.oid,item.oid);assert.equal(f.sends.length,1);assert.match(f.sends[0].get('msg'),kind==='balance'?/필요 3000원, 현재 0원/:/입차 상세 조회/);await runSocialfactory({env:f.env,store:f.store,clientFactory:()=>client,site});assert.equal(f.sends.length,1);
});
