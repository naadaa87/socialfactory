(async function(){
  if(window.__sfCollecting)return;window.__sfCollecting=true;
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const notify=text=>{let box=document.getElementById('sf-collector-status');if(!box){box=document.createElement('div');box.id='sf-collector-status';box.setAttribute('role','status');box.style.cssText='position:fixed;bottom:20px;left:20px;z-index:2147483647;max-width:520px;padding:18px;background:#17326b;color:white;font:16px sans-serif;border-radius:12px';document.body.append(box);}box.textContent=text;};
  async function until(fn){for(let i=0;i<100;i++){const result=fn();if(result)return result;await wait(150);}throw Error('화면을 읽을 수 없습니다. 로그인과 조회 조건을 확인해 주세요.');}
  try{
    let state=await chrome.runtime.sendMessage({type:'state'});if(!state.ok)return;
    notify(state.auto?'15분 자동 매출 동기화 중입니다.':'결제내역을 수집 중입니다. 이 탭을 조작하지 말아 주세요.');
    if(state.firstPage && Number(new URL(location.href).searchParams.get('page')||1)!==1){
      const first=Array.from(document.querySelectorAll('a[href]')).find(a=>{const u=new URL(a.href,location.href);return u.origin===location.origin&&u.pathname===location.pathname&&Number(u.searchParams.get('page'))===1;});
      if(!first)throw Error('첫 페이지 버튼을 찾을 수 없습니다. 호스트센터에서 1페이지를 선택해 주세요.');
      first.click();await until(()=>Number(new URL(location.href).searchParams.get('page')||1)===1);
    }
    async function selectDate(title,value){
      const input=document.querySelector('input[title="'+title+'"]');if(!input)throw Error('날짜 입력을 찾지 못했습니다.');
      if(input.value===value)return;
      input.click();await until(()=>document.querySelector('.calendar_wrap'));
      const parts=value.split('-').map(Number),target=parts[0]*12+parts[1];
      for(let n=0;n<120;n++){
        const wrap=document.querySelector('.calendar_wrap'),m=wrap?.querySelector('strong')?.textContent.match(/(\d{4})\.(\d{1,2})/);if(!m)throw Error('달력 형식이 변경됐습니다.');
        const current=Number(m[1])*12+Number(m[2]);if(current===target)break;
        const button=wrap.querySelector(current>target?'.btn_month_prev':'.btn_month_next');if(!button)throw Error('달력 월 이동 버튼이 없습니다.');button.click();await until(()=>document.querySelector('.calendar_wrap strong')?.textContent!==m[0]);
      }
      const wrap=document.querySelector('.calendar_wrap'),ym=wrap?.querySelector('strong')?.textContent.match(/(\d{4})\.(\d{1,2})/);
      if(!ym||Number(ym[1])*12+Number(ym[2])!==target)throw Error('조회 날짜 선택 한도를 넘었습니다.');
      const day=Array.from(wrap.querySelectorAll('td a:not(.disable)')).find(a=>Number(a.textContent.trim())===parts[2]);if(!day)throw Error('조회 날짜를 선택할 수 없습니다.');day.click();await until(()=>input.value===value);
    }
    async function configure(){
      const period=await until(()=>document.querySelector('select#period_select'));
      const option=Array.from(period.options).find(o=>o.textContent.trim()==='결제일');if(!option)throw Error('결제일 조회 항목을 찾지 못했습니다.');period.value=option.value;period.dispatchEvent(new Event('change',{bubbles:true}));
      await until(()=>document.querySelector('select#space_select')?.options.length>1);
      const space=document.querySelector('select#space_select'),venue=Array.from(space.options).find(o=>o.textContent.trim()==='소셜팩토리 건대 (초특가)');if(!venue)throw Error('소셜팩토리 공간을 찾지 못했습니다.');space.value=venue.value;space.dispatchEvent(new Event('change',{bubbles:true}));
      const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
      await selectDate('이용시작일',state.since);await selectDate('이용종료일',today);
      const query=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='조회');if(!query)throw Error('조회 버튼이 없습니다.');query.click();
      await until(()=>Array.from(document.querySelectorAll('em')).some(e=>e.textContent.includes(state.since.replace(/-/g,'.'))&&e.textContent.includes(today.replace(/-/g,'.'))));
      await chrome.runtime.sendMessage({type:'configured'});
    }
    while(true){
    state=await chrome.runtime.sendMessage({type:'state'});if(!state.ok)return;
    if(state.configure)await configure();
    // Next.js may show the previous page's table while the new page is loading.
    // Read a different, stable list of reservation IDs before opening any details.
    let snapshot,lastSignature='',stableSince=0;
    await until(()=>{
      const table=Array.from(document.querySelectorAll('table')).find(t=>(state.source==='account'?t.querySelector('caption')?.textContent.trim()==='정산 조회 목록':t.querySelector('caption')?.textContent.trim()==='정산 예정 조회 목록'));if(!table){
        const period=Array.from(document.querySelectorAll('em')).find(e=>/\d{4}\.\d{2}\.\d{2}/.test(e.textContent));
        const text=document.body.textContent||'';
        if(state.auto&&period&&/총\s*0\s*건/.test(text)){
          if(lastSignature!=='empty'){lastSignature='empty';stableSince=Date.now();return false;}
          if(Date.now()-stableSince>1500){snapshot={table:null,headers:[],idCol:1,venueCol:2,entries:[],signature:'empty'};return true;}
        }return false;
      }
      const headers=Array.from(table.querySelectorAll('thead th')).map(x=>x.textContent.trim());
      const idCol=headers.indexOf('예약번호'),venueCol=headers.indexOf('공간명');if(idCol<0||venueCol<0)return false;
      const entries=Array.from(table.querySelectorAll('tbody > tr')).filter(r=>r.querySelector('button')&&r.children.length===headers.length);
      const signature=entries.map(r=>r.children[idCol].textContent.trim()).join('|');
      if(!signature){
        const summary=document.body.textContent;
        if(state.auto&&/총\s*0\s*건/.test(summary)&&!/기간에[\s\S]*-/.test(summary)){
          if(lastSignature!=='empty'){lastSignature='empty';stableSince=Date.now();return false;}
          if(Date.now()-stableSince>1500){snapshot={table,headers,idCol,venueCol,entries,signature:'empty'};return true;}
        }return false;
      }
      if(signature===state.previousSignature)return false;
      if(signature!==lastSignature){lastSignature=signature;stableSince=Date.now();return false;}
      if(Date.now()-stableSince<600)return false;
      snapshot={table,headers,idCol,venueCol,entries,signature};return true;
    });
    const {table,headers,idCol,venueCol,entries,signature}=snapshot;
    if(!entries.length&&!state.auto)throw Error('예약내역이 없습니다. 조회 조건을 확인해 주세요.');
    const rows=[];let skipped=0;
    for(const tr of entries){
      const venue=tr.children[venueCol].textContent.trim();if(venue!=='소셜팩토리 건대 (초특가)'){skipped++;continue;}
      const id=tr.children[idCol].textContent.trim();if(!/^\d{1,16}$/.test(id))throw Error('예약번호 형식이 변경되었습니다.');
      function detail(){const next=tr.nextElementSibling;return next?.querySelector('td[colspan]')?next:null;}
      if(!detail())tr.querySelector('button').click();
      const expanded=await until(detail),fields={};
      if(!tr.isConnected || tr.children[idCol].textContent.trim()!==id)throw Error('예약 표가 수집 중 변경되었습니다. 새로고침 후 다시 수집해 주세요.');
      expanded.querySelectorAll('li').forEach(li=>{const span=li.querySelector('span');if(span){const key=span.textContent.trim();fields[key]=li.textContent.slice(span.textContent.length).replace(/^\s*:\s*/,'').trim();}});
      const date=value=>{const m=String(value||'').match(/^(\d{4})\.(\d{2})\.(\d{2})/);if(!m)throw Error('결제일/이용일을 읽을 수 없습니다.');return m.slice(1).join('-');};
      const money=key=>{const m=String(fields[key]||'').match(/^([\d,]+)\s*원(?:\s*\(VAT포함\))?$/);if(!m)throw Error(key+'을 확인할 수 없습니다.');return Number(m[1].replace(/,/g,''));};
      const use=fields['예약내용']||'',start=date(use),dates=use.match(/\d{4}\.\d{2}\.\d{2}/g)||[];
      // Reject unrecognized overnight/multi-day display rather than guess an end date.
      const times=use.match(/(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})/);
      if(!times || Number(times[3])*60+Number(times[4])<=Number(times[1])*60+Number(times[2]) || /익일|다음날/.test(use)||dates.length>1)throw Error('여러 날짜 예약 표시를 확인해야 합니다. 수집을 중단했습니다.');
      rows.push({reservation_id:id,venue,use_date:start,end_date:start,paid_at:date(fields['결제일시']),amount:money('결제금액'),refund_amount:money('취소금액'),...(fields['정산후 취소금액']?{after_settlement_refund:money('정산후 취소금액')}:{})});
    }
    const current=new URL(location.href),page=Number(current.searchParams.get('page')||1);
    const next=Array.from(document.querySelectorAll('a[href]')).find(a=>{const u=new URL(a.href,location.href);return u.origin===current.origin&&u.pathname===current.pathname&&Number(u.searchParams.get('page'))===page+1;});
    const result=await chrome.runtime.sendMessage({type:'page',pageUrl:location.href,rows,skipped,signature,next:next?next.href:null});
    if(!result.ok)throw Error(result.error||'수집이 중단되었습니다.');
    if(result.switchTo){
      const link=Array.from(document.querySelectorAll('a[href]')).find(a=>a.href===result.switchTo);if(!link)throw Error('정산 완료 이동 버튼이 없습니다.');link.click();await until(()=>location.pathname==='/report/account');continue;
    }
    if(result.synced){notify('자동 동기화 완료. 파일 업로드 없이 매출에 반영했습니다.');break;}
    if(result.next){
      if(!next || next.href!==result.next)throw Error('다음 페이지 버튼이 변경되었습니다.');
      next.click();await until(()=>Number(new URL(location.href).searchParams.get('page'))===page+1);continue;
    }
    if(result.file){const blob=new Blob([JSON.stringify(result.file,null,2)],{type:'application/json'}),href=URL.createObjectURL(blob),a=document.createElement('a');a.href=href;a.download='spacecloud-payments-'+new Date().toISOString().slice(0,10)+'.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),30000);notify('수집 완료: '+result.file.rows.length+'건 ('+result.file.pages+'페이지). 저장된 JSON 파일을 소셜팩토리 관리자 → 매출에서 선택해 주세요.');}
    break;
    }
  }catch(e){notify('수집 실패: '+e.message+' 파일을 저장하지 않았습니다.');await chrome.runtime.sendMessage({type:'error',message:e.message,status:location.pathname.startsWith('/auth/')?'login_required':'collection_error'});}
  finally{window.__sfCollecting=false;}
})();
