import { json } from '../../_lib/auth.js';
import { workerAuthorized } from '../../_lib/booking-spacecloud-sync.js';
import { beginHostCalendar, finishHostCalendar, failHostCalendar, hostCalendarSummary } from '../../_lib/spacecloud-host-calendar.js';
import { refreshCalendarDisplay } from '../../_lib/spacecloud-display.js';
export async function onRequestPost({request,env,waitUntil}){
 if(!workerAuthorized(request,env))return json({ok:false,error:'unauthorized'},401);
 try{
  const text=await request.text();if(text.length>2000000)return json({ok:false,error:'too-large'},413);const b=JSON.parse(text);
  if(b.action==='status')return json({ok:true,calendar:await hostCalendarSummary(env)});
  if(b.action==='begin')return json({ok:true,plan:await beginHostCalendar(env)});
  if(b.action==='sync'){
   const result=await finishHostCalendar(env,b);
   // A completed source audit also prepares the fast admin view without another upstream request.
   try {
    const display=await refreshCalendarDisplay(env,{cacheOnly:true,afterSourceSync:true});
    // Keep fallback iCal fresh even when no admin browser is open. Never hold up
    // the committed source audit or a calendar read while that network work runs.
    const ttl=display.info.refresh_minutes*60000;
    if(typeof waitUntil==='function' && Number.isFinite(ttl) && display.info.rooms.some(r=>Date.now()-r.checked_at>=ttl))
      waitUntil(refreshCalendarDisplay(env).catch(()=>{console.error('calendar-feed-refresh');}));
   }
   catch { console.error('calendar-display-refresh'); }
   return json(result);
  }
  if(b.action==='error'){await failHostCalendar(env,b.observed_at,b.error,b.retry_after_ms);return json({ok:true});}
  return json({ok:false,error:'invalid-action'},400);
 }catch(error){return json({ok:false,error:error.code||'calendar-error'},error.status||503);}
}
