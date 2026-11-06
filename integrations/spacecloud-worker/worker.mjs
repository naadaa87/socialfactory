import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig, QueueClient } from './queue.mjs';
import { executeJob, planJob } from './safety.mjs';
import { SpacecloudUI, ROOMS } from './spacecloud-ui.mjs';
import { acquireProfileLock } from './profile.mjs';

const login=process.argv.includes('--login'),check=process.argv.includes('--check');
const config=login?{profile:process.env.SPACECLOUD_PROFILE_DIR||'.profile',headless:false,accountLabel:process.env.SPACECLOUD_ACCOUNT_LABEL||'소셜팩토리 건대 (초특가)'}:readConfig();
if(!login && !check && !config.allowWrites)throw new Error('Writes are disabled. Complete login/check, then explicitly set SPACECLOUD_ALLOW_WRITES=true.');
const profileLock=await acquireProfileLock(config.profile);
let context,stopping=false;
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
try {
  context=await chromium.launchPersistentContext(profileLock.profileDir,{headless:config.headless,chromiumSandbox:true,locale:'ko-KR',timezoneId:'Asia/Seoul',viewport:{width:1280,height:1100}});
  if(login) {
    const page=await context.newPage();
    await page.goto('https://partner.spacecloud.kr/reservation-calendar?product=140492&space=82026');
    console.log('전용 브라우저에서 스페이스클라우드 호스트 계정에 로그인한 뒤 Ctrl+C로 종료하세요. 비밀번호·쿠키를 복사하지 않습니다.');
    while(!stopping && context.pages().length)await delay(500);
  } else {
    const driver=new SpacecloudUI(context,config);await driver.initialize();
    if(check) {
      for(const room of Object.keys(ROOMS)) {await driver.openRoom(room);await driver.hostMonth();console.log(room+': host calendar verified (read only).');}
      console.log('로그인·방 선택 구조 확인 완료. 실제 생성·삭제와 자정 경계는 별도 빈 시간 테스트 후 활성화하세요.');
    } else {
      const queue=new QueueClient(config);
      const snapshotAt=new Map();
      while(!stopping) {
        let job;
        try {job=await queue.claim();}catch {console.error('Queue unavailable. No external reservation changed.');await delay(config.pollMs);continue;}
        if(!job){
          const room=Object.keys(ROOMS).find(room=>Date.now()-(snapshotAt.get(room)||0)>180000);
          if(room) {
            try {
              const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
              const end=new Date(Date.parse(today+'T00:00:00Z')+30*86400000).toISOString().slice(0,10);
              await queue.snapshot(await driver.calendarSnapshot(room,today,end));
            } catch {console.error(room+': calendar snapshot unavailable; previous server snapshot retained.');}
            snapshotAt.set(room,Date.now());
          }
          await delay(config.pollMs);continue;
        }
        let result,planned,leaseLost=false,beating=false;
        const heartbeat=async()=>{if(leaseLost)throw new Error('Lease lost.');try {await queue.heartbeat(job);}catch(error){leaseLost=true;throw error;}};
        const timer=setInterval(async()=>{if(beating || leaseLost)return;beating=true;try{await heartbeat();}catch{}finally{beating=false;}},20000);
        try {
          planned=planJob(job);result=await executeJob(planned,driver,heartbeat);
        }catch {result={status:'review',message:'작업 결과 또는 브라우저 상태를 확인하지 못했습니다. 점유를 유지하고 확인이 필요합니다.'};}
        finally {clearInterval(timer);}
        let reported=false;
        for(let attempt=0;attempt<3 && !reported;attempt++) {
          try {await queue.complete(job,result);reported=true;console.log(job.code+': '+result.status);}
          catch {if(attempt<2)await delay(1000*(attempt+1));}
        }
        if(!reported)console.error(job.code+': report failed. Do not retry a write; reconcile the owned marker in the admin review queue.');
        // Completion is reported immediately; a slow inventory scan must not make an older verification appear fresh.
        if(reported && planned && (result.status==='succeeded' || result.status==='conflict')) {
          try {await queue.snapshot(await driver.calendarSnapshot(job.room,job.date,planned.segments.at(-1).date));}
          catch {console.error(job.code+': calendar snapshot unavailable; previous server snapshot retained.');}
        }
      }
    }
    await driver.close();
  }
} finally {
  await context?.close();
  await profileLock.release();
}
