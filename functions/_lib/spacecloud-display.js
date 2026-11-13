/** The server collector prepares occupancy once; calendar reads never wait on upstream iCal. */
import { sha256Hex } from './auth.js';
import { readFeedConfig, loadSpacecloudForDisplay } from './spacecloud.js';

const TABLE = `CREATE TABLE IF NOT EXISTS spacecloud_calendar_display (
  id INTEGER PRIMARY KEY CHECK(id=1), config_hash TEXT NOT NULL,
  built_at INTEGER NOT NULL, payload TEXT NOT NULL)`;
const pending = new WeakMap();
const fingerprint = feeds => sha256Hex(JSON.stringify(feeds));

export async function publishCalendarDisplay(env, data, feeds, builtAt) {
  if (data.info.error || (data.info.configured && !data.info.rooms.length)) return;
  await env.DB.prepare(TABLE).run();
  await env.DB.prepare(`INSERT INTO spacecloud_calendar_display(id,config_hash,built_at,payload)
    VALUES(1,?1,?2,?3) ON CONFLICT(id) DO UPDATE SET config_hash=excluded.config_hash,
    built_at=excluded.built_at,payload=excluded.payload WHERE excluded.built_at>=built_at`)
    .bind(await fingerprint(feeds),builtAt,JSON.stringify(data)).run();
}

export async function invalidateCalendarDisplay(env) {
  try { await env.DB.prepare('DELETE FROM spacecloud_calendar_display WHERE id=1').run(); }
  catch (error) { if (!/no such table/i.test(error.message)) throw error; }
}

export function refreshCalendarDisplay(env, options = {}) {
  if (pending.has(env.DB)) {
    const previous = pending.get(env.DB);
    // Explicit refreshes and a newly committed source audit must build after older work.
    if (options.force || options.afterSourceSync)
      return previous.catch(() => {}).then(() => refreshCalendarDisplay(env,options));
    return previous;
  }
  // Always build the complete projection, never a single user's selected month.
  const task = loadSpacecloudForDisplay(env, {
    force: options.force, fetcher: options.fetcher, now: options.now, cacheOnly: options.cacheOnly
  });
  pending.set(env.DB,task);
  task.finally(() => { if (pending.get(env.DB) === task) pending.delete(env.DB); }).catch(() => {});
  return task;
}

export async function loadCalendarDisplay(env, { from, to, waitUntil } = {}) {
  let saved, feeds;
  try {
    [saved,feeds] = await Promise.all([
      env.DB.prepare('SELECT * FROM spacecloud_calendar_display WHERE id=1').first(),readFeedConfig(env)
    ]);
  } catch { /* Initial deployment/configuration falls back to a full verified build. */ }
  let data;
  if (saved && feeds && saved.config_hash === await fingerprint(feeds)) {
    try { data = JSON.parse(saved.payload); if (!Array.isArray(data.results) || !data.info) data = null; } catch {}
    // A collector outage never erases the last good schedule. Refresh off the response path.
    if (data && Date.now()-saved.built_at > 15000 && typeof waitUntil === 'function')
      waitUntil(refreshCalendarDisplay(env).catch(() => {}));
  }
  if (!data) data = await refreshCalendarDisplay(env);
  return { ...data, results: data.results.filter(row => (!from || row.date >= from) && (!to || row.date <= to)) };
}
