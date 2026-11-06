import { ReviewRequired, memoFor } from './safety.mjs';
import { calendarGridDates, parseCalendarEntry, publicSlotExpectations } from './calendar.mjs';

export const ROOMS = Object.freeze({r1:{product:140236,max:36},r2:{product:140235,max:40},r3:{product:140486,max:16},r4:{product:140487,max:48},r5:{product:140492,max:30}});
const previousDate=date=>new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
const monthOf=date=>date.slice(0,7).replace('-','.');
const numberOfMonth=month=>Number(month.slice(0,4))*12+Number(month.slice(5,7));
const normalize=text=>text.replace(/\s+/g,' ').trim();

export class SpacecloudUI {
  constructor(context,config) { this.context=context;this.config=config;this.room=null;this.job=null; }
  async initialize() {this.host=await this.context.newPage();this.guest=await this.context.newPage();this.host.setDefaultTimeout(15000);this.guest.setDefaultTimeout(15000);}
  async click(locator) {
    if(await locator.count()!==1 || !await locator.isVisible()) throw new ReviewRequired('화면의 조작 대상을 하나로 확인하지 못했습니다.');
    await locator.scrollIntoViewIfNeeded();
    const box=await locator.boundingBox();if(!box) throw new ReviewRequired('화면의 조작 대상을 확인하지 못했습니다.');
    await locator.page().mouse.click(box.x+box.width/2,box.y+box.height/2);
  }
  async openRoom(room) {
    if(!ROOMS[room]) throw new ReviewRequired('등록되지 않은 방입니다.');
    this.room=room;
    await this.host.goto(`https://partner.spacecloud.kr/reservation-calendar?product=${ROOMS[room].product}&space=82026`,{waitUntil:'domcontentloaded'});
    const heading=this.host.getByRole('heading',{name:`${this.config.accountLabel}, ${Number(room.slice(1))}번룸 (최대 ${ROOMS[room].max}명)`,exact:true});
    await heading.waitFor({state:'visible'});
    await this.host.locator('.booking_wrap').first().waitFor({state:'visible'});
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
      await this.click(this.host.getByText(direction,{exact:true}));
      await this.host.waitForFunction(({selector,current})=>document.querySelector(selector)?.textContent.trim()!==current,{selector:'a[title="달력레이어 팝업 열림"] em',current});
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
    const entries=await cell.locator('.booking_list li').evaluateAll(nodes=>nodes.map((node,index)=>{
      const a=node.querySelector('a');
      return {index,text:a?.textContent?.replace(/\s+/g,' ').trim()||'',href:a?.getAttribute('href')||'',hours:a?[...a.querySelectorAll('em')].map(em=>em.textContent.trim()):[]};
    }));
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
    // A full reload prevents reusing a previously rendered, stale calendar.
    await this.openRoom(this.room);
    const records=[...await this.readDate(previousDate(date)),...await this.readDate(date)];
    for(let i=0;i<records.length;i++) {
      if(records[i].name===this.job?.marker) records[i]=await this.readOwnedDetail(records[i]);
    }
    return records;
  }
  async ownedPopup(record) {
    const cell=await this.dateCell(record.source.date);
    const entries=cell.locator('.booking_list li a');
    const entry=entries.nth(record.source.index);
    if(normalize(await entry.innerText())!==record.source.text || await entry.getAttribute('href')) throw new ReviewRequired('대상 외부 예약의 표식이 변경되었습니다.');
    await this.click(entry);
    const popup=this.host.locator('.layer_popup.reservation_state._popup4:visible');
    await popup.waitFor({state:'visible'});
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
    const memo=normalize(await popup.locator('.list_memo > div').innerText());
    const result={...record,date,start_min,end_min,name:nameLine.replace(/^예약자명\s*:\s*/,''),memo,manual:true};
    if(!leaveOpen) {
      const close=popup.locator('a').filter({hasText:/^\s*(닫기|확인)\s*$/});
      if(await close.count()===1) await this.click(close);
      else {
        // Leaving the detail via a fresh calendar navigation is read-only and deterministic.
        await this.openRoom(this.room);
      }
    }
    return result;
  }
  async chooseFormDate(date) {
    await this.click(this.host.locator('#_dpicker1 a._miniCalOpen'));
    const wrap=this.host.locator('.calendar_wrap:visible').filter({has:this.host.getByRole('table',{name:'달력 월간 테이블'})});
    await wrap.waitFor({state:'visible'});
    for(let tries=0;tries<15;tries++) {
      const parts=(await wrap.locator('.calendar_tit strong em').allTextContents()).map(normalize);
      const month=parts.length===2?parts[0]+'.'+parts[1].padStart(2,'0'):'';
      if(!/^\d{4}\.\d{2}$/.test(month)) throw new ReviewRequired('날짜 선택 창의 기준 월을 확인하지 못했습니다.');
      const target=monthOf(date);if(month===target)break;
      await this.click(wrap.locator(numberOfMonth(target)>numberOfMonth(month)?'.btn_month_next':'.btn_month_prev'));
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
    await this.click(anchor);
    const value=await this.host.locator('#start_day').inputValue();
    if(value.replace(/[^0-9]/g,'')!==date.replaceAll('-','')) throw new ReviewRequired('외부 예약 양식의 날짜가 일치하지 않습니다.');
  }
  async createSegment(segment) {
    if(!this.config.allowWrites)throw new ReviewRequired('외부 예약 쓰기가 비활성 상태입니다.');
    await this.click(this.host.getByText('예약추가',{exact:true}));
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
    await this.click(this.host.locator('a#_addExternalSchedule'));
    await this.host.locator('#reserve_name').waitFor({state:'hidden'});
  }
  async removeSegment(segment,record) {
    if(!this.config.allowWrites)throw new ReviewRequired('외부 예약 쓰기가 비활성 상태입니다.');
    const checked=await this.readOwnedDetail(record,true);
    if(checked.name!==segment.marker || checked.memo!==memoFor(segment) || checked.date!==segment.date
      ||checked.start_min!==segment.start_min ||checked.end_min!==segment.end_min)throw new ReviewRequired('해제할 외부 예약의 정보가 다릅니다.');
    const popup=this.host.locator('.layer_popup.reservation_state._popup4:visible');
    await this.click(popup.locator('a.btn_negative').filter({hasText:/^\s*예약\s*삭제\s*$/}));
    const confirm=this.host.locator('.layer_popup:visible').filter({has:this.host.getByText('예약을 삭제하시겠습니까?',{exact:true})});
    await confirm.waitFor({state:'visible'});
    await this.beforeWrite();
    await this.click(confirm.getByText('확인',{exact:true}));
    await confirm.waitFor({state:'hidden'});
  }
  async openPublicDate(date) {
    await this.guest.goto('https://www.spacecloud.kr/space/82026',{waitUntil:'domcontentloaded'});
    const room=this.guest.getByRole('radio',{name:`${Number(this.room.slice(1))}번룸 (최대 ${ROOMS[this.room].max}명)`,exact:true});
    await room.waitFor({state:'visible'});await room.press('Space');
    const time=this.guest.getByRole('radio',{name:'시간 단위 예약하기(최소 2시간 부터)',exact:true});
    await time.waitFor({state:'visible'});await time.press('Space');
    const next=this.guest.locator('a.btn_month_next');await next.waitFor({state:'visible'});
    for(let tries=0;tries<15;tries++) {
      const month=await next.evaluate(el=>el.parentElement.textContent.match(/\d{4}\s*\.\s*\d{1,2}/)?.[0]?.replace(/\s/g,'')||'');
      const parts=month.split('.');const current=parts.length===2?parts[0]+'.'+parts[1].padStart(2,'0'):'';
      if(!current)throw new ReviewRequired('고객 예약 화면의 기준 월을 확인하지 못했습니다.');
      if(current===monthOf(date))break;
      await this.click(this.guest.locator(numberOfMonth(monthOf(date))>numberOfMonth(current)?'a.btn_month_next':'a.btn_month_prev'));
      await this.guest.waitForFunction(({current})=>[...document.querySelectorAll('a.btn_month_next')].some(el=>{const p=el.parentElement.textContent.match(/(\d{4})\s*\.\s*(\d{1,2})/);return p && p[1]+'.'+p[2].padStart(2,'0')!==current;}),{current});
      if(tries===14)throw new ReviewRequired('고객 예약 화면의 날짜 이동을 완료하지 못했습니다.');
    }
    const day=this.guest.locator('a').filter({hasText:new RegExp('^\\s*'+Number(date.slice(8))+'\\s*$')});
    const visible=[];for(const a of await day.all())if(await a.isVisible())visible.push(a);
    if(visible.length!==1)throw new ReviewRequired('고객 예약 화면의 이용일이 모호합니다.');
    await this.click(visible[0]);
    await this.guest.locator('.ts-row[data-row-idx="0"]').waitFor({state:'visible'});
  }
  async verifyPublic(segment,remaining) {
    const expected=publicSlotExpectations(segment,remaining);
    for(let attempt=0;attempt<3;attempt++) {
      await this.openPublicDate(segment.date);
      let matches=true;
      for(const slot of expected) {
        const row=this.guest.locator(`.ts-row[data-row-idx="${slot.index}"]`);
        const classes=(await row.getAttribute('class'))||'';
        if(slot.disabled ? !classes.includes('is-disabled') : !classes.includes('is-selectable')||classes.includes('is-disabled'))matches=false;
      }
      if(matches)return;
      await this.guest.waitForTimeout(1000);
    }
    throw new ReviewRequired('고객 예약 화면의 차단·해제 반영을 확인하지 못했습니다.');
  }
  async close() {await Promise.allSettled([this.host?.close(),this.guest?.close()]);}
}
