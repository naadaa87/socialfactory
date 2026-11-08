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
  const field = page.locator('input[title="'+title+'"]');
  if (await field.inputValue()===date) return;
  await field.click();
  const calendar=page.locator('.calendar_wrap');
  const [year,month,day]=date.split('-').map(Number);
  for(let n=0;n<120;n++){
    const label=calendar.locator('strong');
    const match=(await label.innerText()).trim().match(/^(\d{4})\.(\d{1,2})$/);
    if(!match)throw fail();
    const delta=(year-Number(match[1]))*12+month-Number(match[2]);
    if(!delta){
      await calendar.locator('td a:not(.disable)').filter({hasText:new RegExp('^0?'+day+'$')}).click();
      if(await field.inputValue()!==date)throw fail();
      return;
    }
    await calendar.locator(delta<0?'.btn_month_prev':'.btn_month_next').click();
    await label.filter({hasNotText:new RegExp('^'+match[0].replace('.','\\.')+'$')}).waitFor();
  }
  throw fail();
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

async function collectReport(page,path,plan,live) {
  await page.goto(HOST+path,{waitUntil:'domcontentloaded',timeout:15000});
  if(new URL(page.url()).origin!==HOST || new URL(page.url()).pathname!==path)throw fail('login-required');
  const space=page.locator('select#space_select');
  await space.locator('option').filter({hasText:VENUE}).waitFor({state:'attached',timeout:10000}).catch(()=>{throw fail('login-required');});
  await page.locator('select#period_select').selectOption({label:'결제일'});
  await space.selectOption({label:VENUE});
  await selectDate(page,'이용시작일',plan.from);
  await selectDate(page,'이용종료일',plan.to);
  await page.getByRole('button',{name:'조회',exact:true}).click();
  const period=plan.from.replaceAll('-','.')+' ~ '+plan.to.replaceAll('-','.');
  const records=[],seen=new Set();
  let expectedTotal;
  for(let pageNumber=1;pageNumber<=200;pageNumber++){
    live();
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
    for(const id of stable.ids){
      live();
      if(!/^\d{1,16}$/.test(id) || seen.has(id) || stable.venues[stable.ids.indexOf(id)]!==VENUE)throw fail();
      seen.add(id);
      const row=page.locator('tbody > tr').filter({has:page.getByRole('cell',{name:id,exact:true})});
      const detail=row.locator('xpath=following-sibling::tr[1]').locator('td[colspan] li');
      if(!await detail.count())await row.getByRole('button',{name:'상세보기',exact:true}).click();
      await detail.first().waitFor();
      const fields=await detail.evaluateAll(items=>Object.fromEntries(items.flatMap(li=>{
        const label=li.querySelector('span')?.textContent;
        return label?[[label.trim(),li.textContent.slice(label.length).replace(/^\s*:\s*/,'').trim()]]:[];
      })));
      const payment=parseHostPayment(id,fields);
      if(payment.paid_at<plan.from || payment.paid_at>plan.to)throw fail();
      records.push(payment);
    }
    if(records.length===expectedTotal)return records;
    if(records.length>expectedTotal)throw fail();
    await page.getByRole('link',{name:String(pageNumber+1),exact:true}).click();
  }
  throw fail();
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
