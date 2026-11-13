export const isCalendarLinked = row => /^SC[1-5]-[a-f0-9]{16}$/.test(row.code) && row.channel === 'spacecloud';

// Occupancy state is separate from the paid/refund ledger. Persist a confirmed
// disappearance so a cancelled payment-backed slot cannot reappear after its
// original end time passes. A later successful reappearance restores the slot.
export async function reconcileCalendarLinks(env, snapshots, now, superseded = []) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS spacecloud_calendar_link_state (
    code TEXT PRIMARY KEY, state TEXT NOT NULL, checked_at INTEGER NOT NULL)`).run();
  const removed = new Set(((await env.DB.prepare("SELECT code FROM spacecloud_calendar_link_state WHERE state='removed'").all()).results || []).map(r=>r.code));
  const manual = (await env.DB.prepare(`SELECT code,channel,status,space,date,start_min,end_min,customer_name
    FROM reservations WHERE channel='spacecloud' AND status='confirmed'`).all()).results || [];
  const writes = [];
  for (const row of manual) {
    if (!isCalendarLinked(row)) continue;
    const start = Date.parse(row.date + 'T00:00:00+09:00') + row.start_min * 60000;
    const end = Date.parse(row.date + 'T00:00:00+09:00') + row.end_min * 60000;
    const replaced = superseded.some(e => e.space === row.space && e.date === row.date
      && e.start_min === row.start_min && e.end_min === row.end_min
      && e.customer_name.normalize('NFC').trim() === row.customer_name.normalize('NFC').trim());
    if (end <= now && !replaced && !removed.has(row.code)) continue;
    const source = snapshots.find(s => s.room.space === row.space);
    if (!source?.room.updated_at || source.room.error || source.room.stale) continue;
    const present = source.events.some(e => e.start === start && e.end === end
      && e.title.normalize('NFC').trim() === row.customer_name.normalize('NFC').trim());
    writes.push(env.DB.prepare(`INSERT INTO spacecloud_calendar_link_state(code,state,checked_at) VALUES(?1,?2,?3)
      ON CONFLICT(code) DO UPDATE SET state=excluded.state,checked_at=excluded.checked_at
      WHERE excluded.checked_at>=spacecloud_calendar_link_state.checked_at`)
      .bind(row.code, present ? 'active' : 'removed', source.room.checked_at));
  }
  for (let i = 0; i < writes.length; i += 100) await env.DB.batch(writes.slice(i, i + 100));
  return ((await env.DB.prepare("SELECT code FROM spacecloud_calendar_link_state WHERE state='removed'").all()).results || []).map(r => r.code);
}
