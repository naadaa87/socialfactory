(async function(){
  if(window.__sfCollecting)return;window.__sfCollecting=true;
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const notify=text=>{let box=document.getElementById('sf-collector-status');if(!box){box=document.createElement('div');box.id='sf-collector-status';box.setAttribute('role','status');box.style.cssText='position:fixed;bottom:20px;left:20px;z-index:2147483647;max-width:520px;padding:18px;background:#17326b;color:white;font:16px sans-serif;border-radius:12px';document.body.append(box);}box.textContent=text;};
  async function until(fn){for(let i=0;i<100;i++){const result=fn();if(result)return result;await wait(150);}throw Error('화면을 읽을 수 없습니다. 로그인과 조회 조건을 확인해 주세요.');}
  try{
    if(!(await chrome.runtime.sendMessage({type:'state'})).ok)return;
    notify('정산 전 결제내역을 수집 중입니다. 이 탭을 조작하지 말아 주세요.');
    const table=await until(()=>Array.from(document.querySelectorAll('table')).find(t=>t.querySelector('caption')?.textContent.trim()==='정산 예정 조회 목록'));
    const headers=Array.from(table.querySelectorAll('thead th')).map(x=>x.textContent.trim());
    const idCol=headers.indexOf('예약번호'),venueCol=headers.indexOf('공간명');if(idCol<0||venueCol<0)throw Error('정산 예정 표 형식이 변경되었습니다.');
    const entries=Array.from(table.querySelectorAll('tbody > tr')).filter(r=>r.querySelector('button')&&r.children.length===headers.length);
    if(!entries.length)throw Error('예약내역이 없습니다. 조회 조건을 확인해 주세요.');
    const rows=[];let skipped=0;
    for(const tr of entries){
      const venue=tr.children[venueCol].textContent.trim();if(venue!=='소셜팩토리 건대 (초특가)'){skipped++;continue;}
      const id=tr.children[idCol].textContent.trim();if(!/^\d{1,16}$/.test(id))throw Error('예약번호 형식이 변경되었습니다.');
      function detail(){const next=tr.nextElementSibling;return next?.querySelector('td[colspan]')?next:null;}
      if(!detail())tr.querySelector('button').click();
      const expanded=await until(detail),fields={};
      expanded.querySelectorAll('li').forEach(li=>{const span=li.querySelector('span');if(span){const key=span.textContent.trim();fields[key]=li.textContent.slice(span.textContent.length).replace(/^\s*:\s*/,'').trim();}});
      const date=value=>{const m=String(value||'').match(/^(\d{4})\.(\d{2})\.(\d{2})/);if(!m)throw Error('결제일/이용일을 읽을 수 없습니다.');return m.slice(1).join('-');};
      const money=key=>{const m=String(fields[key]||'').match(/^([\d,]+)\s*원(?:\s*\(VAT포함\))?$/);if(!m)throw Error(key+'을 확인할 수 없습니다.');return Number(m[1].replace(/,/g,''));};
      const use=fields['예약내용']||'',start=date(use),dates=use.match(/\d{4}\.\d{2}\.\d{2}/g)||[];
      // Reject unrecognized overnight/multi-day display rather than guess an end date.
      const times=use.match(/(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})/);
      if(!times || Number(times[3])*60+Number(times[4])<=Number(times[1])*60+Number(times[2]) || /익일|다음날/.test(use)||dates.length>1)throw Error('여러 날짜 예약 표시를 확인해야 합니다. 수집을 중단했습니다.');
      rows.push({reservation_id:id,venue,use_date:start,end_date:start,paid_at:date(fields['결제일시']),amount:money('결제금액'),refund_amount:money('취소금액')});
    }
    const current=new URL(location.href),page=Number(current.searchParams.get('page')||1);
    const next=Array.from(document.querySelectorAll('a[href]')).find(a=>{const u=new URL(a.href,location.href);return u.origin===current.origin&&u.pathname===current.pathname&&Number(u.searchParams.get('page'))===page+1;});
    const result=await chrome.runtime.sendMessage({type:'page',rows,skipped,next:next?next.href:null});
    if(!result.ok)throw Error(result.error||'수집이 중단되었습니다.');
    if(result.file){const blob=new Blob([JSON.stringify(result.file,null,2)],{type:'application/json'}),href=URL.createObjectURL(blob),a=document.createElement('a');a.href=href;a.download='spacecloud-payments-'+new Date().toISOString().slice(0,10)+'.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),30000);notify('수집 완료: '+result.file.rows.length+'건 ('+result.file.pages+'페이지). 저장된 JSON 파일을 소셜팩토리 관리자 → 매출에서 선택해 주세요.');}
  }catch(e){notify('수집 실패: '+e.message+' 파일을 저장하지 않았습니다.');await chrome.runtime.sendMessage({type:'error'});}
  finally{window.__sfCollecting=false;}
})();
