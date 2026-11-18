import { json } from '../../_lib/auth.js';
import { kstToday } from '../../_lib/admin.js';
import { readBoard } from '../../_lib/reservation-board.js';
import { loadSpacecloudForDisplay, mergeCalendarRows } from '../../_lib/spacecloud.js';

export async function onRequestGet({env}) {
  try {
    // Unlisted visitor display: only the masked, minimal readBoard projection is public.
    // Display the original reservation, excluding verified copies of our own holds.
    const board=await readBoard(env,{today:kstToday(),loadExternal:loadSpacecloudForDisplay,mergeRows:mergeCalendarRows});
    return json(board,200,{'X-SF-Board-Name-Format':'20261116-detail-mask'});
  } catch {return json({ok:false,message:'예약을 확인하지 못했습니다. 관리자에게 문의해 주세요.'},503);}
}
