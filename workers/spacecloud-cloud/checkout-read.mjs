import { collectHostCalendarAPI } from './calendar.mjs';
import { ROOMS } from '../../integrations/spacecloud-worker/spacecloud-ui.mjs';
import { inspectRecords, planJob } from '../../integrations/spacecloud-worker/safety.mjs';
import { readPublicAvailability } from '../../integrations/spacecloud-worker/public-availability.mjs';

const priorDate=date=>new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);

// A fast checkout can only prove an existing hold. A mismatch or an unavailable
// API falls back to the normal browser verifier without modifying a reservation.
export async function readCheckoutHold(state,scope,{fetcher=fetch,now=Date.now}={}) {
  const job=planJob({...scope,action:'verify',job_id:'checkout-read',lease_token:'checkout-read',replaces:[]});
  const {room,marker,segments}=job;
  const months=new Set(segments.flatMap(segment=>[segment.date,priorDate(segment.date)]).map(date=>date.slice(0,7)));
  const scopes=[...months].map(month=>({space:room,product_id:String(ROOMS[room].product),month}));
  const deadline=AbortSignal.timeout(5500);
  const get=async (url,options)=>{
    const headers=new Headers(options.headers);
    headers.set('Cache-Control','no-cache, no-store');
    headers.set('Pragma','no-cache');
    const response=await fetcher(url,{...options,headers,cache:'no-store',signal:AbortSignal.any([options.signal,deadline])});
    const age=response.headers.get('age');
    if(response.redirected || (response.url && response.url!==url) || (age!==null && age!=='0') ||
        /^(STALE|UPDATING)$/i.test(response.headers.get('cf-cache-status') || '') ||
        /\b11[01]\b/.test(response.headers.get('warning') || ''))throw new Error('checkout-calendar-stale');
    return response;
  };
  const observed_at=now();
  const [host,...publicDays]=await Promise.all([
    collectHostCalendarAPI(state,{scopes},{fetcher:get,checkoutMarker:marker}),
    ...segments.map(({date})=>readPublicAvailability({room,date},{fetcher:get,timeoutMs:5500}))
  ]);
  if(!host || deadline.aborted)return null;
  const records=host.snapshots.flatMap(snapshot=>snapshot.events.map(event=>({
    date:event.date,start_min:event.start_min,end_min:event.end_min,
    name:event.title,memo:event.memo,manual:event.kind!=='reservation'
  })));
  for(const [index,segment] of segments.entries()){
    const {own,conflicts}=inspectRecords(records,segment);
    const day=publicDays[index];
    if(!own || conflicts.length || (day.day_available && !day.hours.slice(segment.start_min/60,segment.end_min/60).every(hour=>hour===false)))return null;
  }
  return {room,marker,date:job.date,start_min:job.start_min,end_min:job.end_min,segments,observed_at,
    verified_blocked:true,no_conflicts:true};
}
