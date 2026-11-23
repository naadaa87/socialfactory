import {calendarRows} from './spacecloud.js';
// A verified write can finish while a prior calendar audit is still publishing.
// Bridge only that short interval; a later authoritative audit takes over.
export async function applySourceWrites(env,data) {
 let jobs;try {jobs=(await env.DB.prepare("SELECT * FROM spacecloud_source_jobs WHERE state='succeeded' AND updated_at>?1 ORDER BY updated_at,id LIMIT 1000")
  .bind(data.info?.host_calendar?.last_success||0).all()).results||[];}catch(error){if(/no such table/.test(error.message))return data;throw error;}
 if(!jobs.length)return data;
 let rows=data.results;const removed=new Set(data.info?.removed_linked_codes||[]);
 for(const job of jobs) {
  const before=JSON.parse(job.before_json);
  const originalBase=Date.parse(before.date+'T00:00:00+09:00');
  const originals=await calendarRows([{start:originalBase+before.start_min*60000,end:originalBase+before.end_min*60000,title:before.title,source_url:''}],before.space,job.updated_at);
  const oldCodes=new Set([job.source_code,...originals.map(r=>r.code)]);
  rows=rows.filter(r=>!oldCodes.has(r.code) && !(r.space===before.space&&r.source_manual_id===before.id));
  if(job.action==='cancel'){if(job.linked_code)removed.add(job.linked_code);continue;}
  const target=JSON.parse(job.target_json),base=Date.parse(target.date+'T00:00:00+09:00');
  if(job.linked_code)removed.delete(job.linked_code);
  const changed=await calendarRows([{start:base+target.start_min*60000,end:base+target.end_min*60000,title:target.title,
   source_manual_id:job.result_id,source_url:''}],target.space,job.updated_at);
  const codes=new Set(changed.map(r=>r.code));rows=rows.filter(r=>!codes.has(r.code)).concat(changed);
 }
 return {...data,results:rows,info:{...data.info,removed_linked_codes:[...removed]}};
}
