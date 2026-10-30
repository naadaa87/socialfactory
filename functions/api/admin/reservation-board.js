import { adminGate, kstToday } from '../../_lib/admin.js';
import { json } from '../../_lib/auth.js';
import { readBoard } from '../../_lib/reservation-board.js';
import { loadSpacecloud, mergeCalendarRows } from '../../_lib/spacecloud.js';

// Prototype: same admin authentication as the existing system, no public booking feed.
// A dedicated monitor credential can be added separately before unattended operation.
export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  try {
    return json(await readBoard(env, { today: kstToday(), loadExternal: loadSpacecloud, mergeRows: mergeCalendarRows }));
  } catch {
    return json({ ok: false, message: '예약을 확인하지 못했습니다. 관리자에게 문의해 주세요.' }, 503);
  }
}
