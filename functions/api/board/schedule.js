import { json } from '../../_lib/auth.js';
import { kstToday } from '../../_lib/admin.js';
import { readBoard } from '../../_lib/reservation-board.js';
import { mergeCalendarRows } from '../../_lib/spacecloud.js';
import { loadCalendarDisplay } from '../../_lib/spacecloud-display.js';

export async function onRequestGet({env,waitUntil}) {
  try {
    // Unlisted visitor display: only the masked, minimal readBoard projection is public.
    // Display the original reservation, excluding verified copies of our own holds.
    // The collector publishes this verified projection after every source audit.
    // Fast monitor polling must not repeat full upstream reads or reconciliation.
    const board=await readBoard(env,{today:kstToday(),
      loadExternal:(env,options)=>loadCalendarDisplay(env,{...options,waitUntil}),mergeRows:mergeCalendarRows});
    return json(board,200,{'X-SF-Board-Name-Format':'20261116-detail-mask'});
  } catch {return json({ok:false,message:'예약을 확인하지 못했습니다. 관리자에게 문의해 주세요.'},503);}
}
