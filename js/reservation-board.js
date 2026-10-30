import { ROOM_IDS, roomSchedule, kstDay, formatTime, isOutdated } from './reservation-board-model.mjs';

const $ = id => document.getElementById(id);
const demo = new URLSearchParams(location.search).get('demo') === '1';
const capacities = { r1:36, r2:40, r3:16, r4:48, r5:30 };
const images = { r1:'room-1-01-lecture-rear', r2:'room-2-01-lecture-angle', r3:'room-3-01-lecture', r4:'room-4-01-lecture-angle', r5:'room-5-01-theater' };
let data = null, receivedAt = 0, failed = false, loginRequired = false, loading = false, selected = 'r1', page = 0;
// A fixed, explicitly labelled example clock makes every visual review reproducible.
const demoDate = kstDay(Date.now());
const now = () => demo ? Date.parse(demoDate + 'T14:25:00+09:00') : Date.now();
const elem = (tag, text, className) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (className) e.className = className; return e; };
const timeText = row => (row.continued ? '전일~ ' : '') + formatTime(row.start, data.date) + ' – ' + formatTime(row.end, data.date) + (row.continues ? ' ~익일' : '');

function example() {
  const at = time => Date.parse(demoDate + 'T' + time + ':00+09:00');
  const items = [
    ['r1','김○원','10:00','12:00'],['r1','이○진','13:00','16:00'],['r1','박○영','17:00','19:00'],
    ['r2','최○수','14:00','18:00'],['r2','김○현','19:00','21:00'],
    ['r3','정○윤','16:00','18:00'],['r4','한○민','09:00','12:00'],
    ['r5','윤○우','13:00','15:00'],['r5','오○서','15:30','18:00']
  ];
  return { ok:true, date:demoDate, generated_at:now(), reservations:items.map(([room,name,s,e]) => ({room,name,start:at(s),end:at(e)})).sort((a,b)=>a.start-b.start),
    rooms:ROOM_IDS.map(id=>({id,calendar:'ok'})), unassigned:0 };
}

function focusRoom(id) {
  selected = id;
  document.querySelectorAll('[data-room]').forEach(e => { e.classList.toggle('selected',e.dataset.room === id); if(e.classList.contains('pin')) e.setAttribute('aria-pressed', String(e.dataset.room === id)); });
  $('room-image').src = '/images/space/' + images[id] + '-sm.webp';
  $('room-image').alt = id.slice(1) + '번룸 내부';
  $('photo-title').textContent = id.slice(1) + '번룸';
  $('photo-number').textContent = '0' + id.slice(1);
  $('photo-description').textContent = (id === 'r5' ? '주출입구에서 오른쪽 · ' : '주출입구에서 왼쪽 복도 · ') + '최대 ' + capacities[id] + '명';
}

function slot(rows, next, uncertain, unavailable) {
  const box = elem('div', null, 'slot');
  if (unavailable) { box.append(elem('p','확인 중','empty'),elem('span','관리자에게 문의해 주세요','empty-sub')); return box; }
  if (!rows.length) {
    box.append(elem('p',uncertain ? '일정 확인 필요' : next ? '이후 예약 없음' : '현재 예약 없음','empty'));
    if(!next) box.append(elem('span',uncertain ? '마지막 확인 일정 기준' : '이용 가능 여부는 예약 후 확인','empty-sub'));
    return box;
  }
  box.append(elem('span',rows.length > 1 ? '일정 겹침 · 확인 필요' : next ? '이용 예정' : '예약 시간 중', 'badge' + (rows.length>1?' warn':next?' next':'')));
  rows.forEach(row => { box.append(elem('strong',row.name),elem('time',timeText(row))); });
  return box;
}

function render() {
  const timestamp = now();
  const obsolete = !demo && isOutdated(data,timestamp,receivedAt);
  const unavailable = !data || data.date !== kstDay(timestamp) || obsolete;
  $('date').textContent = new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'long',day:'numeric',weekday:'long'}).format(timestamp);
  $('clock').textContent = (demo ? '예시 ' : '') + new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(timestamp);
  const rooms = $('rooms'); rooms.replaceChildren();
  ROOM_IDS.forEach(id => {
    const state = data?.rooms.find(r=>r.id===id);
    const uncertain = failed || state?.calendar !== 'ok';
    const schedule = roomSchedule(data?.reservations || [],id,timestamp);
    const row = elem('article',null,'room-row'); row.dataset.room = id;
    const identity = elem('div',null,'room-identity'), label = elem('div');
    label.append(elem('h3',id.slice(1)+'번룸'),elem('small','최대 '+capacities[id]+'명'));
    identity.append(elem('span',id.slice(1),'number'),label);
    row.append(identity,slot(schedule.current,false,uncertain,unavailable),slot(schedule.next?[schedule.next]:[],true,uncertain,unavailable));
    row.addEventListener('click',()=>focusRoom(id)); rooms.append(row);
  });
  focusRoom(selected);
  $('total').textContent = unavailable ? '확인 필요' : '오늘 '+data.reservations.length+'건';
  const warnings = [];
  if(loginRequired) warnings.push('예약 조회를 위한 관리자 로그인이 필요합니다.');
  else if(obsolete && data) warnings.push('예약 정보를 갱신하지 못해 일정을 숨겼습니다. 관리자에게 문의해 주세요.');
  else if(!data) warnings.push(failed ? '예약 정보를 불러오지 못했습니다. 연결을 확인해 주세요.' : '예약 정보를 확인하고 있습니다.');
  else if(failed) warnings.push('연결이 불안정합니다. 마지막 확인 일정을 표시합니다.');
  if(data && !unavailable) {
    const badRooms = data.rooms.filter(r=>r.calendar!=='ok');
    if(badRooms.length) warnings.push(badRooms.map(r=>r.id.slice(1)+'번룸').join('·')+' 외부 일정 연결을 확인해야 합니다.');
    if(data.unassigned) warnings.push('방 번호가 없는 예약은 별도 확인이 필요합니다.');
  }
  $('notice').replaceChildren(document.createTextNode(warnings.join(' ')));
  if(loginRequired) { const a=elem('a',' 관리자 로그인 ↗'); a.href='/admin'; a.target='_blank'; a.rel='noopener'; $('notice').append(a); }
  $('connection').textContent = demo?'예시 데이터':failed||unavailable?'연결 확인 필요':'1분마다 자동 갱신';
  document.querySelector('.schedule-bottom').classList.toggle('offline', failed||unavailable);
  $('updated').textContent = demo?'시제품 · 실제 예약과 연결되지 않은 예시 화면':receivedAt?'마지막 확인 '+new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(receivedAt):'갱신 대기 중';
  const entries = unavailable?[]:data.reservations;
  const pages = Math.max(1,Math.ceil(entries.length/5)); page = ((page%pages)+pages)%pages;
  $('page-count').textContent=(page+1)+' / '+pages;
  $('previous').disabled=pages===1; $('next').disabled=pages===1;
  $('day-subtitle').textContent=pages>1?'전체 '+entries.length+'건 · 12초마다 다음 일정':'종료된 예약도 함께 표시합니다';
  const dayItems=$('day-items'); dayItems.replaceChildren();
  entries.slice(page*5,page*5+5).forEach(r=>{
    const ended=r.end<=timestamp, current=r.start<=timestamp&&!ended;
    const item=elem('div',null,'day-item'+(ended?' ended':current?' current':''));
    const top=elem('div',null,'day-top'); top.append(elem('b',r.room.slice(1)+'번룸'),elem('span',ended?'종료':current?'예약 시간 중':'예정'));
    item.append(top,elem('strong',r.name),elem('time',timeText(r))); dayItems.append(item);
  });
  if(!entries.length) dayItems.append(elem('p',unavailable?'예약 정보를 확인해 주세요.':'오늘 등록된 예약이 없습니다.','day-empty'));
}

async function refresh() {
  if(loading||demo) return;
  loading=true;
  const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),20000);
  try {
    const response=await fetch('/api/admin/reservation-board',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
    loginRequired=response.status===401;
    if(!response.ok) throw new Error('request');
    const fresh=await response.json();
    if(!fresh.ok||!Array.isArray(fresh.reservations)||!Array.isArray(fresh.rooms)) throw new Error('format');
    data=fresh; receivedAt=Date.now(); failed=false; loginRequired=false;
  } catch { failed=true; if(loginRequired) data=null; }
  finally { clearTimeout(timeout); loading=false; render(); }
}

$('preview-bar').hidden=!demo;
document.querySelectorAll('.pin').forEach(pin=>pin.addEventListener('click',()=>focusRoom(pin.dataset.room)));
$('previous').addEventListener('click',()=>{page--;render();});
$('next').addEventListener('click',()=>{page++;render();});
$('fullscreen').addEventListener('click',async()=>{try {if(document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen();} catch { $('fullscreen').title='브라우저의 전체 화면 기능을 이용해 주세요'; }});
window.addEventListener('online',refresh);
document.addEventListener('visibilitychange',()=>{if(!document.hidden) refresh();});
if(demo){data=example();receivedAt=now();}
render(); refresh();
setInterval(render,10000);
setInterval(refresh,60000);
if(!matchMedia('(prefers-reduced-motion: reduce)').matches) setInterval(()=>{page++;render();},12000);
