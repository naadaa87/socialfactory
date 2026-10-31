import { json } from '../../_lib/auth.js';
import { kstToday } from '../../_lib/admin.js';
import { readBoard } from '../../_lib/reservation-board.js';
import { loadSpacecloud, mergeCalendarRows } from '../../_lib/spacecloud.js';

export async function onRequestGet({env}) {
  try {
    // Unlisted visitor display: only the masked, minimal readBoard projection is public.
    const board=await readBoard(env,{today:kstToday(),loadExternal:loadSpacecloud,mergeRows:mergeCalendarRows});
    return json(board);
  } catch {return json({ok:false,message:'예약을 확인하지 못했습니다. 관리자에게 문의해 주세요.'},503);}
}
