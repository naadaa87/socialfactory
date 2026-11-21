/**
 * 모임 지원 — 모임 초대장 · 룸 가이드(와이파이) 공통 코드 (/api/meet/*)
 * - 모임 초대장: 확정된 예약(예약번호 + 조회 링크)이나 관리자가 만듭니다. 참석자는 가입 없이 이름이나 별명으로 참석 여부를 남깁니다.
 * - 룸 가이드: 방마다 붙이는 QR(방 키 포함)로 열면 그 공간의 와이파이를 보여 줍니다. 키 없이 열면 와이파이는 보이지 않습니다.
 * 이 폴더(_lib)는 주소로 열리지 않는 내부 모듈입니다.
 */
import '../../js/booking-rates.js';
import { json, clean, sameOrigin, ipHashOf, randomToken, safeEqual } from './auth.js';
import { paymentContext } from '../api/booking/payment-status.js';

export const SITE = 'https://socialfactory.co.kr';
export const PLACE = {
  name: '소셜팩토리 건대',
  address: '서울 광진구 화양동 10-1 한아름건물 4층',
  road: '서울 광진구 능동로13길 39',
  building: '한아름건물 4층',
  transit: '지하철 2 · 7호선 건대입구역에서 걸어올 수 있습니다.'
};
const RATES = globalThis.SF_BOOKING_RATES || { rooms: {} };
const room = (n, gear, screen, way) => ({ kind: 'room', name: `${n}번룸`, sub: `강의실${n}`, max: RATES.rooms['r' + n]?.max || null, gear, screen, way });
/** 룸 가이드를 붙이는 공간. way 는 4층 주출입구 기준 길 안내입니다(현장 안내 화면과 같은 기준). */
export const SPACES = {
  r1: room(1, '대형 모니터 · 칠판', 'monitor', '4층 주출입구에서 왼쪽 복도로 들어가세요. 층 안내도 아래쪽 가운데 방입니다.'),
  r2: room(2, '빔프로젝터 · 칠판', 'projector', '4층 주출입구에서 왼쪽 복도로 들어가세요. 층 안내도 왼쪽 아래 방입니다.'),
  r3: room(3, '대형 모니터 · 칠판 · 화이트보드', 'monitor', '4층 주출입구에서 왼쪽 복도로 들어가세요. 층 안내도 왼쪽 가운데 방입니다.'),
  r4: room(4, '빔프로젝터 · 칠판', 'projector', '4층 주출입구에서 왼쪽 복도로 들어가세요. 층 안내도 왼쪽 맨 위 방입니다.'),
  r5: room(5, '빔프로젝터 · 칠판', 'projector', '4층 주출입구에서 오른쪽으로 가세요. 휴게 공간 옆 방입니다.'),
  coworking: { kind: 'coworking', name: '코워킹 · 스터디카페', sub: '24시간 좌석', max: null },
  lounge: { kind: 'lounge', name: '휴게 · 대기 공간', sub: '출입구 옆', max: null },
  office: { kind: 'office', name: '독립사무실', sub: 'A · B · C · D호', max: null }
};
export const ROOMS = ['r1', 'r2', 'r3', 'r4', 'r5'];
export const THEMES = { meet: '모임', study: '스터디', book: '독서모임', class: '클래스 · 강의', seminar: '세미나 · 강연', workshop: '워크숍', meeting: '회의', party: '친목 · 파티' };
const PURPOSE_THEME = { meeting: 'meeting', education: 'class', seminar: 'seminar', study: 'study', workshop: 'workshop', shooting: 'meet', other: 'meet' };
/** 와이파이 기본값. 관리자 화면에서 바꾸면 그 값이 우선합니다. */
export const DEFAULT_WIFI = {
  networks: [
    { id: 'a', ssids: ['SocialFactory_2.4G', 'SocialFactory_5G', 'SocialFactory_6G'], password: '1234567890', spaces: ['r3', 'r4', 'r5', 'coworking', 'lounge', 'office'] },
    { id: 'b', ssids: ['SocialFactory2_2.4G', 'SocialFactory2_5G'], password: '1234567890', spaces: ['r1', 'r2', 'r3', 'r4'] }
  ]
};
export const LIMITS = { title: 40, host: 20, message: 600, entry: 300, name: 20, note: 60, rsvpsPerInvite: 300, rsvpsPerIpHour: 40, invitesPerDay: 60, keepDays: 30 };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meet_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    manage_key TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'booking' CHECK (source IN ('booking', 'admin')),
    booking_code TEXT UNIQUE,
    space TEXT NOT NULL,
    date TEXT NOT NULL,
    start_min INTEGER NOT NULL,
    end_min INTEGER NOT NULL,
    title TEXT NOT NULL,
    host_name TEXT,
    theme TEXT NOT NULL DEFAULT 'meet',
    message TEXT,
    show_names INTEGER NOT NULL DEFAULT 0,
    rsvp_open INTEGER NOT NULL DEFAULT 1,
    entry_note TEXT,
    entry_hours INTEGER NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    views INTEGER NOT NULL DEFAULT 0,
    memo TEXT,
    ip_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
    updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_meet_invites_date ON meet_invites (date, start_min)`,
  `CREATE TABLE IF NOT EXISTS meet_rsvps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invite_id INTEGER NOT NULL,
    device TEXT NOT NULL,
    name TEXT NOT NULL,
    answer TEXT NOT NULL CHECK (answer IN ('yes', 'no')),
    note TEXT,
    car INTEGER NOT NULL DEFAULT 0,
    ip_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
    updated_at TEXT,
    UNIQUE (invite_id, device)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_meet_rsvps_invite ON meet_rsvps (invite_id, answer)`,
  `CREATE INDEX IF NOT EXISTS idx_meet_rsvps_ip ON meet_rsvps (ip_hash, created_at)`,
  `CREATE TABLE IF NOT EXISTS meet_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)`
];
const ready = new WeakMap();
export async function ensureMeetSchema(env) {
  if (!env.DB) throw new Error('no-db');
  if (!ready.has(env.DB)) {
    const task = (async () => { for (const sql of SCHEMA) await env.DB.prepare(sql).run(); })();
    ready.set(env.DB, task); task.catch(() => ready.delete(env.DB));
  }
  await ready.get(env.DB);
}

/* ---------- 작은 도구 ---------- */
export const NOW_SQL = "datetime('now', '+9 hours')";
export const kstNow = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
export const kstDate = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
export const one = (v, max) => clean(typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ') : '', max);
export const lines = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max) : '');
export const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
export const atMs = (date, min) => Date.parse(date + 'T00:00:00+09:00') + Number(min) * 60000;
export const hhmm = (min) => { const m = ((Number(min) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const ABC = '23456789abcdefghjkmnpqrstuvwxyz';
export function makeCode(len = 10) {
  const b = crypto.getRandomValues(new Uint8Array(len));
  let s = ''; for (const x of b) s += ABC[x % ABC.length];
  return s;
}
const bad = (message, status = 400, error = 'invalid', extra = {}) => json({ ok: false, error, message, ...extra }, status);
async function readBody(request) { try { const b = await request.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; } catch { return null; } }
export const inviteUrl = (slug) => `${SITE}/i/${slug}`;
export const manageUrl = (slug, key) => `${SITE}/meet-manage?c=${slug}#k=${key}`;
const validDevice = (v) => /^[A-Za-z0-9_-]{16,64}$/.test(v || '');

/* ---------- 설정 (와이파이 · 방 키) ---------- */
export async function readSetting(env, id) {
  const row = await env.DB.prepare('SELECT value FROM meet_settings WHERE id = ?1').bind(id).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}
export async function writeSetting(env, id, value) {
  await env.DB.prepare(`INSERT INTO meet_settings (id, value, updated_at) VALUES (?1, ?2, ${NOW_SQL})
    ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(id, JSON.stringify(value)).run();
}
/** 관리자 입력을 정리합니다. 문제가 있으면 { error } */
export function normalizeWifi(input) {
  const list = Array.isArray(input?.networks) ? input.networks.slice(0, 6) : null;
  if (!list) return { error: '와이파이 목록을 확인해 주세요.' };
  const networks = [];
  for (const [i, n] of list.entries()) {
    const ssids = [...new Set((Array.isArray(n?.ssids) ? n.ssids : String(n?.ssids || '').split(/[,\n]/)).map((s) => one(String(s), 40)).filter(Boolean))].slice(0, 6);
    const password = one(String(n?.password ?? ''), 64);
    const spaces = [...new Set((Array.isArray(n?.spaces) ? n.spaces : []).filter((s) => SPACES[s]))];
    if (!ssids.length && !password && !spaces.length) continue;
    if (!ssids.length) return { error: `${i + 1}번째 와이파이의 이름을 적어 주세요.` };
    if (!spaces.length) return { error: `${ssids[0]}를 쓰는 공간을 하나 이상 골라 주세요.` };
    networks.push({ id: String.fromCharCode(97 + networks.length), ssids, password, spaces });
  }
  return { value: { networks } };
}
export async function getWifi(env) {
  const saved = await readSetting(env, 'wifi');
  return saved && Array.isArray(saved.networks) ? saved : DEFAULT_WIFI;
}
export const wifiFor = (wifi, space) => (wifi.networks || []).filter((n) => (n.spaces || []).includes(space)).map((n) => ({ ssids: n.ssids, password: n.password }));
/** 방 QR 에 넣는 키. 처음 필요할 때 만들어 저장하고, 관리자가 새로 만들 수 있습니다. */
export async function getRoomKeys(env) {
  const saved = (await readSetting(env, 'room_keys')) || {};
  let changed = false;
  for (const id of Object.keys(SPACES)) if (!/^[a-z0-9]{8,16}$/.test(saved[id] || '')) { saved[id] = makeCode(10); changed = true; }
  if (changed) await writeSetting(env, 'room_keys', saved);
  return saved;
}
export const roomUrl = (space, key) => `${SITE}/room?s=${space}&k=${key}`;

/* ---------- 초대장 ---------- */
/** 예약에서 만든 초대장은 일정 · 방을 예약 기록에서 읽습니다(관리자가 예약을 바꾸면 함께 바뀝니다). */
export async function bookingOf(env, code) {
  if (!code) return null;
  try { return await env.DB.prepare('SELECT code, status, room, date, start_min, end_min, people, purpose FROM booking_requests WHERE code = ?1').bind(code).first(); }
  catch { return null; }
}
export async function resolveInvite(env, row) {
  if (!row) return null;
  const inv = { ...row };
  inv.bookingClosed = false;
  if (row.source === 'booking') {
    const b = await bookingOf(env, row.booking_code);
    if (!b || b.status !== 'confirmed') inv.bookingClosed = true;
    if (b) Object.assign(inv, { space: b.room, date: b.date, start_min: b.start_min, end_min: b.end_min, people: b.people });
  }
  return inv;
}
export function phaseOf(inv, now = Date.now()) {
  if (inv.status !== 'active' || inv.bookingClosed) return 'closed';
  const start = atMs(inv.date, inv.start_min), end = atMs(inv.date, inv.end_min);
  if (now >= end) return 'ended';
  if (now >= start) return 'live';
  if (kstDate(now) === inv.date || start - now <= 12 * 3600e3) return 'today';
  return 'upcoming';
}
/** 당일 정보(와이파이 · 출입 안내)를 보여 줄 때인지 */
export function dayWindow(inv, now = Date.now(), hours = 3) {
  if (inv.status !== 'active' || inv.bookingClosed) return false;
  const start = atMs(inv.date, inv.start_min), end = atMs(inv.date, inv.end_min);
  return now >= start - hours * 3600e3 && now < end + 3600e3;
}
async function counts(env, id) {
  const r = await env.DB.prepare("SELECT SUM(answer = 'yes') AS yes, SUM(answer = 'no') AS no, SUM(CASE WHEN answer = 'yes' THEN car ELSE 0 END) AS cars FROM meet_rsvps WHERE invite_id = ?1").bind(id).first();
  return { yes: Number(r?.yes) || 0, no: Number(r?.no) || 0, cars: Number(r?.cars) || 0 };
}
export function readInviteInput(b, { partial = false } = {}) {
  const v = {}, errors = {};
  if (!partial || b.title !== undefined) { v.title = one(b.title, LIMITS.title); if (!v.title) errors.title = '모임 이름을 적어 주세요.'; }
  if (!partial || b.hostName !== undefined) v.host_name = one(b.hostName, LIMITS.host) || null;
  if (!partial || b.theme !== undefined) v.theme = THEMES[b.theme] ? b.theme : 'meet';
  if (!partial || b.message !== undefined) {
    v.message = lines(b.message, LIMITS.message) || null;
    if (v.message && (v.message.match(/https?:\/\//g) || []).length > 3) errors.message = '안내 글의 링크는 3개까지 넣을 수 있습니다.';
  }
  if (!partial || b.showNames !== undefined) v.show_names = b.showNames ? 1 : 0;
  if (!partial || b.rsvpOpen !== undefined) v.rsvp_open = b.rsvpOpen === false ? 0 : 1;
  if (!partial || b.entryNote !== undefined) v.entry_note = lines(b.entryNote, LIMITS.entry) || null;
  if (!partial || b.entryHours !== undefined) v.entry_hours = Math.max(1, Math.min(24, parseInt(b.entryHours, 10) || 3));
  if (b.status !== undefined) { if (!['active', 'closed'].includes(b.status)) errors.status = '상태를 확인해 주세요.'; else v.status = b.status; }
  return { v, errors };
}
export async function createInvite(env, fields) {
  for (let i = 0; i < 5; i++) {
    const slug = makeCode(10), key = randomToken(24);
    try {
      const row = await env.DB.prepare(`INSERT INTO meet_invites (slug, manage_key, source, booking_code, space, date, start_min, end_min, title, host_name, theme, message, show_names, rsvp_open, entry_note, entry_hours, memo, ip_hash)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18) RETURNING id`).bind(
        slug, key, fields.source, fields.booking_code || null, fields.space, fields.date, fields.start_min, fields.end_min, fields.title, fields.host_name ?? null,
        fields.theme || 'meet', fields.message ?? null, fields.show_names ?? 0, fields.rsvp_open ?? 1, fields.entry_note ?? null, fields.entry_hours ?? 3, fields.memo ?? null, fields.ip_hash ?? null).first();
      return { id: row.id, slug, key };
    } catch (e) {
      if (/booking_code/.test(String(e && e.message))) throw e;
      if (!/UNIQUE/i.test(String(e && e.message))) throw e;
    }
  }
  throw new Error('code-collision');
}
/** 지난 모임의 초대장과 응답을 지웁니다(모임일 30일 뒤). */
export async function purgeOld(env) {
  const before = kstDate(Date.now() - LIMITS.keepDays * 86400e3);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM meet_rsvps WHERE invite_id IN (SELECT id FROM meet_invites WHERE date < ?1)').bind(before),
    env.DB.prepare('DELETE FROM meet_invites WHERE date < ?1').bind(before)
  ]);
}
function spaceInfo(space) {
  const s = SPACES[space] || {};
  return { space, spaceName: s.name || space, spaceSub: s.sub || '', way: s.way || '', gear: s.gear || '', capacity: s.max || null };
}
export async function publicInvite(env, inv, device, now = Date.now()) {
  const c = await counts(env, inv.id);
  const phase = phaseOf(inv, now);
  const out = {
    slug: inv.slug, url: inviteUrl(inv.slug), title: inv.title, host: inv.host_name || '', theme: inv.theme, themeName: THEMES[inv.theme] || '모임',
    message: inv.message || '', date: inv.date, startMin: inv.start_min, endMin: inv.end_min, startAt: atMs(inv.date, inv.start_min), endAt: atMs(inv.date, inv.end_min),
    phase, rsvpOpen: !!inv.rsvp_open && ['upcoming', 'today', 'live'].includes(phase), showNames: !!inv.show_names, counts: { yes: c.yes, no: c.no },
    ...spaceInfo(inv.space), place: PLACE, entry: '', wifi: []
  };
  if (inv.show_names) {
    const rs = await env.DB.prepare("SELECT name FROM meet_rsvps WHERE invite_id = ?1 AND answer = 'yes' ORDER BY id LIMIT 200").bind(inv.id).all();
    out.names = (rs.results || []).map((r) => r.name);
  }
  if (validDevice(device)) {
    const m = await env.DB.prepare('SELECT name, answer, note, car FROM meet_rsvps WHERE invite_id = ?1 AND device = ?2').bind(inv.id, device).first();
    out.mine = m ? { name: m.name, answer: m.answer, note: m.note || '', car: !!m.car } : null;
  }
  if (dayWindow(inv, now, Number(inv.entry_hours) || 3) && inv.entry_note) out.entry = inv.entry_note;
  if (dayWindow(inv, now, 3)) out.wifi = wifiFor(await getWifi(env), inv.space);
  return out;
}
export async function manageView(env, inv, now = Date.now()) {
  const base = await publicInvite(env, inv, '', now);
  const rs = await env.DB.prepare('SELECT id, name, answer, note, car, created_at, updated_at FROM meet_rsvps WHERE invite_id = ?1 ORDER BY answer DESC, id').bind(inv.id).all();
  const c = await counts(env, inv.id);
  return {
    ...base, counts: c, views: Number(inv.views) || 0, status: inv.status, bookingClosed: !!inv.bookingClosed, source: inv.source, bookingCode: inv.booking_code || '',
    people: inv.people || null, hostName: inv.host_name || '', showNamesSetting: !!inv.show_names, rsvpSetting: !!inv.rsvp_open,
    entryNote: inv.entry_note || '', entryHours: Number(inv.entry_hours) || 3, manageUrl: manageUrl(inv.slug, inv.manage_key),
    responses: (rs.results || []).map((r) => ({ id: r.id, name: r.name, answer: r.answer, note: r.note || '', car: !!r.car, at: r.updated_at || r.created_at }))
  };
}
export function icsOf(inv) {
  const z = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const s = SPACES[inv.space] || {};
  const where = `${PLACE.name} ${s.name || ''}, ${PLACE.road} ${PLACE.building}`;
  const desc = [inv.host_name ? `${inv.host_name}님의 초대` : '', `초대장: ${inviteUrl(inv.slug)}`, inv.message ? '\n' + inv.message : ''].filter(Boolean).join('\n');
  const fold = (line) => { const out = []; let cur = ''; for (const ch of line) { if (new TextEncoder().encode(cur + ch).length > 73) { out.push(cur); cur = ' ' + ch; } else cur += ch; } out.push(cur); return out.join('\r\n'); };
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SocialFactory//Meet//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${inv.slug}@socialfactory.co.kr`, `DTSTAMP:${z(Date.now())}`, `DTSTART:${z(atMs(inv.date, inv.start_min))}`, `DTEND:${z(atMs(inv.date, inv.end_min))}`,
    `SUMMARY:${esc(inv.title)}`, `LOCATION:${esc(where)}`, `DESCRIPTION:${esc(desc)}`, `URL:${inviteUrl(inv.slug)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(inv.title)}`, 'TRIGGER:-PT1H', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
}
async function inviteBySlug(env, slug) {
  if (!/^[a-z0-9]{6,16}$/.test(slug || '')) return null;
  return resolveInvite(env, await env.DB.prepare('SELECT * FROM meet_invites WHERE slug = ?1').bind(slug).first());
}

/* ---------- 예약 확인 (예약번호 + 조회 링크의 t) ---------- */
async function bookingContext(env, code, token) {
  const ctx = await paymentContext(env, clean(code, 64), clean(token, 128));
  return ctx && ctx.booking ? ctx.booking : null;
}
function bookingSummary(b) {
  return { space: b.room, ...spaceInfo(b.room), date: b.date, startMin: b.start_min, endMin: b.end_min, people: b.people, status: b.status, suggestedTheme: PURPOSE_THEME[b.purpose] || 'meet' };
}

/* ---------- 공개 API ---------- */
export async function handlePublic(context) {
  const { request, env } = context;
  if (!env.DB) return bad('연결을 확인하고 다시 시도해 주세요.', 503, 'no-db');
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/meet\/?/, '').split('/').filter(Boolean);
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request)) return bad('홈페이지에서 다시 시도해 주세요.', 403, 'origin');
  try {
    await ensureMeetSchema(env);
    const [a, b, c, d] = parts;
    if (a === 'booking' && !b && method === 'POST') return bookingStatus(request, env);
    if (a === 'booking' && b === 'invite' && method === 'POST') return bookingCreate(request, env);
    if (a === 'invite' && b && !c && method === 'GET') return getInvite(request, env, b);
    if (a === 'invite' && b && c === 'view' && method === 'POST') return addView(env, b);
    if (a === 'invite' && b && c === 'rsvp' && method === 'POST') return saveRsvp(request, env, b);
    if (a === 'invite' && b && c === 'rsvp' && method === 'DELETE') return deleteRsvp(request, env, b);
    if (a === 'invite' && b && c === 'calendar.ics' && method === 'GET') return calendar(env, b);
    if (a === 'manage' && b && !c && method === 'GET') return manageGet(request, env, b);
    if (a === 'manage' && b && !c && method === 'PATCH') return managePatch(request, env, b);
    if (a === 'manage' && b && c === 'rsvp' && /^\d+$/.test(d || '') && method === 'DELETE') return manageDeleteRsvp(request, env, b, Number(d));
    if (a === 'room' && b && !c && method === 'GET') return roomWifi(env, b, url.searchParams.get('k'));
    return bad('찾을 수 없는 주소입니다.', 404, 'not-found');
  } catch (e) {
    console.error('meet', e && e.message);
    return bad('처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500, 'server');
  }
}

async function bookingStatus(request, env) {
  const body = await readBody(request); if (!body) return bad('요청을 읽지 못했습니다.');
  const b = await bookingContext(env, body.code, body.t);
  if (!b) return bad('예약 확인 링크를 확인해 주세요.', 404, 'not-found');
  const row = await env.DB.prepare('SELECT * FROM meet_invites WHERE booking_code = ?1').bind(b.code).first();
  const ended = Date.now() >= atMs(b.date, b.end_min);
  return json({ ok: true, booking: bookingSummary(b), eligible: b.status === 'confirmed' && !ended, ended,
    invite: row ? { slug: row.slug, url: inviteUrl(row.slug), manageUrl: manageUrl(row.slug, row.manage_key), title: row.title } : null });
}
async function bookingCreate(request, env) {
  const body = await readBody(request); if (!body) return bad('요청을 읽지 못했습니다.');
  const b = await bookingContext(env, body.code, body.t);
  if (!b) return bad('예약 확인 링크를 확인해 주세요.', 404, 'not-found');
  if (b.status !== 'confirmed') return bad('예약이 확정된 뒤에 초대장을 만들 수 있습니다.', 409, 'not-confirmed');
  if (Date.now() >= atMs(b.date, b.end_min)) return bad('이미 끝난 예약입니다.', 409, 'ended');
  const existing = await env.DB.prepare('SELECT slug, manage_key FROM meet_invites WHERE booking_code = ?1').bind(b.code).first();
  if (existing) return json({ ok: true, existed: true, slug: existing.slug, url: inviteUrl(existing.slug), manageUrl: manageUrl(existing.slug, existing.manage_key), key: existing.manage_key });
  const { v, errors } = readInviteInput({ theme: PURPOSE_THEME[b.purpose] || 'meet', ...body });
  if (Object.keys(errors).length) return bad(Object.values(errors)[0], 400, 'invalid', { fields: errors });
  const ip = await ipHashOf(request, env);
  if (ip) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS c FROM meet_invites WHERE ip_hash = ?1 AND created_at >= datetime('now', '+9 hours', '-1 day')").bind(ip).first();
    if (Number(n?.c) >= LIMITS.invitesPerDay) return bad('오늘 만들 수 있는 초대장 수를 넘었습니다. 내일 다시 시도해 주세요.', 429, 'limit');
  }
  let made;
  try { made = await createInvite(env, { ...v, source: 'booking', booking_code: b.code, space: b.room, date: b.date, start_min: b.start_min, end_min: b.end_min, ip_hash: ip }); }
  catch (e) {
    const again = await env.DB.prepare('SELECT slug, manage_key FROM meet_invites WHERE booking_code = ?1').bind(b.code).first();
    if (!again) throw e;
    made = { slug: again.slug, key: again.manage_key };
  }
  purgeOld(env).catch(() => {});
  return json({ ok: true, slug: made.slug, url: inviteUrl(made.slug), manageUrl: manageUrl(made.slug, made.key), key: made.key });
}
async function getInvite(request, env, slug) {
  const inv = await inviteBySlug(env, slug);
  if (!inv) return bad('초대장을 찾을 수 없습니다. 주소를 다시 확인해 주세요.', 404, 'not-found');
  return json({ ok: true, invite: await publicInvite(env, inv, request.headers.get('x-device') || '') });
}
async function addView(env, slug) {
  if (/^[a-z0-9]{6,16}$/.test(slug)) await env.DB.prepare('UPDATE meet_invites SET views = views + 1 WHERE slug = ?1').bind(slug).run();
  return json({ ok: true });
}
async function saveRsvp(request, env, slug) {
  const body = await readBody(request); if (!body) return bad('요청을 읽지 못했습니다.');
  const inv = await inviteBySlug(env, slug);
  if (!inv) return bad('초대장을 찾을 수 없습니다.', 404, 'not-found');
  const phase = phaseOf(inv);
  if (!inv.rsvp_open || !['upcoming', 'today', 'live'].includes(phase)) return bad(phase === 'ended' ? '이미 끝난 모임입니다.' : '지금은 참석 응답을 받지 않습니다.', 409, 'closed');
  if (!validDevice(body.device)) return bad('브라우저를 새로 고친 뒤 다시 시도해 주세요.', 400, 'device');
  const name = one(body.name, LIMITS.name);
  if (!name) return bad('이름이나 별명을 적어 주세요.', 400, 'invalid', { fields: { name: '이름이나 별명을 적어 주세요.' } });
  const answer = body.answer === 'no' ? 'no' : body.answer === 'yes' ? 'yes' : '';
  if (!answer) return bad('참석 여부를 골라 주세요.');
  const note = one(body.note, LIMITS.note) || null, car = body.car && answer === 'yes' ? 1 : 0;
  const ip = await ipHashOf(request, env);
  const mine = await env.DB.prepare('SELECT id FROM meet_rsvps WHERE invite_id = ?1 AND device = ?2').bind(inv.id, body.device).first();
  if (!mine) {
    const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM meet_rsvps WHERE invite_id = ?1').bind(inv.id).first();
    if (Number(total?.c) >= LIMITS.rsvpsPerInvite) return bad('응답이 너무 많아 더 받을 수 없습니다. 모임장에게 알려 주세요.', 429, 'limit');
    if (ip) {
      const n = await env.DB.prepare("SELECT COUNT(*) AS c FROM meet_rsvps WHERE ip_hash = ?1 AND created_at >= datetime('now', '+9 hours', '-1 hour')").bind(ip).first();
      if (Number(n?.c) >= LIMITS.rsvpsPerIpHour) return bad('잠시 뒤 다시 시도해 주세요.', 429, 'limit');
    }
    await env.DB.prepare('INSERT INTO meet_rsvps (invite_id, device, name, answer, note, car, ip_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(inv.id, body.device, name, answer, note, car, ip).run();
  } else {
    await env.DB.prepare(`UPDATE meet_rsvps SET name = ?1, answer = ?2, note = ?3, car = ?4, updated_at = ${NOW_SQL} WHERE id = ?5`).bind(name, answer, note, car, mine.id).run();
  }
  return json({ ok: true, invite: await publicInvite(env, inv, body.device) });
}
async function deleteRsvp(request, env, slug) {
  const body = await readBody(request); if (!body) return bad('요청을 읽지 못했습니다.');
  const inv = await inviteBySlug(env, slug);
  if (!inv) return bad('초대장을 찾을 수 없습니다.', 404, 'not-found');
  if (!validDevice(body.device)) return bad('응답을 찾지 못했습니다.', 400, 'device');
  await env.DB.prepare('DELETE FROM meet_rsvps WHERE invite_id = ?1 AND device = ?2').bind(inv.id, body.device).run();
  return json({ ok: true, invite: await publicInvite(env, inv, body.device) });
}
async function calendar(env, slug) {
  const inv = await inviteBySlug(env, slug);
  if (!inv) return new Response('초대장을 찾을 수 없습니다.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(icsOf(inv), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="socialfactory-meet.ics"', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}
async function managed(request, env, slug) {
  const inv = await inviteBySlug(env, slug);
  const key = request.headers.get('x-invite-key') || '';
  if (!inv || !key || !safeEqual(key, inv.manage_key)) return null;
  return inv;
}
async function manageGet(request, env, slug) {
  const inv = await managed(request, env, slug);
  if (!inv) return bad('초대장 관리 링크를 확인해 주세요.', 404, 'not-found');
  return json({ ok: true, invite: await manageView(env, inv) });
}
async function managePatch(request, env, slug) {
  const inv = await managed(request, env, slug);
  if (!inv) return bad('초대장 관리 링크를 확인해 주세요.', 404, 'not-found');
  const body = await readBody(request); if (!body) return bad('요청을 읽지 못했습니다.');
  const { v, errors } = readInviteInput(body, { partial: true });
  if (Object.keys(errors).length) return bad(Object.values(errors)[0], 400, 'invalid', { fields: errors });
  const sets = [], args = [];
  for (const [k, val] of Object.entries(v)) { args.push(val); sets.push(`${k} = ?${args.length}`); }
  if (!sets.length) return bad('바꿀 내용이 없습니다.');
  args.push(inv.id);
  await env.DB.prepare(`UPDATE meet_invites SET ${sets.join(', ')}, updated_at = ${NOW_SQL} WHERE id = ?${args.length}`).bind(...args).run();
  const fresh = await resolveInvite(env, await env.DB.prepare('SELECT * FROM meet_invites WHERE id = ?1').bind(inv.id).first());
  return json({ ok: true, invite: await manageView(env, fresh) });
}
async function manageDeleteRsvp(request, env, slug, id) {
  const inv = await managed(request, env, slug);
  if (!inv) return bad('초대장 관리 링크를 확인해 주세요.', 404, 'not-found');
  await env.DB.prepare('DELETE FROM meet_rsvps WHERE id = ?1 AND invite_id = ?2').bind(id, inv.id).run();
  return json({ ok: true, invite: await manageView(env, inv) });
}
async function roomWifi(env, space, key) {
  if (!SPACES[space]) return bad('공간을 찾을 수 없습니다.', 404, 'not-found');
  const keys = await getRoomKeys(env);
  const valid = typeof key === 'string' && key.length >= 8 && safeEqual(key, keys[space]);
  return json({ ok: true, space, ...spaceInfo(space), keyValid: valid, wifi: valid ? wifiFor(await getWifi(env), space) : [] });
}
