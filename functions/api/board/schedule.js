import { json } from '../../_lib/auth.js';
import { kstToday } from '../../_lib/admin.js';
import { readBoardDevice } from '../../_lib/board-device.js';
import { readBoard } from '../../_lib/reservation-board.js';
import { loadSpacecloud, mergeCalendarRows } from '../../_lib/spacecloud.js';

export async function onRequestGet({request,env}) {
  try {
    const device=await readBoardDevice(request,env);
    if(!device) return json({ok:false,error:'board-unpaired'},401);
    const board=await readBoard(env,{today:kstToday(),loadExternal:loadSpacecloud,mergeRows:mergeCalendarRows});
    return json({...board,monitor:{name:device.name,expires_at:device.token_until}});
  } catch {return json({ok:false,message:'예약을 확인하지 못했습니다. 관리자에게 문의해 주세요.'},503);}
}
