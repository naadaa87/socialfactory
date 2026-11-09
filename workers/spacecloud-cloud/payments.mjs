const HOST = 'https://partner.spacecloud.kr';
const VENUE = '소셜팩토리 건대 (초특가)';
const fail = (code='host-layout') => Object.assign(new Error(code),{code});

function reportPage({path,period,pageNumber}) {
  if (location.origin!=='https://partner.spacecloud.kr' || location.pathname!==path
    || Number(new URL(location.href).searchParams.get('page') || 1)!==pageNumber) return null;
  if (![...document.querySelectorAll('em')].some(e=>e.textContent.trim()===period)) return null;
  const total = document.body.innerText.match(/총\s*([\d,]+)\s*건\s*\//);
  if (!total) return null;
  const table = [...document.querySelectorAll('table')].find(t=>t.caption?.textContent.trim()
    ===(path.endsWith('/draft')?'정산 예정 조회 목록':'정산 조회 목록'));
  const headers = [...(table?.querySelectorAll('thead th') || [])].map(h=>h.textContent.trim());
  const idCol = headers.indexOf('예약번호'), venueCol = headers.indexOf('공간명');
  const count = Number(total[1].replaceAll(',',''));
  if (!count) return {count,ids:[],idCol,venueCol};
  if (idCol<0 || venueCol<0) return null;
  const rows = [...table.querySelectorAll('tbody > tr')].filter(r=>r.querySelector('button') && r.children.length===headers.length);
  if (!rows.length) return null;
  return {count,idCol,venueCol,ids:rows.map(r=>r.children[idCol].textContent.trim()),
    venues:rows.map(r=>r.children[venueCol].textContent.trim())};
}

async function selectDate(page,title,date) {
  // Use the host's own calendar controls, as the PC collector does.
  const result=await page.evaluate(async ({title,date})=>{
    const until=async check=>{
      for(let i=0;i<40;i++){
        const value=check();
        if(value)return value;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      return null;
    };
    const field=document.querySelector('input[title="'+title+'"]');
    if(!field || !field.getClientRects().length)return 'field';
    if(field.value===date)return 'ok';
    field.click();
    const calendar=()=>[...document.querySelectorAll('.calendar_wrap')].find(el=>el.getClientRects().length);
    const monthLabel=()=>calendar()?.querySelector('strong')?.textContent.trim();
    const [year,month,day]=date.split('-').map(Number);
    for(let n=0;n<120;n++){
      const label=await until(monthLabel);
      const match=label?.match(/^(\d{4})\.(\d{1,2})$/);
      if(!match)return 'calendar';
      const delta=(year-Number(match[1]))*12+month-Number(match[2]);
      if(!delta){
        const button=[...calendar().querySelectorAll('td a:not(.disable)')].find(el=>Number(el.textContent.trim())===day);
        if(!button)return 'day';
        button.click();
        return await until(()=>field.value===date)?'ok':'selected';
      }
      const button=calendar().querySelector(delta<0?'.btn_month_prev':'.btn_month_next');
      if(!button)return 'month';
      button.click();
      if(!await until(()=>monthLabel() && monthLabel()!==label))return 'changed';
    }
    return 'limit';
  },{title,date});
  if(result!=='ok')throw fail('host-date-'+(title==='이용시작일'?'start':'end')+'-'+result);
}

export function parseHostPayment(reservation_id,fields) {
  const date = value => {
    const match=String(value || '').match(/^(\d{4})\.(\d{2})\.(\d{2})/);
    if(!match)throw fail();
    return match.slice(1).join('-');
  };
  const money = key => {
    const match=String(fields[key] || '').match(/^([\d,]+)\s*원(?:\s*\(VAT포함\))?$/);
    if(!match)throw fail();
    return Number(match[1].replaceAll(',',''));
  };
  const use=fields['예약내용'] || '',use_date=date(use);
  const dates=use.match(/\d{4}\.\d{2}\.\d{2}/g) || [];
  const times=use.match(/(\d{1,2}):(\d{2})\s*~\s*(?:(?:익일|다음날)\s*)?(\d{1,2}):(\d{2})/);
  let end_date=use_date;
  if(dates.length===2 && date(dates[1])>use_date) end_date=date(dates[1]);
  else if(dates.length===1 && /익일|다음날/.test(use)) end_date=new Date(Date.parse(use_date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  else if(dates.length!==1 || !times || Number(times[3])*60+Number(times[4])<=Number(times[1])*60+Number(times[2]))throw fail();
  return {reservation_id,venue:VENUE,use_date,end_date,paid_at:date(fields['결제일시']),
    amount:money('결제금액'),refund_amount:money('취소금액'),
    ...(fields['정산후 취소금액']?{after_settlement_refund:money('정산후 취소금액')}:{})};
}

async function readDetail(page,id,idCol,venueCol,venue) {
  return page.evaluate(async ({id,idCol,venueCol,venue})=>{
    const row=[...document.querySelectorAll('table tbody > tr')].find(r=>r.children[idCol]?.textContent.trim()===id
      && r.children[venueCol]?.textContent.trim()===venue);
    const button=row?.querySelector('button');
    if(!button || !button.getClientRects().length)return null;
    const details=()=>row.nextElementSibling?.querySelectorAll('td[colspan] li');
    if(!details()?.length)button.click();
    for(let i=0;i<40;i++){
      const items=details();
      if(items?.length && row.isConnected && row.children[idCol]?.textContent.trim()===id){
        return Object.fromEntries([...items].flatMap(li=>{
          const label=li.querySelector('span')?.textContent;
          return label?[[label.trim(),li.textContent.slice(label.length).replace(/^\s*:\s*/,'').trim()]]:[];
        }));
      }
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return null;
  },{id,idCol,venueCol,venue});
}

async function collectReport(page,path,plan,live) {
  const report=path.endsWith('/draft')?'draft':'account';
  let stage='navigate';
  try {
    await page.goto(HOST+path,{waitUntil:'domcontentloaded',timeout:15000});
    if(new URL(page.url()).origin!==HOST || new URL(page.url()).pathname!==path)throw fail('login-required');
    stage='configure';
    const space=page.locator('select#space_select');
    await space.locator('option').filter({hasText:VENUE}).waitFor({state:'attached',timeout:10000}).catch(()=>{throw fail('login-required');});
    await page.locator('select#period_select').selectOption({label:'결제일'});
    await space.selectOption({label:VENUE});
    stage='dates';
    await selectDate(page,'이용시작일',plan.from);
    await selectDate(page,'이용종료일',plan.to);
    stage='query';
    if(!await page.evaluate(()=>{
      const button=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='조회' && el.getClientRects().length);
      if(!button || button.disabled)return false;
      button.click();
      return true;
    }))throw fail();
    const period=plan.from.replaceAll('-','.')+' ~ '+plan.to.replaceAll('-','.');
    const records=[],seen=new Set();
    let expectedTotal;
    for(let pageNumber=1;pageNumber<=200;pageNumber++){
      live();
      stage='list';
      const args={path,period,pageNumber};
      let previousSignature=null, stable;
      for(let i=0;i<30;i++){
        const current=await page.evaluate(reportPage,args);
        if(current && current.ids.every(id=>!seen.has(id))){
          const signature=JSON.stringify(current);
          if(previousSignature===signature){stable=current;break;}
          previousSignature=signature;
        }else previousSignature=null;
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      if(!stable || stable.count>2000 || (expectedTotal!==undefined && expectedTotal!==stable.count))throw fail();
      expectedTotal=stable.count;
      if(!expectedTotal)return [];
      stage='detail';
      for(const id of stable.ids){
        live();
        if(!/^\d{1,16}$/.test(id) || seen.has(id) || stable.venues[stable.ids.indexOf(id)]!==VENUE)throw fail();
        seen.add(id);
        const fields=await readDetail(page,id,stable.idCol,stable.venueCol,VENUE);
        if(!fields)throw fail();
        const payment=parseHostPayment(id,fields);
        if(payment.paid_at<plan.from || payment.paid_at>plan.to)throw fail();
        records.push(payment);
      }
      if(records.length===expectedTotal)return records;
      if(records.length>expectedTotal)throw fail();
      stage='next';
      if(!await page.evaluate(({path,next})=>{
        const link=[...document.querySelectorAll('a[href]')].find(a=>{
          const url=new URL(a.href);
          return a.textContent.trim()===String(next) && a.getClientRects().length
            && url.origin===location.origin && url.pathname===path && Number(url.searchParams.get('page'))===next;
        });
        if(!link)return false;
        link.click();
        return true;
      },{path,next:pageNumber+1}))throw fail();
    }
    throw fail();
  } catch(error) {
    if(error?.code==='login-required' || error?.code==='browser-deadline' || error?.code==='runner-lock' || error?.code?.startsWith('host-date-'))throw error;
    const type=error?.name==='TimeoutError'?'timeout':error?.name==='TypeError'?'type':'layout';
    throw fail('host-'+report+'-'+stage+'-'+type);
  }
}

export async function collectHostPayments(context,plan,live) {
  const page=await context.newPage();
  page.setDefaultTimeout(8000);
  const rows=new Map();
  for(const path of ['/report/draft','/report/account']){
    for(const row of await collectReport(page,path,plan,live)){
      const previous=rows.get(row.reservation_id);
      if(!previous){rows.set(row.reservation_id,row);continue;}
      if(['paid_at','use_date','end_date','amount'].some(key=>previous[key]!==row[key]))throw fail();
      previous.refund_amount=Math.max(previous.refund_amount,row.refund_amount);
      previous.after_settlement_refund=Math.max(previous.after_settlement_refund || 0,row.after_settlement_refund || 0);
    }
  }
  live();
  return [...rows.values()];
}

export async function paymentRequest(config,body) {
  try{
    const response=await fetch(config.origin+'/api/internal/spacecloud-payments',{
      method:'POST',redirect:'manual',signal:AbortSignal.timeout(18000),
      headers:{Authorization:'Bearer '+config.token,'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    if(!response.ok)throw fail('sync-rejected');
    const data=await response.json();
    if(data?.ok!==true)throw fail('sync-rejected');
    return data;
  }catch{throw fail('sync-rejected');}
}
