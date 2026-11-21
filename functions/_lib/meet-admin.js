/**
 * 관리자 — 모임 초대장 · 룸 가이드 (/api/admin/meet/*)
 * 초대장 목록 · 직접 만들기(스페이스클라우드 등 다른 채널 예약용) · 닫기 · 지우기, 방 QR 주소, 와이파이 설정을 다룹니다.
 */
import { json } from './auth.js';
import { adminGate } from './admin.js';
import {
  SPACES, ROOMS, THEMES, DEFAULT_WIFI, NOW_SQL, ensureMeetSchema, readInviteInput, createInvite, resolveInvite, manageView, purgeOld,
  getWifi, normalizeWifi, writeSetting, getRoomKeys, roomUrl, inviteUrl, manageUrl, isIsoDate, kstDate, phaseOf, makeCode, one
} from './meet.js';

const bad = (message, status = 400, error = 'invalid', extra = {}) => json({ ok: false, error, message, ...extra }, status);
async function readBody(request) { try { const b = await request.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b : {}; } catch { return null; } }

export async function handleAdmin(context) {
  const { request, env } = context;
  const deny = await adminGate(request, env); if (deny) return deny;
  const url = new URL(request.url);
  const [a, b, c] = url.pathname.replace(/^\/api\/admin\/meet\/?/, '').split('/').filter(Boolean);
  const method = request.method.toUpperCase();
  try {
    await ensureMeetSchema(env);
    const id = /^\d+$/.test(b || '') ? Number(b) : 0;
    if (a === 'summary' && method === 'GET') return summary(env);
    if (a === 'invites' && !b && method === 'GET') return list(env, url.searchParams);
    if (a === 'invites' && !b && method === 'POST') return create(request, env);
    if (a === 'invites' && id && !c && method === 'GET') return detail(env, id);
    if (a === 'invites' && id && !c && method === 'PATCH') return patch(request, env, id);
    if (a === 'invites' && id && !c && method === 'DELETE') return remove(env, id);
    if (a === 'rooms' && !b && method === 'GET') return rooms(env);
    if (a === 'rooms' && b === 'rotate' && method === 'POST') return rotate(request, env);
    if (a === 'wifi' && method === 'GET') return json({ ok: true, wifi: await getWifi(env), defaults: DEFAULT_WIFI, spaces: spaceList() });
    if (a === 'wifi' && method === 'PUT') return saveWifi(request, env);
    return bad('찾을 수 없는 주소입니다.', 404, 'not-found');
  } catch (e) {
    console.error('admin-meet', e && e.message);
    return bad('처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.', 500, 'server');
  }
}
const spaceList = () => Object.entries(SPACES).map(([id, s]) => ({ id, name: s.name, sub: s.sub, kind: s.kind }));

async function summary(env) {
  const today = kstDate();
  const r = await env.DB.prepare(`SELECT COUNT(*) AS total, SUM(status = 'active' AND date >= ?1) AS upcoming, SUM(status = 'active' AND date = ?1) AS today FROM meet_invites`).bind(today).first();
  const rs = await env.DB.prepare(`SELECT SUM(answer = 'yes') AS yes, COUNT(*) AS c FROM meet_rsvps WHERE invite_id IN (SELECT id FROM meet_invites WHERE date >= ?1)`).bind(today).first();
  return json({ ok: true, summary: { total: Number(r?.total) || 0, upcoming: Number(r?.upcoming) || 0, today: Number(r?.today) || 0, yes: Number(rs?.yes) || 0, responses: Number(rs?.c) || 0 } });
}
async function list(env, q) {
  purgeOld(env).catch(() => {});
  const today = kstDate(), where = [], args = [];
  const scope = q.get('scope') || 'upcoming';
  if (scope === 'upcoming') { args.push(today); where.push(`i.date >= ?${args.length}`); }
  else if (scope === 'past') { args.push(today); where.push(`i.date < ?${args.length}`); }
  const text = one(q.get('q') || '', 40);
  if (text) { args.push('%' + text.replace(/[\\%_]/g, (ch) => '\\' + ch) + '%'); const k = '?' + args.length; where.push(`(i.title LIKE ${k} ESCAPE '\\' OR i.host_name LIKE ${k} ESCAPE '\\' OR i.booking_code LIKE ${k} ESCAPE '\\' OR i.memo LIKE ${k} ESCAPE '\\')`); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const order = scope === 'past' ? 'i.date DESC, i.start_min DESC' : 'i.date, i.start_min';
  const rows = await env.DB.prepare(`SELECT i.*, (SELECT COUNT(*) FROM meet_rsvps r WHERE r.invite_id = i.id AND r.answer = 'yes') AS yes,
      (SELECT COUNT(*) FROM meet_rsvps r WHERE r.invite_id = i.id AND r.answer = 'no') AS no FROM meet_invites i ${W} ORDER BY ${order} LIMIT 200`).bind(...args).all();
  const out = [];
  for (const row of rows.results || []) {
    const inv = await resolveInvite(env, row);
    out.push({ id: inv.id, slug: inv.slug, title: inv.title, host: inv.host_name || '', source: inv.source, bookingCode: inv.booking_code || '', memo: inv.memo || '',
      space: inv.space, spaceName: SPACES[inv.space]?.name || inv.space, date: inv.date, startMin: inv.start_min, endMin: inv.end_min,
      status: inv.status, phase: phaseOf(inv), bookingClosed: !!inv.bookingClosed, yes: Number(row.yes) || 0, no: Number(row.no) || 0, views: Number(inv.views) || 0,
      url: inviteUrl(inv.slug), manageUrl: manageUrl(inv.slug, inv.manage_key), createdAt: inv.created_at });
  }
  return json({ ok: true, invites: out });
}
async function create(request, env) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const space = ROOMS.includes(b.space) ? b.space : '';
  if (!space) return bad('방을 골라 주세요.', 400, 'invalid', { fields: { space: '방을 골라 주세요.' } });
  if (!isIsoDate(b.date)) return bad('날짜를 골라 주세요.', 400, 'invalid', { fields: { date: '날짜를 골라 주세요.' } });
  const start = parseInt(b.startMin, 10), end = parseInt(b.endMin, 10);
  if (!(start >= 0 && start < 1440 && start % 30 === 0)) return bad('시작 시각을 30분 단위로 골라 주세요.', 400, 'invalid', { fields: { startMin: '시작 시각을 골라 주세요.' } });
  if (!(end > start && end - start <= 1440 && end % 30 === 0)) return bad('끝나는 시각을 확인해 주세요.', 400, 'invalid', { fields: { endMin: '끝나는 시각을 확인해 주세요.' } });
  if (b.date < kstDate(Date.now() - 86400e3)) return bad('지난 날짜의 초대장은 만들 수 없습니다.', 400, 'invalid', { fields: { date: '오늘 이후 날짜를 골라 주세요.' } });
  const { v, errors } = readInviteInput(b);
  if (Object.keys(errors).length) return bad(Object.values(errors)[0], 400, 'invalid', { fields: errors });
  const made = await createInvite(env, { ...v, source: 'admin', space, date: b.date, start_min: start, end_min: end, memo: one(b.memo, 100) || null });
  return json({ ok: true, id: made.id, slug: made.slug, url: inviteUrl(made.slug), manageUrl: manageUrl(made.slug, made.key) });
}
async function load(env, id) {
  return resolveInvite(env, await env.DB.prepare('SELECT * FROM meet_invites WHERE id = ?1').bind(id).first());
}
async function detail(env, id) {
  const inv = await load(env, id);
  if (!inv) return bad('초대장을 찾을 수 없습니다.', 404, 'not-found');
  return json({ ok: true, invite: { id: inv.id, memo: inv.memo || '', ...(await manageView(env, inv)) } });
}
async function patch(request, env, id) {
  const inv = await load(env, id);
  if (!inv) return bad('초대장을 찾을 수 없습니다.', 404, 'not-found');
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const { v, errors } = readInviteInput(b, { partial: true });
  if (b.memo !== undefined) v.memo = one(b.memo, 100) || null;
  if (inv.source === 'admin') {
    if (b.space !== undefined) { if (!ROOMS.includes(b.space)) errors.space = '방을 골라 주세요.'; else v.space = b.space; }
    if (b.date !== undefined) { if (!isIsoDate(b.date)) errors.date = '날짜를 골라 주세요.'; else v.date = b.date; }
    if (b.startMin !== undefined || b.endMin !== undefined) {
      const s = parseInt(b.startMin ?? inv.start_min, 10), e = parseInt(b.endMin ?? inv.end_min, 10);
      if (!(s >= 0 && s < 1440 && s % 30 === 0 && e > s && e - s <= 1440 && e % 30 === 0)) errors.startMin = '시간을 확인해 주세요.';
      else { v.start_min = s; v.end_min = e; }
    }
  }
  if (Object.keys(errors).length) return bad(Object.values(errors)[0], 400, 'invalid', { fields: errors });
  const sets = [], args = [];
  for (const [k, val] of Object.entries(v)) { args.push(val); sets.push(`${k} = ?${args.length}`); }
  if (!sets.length) return bad('바꿀 내용이 없습니다.');
  args.push(id);
  await env.DB.prepare(`UPDATE meet_invites SET ${sets.join(', ')}, updated_at = ${NOW_SQL} WHERE id = ?${args.length}`).bind(...args).run();
  return detail(env, id);
}
async function remove(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM meet_rsvps WHERE invite_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM meet_invites WHERE id = ?1').bind(id)
  ]);
  return json({ ok: true });
}
async function rooms(env) {
  const keys = await getRoomKeys(env);
  return json({ ok: true, rooms: spaceList().map((s) => ({ ...s, url: roomUrl(s.id, keys[s.id]) })) });
}
async function rotate(request, env) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const keys = await getRoomKeys(env);
  const targets = b.space === 'all' ? Object.keys(SPACES) : SPACES[b.space] ? [b.space] : [];
  if (!targets.length) return bad('공간을 골라 주세요.');
  for (const t of targets) keys[t] = makeCode(10);
  await writeSetting(env, 'room_keys', keys);
  return rooms(env);
}
async function saveWifi(request, env) {
  const b = await readBody(request); if (!b) return bad('요청을 읽지 못했습니다.');
  const r = normalizeWifi(b);
  if (r.error) return bad(r.error);
  await writeSetting(env, 'wifi', r.value);
  return json({ ok: true, wifi: r.value });
}
export { THEMES };
