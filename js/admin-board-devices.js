(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  if(!$('board-device-form')) return;
  const time=t=>t?new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}):'—';
  const el=(tag,text,className)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(className)e.className=className;return e;};
  let loading=false,codeTimer;
  async function api(body){
    const response=await fetch('/api/admin/board-devices',{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',
      headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok)throw Error(data.message||'관리자 로그인과 연결 상태를 확인해 주세요.');return data;
  }
  async function load(){
    if(loading||$('app').hidden||$('view-set').hidden)return;
    loading=true;
    try {
      const data=await api(),list=$('board-device-list');list.replaceChildren();
      if(!data.devices.length)list.append(el('li','연결된 모니터가 없습니다.'));
      data.devices.forEach(device=>{
        const expired=(device.status==='active'?device.token_until:device.pair_until)<data.now;
        const status=device.status==='revoked'?'연결 해제':expired?'만료':device.status==='active'?'연결됨':'연결 대기';
        const row=el('li'),info=el('div'); info.style.flex='1';
        info.append(el('b',device.name+' · '+status),el('small','최근 확인: '+time(device.last_seen_at)+' · 만료: '+time(device.token_until||device.pair_until),'muted'));
        row.append(info);
        if(device.status!=='revoked'){
          const button=el('button','연결 해제','btn btn-light btn-sm');button.type='button';
          button.addEventListener('click',async()=>{button.disabled=true;try{await api({action:'revoke',id:device.id});await load();}catch(e){$('board-device-status').textContent=e.message;}finally{button.disabled=false;}});row.append(button);
        }
        list.append(row);
      });
    }catch(e){$('board-device-status').textContent=e.message;}finally{loading=false;}
  }
  $('board-device-form').addEventListener('submit',async event=>{
    event.preventDefault();const button=$('board-device-create');button.disabled=true;
    $('board-device-status').textContent='연결 링크를 만들고 있습니다.';
    try{
      const data=await api({action:'create',name:$('board-device-name').value});
      $('board-device-link').value=data.link;$('board-device-pair').hidden=false;
      $('board-device-status').textContent='이 링크를 모니터 브라우저에서 한 번 열어 주세요. 10분 안에 1회 사용하며, 연결 후 주소는 일반 안내 주소로 바뀝니다.';
      clearTimeout(codeTimer);codeTimer=setTimeout(()=>{$('board-device-link').value='';$('board-device-pair').hidden=true;},Math.max(0,data.expires_at-Date.now()));
      await load();
    }catch(e){$('board-device-status').textContent=e.message;}finally{button.disabled=false;}
  });
  $('board-device-copy').addEventListener('click',async()=>{
    try{await navigator.clipboard.writeText($('board-device-link').value);$('board-device-status').textContent='연결 링크를 복사했습니다. 모니터 브라우저에서 열어 주세요.';}
    catch{$('board-device-link').focus();$('board-device-link').select();$('board-device-status').textContent='선택된 연결 링크를 복사해 주세요.';}
  });
  $('board-device-reload').addEventListener('click',load);
  new MutationObserver(load).observe($('app'),{attributes:true,attributeFilter:['hidden']});
  new MutationObserver(load).observe($('view-set'),{attributes:true,attributeFilter:['hidden']});
  window.addEventListener('hashchange',load);load();
  setInterval(()=>{if(!document.hidden)load();},60000);
})();
