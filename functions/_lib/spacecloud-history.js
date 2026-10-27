import { calendarRows } from './spacecloud.js';
import { calendarReservationId, ensureSpacecloudSales } from './spacecloud-sales.js';

const TABLE = `CREATE TABLE IF NOT EXISTS spacecloud_calendar_history (
  space TEXT NOT NULL, uid TEXT NOT NULL, reservation_id TEXT NOT NULL,
  config_hash TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  title TEXT NOT NULL, source TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  PRIMARY KEY (space, uid))`;
const KST = 9 * 3600000;

export async function ensureCalendarHistory(env) {
  await env.DB.prepare(TABLE).run();
}

export async function rememberFeedEvents(env, space, configHash, events, now) {
  await ensureCalendarHistory(env);
  const current = new Set(events.map(e => e.uid));
  const future = (await env.DB.prepare(`SELECT uid FROM spacecloud_calendar_history
    WHERE space=?1 AND config_hash=?2 AND source='feed' AND end_ms>?3`)
    .bind(space, configHash, now).all()).results || [];
  const deletes = future.filter(e => !current.has(e.uid)).map(e => env.DB.prepare(
    `DELETE FROM spacecloud_calendar_history WHERE space=?1 AND uid=?2 AND config_hash=?3 AND source='feed'`
  ).bind(space, e.uid, configHash));
  const writes = events.map(e => {
    const reservationId = calendarReservationId(e.source_url);
    if (!reservationId) return null;
    return env.DB.prepare(`INSERT INTO spacecloud_calendar_history
      (space,uid,reservation_id,config_hash,start_ms,end_ms,title,source,recorded_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,'feed',?8)
      ON CONFLICT(space,uid) DO UPDATE SET reservation_id=excluded.reservation_id,
      config_hash=excluded.config_hash,start_ms=excluded.start_ms,end_ms=excluded.end_ms,
      title=excluded.title,recorded_at=excluded.recorded_at
      WHERE source='feed'`)
      .bind(space, e.uid, reservationId, configHash, e.start, e.end, e.title, now);
  }).filter(Boolean);
  const statements = deletes.concat(writes);
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
}

export async function historicalCalendarRows(env, feeds, current, now, { from, to } = {}) {
  await ensureCalendarHistory(env);
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_spacecloud_history_end ON spacecloud_calendar_history(end_ms)').run();
  await ensureSpacecloudSales(env);
  const hashes = new Map(feeds.map(f => [f.space, f.hash]));
  const where = ['h.end_ms<=?1'];
  const args = [now];
  if (from) { args.push(Date.parse(from + 'T00:00:00Z') - KST); where.push(`h.end_ms>?${args.length}`); }
  if (to) { args.push(Date.parse(to + 'T00:00:00Z') + 86400000 - KST); where.push(`h.start_ms<?${args.length}`); }
  const records = (await env.DB.prepare(`SELECT h.* FROM spacecloud_calendar_history h
    INNER JOIN spacecloud_sales s ON s.reservation_id=h.reservation_id
    WHERE ${where.join(' AND ')} ORDER BY h.start_ms DESC LIMIT 6000`).bind(...args).all()).results || [];
  const active = new Set(current.map(r => `${calendarReservationId(r.source_url)}|${r.space}|${r.date}`));
  const output = [];
  for (const h of records) {
    if (h.source === 'feed' && hashes.get(h.space) !== h.config_hash) continue;
    const rows = await calendarRows([{ uid:h.uid, start:h.start_ms, end:h.end_ms,
      title:h.title, source_url:`https://partner.spacecloud.kr/reservation/${h.reservation_id}` }], h.space, h.recorded_at, { from, to });
    for (const row of rows) {
      const key = `${h.reservation_id}|${row.space}|${row.date}`;
      if (!active.has(key)) { output.push({ ...row, historical: true, history_source:h.source }); active.add(key); }
    }
  }
  return output;
}

export function historicalInterval(date, startMin, endMin) {
  const midnight = Date.parse(`${date}T00:00:00Z`) - KST;
  return { start: midnight + startMin * 60000, end: midnight + endMin * 60000 };
}
