const HOST='https://partner.spacecloud.kr';
const validUrl=url=>{try{const u=new URL(url);return u.origin===HOST&&u.pathname==='/report/draft';}catch{return false;}};
async function job(){return (await chrome.storage.session.get('job')).job;}
async function inject(tabId){await chrome.scripting.executeScript({target:{tabId},files:['content.js']});}
chrome.action.onClicked.addListener(async tab=>{
  if(!validUrl(tab.url)) {await chrome.action.setBadgeText({tabId:tab.id,text:'예정'});return;}
  const old=await job();if(old&&old.tabId===tab.id&&old.running)return;
  await chrome.storage.session.set({job:{tabId:tab.id,running:true,rows:[],visited:[],skipped:0}});
  await chrome.action.setBadgeText({tabId:tab.id,text:'수집'});
  await inject(tab.id);
});
chrome.tabs.onUpdated.addListener(async(tabId,change)=>{
  if(change.status!=='complete')return;const j=await job();
  if(j&&j.running&&j.tabId===tabId){try{await inject(tabId);}catch{await chrome.storage.session.remove('job');await chrome.action.setBadgeText({tabId,text:'오류'});}}
});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  (async()=>{
    const j=await job();if(!j||!j.running||j.tabId!==sender.tab?.id||!validUrl(sender.url))return {ok:false};
    if(message.type==='state')return {ok:true,previousSignature:j.signature||null,firstPage:j.visited.length===0};
    if(message.type==='error'){await chrome.storage.session.remove('job');await chrome.action.setBadgeText({tabId:j.tabId,text:'오류'});return {ok:false};}
    if(message.type!=='page'||!Array.isArray(message.rows))return {ok:false};
    const url=new URL(message.pageUrl||sender.url);if(!validUrl(url.href))throw Error('수집 화면 주소를 확인할 수 없습니다.');const page=Number(url.searchParams.get('page')||1);
    if(j.visited.includes(page)||j.visited.length>=100)throw Error('중복 페이지 또는 수집 한도 초과');
    if(message.signature&&j.signature===message.signature)throw Error('이전 페이지의 예약 표가 남아 있습니다. 새로고침 후 다시 수집해 주세요.');
    j.signature=message.signature||null;
    j.visited.push(page);j.skipped+=message.skipped||0;
    for(const row of message.rows){
      const prev=j.rows.find(x=>x.reservation_id===row.reservation_id);
      if(prev&&['reservation_id','venue','use_date','end_date','paid_at','amount','refund_amount'].some(key=>prev[key]!==row[key]))throw Error('페이지 사이 예약 정보가 변경됐습니다. 다시 수집해 주세요.');
      if(!prev)j.rows.push(row);
    }
    if(j.rows.length>5000)throw Error('5,000건 한도를 초과했습니다. 조회 기간을 줄여 주세요.');
    if(message.next){
      const next=new URL(message.next,HOST);
      if(!validUrl(next.href)||Number(next.searchParams.get('page'))!==page+1)throw Error('다음 페이지 주소를 확인할 수 없습니다.');
      const a=new URL(url),b=new URL(next);a.searchParams.delete('page');b.searchParams.delete('page');a.searchParams.sort();b.searchParams.sort();if(a.search!==b.search)throw Error('페이지 사이 조회 조건이 변경됐습니다.');
      await chrome.storage.session.set({job:j});return {ok:true,next:next.href};
    }
    await chrome.storage.session.remove('job');await chrome.action.setBadgeText({tabId:j.tabId,text:'완료'});
    return {ok:true,file:{format:'socialfactory-spacecloud-payments',version:1,source:'host-draft',collected_at:new Date().toISOString(),pages:j.visited.length,skipped:j.skipped,rows:j.rows}};
  })().then(reply,async e=>{await chrome.storage.session.remove('job');if(sender.tab)await chrome.action.setBadgeText({tabId:sender.tab.id,text:'오류'});reply({ok:false,error:e.message});});return true;
});
