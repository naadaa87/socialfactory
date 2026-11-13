import { json } from '../../_lib/auth.js';
import { workerAuthorized } from '../../_lib/booking-spacecloud-sync.js';
import { beginHostCalendar, finishHostCalendar, failHostCalendar, hostCalendarSummary } from '../../_lib/spacecloud-host-calendar.js';
export async function onRequestPost({request,env}){
 if(!workerAuthorized(request,env))return json({ok:false,error:'unauthorized'},401);
 try{
  const text=await request.text();if(text.length>2000000)return json({ok:false,error:'too-large'},413);const b=JSON.parse(text);
  if(b.action==='status')return json({ok:true,calendar:await hostCalendarSummary(env)});
  if(b.action==='begin')return json({ok:true,plan:await beginHostCalendar(env)});
  if(b.action==='sync')return json(await finishHostCalendar(env,b));
  if(b.action==='error'){await failHostCalendar(env,b.observed_at,b.error);return json({ok:true});}
  return json({ok:false,error:'invalid-action'},400);
 }catch(error){return json({ok:false,error:error.code||'calendar-error'},error.status||503);}
}
