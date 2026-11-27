export class ReviewRequired extends Error {
  constructor(message) { super(message); this.name = 'ReviewRequired'; }
}
export class CalendarReadError extends ReviewRequired {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const stageLabels = {
  'open-room':'호스트 달력 열기', 'read-initial':'호스트 일정 조회', 'verify-owned':'기존 시간 확보 확인',
  'verify-public-available':'고객용 예약 가능 시간 조회', 'read-before-change':'변경 전 일정 조회',
  'create-owned':'외부 시간 확보 요청', 'remove-owned':'외부 시간 해제 요청',
  'read-after-block':'확보 후 일정 조회', 'read-after-release':'해제 후 일정 조회',
  'verify-public-block':'고객용 달력에 차단 반영 확인', 'verify-public-release':'고객용 달력에 해제 반영 확인'
};
const readIssueLabels = new Map([
  ['timeout','조회 시간 초과'], ['network','일시적인 통신 오류'],
  ['login','스페이스클라우드 로그인 또는 접근 권한 확인 필요'], ['rate-limit','스페이스클라우드 요청 제한']
]);

const dateOK = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
export const nextDate = date => new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
export const memoFor = segment => `홈페이지 예약 연동 · ${segment.marker} · ${segment.date}`;

export function planJob(job) {
  const jobId=String(job?.job_id ?? job?.id ?? '');
  const admin=/^BADM[a-f0-9]{32}$/.test(job?.code || '');
  if (!job || !['block','verify','release'].includes(job.action) || !/^r[1-5]$/.test(job.room)
    || !/^B[A-Za-z0-9_-]{6,40}$/.test(job.code) || job.marker !== `SFWEB:${job.code}`
    || !dateOK(job.date) || !Number.isInteger(job.start_min) || !Number.isInteger(job.end_min)
    || job.start_min < 0 || job.start_min >= 1440 || job.start_min % 60 || job.end_min % 60
    || job.end_min - job.start_min < (admin?60:120) || job.end_min - job.start_min > (admin?1500:1440)
    || !job.lease_token || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) {
    throw new ReviewRequired('잘못된 작업 또는 시간 단위입니다. 실제 예약은 변경하지 않았습니다.');
  }
  const segments = [{ date:job.date, start_min:job.start_min, end_min:Math.min(1440,job.end_min), marker:job.marker }];
  if (job.end_min > 1440) segments.push({date:nextDate(job.date),start_min:0,end_min:job.end_min-1440,marker:job.marker});
  if (job.segments && (job.segments.length !== segments.length || job.segments.some((s,i) =>
    ['date','start_min','end_min','marker'].some(key => s[key] !== segments[i][key])))) {
    throw new ReviewRequired('작업의 날짜별 시간 범위가 일치하지 않습니다.');
  }
  const replacements=job.replaces || [];
  if(!Array.isArray(replacements) || replacements.length>100 || (replacements.length && !admin)
    || replacements.some(s=>!dateOK(s.date) || !/^SFWEB:BADM[a-f0-9]{32}$/.test(s.marker)
      || s.marker===job.marker || !Number.isInteger(s.start_min) || !Number.isInteger(s.end_min)
      || s.start_min<0 || s.end_min>1440 || s.end_min<=s.start_min || s.start_min%60 || s.end_min%60))
    throw new ReviewRequired('이전 연동 예약의 표식과 시간 범위를 확인하지 못했습니다.');
  return { ...job, job_id:jobId, segments,replaces:replacements };
}

const absolute = (record, key) => Date.parse(record.date+'T00:00:00Z')/60000 + record[key];
export const overlaps = (a,b) => absolute(a,'start_min') < absolute(b,'end_min') && absolute(b,'start_min') < absolute(a,'end_min');
export const samePeriod = (a,b) => a.date === b.date && a.start_min === b.start_min && a.end_min === b.end_min;
export const isOwned = (record, segment) => samePeriod(record,segment) && record.name === segment.marker && record.memo === memoFor(segment) && record.manual === true;

export function inspectRecords(records, segment, replacements=[]) {
  if (!Array.isArray(records) || records.some(r => !dateOK(r.date) || !Number.isInteger(r.start_min) || !Number.isInteger(r.end_min)
    || r.start_min < 0 || r.end_min <= r.start_min || r.end_min > 2880)) {
    throw new ReviewRequired('캘린더 예약 시간을 모두 확인하지 못했습니다.');
  }
  const marked = records.filter(r => (r.date === segment.date || overlaps(r,segment)) && (r.name === segment.marker || r.memo?.includes(segment.marker)));
  const own = marked.filter(r => isOwned(r,segment));
  // Overnight bookings have one owned record per date. An adjacent day segment is not a duplicate.
  if (marked.some(r => !isOwned(r,segment)) || own.length > 1) throw new ReviewRequired('연동 표식이 중복되거나 날짜·시간·메모가 다릅니다. 삭제하지 않고 확인이 필요합니다.');
  return { own:own[0] || null, conflicts:records.filter(r => !isOwned(r,segment) && !replacements.some(old=>isOwned(r,old)) && overlaps(r,segment)) };
}

export async function executeJob(rawJob, driver, heartbeat) {
  const job = planJob(rawJob), receipt = {marker:job.marker,room:job.room,date:job.date,start_min:job.start_min,end_min:job.end_min,segments:job.segments};
  let writeAttempted=false,retriedRead=false,phase='open-room';
  const observationTimes=[];
  async function readAgain(read,{host=false}={}) {
    try { return await read(); }
    catch (error) {
      const temporary = error instanceof CalendarReadError
        ? ['network','timeout'].includes(error.kind) : error?.name==='TimeoutError';
      if (!temporary || retriedRead) throw error;
      // The callback is a read only. Ownership and conflicts are checked again,
      // even when a previous mutation may already have reached SpaceCloud.
      await heartbeat();
      retriedRead=true;
      if (host) await driver.openRoom(job.room);
      return read();
    }
  }
  try {
    driver.job=job;
    driver.managedRecords=[];
    const inspect=(records,segment)=>{
      const result=inspectRecords(records,segment,job.replaces);
      for(const record of records)if(job.replaces.some(old=>isOwned(record,old))) {
        if(!driver.managedRecords.some(old=>samePeriod(old,record) && old.name===record.name))
          driver.managedRecords.push(record);
      }
      return result;
    };
    driver.beforeWrite=heartbeat;
    await readAgain(()=>driver.openRoom(job.room));
    // Read every affected date before the first change, including the next day for overnight bookings.
    const initial = [],initialReadTimes=[];
    phase='read-initial';
    const grouped=job.segments.length>1 && typeof driver.recordsForDates==='function';
    const dates=job.segments.map(segment=>segment.date);
    if(grouped) {
      const readStartedAt=Date.now();
      const records=await readAgain(()=>driver.recordsForDates(dates),{host:true});
      initial.push(...job.segments.map((segment,index)=>inspect(records[index],segment)));
      initialReadTimes.push(readStartedAt);
    } else for (const segment of job.segments) {
      const readStartedAt=Date.now();
      initial.push(inspect(await readAgain(()=>driver.recordsFor(segment.date),{host:true}),segment));
      initialReadTimes.push(readStartedAt);
    }
    if(job.action==='verify' && initial.some(x=>!x.own)) {
      phase='verify-owned';
      throw new ReviewRequired('홈페이지 예약의 외부 차단을 찾지 못했습니다.');
    }
    if (job.action !== 'release' && initial.some(x => x.conflicts.length)) {
      const owned=initial.some(x => x.own);
      if(!owned)receipt.verified_released=true;
      receipt.observed_at=Date.now();
      return {status:owned ? 'review' : 'conflict',receipt,message:'스페이스클라우드의 다른 예약과 겹칩니다. 기존 예약은 변경하지 않았습니다.'};
    }
    if(job.action==='block' && driver.config?.publicAvailabilityMode==='public-api-v1'){
      // Check every unowned date before the first mutation, including tomorrow.
      for(let i=0;i<job.segments.length;i++)if(!initial[i].own){
        if(typeof driver.assertPublicAvailable!=='function')throw new ReviewRequired('공개 일정 사전 확인을 사용할 수 없습니다.');
        phase='verify-public-available';await heartbeat();
        await readAgain(()=>driver.assertPublicAvailable(job.segments[i]));
      }
    }
    // A read-only verification needs one fresh host observation and the public
    // check. Never reuse this branch for a creation, removal or partial block.
    if(job.action==='verify' || (job.action==='block' && initial.every(x=>x.own))) {
      phase='verify-owned';
      if(initial.some(x=>!x.own))throw new ReviewRequired('홈페이지 예약의 외부 차단을 찾지 못했습니다.');
      for(let i=0;i<job.segments.length;i++) {
        await heartbeat();
        phase='verify-public-block';
        await readAgain(()=>driver.verifyPublic(job.segments[i],[initial[i].own]));
      }
      // Public rendering and a slow heartbeat cannot refresh the host snapshot.
      // The API retains its 30-second freshness limit for every segment.
      receipt.observed_at=Math.min(...initialReadTimes);
      await heartbeat();
      receipt.no_conflicts=true;receipt.verified_blocked=true;
      return {status:'succeeded',receipt};
    }
    const release=job.action==='release';
    const verifyWrittenSegment=async (segment,after)=>{
      if(release && after.own)throw new ReviewRequired('등록한 차단의 해제를 확인하지 못했습니다.');
      if(!release && after.conflicts.length)throw new ReviewRequired('차단 등록 후 다른 예약이 확인되었습니다.');
      if(!release && !after.own)throw new ReviewRequired('등록한 외부예약이 호스트 달력에 표시되지 않습니다.');
      phase=release?'verify-public-release':'verify-public-block';
      await readAgain(()=>driver.verifyPublic(segment,release?after.conflicts:[after.own]));
    };
    for (let i=0;i<job.segments.length;i++) {
      const segment=job.segments[i];
      phase='read-before-change';
      const current=grouped && i===0?initial[0]:inspect(await readAgain(()=>driver.recordsFor(segment.date),{host:true}),segment);
      if(release) {
        if(current.own) {phase='remove-owned';await heartbeat();writeAttempted=true;await driver.removeSegment(segment,current.own);}
      } else {
        if(current.conflicts.length)throw new ReviewRequired('작업 도중 다른 예약이 확인되었습니다. 결제를 보류합니다.');
        if(!current.own) {
          phase='create-owned';await heartbeat();writeAttempted=true;await driver.createSegment(segment);
        }
      }
      if(!grouped) {
        phase=release?'read-after-release':'read-after-block';
        const readStartedAt=Date.now();
        const after=inspect(await readAgain(()=>driver.recordsFor(segment.date),{host:true}),segment);
        await verifyWrittenSegment(segment,after);
        observationTimes.push(readStartedAt);
      }
    }
    if(grouped) {
      // Observe both dates only after the final write. The first night's proof
      // must not age while the next night's write is still running.
      phase=release?'read-after-release':'read-after-block';
      let readStartedAt=Date.now();
      let records=await readAgain(()=>driver.recordsForDates(dates),{host:true});
      let inspected=job.segments.map((segment,i)=>inspect(records[i],segment));
      // The host can briefly render an older calendar after accepting a write.
      // Refresh once without repeating the mutation or retrying a real conflict.
      const shouldRefresh=release?inspected.some(day=>day.own)
        :inspected.every(day=>!day.conflicts.length) && inspected.some(day=>!day.own);
      if(shouldRefresh) {
        await heartbeat();
        readStartedAt=Date.now();
        records=await readAgain(()=>driver.recordsForDates(dates),{host:true});
        inspected=job.segments.map((segment,i)=>inspect(records[i],segment));
      }
      for(let i=0;i<job.segments.length;i++) {
        phase=release?'read-after-release':'read-after-block';
        await verifyWrittenSegment(job.segments[i],inspected[i]);
      }
      observationTimes.push(readStartedAt);
    }
    receipt.observed_at=Math.min(...observationTimes);
    await heartbeat();
    receipt.no_conflicts=true;
    receipt[job.action === 'release' ? 'verified_released' : 'verified_blocked']=true;
    return {status:'succeeded',receipt};
  } catch (error) {
    driver.reportReview?.({phase,kind:error?.name || 'Error',reason:error instanceof ReviewRequired ? error.message : error instanceof TypeError || error?.name==='TimeoutError' ? String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g,'[url]').slice(0,160) : null});
    // The UI may have accepted a write before a timeout. Never blindly retry or delete on uncertainty.
    const reason = error instanceof CalendarReadError ? readIssueLabels.get(error.kind)
      : error?.name==='TimeoutError' ? readIssueLabels.get('timeout') : null;
    const detail = reason ? ` · ${reason}` : '';
    const followUp = writeAttempted ? '변경 반영 여부를 확인해 주세요.' : '최신 일정을 다시 확인해 주세요.';
    return {status:'review',receipt,message:`${stageLabels[phase] || '외부 일정 확인'} 실패${detail}. ${followUp}`};
  }
}
