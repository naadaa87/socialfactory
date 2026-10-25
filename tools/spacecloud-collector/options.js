const $=id=>document.getElementById(id);
let initialized=false;
async function refresh(){const s=await chrome.runtime.sendMessage({type:'settings'});if(!initialized){$('since').value=s.since;initialized=true;}$('connect').disabled=!!s.connected&&!$('code').value.trim();$('status').textContent=(s.connected?'서버 연결됨':'서버 연결 필요')+' · '+(s.enabled?'15분 자동 동기화 사용 중':'자동 동기화 중지')+'\n'+(s.result?JSON.stringify(s.result,null,2):'아직 수집 결과가 없습니다.');}
$('code').addEventListener('input',()=>{$('connect').disabled=!$('code').value.trim();});
for(const type of ['connect','run','pause','resume'])$(type).addEventListener('click',async()=>{const button=$(type);if(button.disabled)return;button.disabled=true;try{const r=await chrome.runtime.sendMessage({type,code:$('code').value.trim(),since:$('since').value});if(!r.ok)throw Error(r.error||'처리 실패');if(type==='connect')$('code').value='';await refresh();}catch(e){$('status').textContent=e.message;}finally{if(type!=='connect'||$('code').value.trim())button.disabled=false;}});
refresh();setInterval(refresh,10000);
