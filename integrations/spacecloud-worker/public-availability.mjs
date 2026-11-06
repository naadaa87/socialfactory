import { ReviewRequired } from './safety.mjs';

// Public product/type pairs embedded in https://www.spacecloud.kr/space/82026.
// Its shipped customer calendar uses this same read-only prices endpoint.
export const PUBLIC_AVAILABILITY_MODE='public-api-v1';
export const PUBLIC_AVAILABILITY_PRODUCTS=Object.freeze({
  r1:Object.freeze({product:140236,type:245094}),r2:Object.freeze({product:140235,type:245092}),
  r3:Object.freeze({product:140486,type:245511}),r4:Object.freeze({product:140487,type:245513}),
  r5:Object.freeze({product:140492,type:245523})
});
const MAX_BYTES=256*1024,TIMEOUT_MS=6000;
const fail=detail=>new ReviewRequired('스페이스클라우드 공개 예약 가능 시간을 확인하지 못했습니다. '+detail);
const part=(value,digits,min,max)=>{
  if(!((typeof value==='number' && Number.isSafeInteger(value)) || (typeof value==='string' && new RegExp('^\\d{'+digits+'}$').test(value))))throw fail('날짜 형식이 변경되었습니다.');
  const number=Number(value);if(number<min || number>max)throw fail('날짜 범위가 올바르지 않습니다.');return number;
};
function dateParts(date) {
  if(typeof date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))throw fail('이용일을 확인해 주세요.');
  const time=Date.parse(date+'T00:00:00Z');
  if(!Number.isFinite(time) || new Date(time).toISOString().slice(0,10)!==date)throw fail('이용일을 확인해 주세요.');
  return {year:Number(date.slice(0,4)),month:Number(date.slice(5,7)),time};
}
export function publicAvailabilityURL(room,date) {
  const pair=PUBLIC_AVAILABILITY_PRODUCTS[room],target=dateParts(date);
  if(!Object.hasOwn(PUBLIC_AVAILABILITY_PRODUCTS,room) || !pair)throw fail('등록되지 않은 방입니다.');
  return `https://api.spacecloud.kr/products/${pair.product}/prices?reservation_type_id=${pair.type}&year=${target.year}&month=${String(target.month).padStart(2,'0')}`;
}
export function parsePublicAvailability(data,{room,date}) {
  publicAvailabilityURL(room,date);const target=dateParts(date);
  if(!data || typeof data!=='object' || Array.isArray(data)
    || part(data.year,'4',1,9999)!==target.year || part(data.month,'1,2',1,12)!==target.month
    || !Array.isArray(data.days) || !data.days.length || data.days.length>42)throw fail('월간 응답이 이용일과 일치하지 않습니다.');
  const identities=new Set();let selected;
  const monthStart=Date.parse(date.slice(0,7)+'-01T00:00:00Z'),nextMonth=new Date(monthStart);nextMonth.setUTCMonth(nextMonth.getUTCMonth()+1);
  for(const day of data.days) {
    if(!day || typeof day!=='object' || Array.isArray(day))throw fail('날짜별 응답이 변경되었습니다.');
    const year=part(day.year,'4',1,9999),month=part(day.month,'1,2',1,12),number=part(day.day,'1,2',1,31);
    const identity=String(year).padStart(4,'0')+'-'+String(month).padStart(2,'0')+'-'+String(number).padStart(2,'0');
    const parsed=dateParts(identity);
    if(parsed.time<monthStart-6*86400000 || parsed.time>nextMonth.getTime()+6*86400000 || identities.has(identity)
      || typeof day.available!=='boolean' || !Array.isArray(day.times))throw fail('달력 날짜가 중복되거나 범위를 벗어났습니다.');
    identities.add(identity);if(identity===date)selected=day;
  }
  if(!selected || selected.times.length!==24)throw fail('이용일의 24시간 정보를 모두 확인하지 못했습니다.');
  const hours=Array(24);const seen=new Set();
  for(const time of selected.times) {
    if(!time || typeof time!=='object' || !Number.isInteger(time.hour) || time.hour<0 || time.hour>23
      || seen.has(time.hour) || typeof time.available!=='boolean')throw fail('시간별 예약 가능 정보가 중복되거나 변경되었습니다.');
    seen.add(time.hour);hours[time.hour]=time.available;
  }
  // Return availability only; do not retain prices, arbitrary response fields or customer information.
  return {room,date,day_available:selected.available,hours};
}
async function readJson(response) {
  const length=response.headers.get('content-length');
  if(length!==null && (!/^\d+$/.test(length) || Number(length)>MAX_BYTES))throw fail('응답 크기를 확인하지 못했습니다.');
  if(!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || ''))throw fail('JSON 응답을 확인하지 못했습니다.');
  if(!response.body?.getReader)throw fail('응답 본문을 확인하지 못했습니다.');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw fail('응답 크기가 제한을 넘었습니다.');chunks.push(value);}
  } catch(error){void reader.cancel().catch(()=>{});throw error;}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export async function readPublicAvailability({room,date},{fetcher=(...args)=>globalThis.fetch(...args),timeoutMs=TIMEOUT_MS}={}) {
  const url=publicAvailabilityURL(room,date);
  const controller=new AbortController();let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('조회 시간이 초과되었습니다.'));},Math.min(TIMEOUT_MS,Math.max(1,timeoutMs)));});
  const work=(async()=>{
    const response=await fetcher(url,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',signal:controller.signal,
      headers:{Accept:'application/json','Cache-Control':'no-cache, no-store',Pragma:'no-cache'}});
    if(response.status!==200 || response.redirected || (response.url && response.url!==url))throw fail('정상 응답이 아닙니다.');
    const age=response.headers.get('age'),warning=response.headers.get('warning') || '',cacheStatus=response.headers.get('cf-cache-status') || '';
    if((age!==null && (!/^\d+$/.test(age) || Number(age)>0)) || /\b11[01]\b/.test(warning) || /^(STALE|UPDATING)$/i.test(cacheStatus))throw fail('캐시된 응답을 최신 일정으로 사용하지 않습니다.');
    return parsePublicAvailability(await readJson(response),{room,date});
  })();
  try{return await Promise.race([work,timeout]);}
  catch(error){if(error instanceof ReviewRequired)throw error;throw fail('조회 또는 응답 검증에 실패했습니다.');}
  finally{clearTimeout(timer);controller.abort();}
}
