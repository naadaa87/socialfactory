/** SpaceCloud iCal calendars. Feed URLs stay in SPACECLOUD_ICAL_FEEDS (server secret).
 * Snapshots are separate from reservations: no customer/payment data is invented.
 * Refresh on authenticated reads (5 minute cache) or explicit admin refresh.
 */
import { sha256Hex } from './auth.js';
import { historicalCalendarRows, rememberFeedEvents } from './spacecloud-history.js';

const TTL = 5 * 60 * 1000;
const DAY = 86400000, KST = 9 * 3600000;
const MAX_BYTES = 2 * 1024 * 1024;
const TABLE = `CREATE TABLE IF NOT EXISTS spacecloud_calendar_cache (
  space TEXT PRIMARY KEY, config_hash TEXT NOT NULL, checked_at INTEGER NOT NULL,
  updated_at INTEGER, error TEXT, events_json TEXT NOT NULL DEFAULT '[]')`;
const SETTINGS = `CREATE TABLE IF NOT EXISTS spacecloud_calendar_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL, updated_at INTEGER NOT NULL)`;
const pending = new Map();

export function validateFeedConfig(config) {
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('feed-config');
  return Object.entries(config).map(([space, url]) => {
    if (!/^r[1-5]$/.test(space) || typeof url !== 'string') throw new Error('feed-config');
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'api.spacecloud.kr' || u.port || u.username || u.password || u.hash
      || u.pathname !== '/partner/reservations/ical' || !/^\d+$/.test(u.searchParams.get('product_id') || '')
      || !/^[a-zA-Z0-9_-]+$/.test(u.searchParams.get('ical_uid') || '')
      || [...u.searchParams.keys()].length !== 2) throw new Error('feed-config');
    return { space, url: u.href };
  });
}

const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function configKey(env, source) {
  const secret = source === 'session' ? env.SESSION_SECRET : env.ADMIN_KEY;
  if (!secret) throw new Error('missing-config-key');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('spacecloud-config-v1|' + secret));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function readFeedConfig(env) {
  await env.DB.prepare(SETTINGS).run();
  const row = await env.DB.prepare('SELECT payload FROM spacecloud_calendar_settings WHERE id = 1').first();
  if (row) {
    const data = JSON.parse(row.payload);
    if (data.v !== 1) throw new Error('invalid-config');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(data.iv) },
      await configKey(env, data.key_source), fromBase64(data.cipher));
    return validateFeedConfig(JSON.parse(new TextDecoder().decode(plain)));
  }
  return env.SPACECLOUD_ICAL_FEEDS ? validateFeedConfig(JSON.parse(env.SPACECLOUD_ICAL_FEEDS)) : [];
}
export async function saveFeedConfig(env, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('feed-config');
  let previous;
  try { previous = Object.fromEntries((await readFeedConfig(env)).map(f => [f.space, f.url])); }
  catch {
    if (!['r1', 'r2', 'r3', 'r4', 'r5'].every(room => typeof changes[room] === 'string' && changes[room].trim())) throw new Error('feed-config');
    previous = {};
  }
  const next = { ...previous };
  for (const [space, value] of Object.entries(changes)) {
    if (typeof value !== 'string' || !/^r[1-5]$/.test(space)) throw new Error('feed-config');
    if (value.trim()) next[space] = value.trim();
  }
  const feeds = validateFeedConfig(next);
  if (!feeds.length) throw new Error('feed-config');
  const source = env.SESSION_SECRET ? 'session' : 'admin', iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await configKey(env, source),
    new TextEncoder().encode(JSON.stringify(Object.fromEntries(feeds.map(f => [f.space, f.url])))));
  const payload = JSON.stringify({ v: 1, key_source: source, iv: toBase64(iv), cipher: toBase64(new Uint8Array(cipher)) });
  await env.DB.prepare(`INSERT INTO spacecloud_calendar_settings (id, payload, updated_at) VALUES (1, ?1, ?2)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`).bind(payload, Date.now()).run();
}

function unescapeText(value) {
  return value.replace(/\\([nN,;\\])/g, (_, c) => /n/i.test(c) ? '\n' : c).replace(/\u0000/g, '');
}
function parseDate(prop) {
  if (!prop) throw new Error('missing-time');
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(prop.value);
  if (!m || (prop.params.VALUE === 'DATE' && m[4] !== undefined)) throw new Error('invalid-time');
  const [, year, month, day, hour = '00', minute = '00', second = '00', utc] = m;
  const tz = prop.params.TZID;
  if (tz && !['Asia/Seoul', 'UTC', 'Etc/UTC'].includes(tz)) throw new Error('unsupported-timezone');
  const wall = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const d = new Date(wall);
  if (d.getUTCFullYear() !== +year || d.getUTCMonth() !== +month - 1 || d.getUTCDate() !== +day
    || +hour > 23 || +minute > 59 || +second !== 0) throw new Error('invalid-time');
  return wall - (utc || tz === 'UTC' || tz === 'Etc/UTC' ? 0 : KST);
}
function safeEventUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port
      && ['spacecloud.kr', 'www.spacecloud.kr', 'partner.spacecloud.kr'].includes(u.hostname) ? u.href : '';
  } catch { return ''; }
}

/** Fail the whole snapshot on malformed/unsupported events, retaining the previous good data. */
export function parseCalendar(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES) throw new Error('invalid-calendar');
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').trim().split('\n');
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines[lines.length - 1] !== 'END:VCALENDAR') throw new Error('invalid-calendar');
  const events = new Map(); let props = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { if (props) throw new Error('invalid-calendar'); props = {}; continue; }
    if (line === 'END:VEVENT') {
      if (!props || !props.UID || !props.UID.value || props.UID.value.length > 500) throw new Error('invalid-event');
      const uid = unescapeText(props.UID.value);
      if (events.has(uid)) throw new Error('duplicate-uid');
      if (props.RRULE || props.RDATE || props.EXDATE || props['RECURRENCE-ID']) throw new Error('unsupported-recurrence');
      const start = parseDate(props.DTSTART), end = parseDate(props.DTEND);
      if (!(end > start) || end - start > 366 * DAY) throw new Error('invalid-range');
      events.set(uid, { uid, start, end, title: unescapeText(props.SUMMARY?.value || '스페이스클라우드 일정').slice(0, 200),
        source_url: safeEventUrl(props.URL?.value || ''), cancelled: props.STATUS?.value === 'CANCELLED' });
      if (events.size > 5000) throw new Error('too-many-events');
      props = null; continue;
    }
    if (!props) continue;
    const colon = line.indexOf(':'); if (colon < 1) throw new Error('invalid-event');
    const [name, ...parameters] = line.slice(0, colon).split(';');
    // Only the fields needed by the calendar are retained. Never persist feed tokens.
    if (!['UID', 'DTSTART', 'DTEND', 'SUMMARY', 'URL', 'STATUS', 'RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID'].includes(name)) continue;
    if (props[name]) throw new Error('duplicate-property');
    const params = {};
    for (const p of parameters) { const i = p.indexOf('='); if (i > 0) params[p.slice(0, i)] = p.slice(i + 1).replace(/^"|"$/g, ''); }
    props[name] = { value: line.slice(colon + 1), params };
  }
  if (props) throw new Error('invalid-calendar');
  return [...events.values()].filter(e => !e.cancelled);
}

export async function calendarRows(events, space, updatedAt, { from, to } = {}) {
  const rows = [];
  const fromDay = from ? Math.floor(Date.parse(from + 'T00:00:00Z') / DAY) : -Infinity;
  const toDay = to ? Math.floor(Date.parse(to + 'T00:00:00Z') / DAY) : Infinity;
  for (const event of events) {
    const first = Math.max(Math.floor((event.start + KST) / DAY), fromDay);
    const last = Math.min(Math.ceil((event.end + KST) / DAY), toDay + 1);
    for (let day = first; day < last; day++) {
      if (rows.length >= 6000) throw new Error('too-many-events');
      const date = new Date(day * DAY).toISOString().slice(0, 10);
      rows.push({ code: 'SC' + space.slice(1) + '-' + (await sha256Hex(event.uid + '|' + date)).slice(0, 16), external: true,
        status: 'confirmed', space, date, start_min: Math.max(0, (event.start + KST - day * DAY) / 60000),
        end_min: Math.min(1440, (event.end + KST - day * DAY) / 60000), customer_name: event.title,
        phone: '', people: null, purpose: '', channel: 'spacecloud', amount: null, pay_method: 'spacecloud', pay_status: 'unknown',
        refund_amount: 0, source_url: event.source_url, source_start: event.start, source_end: event.end,
        synced_at: updatedAt, memo: '', inquiry_ref: '' });
    }
  }
  return rows;
}

async function readBody(response) {
  if (!response.ok) throw new Error('HTTP ' + response.status);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('feed-size');
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > MAX_BYTES) { await reader.cancel(); throw new Error('feed-size'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function refreshRoom(env, feed, force, fetcher, now) {
  const hash = await sha256Hex(feed.url);
  let cached = await env.DB.prepare('SELECT * FROM spacecloud_calendar_cache WHERE space = ?1').bind(feed.space).first();
  if (!cached || cached.config_hash !== hash) cached = { events_json: '[]', updated_at: null, checked_at: 0 };
  if (force || now - cached.checked_at >= TTL) {
    const key = feed.space + ':' + hash;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      let snapshot;
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetcher(feed.url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/calendar, text/plain', 'User-Agent': 'SocialFactory-calendar-check' } });
        const events = parseCalendar(await readBody(response));
        // Validate segmentation and size before replacing a previously good snapshot.
        await calendarRows(events, feed.space, now);
        await rememberFeedEvents(env, feed.space, hash, events, now);
        snapshot = { events_json: JSON.stringify(events), checked_at: now, updated_at: now, error: null };
      } catch (error) {
        // Avoid logging the URL: it contains a bearer-like private feed token.
        const message = String(error?.message || '');
        const detail = /^HTTP \d{3}$/.test(message) ? '스페이스클라우드 응답 오류 (' + message + ')'
          : error?.name === 'AbortError' ? '스페이스클라우드 응답 시간이 초과되었습니다'
          : /^(invalid|missing|unsupported|duplicate|too-many|feed-size)/.test(message) ? '캘린더 데이터 형식을 확인해 주세요'
          : '스페이스클라우드 피드를 확인하지 못했습니다';
        snapshot = { ...cached, checked_at: now, error: detail + '. 마지막 정상 일정을 표시합니다.' };
      } finally { clearTimeout(timeout); }
      await env.DB.prepare(`INSERT INTO spacecloud_calendar_cache (space, config_hash, checked_at, updated_at, error, events_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(space) DO UPDATE SET config_hash=excluded.config_hash,
        checked_at=excluded.checked_at, updated_at=excluded.updated_at, error=excluded.error, events_json=excluded.events_json
        WHERE excluded.checked_at >= spacecloud_calendar_cache.checked_at`)
        .bind(feed.space, hash, now, snapshot.updated_at, snapshot.error, snapshot.events_json).run();
      return snapshot;
    })();
    pending.set(key, task);
    try { cached = await task; } finally { pending.delete(key); }
  }
  return cached;
}

export async function loadSpacecloud(env, { force = false, fetcher = fetch, now = Date.now(), from, to } = {}) {
  let feeds;
  try { feeds = await readFeedConfig(env); } catch { return { results: [], info: { configured: false, error: '캘린더 연결 설정을 확인해 주세요.', rooms: [] } }; }
  if (!feeds.length) return { results: [], info: { configured: false, rooms: [] } };
  try {
    await env.DB.prepare(TABLE).run();
    const snapshots = await Promise.all(feeds.map(async feed => {
      const cached = await refreshRoom(env, feed, force, fetcher, now);
      const events = JSON.parse(cached.events_json);
      return { rows: await calendarRows(events, feed.space, cached.updated_at, { from, to }), room: {
        space: feed.space, count: events.length, checked_at: cached.checked_at, updated_at: cached.updated_at,
        error: cached.error || null, stale: !!cached.error || !cached.updated_at || now - cached.updated_at >= TTL * 2 } };
    }));
    const current = snapshots.flatMap(x => x.rows);
    const history = await historicalCalendarRows(env,
      await Promise.all(feeds.map(async f => ({ space:f.space, hash:await sha256Hex(f.url) }))), current, now, { from, to });
    return { results: current.concat(history), info: { configured: true, rooms: snapshots.map(x => x.room), refresh_minutes: TTL / 60000 } };
  } catch { return { results: [], info: { configured: true, error: '외부 일정을 읽지 못했습니다. 다시 불러와 주세요.', rooms: [] } }; }
}

export function filterExternal(rows, params) {
  const get = key => (params.get(key) || '').trim();
  if (get('code') || get('status') === 'cancelled' || get('pstatus') || (get('pay') && get('pay') !== 'spacecloud')) return [];
  const q = get('q').toLowerCase().replace(/-/g, '');
  return rows.filter(r => (!/^\d{4}-\d{2}-\d{2}$/.test(get('from')) || r.date >= get('from'))
    && (!/^\d{4}-\d{2}-\d{2}$/.test(get('to')) || r.date <= get('to')) && (!get('space') || r.space === get('space'))
    && (!q || [r.customer_name, r.code].join(' ').toLowerCase().replace(/-/g, '').includes(q)));
}

/** A manually recorded SpaceCloud booking already covering the slot is shown once. */
export function mergeCalendarRows(manual, external) {
  const recorded = manual.filter(r => r.status === 'confirmed' && r.channel === 'spacecloud');
  const absolute = r => ({ start: Date.parse(r.date + 'T00:00:00Z') + r.start_min * 60000,
    end: Date.parse(r.date + 'T00:00:00Z') + r.end_min * 60000 });
  return manual.concat(external.filter(e => {
    const x = absolute(e);
    return !recorded.some(r => { const y = absolute(r); return r.space === e.space && y.start <= x.start && y.end >= x.end; });
  })).sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min || a.code.localeCompare(b.code));
}
