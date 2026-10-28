import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../toss-front-plugin/app.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function harness({soundFails=false}={}) {
 const pages=[],listeners=new Map(),timers=new Map();let timerId=0,sounds=0;
 const template={openToast(){}};
 for(const name of ['renderIdlePage','renderInputPage','renderOnboardingPage','renderSelectPage']) template[name]=params=>pages.push({name,params});
 const document={getElementById:()=>({contains:target=>target.inside!==false}),addEventListener:(name,callback)=>listeners.set(name,callback)};
 const window={SF_KIOSK_UI:{normalize:()=>({})},TossFrontSDK:{template,app:{playTouchSound(){sounds++;return soundFails?Promise.reject(new Error('fixture mute')):Promise.resolve()}},storage:{async get({key}){return {value:key==='sf_kiosk_token'?'fixture-token':null}}}}};
 vm.runInNewContext(source,{window,document,fetch:async()=>new Response(JSON.stringify({ok:true,products:[]})),location:{hostname:'fixture.invalid'},URL,AbortController,console,
  setTimeout(callback,ms){const id=++timerId;timers.set(id,{callback,ms});return id},clearTimeout(id){timers.delete(id)}});
 await tick();
 return {get current(){return pages.at(-1)},get sounds(){return sounds},click(control,event={}){listeners.get('click')({target:control,...event})},pointerdown(control){listeners.get('pointerdown')({target:control})},
  runTimers(ms){for(const [id,timer] of [...timers])if(timer.ms===ms){timers.delete(id);timer.callback()}},timers};
}
function control(tag='BUTTON',label='',extra={}) {
 return {tagName:tag,disabled:false,closest(){return this},getAttribute(name){return name==='aria-label'?label:null},...extra};
}
test('조회 버튼의 pointerup 뒤 click이 끝날 때까지 입력 화면을 열지 않음',async()=>{
 const h=await harness();
 h.current.params.secondaryButton.onClick();
 h.current.params.secondaryButton.onClick(); // 같은 터치가 중복 전달되어도 전환은 한 번만 예약
 assert.equal(h.current.name,'renderIdlePage');assert.equal(h.timers.size,1);
 h.click(control());
 assert.equal(h.current.name,'renderIdlePage');
 h.runTimers(0);
 assert.equal(h.current.name,'renderInputPage');assert.equal(h.current.params.type,'phone');
 assert.equal(h.current.params.input.placeholder,'010-');assert.equal([...h.timers.values()].filter(t=>t.ms===120000).length,1);assert.equal(h.sounds,1);
});
test('click을 전달하지 않는 단말기에서도 대기 버튼 동작을 수행',async()=>{
 const h=await harness();h.current.params.secondaryButton.onClick();h.runTimers(40);
 assert.equal(h.current.name,'renderInputPage');
});
test('이동·지우기·체크 버튼에는 소리, SDK 숫자 키에는 중복 소리 없음',async()=>{
 const h=await harness();
 h.click(control());h.click(control('TD','지우기'));h.click(control('INPUT','', {type:'checkbox'}));
 assert.equal(h.sounds,3);
 h.click(control('TD','0'));h.click(control('TD','1'));
 assert.equal(h.sounds,3);
 h.click(control('BUTTON','',{disabled:true}));h.click(control('BUTTON','',{inside:false}));
 assert.equal(h.sounds,3);
});
test('터치음 API 실패가 조회 화면 진입을 막지 않음',async()=>{
 const h=await harness({soundFails:true});h.current.params.secondaryButton.onClick();h.click(control());h.runTimers(0);await tick();
 assert.equal(h.current.name,'renderInputPage');
});

test('구매 버튼은 click이 없는 환경에서도 40ms 뒤 준비 화면으로 반응',async()=>{
 const h=await harness();h.current.params.primaryButton.onClick();h.runTimers(40);
 assert.equal(h.current.params.title,'이용권을 불러오고 있어요');await tick();
});

test('지연 click이 새 키패드로 넘어가면 차단하고 실제 다음 터치는 허용',async()=>{
 const h=await harness(),old=control('BUTTON','내 이용권 확인',{isConnected:true});
 h.pointerdown(old);h.current.params.secondaryButton.onClick();h.runTimers(40);
 old.isConnected=false;const zero=control('TD','0',{isConnected:true});let stopped=false,prevented=false;
 h.click(zero,{detail:1,preventDefault(){prevented=true},stopPropagation(){stopped=true}});
 assert.equal(stopped,true);assert.equal(prevented,true);
 h.pointerdown(zero);stopped=false;h.click(zero,{detail:1,preventDefault(){},stopPropagation(){stopped=true}});
 assert.equal(stopped,false);
});

test('조회 입력을 두고 떠나면 2분 뒤 첫 화면으로 복귀하고 기존 입력 화면 제거',async()=>{
 const h=await harness();h.current.params.secondaryButton.onClick();h.runTimers(40);
 assert.equal(h.current.name,'renderInputPage');h.runTimers(120000);
 assert.equal(h.current.name,'renderIdlePage');assert.equal(h.timers.size,0);
});
test('입력 중 터치는 자동 복귀 타이머를 갱신하고 진행 화면에서는 타이머 해제',async()=>{
 const h=await harness();h.current.params.secondaryButton.onClick();h.runTimers(40);
 const before=[...h.timers.keys()][0];h.pointerdown(control('TD','1'));
 assert(!h.timers.has(before));assert.equal(h.timers.size,1);
 h.current.params.onBack();h.current.params.primaryButton.onClick();h.runTimers(40);
 assert.equal(h.current.name,'renderSelectPage');assert.equal([...h.timers.values()].filter(t=>t.ms===120000).length,0);await tick();
});
