import { calendarRows } from './spacecloud.js';
import { calendarReservationId } from './spacecloud-sales.js';
import { calendarEventIdentity } from './spacecloud-identity.js';

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
  const current = new Set(events.filter(e => !e.cancelled).map(calendarEventIdentity));
  const future = (await env.DB.prepare(`SELECT uid FROM spacecloud_calendar_history
    WHERE space=?1 AND config_hash=?2 AND source='feed' AND end_ms>?3 AND recorded_at<=?3`)
    .bind(space, configHash, now).all()).results || [];
  const deletes = future.filter(e => !current.has(e.uid)).map(e => env.DB.prepare(
    `DELETE FROM spacecloud_calendar_history WHERE space=?1 AND uid=?2 AND config_hash=?3 AND source='feed' AND recorded_at<=?4`
  ).bind(space, e.uid, configHash, now));
  const writes = events.map(e => {
    // Host-added bookings have a calendar UID but no payment reservation ID.
    // Occupancy must be retained independently from the financial ledger.
    const reservationId = calendarReservationId(e.source_url) || '';
    return env.DB.prepare(`INSERT INTO spacecloud_calendar_history
      (space,uid,reservation_id,config_hash,start_ms,end_ms,title,source,recorded_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
      ON CONFLICT(space,uid) DO UPDATE SET reservation_id=excluded.reservation_id,
      config_hash=excluded.config_hash,start_ms=excluded.start_ms,end_ms=excluded.end_ms,
      title=excluded.title,recorded_at=excluded.recorded_at,source=excluded.source
      WHERE source IN ('feed','feed_cancelled','feed_superseded') AND recorded_at<=excluded.recorded_at`)
      .bind(space, calendarEventIdentity(e), reservationId, configHash, e.start, e.end, e.title,
        e.cancelled ? 'feed_cancelled' : 'feed', now);
  });
  const statements = deletes.concat(writes);
  for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
}

// A feed omits completed bookings, so absence alone cannot delete history.
// A live replacement is evidence: payment IDs survive time/room changes; manual
// bookings have no stable upstream ID, so only overlapping slots with the same
// room, Korean date and title can be reconciled automatically. Separate sessions
// and two entries explicitly present in the same snapshot must remain separate.
export async function reconcileCalendarHistory(env, snapshots) {
  await ensureCalendarHistory(env);
  const healthy = snapshots.filter(s => s.room.updated_at && !s.room.error && !s.room.stale);
  const current = healthy.flatMap(s => s.events.filter(e => !e.cancelled)
    .map(event => ({ event, space:s.room.space, at:s.room.updated_at })));
  const records = (await env.DB.prepare(`SELECT * FROM spacecloud_calendar_history
    WHERE source IN ('feed','host_verified')`).all()).results || [];
  const day = ms => Math.floor((ms + KST) / 86400000);
  const writes = [];
  for (const h of records) {
    const own = healthy.find(s => s.room.space === h.space && s.hash === h.config_hash);
    if (!own || h.recorded_at > own.room.updated_at) continue;
    const old = { start:h.start_ms, end:h.end_ms, title:h.title,
      source_url:h.reservation_id ? `https://partner.spacecloud.kr/reservation/${h.reservation_id}` : '' };
    if (own.events.some(e => !e.cancelled && calendarEventIdentity(e) === calendarEventIdentity(old))) continue;
    const replacement = current.find(({event:e,space,at}) => at >= h.recorded_at && (
      h.reservation_id ? calendarReservationId(e.source_url) === h.reservation_id
        : !calendarReservationId(e.source_url) && space === h.space
          && e.title.normalize('NFC').trim() === h.title.normalize('NFC').trim()
          && day(e.start) === day(h.start_ms) && e.start < h.end_ms && h.start_ms < e.end
    ));
    if (!replacement) continue;
    writes.push(env.DB.prepare(`UPDATE spacecloud_calendar_history
      SET source=CASE WHEN source='host_verified' THEN 'host_superseded' ELSE 'feed_superseded' END,recorded_at=?4
      WHERE space=?1 AND uid=?2 AND config_hash=?3 AND source IN ('feed','host_verified') AND recorded_at<=?4`)
      .bind(h.space,h.uid,h.config_hash,replacement.at));
  }
  for (let i=0;i<writes.length;i+=100) await env.DB.batch(writes.slice(i,i+100));
  const removed = (await env.DB.prepare("SELECT * FROM spacecloud_calendar_history WHERE source IN ('feed_superseded','host_superseded')").all()).results || [];
  const rows = [];
  for (const h of removed) {
    if (!snapshots.some(s => s.room.space === h.space && s.hash === h.config_hash)) continue;
    rows.push(...await calendarRows([{start:h.start_ms,end:h.end_ms,title:h.title,
      source_url:h.reservation_id ? `https://partner.spacecloud.kr/reservation/${h.reservation_id}` : ''}],h.space,h.recorded_at));
  }
  return rows;
}

export async function historicalCalendarRows(env, feeds, current, now, { from, to } = {}) {
  await ensureCalendarHistory(env);
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_spacecloud_history_end ON spacecloud_calendar_history(end_ms)').run();
  const hashes = new Map(feeds.map(f => [f.space, f.hash]));
  const where = ['h.end_ms<=?1'];
  const args = [now];
  if (from) { args.push(Date.parse(from + 'T00:00:00Z') - KST); where.push(`h.end_ms>?${args.length}`); }
  if (to) { args.push(Date.parse(to + 'T00:00:00Z') + 86400000 - KST); where.push(`h.start_ms<?${args.length}`); }
  const records = (await env.DB.prepare(`SELECT h.* FROM spacecloud_calendar_history h
    WHERE ${where.join(' AND ')} ORDER BY h.start_ms DESC LIMIT 6000`).bind(...args).all()).results || [];
  const active = new Set(current.map(r => r.code));
  // Reservation IDs also deduplicate one-time verified backfills with live feeds.
  // Never group host-added entries by their absent payment ID.
  const paymentKey = r => {
    const id = calendarReservationId(r.source_url);
    return id ? `${id}|${r.space}|${r.date}` : null;
  };
  const linked = new Set(current.map(paymentKey).filter(Boolean));
  const output = [];
  const eventFor = h => ({ uid:h.uid, start:h.start_ms, end:h.end_ms,
    title:h.title, source_url:h.reservation_id ? `https://partner.spacecloud.kr/reservation/${h.reservation_id}` : '' });
  const cancelled = new Set(records.filter(h => ['feed_cancelled','host_cancelled'].includes(h.source)
    && (h.source === 'host_cancelled' || hashes.get(h.space) === h.config_hash))
    .map(h => `${h.space}|${calendarEventIdentity(eventFor(h))}`));
  for (const h of records) {
    if (!['feed','host_verified'].includes(h.source)) continue;
    if (h.source === 'feed' && hashes.get(h.space) !== h.config_hash) continue;
    const event = eventFor(h);
    if (cancelled.has(`${h.space}|${calendarEventIdentity(event)}`)) continue;
    const rows = await calendarRows([event], h.space, h.recorded_at, { from, to });
    for (const row of rows) {
      const key = paymentKey(row);
      if (!active.has(row.code) && (!key || !linked.has(key))) {
        output.push({ ...row, historical: true, history_source:h.source });
        active.add(row.code);
        if (key) linked.add(key);
      }
    }
  }
  return output;
}

export function historicalInterval(date, startMin, endMin) {
  const midnight = Date.parse(`${date}T00:00:00Z`) - KST;
  return { start: midnight + startMin * 60000, end: midnight + endMin * 60000 };
}
