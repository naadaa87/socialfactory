import { ReviewRequired, memoFor } from './safety.mjs';
import { calendarGridDates, parseCalendarEntry, publicSlotExpectations } from './calendar.mjs';
import { PUBLIC_AVAILABILITY_MODE, readPublicAvailability as fetchPublicAvailability } from './public-availability.mjs';

export const TIME_RADIO_NAME=/^시간\s*단위\s*예약하기\s*\(\s*최소\s*2\s*시간\s*부터\s*\)$/;
export const ROOMS = Object.freeze({r1:{product:140236,max:36},r2:{product:140235,max:40},r3:{product:140486,max:16},r4:{product:140487,max:48},r5:{product:140492,max:30}});
export function publicCalendarLayout() {
  const count=selector=>{
    const elements=[...document.querySelectorAll(selector)];
    return {total:elements.length,visible:elements.filter(element=>{const box=element.getBoundingClientRect(),style=window.getComputedStyle(element);return box.width>0 && box.height>0 && style.display!=='none' && style.visibility!=='hidden' && style.visibility!=='collapse';}).length};
  };
  const text=document.body?.innerText || '';
  const headingTexts=[...document.querySelectorAll('h1,h2,h3,[role="heading"]')].map(element=>(element.textContent || '').replace(/\s+/g,' ').trim());
  const headingLabels=['공간 소개','시설 안내','가격 안내','예약 정보','유의사항','환불규정 안내'];
  const noticeMatchers={login:/로그인/,login_required:/로그인이\s*필요|로그인\s*후|로그인해\s*주세요/,verification:/인증/,reservation_unavailable:/예약\s*불가|예약하실\s*수\s*없|예약할\s*수\s*없|예약이\s*불가/,date_prompt:/날짜\s*선택|날짜를\s*선택|이용\s*날짜/,time_prompt:/시간\s*선택|시간을\s*선택/,instant_reservation:/바로\s*예약/,approval_reservation:/승인\s*예약/};
  // Only fixed markers leave the page; raw body/heading text, URLs and attributes stay private.
  return {client_width:document.documentElement.clientWidth,client_height:document.documentElement.clientHeight,inner_width:window.innerWidth,inner_height:window.innerHeight,next:count('a.btn_month_next'),previous:count('a.btn_month_prev'),calendar_title:count('.calendar_tit'),calendar_wrap:count('.calendar_wrap'),slots:count('.ts-row'),heading_count:headingTexts.length,heading_markers:headingLabels.filter(label=>headingTexts.includes(label)),notice_markers:Object.entries(noticeMatchers).filter(([,pattern])=>pattern.test(text)).map(([label])=>label)};
}
const previousDate=date=>new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
const monthOf=date=>date.slice(0,7).replace('-','.');
const numberOfMonth=month=>Number(month.slice(0,4))*12+Number(month.slice(5,7));
const normalize=text=>text.replace(/\s+/g,' ').trim();

const diagnosticPathWords=new Set(['api','v1','v2','v3','partner','reservation','reservations','calendar','user','users','auth','login','logout','profile','space','spaces','product','products','availability','holidays','status','me','host','hosts','qna','notification','notifications','chat','logs','log','track','event','events','booking','bookings','schedule','schedules','external','session','sessions','config','configuration','settings','assets','static','token','refresh','info','information','account','accounts','check','detail','list','search','common','service','services','categories','category','policy','policies','coupon','coupons','payment','payments','banner','banners']);
const diagnosticQueryKeys=new Set(['_rsc','space','product','date','from','to','year','month','page','limit','offset','q','query','filter','sort','search','space_id','product_id','access_token']);
export function readinessHints(request) {
  let headers={},queryKeys=[];try{headers=request.headers();}catch{}
  try{queryKeys=[...new Set([...new URL(request.url()).searchParams.keys()].map(key=>diagnosticQueryKeys.has(key)?key:'[key]'))].sort();}catch{}
  const purpose=String(headers.purpose || headers['sec-purpose'] || '').toLowerCase();
  let navigation=false;try{navigation=request.isNavigationRequest();}catch{}
  return {query_keys:queryKeys,prefetch:/\bprefetch\b/.test(purpose),next_router_prefetch:headers['next-router-prefetch']==='1',rsc:headers.rsc==='1' || String(headers.accept || '').includes('text/x-component'),navigation:!!navigation};
}
export function readinessDiagnostic(request,{status=null,failure='network-error'}={}) {
  let host='unknown',path='[unavailable]';
  try{const url=new URL(request.url());host=url.hostname;path=url.pathname.split('/').map(part=>part===''?'':diagnosticPathWords.has(part)?part:'[segment]').join('/');}catch{}
  let type='unknown';try{type=request.resourceType();}catch{}
  return {phase:'request-readiness',host,path,type,status:Number.isInteger(status)?status:null,failure,...readinessHints(request)};
}

/** Observe only application request metadata; never read private response bodies. */
export class SpacecloudReadiness {
  constructor(page,{now=()=>Date.now(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),quietMs=750,timeoutMs=15000,report=()=>{}}={}) {
    this.now=now;this.pause=pause;this.quietMs=quietMs;this.timeoutMs=timeoutMs;this.epoch=0;this.version=0;this.pending=new Set();this.tracked=new WeakMap();this.failed=false;this.lastActivity=now();this.report=report;this.reported=0;this.navigating=false;
    const relevant=request=>{try{const url=new URL(request.url());return url.protocol==='https:' && (url.hostname==='spacecloud.kr' || url.hostname.endsWith('.spacecloud.kr')) && ['document','xhr','fetch'].includes(request.resourceType());}catch{return false;}};
    page.on('framenavigated',frame=>{if(this.navigating && frame===page.mainFrame()){this.epoch++;this.pending.clear();this.failed=false;this.version++;this.lastActivity=this.now();this.navigating=false;}});
    page.on('request',request=>{if(this.navigating || !relevant(request))return;const hints=readinessHints(request);if(hints.prefetch || hints.next_router_prefetch)return;this.tracked.set(request,this.epoch);this.pending.add(request);this.version++;this.lastActivity=this.now();});
    const finish=async(request,failed)=>{
      if(this.tracked.get(request)!==this.epoch || !this.pending.has(request))return;
      let status=null,failure=failed?'network-error':'missing-response';
      if(!failed){try{const response=await request.response();status=response?response.status():null;failed=!response || status>=400;failure=response?'http-error':'missing-response';}catch{failed=true;}}
      else {try{const reason=request.failure()?.errorText;const known=['net::ERR_ABORTED','net::ERR_FAILED','net::ERR_TIMED_OUT','net::ERR_CONNECTION_RESET','net::ERR_CONNECTION_CLOSED','net::ERR_NAME_NOT_RESOLVED'];if(known.includes(reason))failure=reason;}catch{}}
      if(this.tracked.get(request)!==this.epoch)return;
      this.pending.delete(request);this.failed ||= failed;this.version++;this.lastActivity=this.now();
      if(failed && this.reported++<3){try{this.report(readinessDiagnostic(request,{status,failure}));}catch{}}
    };
    page.on('requestfinished',request=>{void finish(request,false);});
    page.on('requestfailed',request=>{void finish(request,true);});
  }
  navigate(){this.epoch++;this.pending.clear();this.failed=false;this.reported=0;this.version++;this.lastActivity=this.now();this.navigating=true;}
  changed(){this.lastActivity=this.now();}
  async settle(){
    const deadline=this.now()+this.timeoutMs;
    while(this.now()<deadline){
      if(this.failed)throw new ReviewRequired('스페이스클라우드 일정 조회에 실패하여 최신 상태를 확인하지 못했습니다.');
      if(!this.navigating && !this.pending.size && this.now()-this.lastActivity>=this.quietMs)return this.version;
      await this.pause(100);
    }
    throw new ReviewRequired('스페이스클라우드 일정 조회가 끝나지 않아 최신 상태 확인을 중단했습니다.');
  }
}

export class SpacecloudUI {
  constructor(context,config) { this.context=context;this.config=config;this.room=null;this.job=null;this.readiness=new WeakMap(); }
  async initialize() {
    this.host=await this.context.newPage();this.host.setDefaultTimeout(15000);this.observe(this.host);
    if(this.config.publicAvailabilityMode!==PUBLIC_AVAILABILITY_MODE){this.guest=this.config.publicPage || await (this.config.publicContext || this.context).newPage();this.guest.setDefaultTimeout(15000);this.observe(this.guest);}
  }
  observe(page){let state=this.readiness.get(page);if(!state){state=new SpacecloudReadiness(page,{report:diagnostic=>this.reportReview?.(diagnostic)});this.readiness.set(page,state);}return state;}
  async click(locator,label='화면 조작') {
    // Responsive layouts can retain hidden copies. Only one visible target may receive input.
    const target=locator.filter({visible:true});
    const count=await target.count();
    if(count!==1 || !await target.isVisible()) throw new ReviewRequired(label+': 보이는 조작 대상이 '+count+'개여서 중단했습니다.');
    await target.scrollIntoViewIfNeeded();
    const box=await target.boundingBox();if(!box) throw new ReviewRequired('화면의 조작 대상을 확인하지 못했습니다.');
    const page=target.page(),state=this.readiness.get(page);if(state)state.changed();
    await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  }
  async settle(page) {
    // First-party calendar requests and visible DOM are authoritative; analytics are unrelated.
    return this.observe(page).settle();
  }
  async openRoom(room) {
    if(!ROOMS[room]) throw new ReviewRequired('등록되지 않은 방입니다.');
    this.room=room;
    this.observe(this.host).navigate();
    await this.host.goto(`https://partner.spacecloud.kr/reservation-calendar?product=${ROOMS[room].product}&space=82026`,{waitUntil:'domcontentloaded'});
    const heading=this.host.getByRole('heading',{name:`${this.config.accountLabel}, ${Number(room.slice(1))}번룸 (최대 ${ROOMS[room].max}명)`,exact:true});
    await heading.waitFor({state:'visible'});
    await this.host.locator('.booking_wrap').first().waitFor({state:'visible'});
    await this.settle(this.host);
  }
  async hostMonth() {
    const text=normalize(await this.host.locator('a[title="달력레이어 팝업 열림"] em').innerText());
    if(!/^\d{4}\.\d{2}$/.test(text)) throw new ReviewRequired('호스트 달력의 기준 월을 확인하지 못했습니다.');
    return text;
  }
  async moveHostMonth(date) {
    for(let tries=0;tries<15;tries++) {
      const current=await this.hostMonth(),target=monthOf(date);
      if(current===target) return;
      const direction=numberOfMonth(target)>numberOfMonth(current)?'다음달':'이전달';
      await this.click(this.host.getByText(direction,{exact:true}),'호스트 달력 월 이동');
      await this.host.waitForFunction(({selector,current})=>{const text=document.querySelector(selector)?.textContent.trim();return !!text && text!==current;},{selector:'a[title="달력레이어 팝업 열림"] em',current});
      await this.settle(this.host);
    }
    throw new ReviewRequired('호스트 달력의 날짜 이동을 완료하지 못했습니다.');
  }
  async dateCell(date) {
    await this.moveHostMonth(date);
    const cells=this.host.locator('.booking_wrap');
    const labels=await cells.locator('span.date').allTextContents();
    const dates=calendarGridDates(await this.hostMonth(),labels.map(normalize));
    const index=dates.indexOf(date);
    if(index<0 || dates.indexOf(date,index+1)>=0) throw new ReviewRequired('달력에서 이용일을 확인하지 못했습니다.');
    return cells.nth(index);
  }
  async readDate(date) {
    const cell=await this.dateCell(date);
    const version=await this.settle(this.host);
    let entries=await cell.locator('.booking_list li').evaluateAll(nodes=>nodes.map((node,index)=>{
      const a=node.querySelector('a');
      return {index,text:a?.textContent?.replace(/\s+/g,' ').trim()||'',href:a?.getAttribute('href')||'',hours:a?[...a.querySelectorAll('em')].map(em=>em.textContent.trim()):[]};
    }));
    const settled=await this.settle(this.host);
    if(settled!==version) {
      const refreshed=await this.dateCell(date);
      entries=await refreshed.locator('.booking_list li').evaluateAll(nodes=>nodes.map((node,index)=>{const a=node.querySelector('a');return {index,text:a?.textContent?.replace(/\s+/g,' ').trim()||'',href:a?.getAttribute('href')||'',hours:a?[...a.querySelectorAll('em')].map(em=>em.textContent.trim()):[]};}));
      if(await this.settle(this.host)!==settled)throw new ReviewRequired('일정 조회 중 내용이 변경되어 다시 확인이 필요합니다.');
    }
    if(entries.length>300 || entries.some(e=>!e.text)) throw new ReviewRequired('예약 목록 구조를 확인하지 못했습니다.');
    return entries.map(e=>parseCalendarEntry(date,e));
  }
  async calendarSnapshot(room,start,end) {
    const byDay=new Map(),begin=previousDate(start);
    await this.openRoom(room);
    // Gather a complete visible month at a time, keeping only the requested date range.
    for(let date=begin;date<=end;date=new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10)) {
      if(byDay.has(date))continue;
      await this.moveHostMonth(date);
      const month=await this.hostMonth(),cells=this.host.locator('.booking_wrap');
      const raw=await cells.evaluateAll(nodes=>nodes.map(cell=>({label:cell.querySelector('span.date')?.textContent?.trim(),entries:[...cell.querySelectorAll('.booking_list li')].map((li,index)=>{const a=li.querySelector('a');return {index,text:a?.textContent?.replace(/\s+/g,' ').trim()||'',href:a?.getAttribute('href')||'',hours:a?[...a.querySelectorAll('em')].map(e=>e.textContent.trim()):[]};})})));
      const dates=calendarGridDates(month,raw.map(x=>x.label));
      dates.forEach((day,index)=>{if(day>=begin && day<=end && monthOf(day)===month)byDay.set(day,raw[index].entries.map(entry=>parseCalendarEntry(day,entry)));});
    }
    const events=[];
    for(const records of byDay.values())for(let record of records) {
      let marker=null;
      if(/^SFWEB:B[A-Za-z0-9_-]{6,40}$/.test(record.name) && !record.source.href) {
        record=await this.readOwnedDetail(record);
        if(record.memo===memoFor({...record,marker:record.name}))marker=record.name;
      }
      const firstEnd=Math.min(1440,record.end_min);
      if(record.date>=start && record.date<=end)events.push({date:record.date,start_min:record.start_min,end_min:firstEnd,marker});
      if(record.end_min>1440) {
        const next=new Date(Date.parse(record.date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
        if(next>=start && next<=end)events.push({date:next,start_min:0,end_min:record.end_min-1440,marker});
      }
    }
    return {room,range_start:start,range_end:end,events};
  }
  async recordsFor(date) {
    const [records]=await this.recordsForDates([date]);
    return records;
  }
  async recordsForDates(dates) {
    // Reopening the room can show a stale month. Month navigation loads the
    // live schedule. Include the prior day for reservations crossing midnight.
    const readDates=new Set(dates.flatMap(date=>[previousDate(date),date]));
    const firstDate=readDates.values().next().value;
    if(await this.hostMonth()===monthOf(firstDate)) {
      const nextMonth=new Date(firstDate.slice(0,7)+'-01T00:00:00Z');
      nextMonth.setUTCMonth(nextMonth.getUTCMonth()+1);
      await this.moveHostMonth(nextMonth.toISOString().slice(0,10));
    }
    await this.moveHostMonth(firstDate);
    const byDate=new Map();
    for(const date of readDates) {
      const records=await this.readDate(date);
      for(let i=0;i<records.length;i++) {
        if(records[i].name===this.job?.marker || this.job?.replaces?.some(old=>old.marker===records[i].name))records[i]=await this.readOwnedDetail(records[i]);
      }
      byDate.set(date,records);
    }
    return dates.map(date=>[...byDate.get(previousDate(date)),...byDate.get(date)]);
  }
  async ownedPopup(record) {
    const cell=await this.dateCell(record.source.date);
    const entries=cell.locator('.booking_list li a');
    const entry=entries.nth(record.source.index);
    if(normalize(await entry.innerText())!==record.source.text || await entry.getAttribute('href')) throw new ReviewRequired('대상 외부 예약의 표식이 변경되었습니다.');
    this.reportReview?.({phase:'owned-detail',step:'opening'});
    this.observe(this.host).changed();
    await entry.click();
    await this.settle(this.host);
    const popup=this.host.locator('.layer_popup.reservation_state._popup4:visible');
    await popup.waitFor({state:'visible'});
    this.reportReview?.({phase:'owned-detail',step:'opened'});
    if(normalize(await popup.locator('.pop_header.type5').innerText())!=='직접 추가한 예약 건입니다.') throw new ReviewRequired('직접 등록한 외부 예약이 아닙니다.');
    const title=normalize(await popup.locator('article .title').innerText());
    if(!title.includes(`${Number(this.room.slice(1))}번룸`)) throw new ReviewRequired('외부 예약의 방이 일치하지 않습니다.');
    return popup;
  }
  async readOwnedDetail(record,leaveOpen=false) {
    const popup=await this.ownedPopup(record),lines=(await popup.locator('ul.list_detail > li').allTextContents()).map(normalize);
    const nameLine=lines.find(x=>/^예약자명\s*:/.test(x)),period=lines.find(x=>/^예약내용\s*:/.test(x));
    const match=period?.match(/(\d{4})\.(\d{2})\.(\d{2})\([^)]*\),\s*(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})/);
    if(!nameLine || !match) throw new ReviewRequired('외부 예약 상세의 날짜와 시간을 확인하지 못했습니다.');
    const date=match[1]+'-'+match[2]+'-'+match[3],start_min=Number(match[4])*60+Number(match[5]);
    let end_min=Number(match[6])*60+Number(match[7]);if(end_min<start_min)end_min+=1440;
    this.reportReview?.({phase:'owned-detail',step:'memo'});
    const memo=normalize(await popup.locator('.list_memo > div').innerText());
    const result={...record,date,start_min,end_min,name:nameLine.replace(/^예약자명\s*:\s*/,''),memo,manual:true};
    if(!leaveOpen) {
      const close=popup.locator('a').filter({hasText:/^\s*(닫기|확인|레이어팝업닫기)\s*$/}).filter({visible:true});
      if(await close.count()===1) await this.click(close);
      else {
        // Leaving the detail via a fresh calendar navigation is read-only and deterministic.
        await this.openRoom(this.room);
      }
    }
    return result;
  }
  async chooseFormDate(date) {
    await this.click(this.host.locator('#_dpicker1 a._miniCalOpen'),'예약 날짜 선택기 열기');
    const wrap=this.host.locator('.calendar_wrap:visible').filter({has:this.host.getByRole('table',{name:'달력 월간 테이블'})});
    await wrap.waitFor({state:'visible'});
    for(let tries=0;tries<15;tries++) {
      const parts=(await wrap.locator('.calendar_tit strong em').allTextContents()).map(normalize);
      const month=parts.length===2?parts[0]+'.'+parts[1].padStart(2,'0'):'';
      if(!/^\d{4}\.\d{2}$/.test(month)) throw new ReviewRequired('날짜 선택 창의 기준 월을 확인하지 못했습니다.');
      const target=monthOf(date);if(month===target)break;
      await this.click(wrap.locator(numberOfMonth(target)>numberOfMonth(month)?'.btn_month_next':'.btn_month_prev'),'예약 날짜 선택기 월 이동');
      await this.host.waitForFunction(({month})=>[...document.querySelectorAll('.calendar_wrap')].filter(e=>e.getBoundingClientRect().width).some(e=>{const p=[...e.querySelectorAll('.calendar_tit strong em')].map(n=>n.textContent.trim());return p.length===2 && p[0]+'.'+p[1].padStart(2,'0')!==month;}),{month});
      if(tries===14)throw new ReviewRequired('날짜 선택 창의 이동을 완료하지 못했습니다.');
    }
    const table=wrap.getByRole('table',{name:'달력 월간 테이블'}),cells=table.locator('tbody td');
    const labels=(await cells.allTextContents()).map(normalize);
    const dates=calendarGridDates(monthOf(date),labels);
    const index=dates.indexOf(date);
    if(index<0)throw new ReviewRequired('날짜 선택 창의 이용일을 확인하지 못했습니다.');
    const anchor=cells.nth(index).locator('a');
    if(await anchor.count()!==1 || !/^\d{1,2}$/.test(normalize(await anchor.innerText())) || Number(await anchor.innerText())!==Number(date.slice(8)))throw new ReviewRequired('날짜 선택 창의 이용일이 선택 가능한 상태가 아닙니다.');
    await this.click(anchor,'예약 날짜 선택');
    const value=await this.host.locator('#start_day').inputValue();
    if(value.replace(/[^0-9]/g,'')!==date.replaceAll('-','')) throw new ReviewRequired('외부 예약 양식의 날짜가 일치하지 않습니다.');
  }
  async createSegment(segment) {
    if(!this.config.allowWrites)throw new ReviewRequired('외부 예약 쓰기가 비활성 상태입니다.');
    await this.click(this.host.getByText('예약추가',{exact:true}),'외부예약 추가 열기');
    await this.host.locator('#reserve_name').waitFor({state:'visible'});
    await this.chooseFormDate(segment.date);
    await this.host.locator('#shour').selectOption({label:`${segment.start_min/60} 시`});
    await this.host.locator('#ehour').selectOption({label:`${segment.end_min/60} 시`});
    await this.host.locator('#slct-repeatType').selectOption('-1');
    const allDay=this.host.locator('#chk_repeat');if(await allDay.isChecked())await allDay.uncheck();
    await this.host.locator('#reserve_name').fill(segment.marker);
    await this.host.locator('#reserve_memo').fill(memoFor(segment));
    await this.host.locator('#reserve_tel').fill('');
    if(await this.host.locator('#reserve_name').inputValue()!==segment.marker
      ||await this.host.locator('#reserve_memo').inputValue()!==memoFor(segment))throw new ReviewRequired('외부 예약 표식 입력을 확인하지 못했습니다.');
    await this.beforeWrite();
    if(this.config.publicAvailabilityMode===PUBLIC_AVAILABILITY_MODE){await this.assertPublicAvailable(segment);await this.beforeWrite();}
    await this.click(this.host.locator('a#_addExternalSchedule'),'외부예약 등록 확인');
    await this.host.locator('#reserve_name').waitFor({state:'hidden'});
    // The dialog can close before the host's calendar request finishes.
    await this.settle(this.host);
  }
  async removeSegment(segment,record) {
    if(!this.config.allowWrites)throw new ReviewRequired('외부 예약 쓰기가 비활성 상태입니다.');
    const checked=await this.readOwnedDetail(record,true);
    if(checked.name!==segment.marker || checked.memo!==memoFor(segment) || checked.date!==segment.date
      ||checked.start_min!==segment.start_min ||checked.end_min!==segment.end_min)throw new ReviewRequired('해제할 외부 예약의 정보가 다릅니다.');
    const popup=this.host.locator('.layer_popup.reservation_state._popup4:visible');
    await this.click(popup.locator('a.btn_negative').filter({hasText:/^\s*예약\s*삭제\s*$/}),'자체 외부예약 삭제 요청');
    const confirm=this.host.locator('.layer_popup.confirm:visible').filter({has:this.host.getByText('예약을 삭제하시겠습니까?',{exact:true})});
    await confirm.waitFor({state:'visible'});
    await this.beforeWrite();
    await this.click(confirm.getByText('확인',{exact:true}),'자체 외부예약 삭제 확인');
    await confirm.waitFor({state:'hidden'});
    await this.settle(this.host);
  }
  publicProgress(step,event,extra={}) {
    try{this.reportReview?.({phase:'public-progress',step,event,elapsed_ms:Math.max(0,Date.now()-(this.publicStartedAt || Date.now())),attempt:this.publicAttempt || 1,...extra});}catch{}
  }
  async publicStep(step,event,action) {
    this.publicProgress(step,event+'-before');const result=await action();this.publicProgress(step,event+'-after');return result;
  }
  async assertNoGuestLoginPrompt() {
    const prompt=this.guest.getByText(/^\s*로그인\s*\/\s*회원가입\s*해\s*주세요\.?\s*$/).filter({visible:true});
    if(await prompt.count())throw new ReviewRequired('스페이스클라우드 고객용 로그인이 필요합니다. 관리자에서 고객 로그인을 연결해 주세요.');
  }
  async selectPublicRadio(radio,label,step='room') {
    await this.publicStep(step,'attached',()=>radio.waitFor({state:'attached'}));
    if(!await this.publicStep(step,'checked',()=>radio.isChecked())) {
      const id=await this.publicStep(step,'identity',()=>radio.getAttribute('id'));
      const associated=id && /^[A-Za-z0-9_:.-]+$/.test(id)
        ? this.guest.locator('label[for="'+id+'"],label:has(input[id="'+id+'"])')
        : radio.locator('xpath=ancestor::label[1]');
      await this.publicStep(step,'label',()=>this.click(associated,label));
      if(!await this.publicStep(step,'checked',()=>radio.isChecked())) {
        if(step==='time')await this.assertNoGuestLoginPrompt();
        throw new ReviewRequired(label+': 선택 상태를 확인하지 못했습니다.');
      }
    }
    await this.publicStep(step,'settle',()=>this.settle(this.guest));
  }
  async openPublicDate(date) {
    this.observe(this.guest).navigate();
    await this.publicStep('goto','navigate',()=>this.guest.goto('https://www.spacecloud.kr/space/82026',{waitUntil:'domcontentloaded'}));
    await this.publicStep('ready','settle',()=>this.settle(this.guest));
    const room=this.guest.getByRole('radio',{name:`${Number(this.room.slice(1))}번룸 (최대 ${ROOMS[this.room].max}명)`,exact:true});
    await this.selectPublicRadio(room,'고객 예약 방 선택','room');
    const time=this.guest.getByRole('radio',{name:TIME_RADIO_NAME});
    await this.selectPublicRadio(time,'고객 시간 단위 예약 선택','time');
    await this.assertNoGuestLoginPrompt();
    const layout=await this.publicStep('month','layout',()=>this.guest.evaluate(publicCalendarLayout));
    this.publicProgress('month','layout',layout);
    const next=this.guest.locator('a.btn_month_next');await this.publicStep('month','attached',()=>next.waitFor({state:'visible'}));
    for(let tries=0;tries<15;tries++) {
      const month=await this.publicStep('month','read',()=>next.evaluate(el=>el.parentElement.textContent.match(/\d{4}\s*\.\s*\d{1,2}/)?.[0]?.replace(/\s/g,'')||''));
      const parts=month.split('.');const current=parts.length===2?parts[0]+'.'+parts[1].padStart(2,'0'):'';
      if(!current)throw new ReviewRequired('고객 예약 화면의 기준 월을 확인하지 못했습니다.');
      if(current===monthOf(date))break;
      await this.publicStep('month','click',()=>this.click(this.guest.locator(numberOfMonth(monthOf(date))>numberOfMonth(current)?'a.btn_month_next':'a.btn_month_prev'),'고객 달력 월 이동'));
      await this.publicStep('month','changed',()=>this.guest.waitForFunction(({current})=>[...document.querySelectorAll('a.btn_month_next')].some(el=>{const p=el.parentElement.textContent.match(/(\d{4})\s*\.\s*(\d{1,2})/);return p && p[1]+'.'+p[2].padStart(2,'0')!==current;}),{current}));
      await this.publicStep('month','settle',()=>this.settle(this.guest));
      if(tries===14)throw new ReviewRequired('고객 예약 화면의 날짜 이동을 완료하지 못했습니다.');
    }
    const day=this.guest.locator('a').filter({hasText:new RegExp('^\\s*'+Number(date.slice(8))+'\\s*$')});
    const visible=[];for(const a of await this.publicStep('date','candidates',()=>day.all()))if(await a.isVisible())visible.push(a);
    if(visible.length!==1)throw new ReviewRequired('고객 예약 화면의 이용일이 모호합니다.');
    await this.publicStep('date','click',()=>this.click(visible[0],'고객 예약 날짜 선택'));
    await this.publicStep('slots','visible',()=>this.guest.locator('.ts-row[data-row-idx="0"]').waitFor({state:'visible'}));
    await this.publicStep('slots','settle',()=>this.settle(this.guest));
  }
  async verifyGuestLogin() {
    // Reading the real customer calendar verifies guest authentication without submitting a booking.
    this.room='r5';this.publicStartedAt=Date.now();this.publicAttempt=1;
    const today=new Date(Date.now()+9*60*60*1000).toISOString().slice(0,10);
    await this.openPublicDate(today);
    return {guest_ready:true};
  }
  async readPublicAvailability(segment) {
    if(this.config.publicAvailabilityMode!==PUBLIC_AVAILABILITY_MODE)throw new ReviewRequired('공개 예약 가능 시간 조회 모드를 확인해 주세요.');
    if(!Number.isInteger(segment.start_min) || !Number.isInteger(segment.end_min) || segment.start_min<0 || segment.end_min>1440
      || segment.start_min>=segment.end_min || segment.start_min%60 || segment.end_min%60)throw new ReviewRequired('공개 예약 시간 확인은 같은 날짜의 1시간 단위만 지원합니다.');
    return fetchPublicAvailability({room:this.room,date:segment.date});
  }
  async assertPublicAvailable(segment) {
    const snapshot=await this.readPublicAvailability(segment);
    if(snapshot.day_available!==true)throw new ReviewRequired('공개 예약 화면에서 이용할 수 없는 날짜로 확인되어 등록과 결제를 보류합니다.');
    for(const slot of publicSlotExpectations(segment,this.managedRecords || []))if(!slot.disabled && snapshot.hours[slot.index]!==true)throw new ReviewRequired('공개 예약 화면에서 이미 이용할 수 없는 시간이 확인되어 등록과 결제를 보류합니다.');
  }
  async waitPublicPropagation() {await new Promise(resolve=>setTimeout(resolve,1000));}
  async verifyPublicAPI(segment,remaining) {
    const expected=publicSlotExpectations(segment,remaining);
    for(let attempt=0;attempt<3;attempt++) {
      this.publicAttempt=attempt+1;
      const snapshot=await this.publicStep('slots','read',()=>this.readPublicAvailability(segment));
      let matches=true;this.publicProgress('slots','compare-before');
      for(const slot of expected) {
        const selectable=snapshot.day_available && snapshot.hours[slot.index],disabled=!selectable;
        if(typeof selectable!=='boolean' || disabled!==slot.disabled){matches=false;this.publicProgress('slots','mismatch',{index:slot.index,expected_disabled:slot.disabled,actual_disabled:disabled,actual_selectable:selectable});}
      }
      this.publicProgress('slots','compare-after',{matches});
      if(matches)return;
      if(attempt<2)await this.waitPublicPropagation();
    }
    throw new ReviewRequired('공개 예약 가능 시간에서 차단·해제 반영을 확인하지 못했습니다.');
  }
  async verifyPublic(segment,remaining) {
    const expected=publicSlotExpectations(segment,remaining);this.publicStartedAt=Date.now();
    if(this.config.publicAvailabilityMode===PUBLIC_AVAILABILITY_MODE)return this.verifyPublicAPI(segment,remaining);
    for(let attempt=0;attempt<3;attempt++) {
      this.publicAttempt=attempt+1;
      await this.openPublicDate(segment.date);
      let matches=true;this.publicProgress('slots','compare-before');
      for(const slot of expected) {
        const row=this.guest.locator(`.ts-row[data-row-idx="${slot.index}"]`);
        const classes=new Set(((await row.getAttribute('class'))||'').split(/\s+/));
        const disabled=classes.has('is-disabled'),selectable=classes.has('is-selectable');
        if(slot.disabled ? !disabled : !selectable||disabled) {
          matches=false;this.publicProgress('slots','mismatch',{index:slot.index,expected_disabled:slot.disabled,actual_disabled:disabled,actual_selectable:selectable});
        }
      }
      this.publicProgress('slots','compare-after',{matches});
      if(matches)return;
      await this.guest.waitForTimeout(1000);
    }
    throw new ReviewRequired('고객 예약 화면의 차단·해제 반영을 확인하지 못했습니다.');
  }
  async close() {await Promise.allSettled([this.host?.close(),this.guest?.close()]);}
}
