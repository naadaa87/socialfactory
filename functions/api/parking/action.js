import {json,sameOrigin,clean} from '../../_lib/auth.js';
import {ensureParking,parkingOrder,parkingAccess,parkingAction} from '../../_lib/parking.js';
import {runParkingQueue} from '../../_lib/parking-notify.js';
export async function onRequestPost({request,env,waitUntil}){
 if(!sameOrigin(request))return json({ok:false,error:'origin'},403);if(!env.DB)return json({ok:false},503);
 const raw=await request.text();if(raw.length>4096)return json({ok:false},413);let b;try{b=JSON.parse(raw)}catch{return json({ok:false},400)}if(!b||!/^SF[A-Z0-9]{16}$/.test(b.oid||''))return json({ok:false},400);
 await ensureParking(env);if(!(await parkingAccess(request,env,b.oid,clean(b.token,40))))return json({ok:false,error:'forbidden'},403);
 const p=await parkingOrder(env,b.oid);if(!p)return json({ok:false,error:'not-found'},404);
 const r=await parkingAction(env,p,b);if(r.ok&&waitUntil)waitUntil(runParkingQueue(env));return json({...r,ok:!!r.ok},r.status||200);
}
