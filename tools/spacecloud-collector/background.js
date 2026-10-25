const HOST='https://partner.spacecloud.kr', SERVER='https://socialfactory.co.kr', ALARM='sf-sync-15m';
const validUrl=url=>{try{const u=new URL(url);return u.origin===HOST&&['/report/draft','/report/account'].includes(u.pathname);}catch{return false;}};
const job=async()=>(await chrome.storage.session.get('job')).job;
const settings=async()=>(await chrome.storage.local.get('settings')).settings||{};
async function api(body,token){const response=await fetch(SERVER+'/api/spacecloud-sync',{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});const j=await response.json();if(!response.ok)throw Error(j.message||'서버 연결 실패');return j;}
async function badge(tabId,text){try{await chrome.action.setBadgeText({...(tabId?{tabId}:{}),text});}catch{}}
async function inject(tabId){await chrome.scripting.executeScript({target:{tabId},files:['content.js']});}
// A full navigation can remove the old main frame after the tab reports
// "complete". Retry only that transient race; other script errors still stop
// the collection so an incomplete snapshot is never submitted.
async function injectAfterNavigation(tabId,attempt=0){
 try{await inject(tabId);}catch(e){
  if(!/Frame with ID \d+ was removed/i.test(String(e?.message))||attempt>=4)throw e;
  await new Promise(resolve=>setTimeout(resolve,350));
  const j=await job();if(!j||j.tabId!==tabId)return;
  const tab=await chrome.tabs.get(tabId);
  if(tab.status==='complete'&&validUrl(tab.url))await injectAfterNavigation(tabId,attempt+1);
  // A loading tab will produce another onUpdated("complete") event.
 }
}
async function fail(status,message){
 const j=await job(),s=await settings();await chrome.storage.session.remove('job');await badge(j?.tabId,'오류');
 await chrome.storage.local.set({lastResult:{status,message,at:Date.now()}});
 if(s.token){try{await api({action:'error',status},s.token);}catch{}}
 if(s.lastAlert!==status){await chrome.storage.local.set({settings:{...s,lastAlert:status}});try{await chrome.notifications.create('sf-sync-alert',{type:'basic',iconUrl:'icon.png',title:'소셜팩토리 매출 동기화 확인',message:status==='login_required'?'스페이스클라우드 로그인 만료: 호스트센터에 다시 로그인해 주세요.':message});}catch{}}
 if(j?.owned){try{await chrome.tabs.remove(j.tabId);}catch{}}
}
let starting=false;
async function runAuto(){
 if(starting)return;starting=true;try{
 const s=await settings();if(!s.enabled||!s.token)return;
 const old=await job();if(old){if(Date.now()-old.started<12*60000)return;await fail('collection_error','수집 시간이 초과됐습니다. 다음 주기에 재시도합니다.');}
 const tab=await chrome.tabs.create({url:HOST+'/report/draft?page=1',active:false});
 await chrome.storage.session.set({job:{tabId:tab.id,owned:true,auto:true,started:Date.now(),source:'draft',rows:[],visited:[],skipped:0,configured:[],since:s.since||'2020-01-01'}});
 if(tab.status==='complete')await injectAfterNavigation(tab.id);
 }finally{starting=false;}
}
async function initialize(){
 await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
 const s=await settings();if(s.enabled&&!await chrome.alarms.get(ALARM))await chrome.alarms.create(ALARM,{periodInMinutes:15});
 if(!s.enabled)await chrome.alarms.clear(ALARM);
}
chrome.runtime.onInstalled.addListener(()=>initialize());chrome.runtime.onStartup.addListener(async()=>{await initialize();await runAuto();});
chrome.alarms.onAlarm.addListener(async a=>{if(a.name===ALARM)try{await runAuto();}catch(e){await fail('collection_error',e.message);}});
chrome.action.onClicked.addListener(async tab=>{
 const s=await settings();if(s.enabled&&s.token){await runAuto();return;}
 if(!validUrl(tab.url)){await chrome.runtime.openOptionsPage();return;}
 if(await job())return;
 await chrome.storage.session.set({job:{tabId:tab.id,auto:false,started:Date.now(),source:new URL(tab.url).pathname.endsWith('account')?'account':'draft',rows:[],visited:[],skipped:0,configured:[]}});await badge(tab.id,'수집');await inject(tab.id);
});
chrome.tabs.onUpdated.addListener(async(tabId,change,tab)=>{
 if(change.status!=='complete')return;const j=await job();if(!j||j.tabId!==tabId)return;
 if(tab.url?.startsWith(HOST+'/auth/')){await fail('login_required','호스트센터 로그인 만료');return;}
 if(!validUrl(tab.url)){await fail('collection_error','호스트센터 수집 화면을 벗어났습니다.');return;}
 try{await injectAfterNavigation(tabId);}catch(e){await fail('collection_error',e.message);}
});
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
 (async()=>{
  // Only the packaged options page may connect, start, or pause the device.
  if(sender.id===chrome.runtime.id&&sender.url===chrome.runtime.getURL('options.html')){
   const s=await settings();
   if(m.type==='settings')return {ok:true,enabled:!!s.enabled,connected:!!s.token,since:s.since||'2020-01-01',result:(await chrome.storage.local.get('lastResult')).lastResult};
   if(m.type==='connect'){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(m.since)||m.since<'2020-01-01'||m.since>new Date().toISOString().slice(0,10))throw Error('조회 시작일을 확인해 주세요.');
    const j=await api({action:'pair',code:m.code});await chrome.storage.local.set({settings:{token:j.token,enabled:true,since:m.since,expires_at:j.expires_at}});await initialize();await runAuto();return {ok:true};
   }
   if(m.type==='pause'){const j=await job();if(j)await fail('paused','자동 동기화 일시 중지');await chrome.storage.local.set({settings:{...s,enabled:false}});await initialize();return {ok:true};}
   if(m.type==='resume'){if(!s.token)throw Error('먼저 관리자 연결을 완료해 주세요.');await chrome.storage.local.set({settings:{...s,enabled:true,lastAlert:null}});await initialize();await runAuto();return {ok:true};}
   if(m.type==='run'){if(!s.enabled||!s.token)throw Error('연결을 완료하고 자동 동기화를 재개해 주세요.');await runAuto();return {ok:true};}
   return {ok:false};
  }
  const j=await job();if(!j||j.tabId!==sender.tab?.id||!validUrl(sender.url))return {ok:false};
  if(m.type==='state')return {ok:true,auto:j.auto,source:j.source,previousSignature:j.signature||null,firstPage:!j.visited.length,configure:j.auto&&!j.configured.includes(j.source),since:j.since};
  if(m.type==='configured'){if(!j.configured.includes(j.source))j.configured.push(j.source);await chrome.storage.session.set({job:j});return {ok:true};}
  if(m.type==='error'){await fail(m.status==='login_required'?'login_required':'collection_error',m.message||'수집 실패');return {ok:false};}
  if(m.type!=='page'||!Array.isArray(m.rows))return {ok:false};
  const u=new URL(m.pageUrl||sender.url);if(!validUrl(u.href)||!u.pathname.endsWith(j.source))throw Error('수집 화면이 변경되었습니다.');
  const page=Number(u.searchParams.get('page')||1),pageKey=j.source+':'+page;
  if(j.visited.includes(pageKey)||j.visited.length>=200)throw Error('중복 페이지 또는 200페이지 한도 초과');
  if(m.signature&&j.signature===m.signature)throw Error('이전 페이지의 표가 남아 있습니다.');j.signature=m.signature;j.visited.push(pageKey);j.skipped+=m.skipped||0;
  for(const row of m.rows){
   const prev=j.rows.find(x=>x.reservation_id===row.reservation_id);
   if(prev){if(['reservation_id','venue','use_date','end_date','paid_at','amount'].some(k=>prev[k]!==row[k]))throw Error('동일 예약의 결제금액·날짜가 상충합니다.');prev.refund_amount=Math.max(prev.refund_amount,row.refund_amount);prev.after_settlement_refund=Math.max(prev.after_settlement_refund||0,row.after_settlement_refund||0);}
   else j.rows.push(row);
  }
  if(j.rows.length>5000)throw Error('5,000건 한도 초과. 조회 시작일을 조정해 주세요.');
  if(m.next){const next=new URL(m.next,HOST),a=new URL(u),b=new URL(next);a.searchParams.delete('page');b.searchParams.delete('page');a.searchParams.sort();b.searchParams.sort();if(!validUrl(next.href)||next.pathname!==u.pathname||Number(next.searchParams.get('page'))!==page+1||a.search!==b.search)throw Error('페이지 조회 조건이 변경됐습니다.');await chrome.storage.session.set({job:j});return {ok:true,next:next.href};}
  if(j.auto&&j.source==='draft'){j.source='account';j.signature=null;await chrome.storage.session.set({job:j});return {ok:true,switchTo:HOST+'/report/account'};}
  const file={format:'socialfactory-spacecloud-payments',version:1,source:'host-draft',collected_at:new Date().toISOString(),pages:j.visited.length,skipped:j.skipped,rows:j.rows};
  if(!j.auto){await chrome.storage.session.remove('job');await badge(j.tabId,'완료');return {ok:true,file};}
  const s=await settings();if(!s.enabled)throw Error('자동 동기화가 중지됐습니다.');
  const result=await api({action:'sync',complete:true,observed_at:j.started,rows:j.rows},s.token);
  await chrome.storage.session.remove('job');await chrome.storage.local.set({lastResult:{status:'ok',at:Date.now(),counts:result.counts,pages:file.pages},settings:{...s,lastAlert:null}});await badge(null,result.counts.review?'확인':'완료');
  if(j.owned)try{await chrome.tabs.remove(j.tabId);}catch{}
  return {ok:true,synced:result.counts};
 })().then(reply,async e=>{await fail('collection_error',e.message);reply({ok:false,error:e.message});});return true;
});
initialize().catch(()=>{});
