export class ReviewRequired extends Error {
  constructor(message) { super(message); this.name = 'ReviewRequired'; }
}

const dateOK = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
export const nextDate = date => new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
export const memoFor = segment => `홈페이지 예약 연동 · ${segment.marker} · ${segment.date}`;

export function planJob(job) {
  const jobId=String(job?.job_id ?? job?.id ?? '');
  if (!job || !['block','verify','release'].includes(job.action) || !/^r[1-5]$/.test(job.room)
    || !/^B[A-Za-z0-9_-]{6,40}$/.test(job.code) || job.marker !== `SFWEB:${job.code}`
    || !dateOK(job.date) || !Number.isInteger(job.start_min) || !Number.isInteger(job.end_min)
    || job.start_min < 0 || job.start_min >= 1440 || job.start_min % 60 || job.end_min % 60
    || job.end_min - job.start_min < 120 || job.end_min - job.start_min > 1440
    || !job.lease_token || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    throw new ReviewRequired('잘못된 작업 또는 시간 단위입니다. 실제 예약은 변경하지 않았습니다.');
  }
  const segments = [{ date:job.date, start_min:job.start_min, end_min:Math.min(1440,job.end_min), marker:job.marker }];
  if (job.end_min > 1440) segments.push({date:nextDate(job.date),start_min:0,end_min:job.end_min-1440,marker:job.marker});
  if (job.segments && (job.segments.length !== segments.length || job.segments.some((s,i) =>
    ['date','start_min','end_min','marker'].some(key => s[key] !== segments[i][key])))) {
    throw new ReviewRequired('작업의 날짜별 시간 범위가 일치하지 않습니다.');
  }
  return { ...job, job_id:jobId, segments };
}

const absolute = (record, key) => Date.parse(record.date+'T00:00:00Z')/60000 + record[key];
export const overlaps = (a,b) => absolute(a,'start_min') < absolute(b,'end_min') && absolute(b,'start_min') < absolute(a,'end_min');
export const samePeriod = (a,b) => a.date === b.date && a.start_min === b.start_min && a.end_min === b.end_min;
export const isOwned = (record, segment) => samePeriod(record,segment) && record.name === segment.marker && record.memo === memoFor(segment) && record.manual === true;

export function inspectRecords(records, segment) {
  if (!Array.isArray(records) || records.some(r => !dateOK(r.date) || !Number.isInteger(r.start_min) || !Number.isInteger(r.end_min)
    || r.start_min < 0 || r.end_min <= r.start_min || r.end_min > 2880)) {
    throw new ReviewRequired('캘린더 예약 시간을 모두 확인하지 못했습니다.');
  }
  const marked = records.filter(r => (r.date === segment.date || overlaps(r,segment)) && (r.name === segment.marker || r.memo?.includes(segment.marker)));
  const own = marked.filter(r => isOwned(r,segment));
  // Overnight bookings have one owned record per date. An adjacent day segment is not a duplicate.
  if (marked.some(r => !isOwned(r,segment)) || own.length > 1) throw new ReviewRequired('연동 표식이 중복되거나 날짜·시간·메모가 다릅니다. 삭제하지 않고 확인이 필요합니다.');
  return { own:own[0] || null, conflicts:records.filter(r => !isOwned(r,segment) && overlaps(r,segment)) };
}

export async function executeJob(rawJob, driver, heartbeat) {
  const job = planJob(rawJob), receipt = {marker:job.marker,room:job.room,date:job.date,start_min:job.start_min,end_min:job.end_min,segments:job.segments};
  let changed = false,phase='open-room';const observationTimes=[];
  try {
    driver.job=job;
    driver.beforeWrite=heartbeat;
    await driver.openRoom(job.room);
    // Read every affected date before the first change, including the next day for overnight bookings.
    const initial = [];
    phase='read-initial';
    for (const segment of job.segments) initial.push(inspectRecords(await driver.recordsFor(segment.date),segment));
    if (job.action !== 'release' && initial.some(x => x.conflicts.length)) {
      const owned=initial.some(x => x.own);
      if(!owned)receipt.verified_released=true;
      receipt.observed_at=Date.now();
      return {status:owned ? 'review' : 'conflict',receipt,message:'스페이스클라우드의 다른 예약과 겹칩니다. 기존 예약은 변경하지 않았습니다.'};
    }
    for (let i=0;i<job.segments.length;i++) {
      const segment=job.segments[i];
      phase='read-before-change';
      const current=inspectRecords(await driver.recordsFor(segment.date),segment);
      if (job.action === 'release') {
        if (current.own) { phase='remove-owned';await heartbeat(); await driver.removeSegment(segment,current.own); changed=true; }
        phase='read-after-release';
        const after=inspectRecords(await driver.recordsFor(segment.date),segment);
        if (after.own) throw new ReviewRequired('등록한 차단의 해제를 확인하지 못했습니다.');
        phase='verify-public-release';await driver.verifyPublic(segment,after.conflicts);
        observationTimes.push(Date.now());
      } else {
        if (current.conflicts.length) throw new ReviewRequired('작업 도중 다른 예약이 확인되었습니다. 결제를 보류합니다.');
        if (!current.own) {
          if (job.action === 'verify') throw new ReviewRequired('홈페이지 예약의 외부 차단을 찾지 못했습니다.');
          phase='create-owned';await heartbeat(); await driver.createSegment(segment); changed=true;
        }
        phase='read-after-block';const after=inspectRecords(await driver.recordsFor(segment.date),segment);
        if (!after.own || after.conflicts.length) throw new ReviewRequired('차단 등록 또는 다른 예약 유무를 확인하지 못했습니다.');
        phase='verify-public-block';await driver.verifyPublic(segment,[after.own]);
        observationTimes.push(Date.now());
      }
    }
    receipt.observed_at=Math.min(...observationTimes);
    await heartbeat();
    receipt.no_conflicts=true;
    receipt[job.action === 'release' ? 'verified_released' : 'verified_blocked']=true;
    return {status:'succeeded',receipt};
  } catch (error) {
    driver.reportReview?.({phase,kind:error?.name || 'Error',reason:error instanceof ReviewRequired ? error.message : error instanceof TypeError || error?.name==='TimeoutError' ? String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g,'[url]').slice(0,160) : null});
    // The UI may have accepted a write before a timeout. Never blindly retry or delete on uncertainty.
    return {status:'review',receipt,message:changed ? '외부 예약 변경 후 확인이 중단되었습니다. 점유를 유지하고 확인이 필요합니다.' : '외부 예약 상태를 확인하지 못했습니다. 점유를 유지하고 확인이 필요합니다.'};
  }
}
