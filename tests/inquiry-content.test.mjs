import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {onRequestPost} from '../functions/api/inquiry.js';

function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 const DB={prepare(sql){let args=[];return {
  bind(...values){args=values;return this;},
  async first(){return db.prepare(sql).get(...args)||null;},
  async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}};}
 };}};
 const env={DB,NOTIFY_WEBHOOK:'https://hooks.example.test/test-only'},notifications=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,env.NOTIFY_WEBHOOK);notifications.push(JSON.parse(options.body));return new Response('',{status:200});});
 const submit=body=>onRequestPost({env,request:new Request('https://socialfactory.test/api/inquiry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
 const input=(extra={})=>({submissionId:crypto.randomUUID(),purpose:'rental',space:'r5',name:'문의 고객',phone:'01012345678',message:'노트북 연결이 필요합니다.',meetingType:'회의 · 면접',consent:true,...extra});
 return {db,notifications,submit,input};
}
test('meeting selector is persisted and notified once, with duplicate submissions returning the existing receipt',async t=>{
 const f=fixture(t),body=f.input(),first=await f.submit(body),j=await first.json();assert.equal(first.status,200);assert.equal(j.notified,true);
 const saved=f.db.prepare('SELECT message,notify_status FROM inquiries').get();assert.equal(saved.message,'노트북 연결이 필요합니다.\n\n모임 유형: 회의 · 면접');assert.equal(saved.notify_status,'sent');
 assert.equal(f.notifications.length,1);assert.equal(f.notifications[0].message,saved.message);assert.equal(f.notifications[0].text.split('모임 유형:').length-1,1);
 const retry=await f.submit(body),again=await retry.json();assert.equal(again.receipt,j.receipt);assert.equal(again.duplicate,true);assert.equal(f.notifications.length,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inquiries').get().n,1);
});
test('selector cannot replace a required inquiry message, and an existing identical line is not appended twice',async t=>{
 const f=fixture(t),invalid=await f.submit(f.input({message:' \u0000 '}));assert.equal(invalid.status,400);assert((await invalid.json()).fields.includes('message'));assert.equal(f.notifications.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM inquiries').get().n,0);
 const message='원하는 내용을 작성했습니다.\n모임 유형: 회의 · 면접';assert.equal((await f.submit(f.input({message}))).status,200);assert.equal(f.db.prepare('SELECT message FROM inquiries').get().message,message);
});
test('selector stays single-line and bounded inside the existing message limit; optional office move-in timing survives',async t=>{
 const f=fixture(t),type='워크숍\u0000\n팀빌딩\t'+'가'.repeat(100),body=f.input({message:'상세'.repeat(2000),meetingType:type});assert.equal((await f.submit(body)).status,200);
 const saved=f.db.prepare('SELECT message FROM inquiries').get().message;assert(saved.length<=3000);assert.equal(saved.includes('\u0000'),false);assert.equal(saved.split('\n').length,3);assert.match(saved,/\n\n모임 유형: 워크숍 팀빌딩 /);assert(saved.split('모임 유형: ')[1].length<=40);
 const office=f.input({purpose:'office',space:'office',meetingType:'',when:'다음 달 입주 희망',message:'2인 월 단위 입주 문의'});assert.equal((await f.submit(office)).status,200);
 const row=f.db.prepare("SELECT message,when_text FROM inquiries WHERE purpose='office'").get();assert.equal(row.message,office.message);assert.equal(row.when_text,office.when);
});

const main=readFileSync(new URL('../js/main.js',import.meta.url),'utf8');
function memberMenu(enabled,cookie){
 const links=[{hidden:true,textContent:'로그인',href:'/login'}],notes=[{hidden:true,innerHTML:''}];
 const block=main.slice(main.indexOf('var memberCfg = CFG.members || {};'),main.indexOf('// 대표 예약 채널 버튼'));
 vm.runInNewContext(block,{CFG:{members:{enabled}},document:{cookie},$$:selector=>selector==='[data-member-link]'?links:notes});return {link:links[0],note:notes[0]};
}
test('existing signed-in members retain account navigation while anonymous membership menus stay disabled',()=>{
 const signed=memberMenu(false,'other=1; sf_m=1');assert.equal(signed.link.hidden,false);assert.equal(signed.link.href,'/mypage');assert.equal(signed.link.textContent,'마이페이지');assert.equal(signed.note.hidden,false);assert.match(signed.note.innerHTML,/로그인한 상태/);
 const anonymous=memberMenu(false,'');assert.equal(anonymous.link.hidden,true);assert.equal(anonymous.note.hidden,true);
 const enabled=memberMenu(true,'');assert.equal(enabled.link.hidden,false);assert.equal(enabled.link.href,'/login');assert.equal(enabled.note.hidden,false);assert.match(enabled.note.innerHTML,/회원가입 없이도/);
});
test('office inquiries expose optional move-in timing and current pass/monthly hints',()=>{
 const html=readFileSync(new URL('../contact.html',import.meta.url),'utf8');assert.match(html,/<div class="field" data-when-purpose="[^"]*\boffice\b[^"]*"><label for="f-when">/);
 assert.match(main,/office: "예: 2인, 월 단위 이용/);assert.equal(main.includes('office: "예: 2인, 1주권'),false);assert.equal(main.includes('coworking: "예: 4주권'),false);
});
