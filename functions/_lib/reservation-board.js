// Only visitor-safe fields cross the display API boundary. Never return raw calendar titles.
import { ROOM_KEYS, addDaysIso, isIsoDate } from './admin.js';

import { reservationBoardName, validBoardName } from './reservation-board-name.js';
export { displayName } from './reservation-board-name.js';

export function boardRows(rows, today) {
  const start = Date.parse(today + 'T00:00:00+09:00'), end = start + 86400000;
  const seen = new Set();
  return rows.flatMap(row => {
    if (row.status !== 'confirmed' || !ROOM_KEYS.includes(row.space) || !isIsoDate(row.date)) return [];
    if (!Number.isFinite(row.start_min) || !Number.isFinite(row.end_min) || row.start_min < 0 || row.end_min <= row.start_min) return [];
    const base = Date.parse(row.date + 'T00:00:00+09:00');
    const from = base + row.start_min * 60000, to = base + row.end_min * 60000;
    if (from >= end || to <= start) return [];
    const key = [row.code, row.space, from, to].join('|');
    if (seen.has(key)) return [];
    seen.add(key);
    // Calendar/manual names may end with a private parenthetical annotation.
    // Use the same name-only masking as detail imports, and let an uninformative
    // cached label fall back to the reservation's own name.
    const name = row.board_name !== '예약 고객' && validBoardName(row.board_name)
      ? row.board_name : reservationBoardName(row.customer_name) || '예약 고객';
    return [{ room: row.space, name, start: Math.max(start, from), end: Math.min(end, to),
      continued: from < start, continues: to > end }];
  }).sort((a, b) => a.start - b.start || a.room.localeCompare(b.room));
}

export async function readBoard(env, { today, now = Date.now(), loadExternal, mergeRows }) {
  // Fetch yesterday too: manual bookings can finish after midnight (end_min > 1440).
  const manual = (await env.DB.prepare(`SELECT code,status,space,date,start_min,end_min,customer_name,channel
    FROM reservations WHERE status='confirmed' AND date BETWEEN ?1 AND ?2
    ORDER BY date,start_min,id LIMIT 1001`).bind(addDaysIso(today, -1), today).all()).results || [];
  if (manual.length > 1000) throw new Error('board-limit');
  const external = await loadExternal(env, { from: today, to: today, now });
  const rows = mergeRows(manual, external.results || [], { info: external.info, now });
  return { ok: true, date: today, generated_at: now, refresh_seconds: 5,
    reservations: boardRows(rows, today),
    rooms: ROOM_KEYS.map(id => {
      const state = external.info?.rooms?.find(r => r.space === id);
      return { id, calendar: !state ? 'missing' : state.error || state.stale ? 'stale' : 'ok',
        checked_at: state?.checked_at || null, updated_at: state?.updated_at || null };
    }),
    // No identifiers or private feed URLs are returned in diagnostics either.
    unassigned: manual.filter(r => !ROOM_KEYS.includes(r.space) && r.date === today).length };
}
