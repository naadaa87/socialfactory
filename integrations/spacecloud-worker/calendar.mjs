import { ReviewRequired } from './safety.mjs';

export function calendarGridDates(month, labels) {
  if (!/^\d{4}\.\d{2}$/.test(month) || !Array.isArray(labels) || labels.length < 28 || labels.length > 42) throw new ReviewRequired('캘린더 월간 구조가 변경되었습니다.');
  const first=labels.findIndex(label => /^\d{1,2}$/.test(String(label).trim()) && Number(label) === 1);
  if (first < 0 || first > 6) throw new ReviewRequired('월간 달력의 첫 날짜를 확인하지 못했습니다.');
  const start=Date.parse(month.replace('.','-')+'-01T00:00:00Z');
  const dates=labels.map((label,index) => {
    const date=new Date(start+(index-first)*86400000).toISOString().slice(0,10);
    if (Number(label) !== Number(date.slice(8))) throw new ReviewRequired('월간 달력의 날짜 순서가 일치하지 않습니다.');
    return date;
  });
  return dates;
}

export function parseCalendarEntry(date,entry) {
  const hours=entry.hours.map(Number);
  if (hours.length !== 2 || hours.some(h => !Number.isInteger(h) || h < 0 || h > 24)
    || hours[0] === 24 || hours[0] === hours[1]) throw new ReviewRequired('예약의 시간 범위를 해석하지 못했습니다.');
  const start_min=hours[0]*60;
  const end_min=(hours[1]+(hours[1] < hours[0] ? 24 : 0))*60;
  if (end_min <= start_min || end_min-start_min > 1440) throw new ReviewRequired('예약 시간이 올바르지 않습니다.');
  return {date,start_min,end_min,name:entry.text.split(',').slice(1).join(',').trim(),memo:'',manual:false,
    source:{date,index:entry.index,text:entry.text,href:entry.href || ''}};
}

export function publicSlotExpectations(segment,records) {
  const base=Date.parse(segment.date+'T00:00:00Z')/60000;
  const slots=[];
  for(let minute=segment.start_min;minute<segment.end_min;minute+=60) {
    const start=base+minute,end=start+60;
    const disabled=records.some(r => {
      const rbase=Date.parse(r.date+'T00:00:00Z')/60000;
      return rbase+r.start_min < end && start < rbase+r.end_min;
    });
    slots.push({index:minute/60,disabled});
  }
  return slots;
}
