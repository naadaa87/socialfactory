import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { segments, union, occupancy, peopleOf, parsePeriod, bucketKeys } from '../functions/_lib/kpi.js';
import { classifyRef, normalizePath, parseVisitEvent, deviceOf, isBot } from '../functions/_lib/visits.js';
import { onRequestGet as kpi } from '../functions/api/admin/kpi.js';
import { onRequestPost as visit } from '../functions/api/visit.js';

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = { prepare(sql) {
    let args = [];
    const st = { bind(...v) { args = v; return st; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async first() { return sqlite.prepare(sql).get(...args) || null; }, async run() { return { meta: sqlite.prepare(sql).run(...args) }; } };
    return st;
  }, async batch(list) { sqlite.exec('BEGIN'); try { const r = []; for (const s of list) r.push(await s.run()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
  return { DB, sqlite, ADMIN_KEY: 'kpi-admin', IP_SALT: 'salt' };
}
const get = async (env, query, admin = true) => {
  const res = await kpi({ request: new Request('https://example.test/api/admin/kpi' + query, { headers: admin ? { authorization: 'Bearer kpi-admin' } : {} }), env, waitUntil() {} });
  return { status: res.status, data: await res.json() };
};
const res = (env, r) => env.sqlite.prepare(`INSERT INTO reservations (code, status, space, date, start_min, end_min, customer_name, people, channel, amount, pay_method, pay_status, paid_at, refund_amount)
  VALUES (?, ?, ?, ?, ?, ?, '고객', ?, ?, ?, 'bank_blank', ?, ?, ?)`).run(r.code, r.status || 'confirmed', r.space, r.date, r.start, r.end, r.people ?? null, r.channel || 'kakao', r.amount, r.pay || 'paid', r.paid || r.date, r.refund || 0);
const scs = (env, r) => env.sqlite.prepare(`INSERT INTO spacecloud_sales (reservation_id, use_date, end_date, paid_at, amount, refund_amount, linked_code, space) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`)
  .run(r.id, r.date, r.date, r.paid, r.amount, r.refund || 0, r.space);

function seed(env) {
  res(env, { code: 'R1', space: 'r1', date: '2026-11-03', start: 600, end: 840, people: 10, amount: 80000, paid: '2026-11-01' });
  res(env, { code: 'R2', space: 'r2', date: '2026-11-05', start: 1320, end: 1560, amount: 120000 });            // 자정 넘김, 인원 미기록
  res(env, { code: 'R3', space: 'r3', date: '2026-11-07', start: 600, end: 720, people: 6, amount: 30000, status: 'cancelled', pay: 'refunded', refund: 20000 });
  res(env, { code: 'R4', space: 'r4', date: '2026-10-31', start: 1380, end: 1500, people: 20, amount: 70000, paid: '2026-11-01' });  // 전달 밤 → 11/1 새벽
  scs(env, { id: '9001', space: 'r5', date: '2026-11-10', paid: '2026-11-08 10:00:00', amount: 50000 });
  scs(env, { id: '9002', space: 'r5', date: '2026-11-12', paid: '2026-11-09 10:00:00', amount: 40000, refund: 40000 });
}

test('segments split overnight bookings, union removes double counting, occupancy uses 24h x days x rooms', () => {
  assert.deepEqual(segments({ date: '2026-11-05', start_min: 1320, end_min: 1560 }), [{ date: '2026-11-05', s: 1320, e: 1440 }, { date: '2026-11-06', s: 0, e: 120 }]);
  assert.deepEqual(union([{ s: 60, e: 120 }, { s: 90, e: 180 }, { s: 200, e: 210 }]), [{ s: 60, e: 180 }, { s: 200, e: 210 }]);
  const occ = occupancy([{ space: 'r1', date: '2026-11-02', start_min: 0, end_min: 1440 }, { space: 'r1', date: '2026-11-02', start_min: 600, end_min: 700 }], '2026-11-01', '2026-11-02', 'day');
  assert.equal(occ.byRoom.r1.minutes, 1440); assert.equal(occ.byRoom.r1.rate, 50); assert.equal(occ.rate, 10);
  assert.equal(occ.series['2026-11-02'].roomRate.r1, 100); assert.equal(occ.heat[0][10], 20);   // 11/2 월요일 10시: 다섯 방 중 하나
  assert.deepEqual(peopleOf({ space: 'r4', people: null }), { n: 24, estimated: true });
  assert.deepEqual(peopleOf({ space: 'r2', people: 0 }), { n: 20, estimated: true });
  assert.deepEqual(peopleOf({ space: 'r2', people: 7 }), { n: 7, estimated: false });
  const p = parsePeriod(new URLSearchParams(''), '2026-11-14');
  assert.equal(p.from, '2026-11-01'); assert.equal(p.to, '2026-11-30'); assert.equal(p.bucket, 'day'); assert.equal(p.prev.from, '2026-10-02'); assert.equal(p.prev.to, '2026-10-31');
  assert.equal(parsePeriod(new URLSearchParams('from=2026-01-01&to=2026-12-31'), '2026-11-14').bucket, 'month');
  assert.match(parsePeriod(new URLSearchParams('from=2026-12-01&to=2026-11-01'), '2026-11-14').error, /늦습니다/);
  assert.deepEqual(bucketKeys('2025-11-15', '2026-02-01', 'month'), ['2025-11', '2025-12', '2026-01', '2026-02']);
});

test('KPI totals: room sales by basis, occupancy, people with half-capacity estimate and cancellation rate', async () => {
  const env = setup(); seed(env);
  assert.equal((await get(env, '', false)).status, 401);
  const { status, data } = await get(env, '?from=2026-11-01&to=2026-11-30&basis=use');
  assert.equal(status, 200);
  assert.equal(data.sales.byRoom.r1.amount, 80000); assert.equal(data.sales.byRoom.r2.amount, 120000); assert.equal(data.sales.byRoom.r3.amount, 10000);
  assert.equal(data.sales.byRoom.r4.amount, 0); assert.equal(data.sales.byRoom.r5.amount, 50000);
  assert.equal(data.summary.rooms, 260000);
  assert.equal(data.occupancy.minutes, 240 + 240 + 60); assert.equal(data.occupancy.available, 30 * 1440 * 5);
  assert.equal(data.occupancy.byRoom.r2.minutes, 240); assert.equal(data.occupancy.byRoom.r4.minutes, 60); assert.equal(data.occupancy.untimed, 1);
  assert.equal(data.people.bookings, 3); assert.equal(data.people.total, 10 + 20 + 15); assert.equal(data.people.estimated, 35); assert.equal(data.people.estimatedBookings, 2);
  assert.equal(data.cancel.total, 5); assert.equal(data.cancel.cancelled, 2); assert.equal(data.cancel.rate, 40);
  assert.equal(data.cancel.byChannel.spacecloud.cancelled, 1);
  const paid = (await get(env, '?from=2026-11-01&to=2026-11-30&basis=paid')).data;
  assert.equal(paid.sales.byRoom.r4.amount, 70000);   // 결제일 기준이면 10/31 이용 예약도 11월 매출
  assert.equal(paid.prev.summary.rooms, 0);
  const year = (await get(env, '?from=2026-01-01&to=2026-12-31')).data;
  assert.equal(year.period.bucket, 'month'); assert.equal(year.buckets.length, 12); assert.equal(year.sales.series['2026-11'].r1, 80000);
  assert.equal((await get(env, '?from=2026-11-30&to=2026-11-01')).status, 400);
});

test('visit endpoint records page views, active time and clicks without cookies and the KPI aggregates them', async () => {
  const env = setup();
  const send = (body, ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', ip = '203.0.113.5') =>
    visit({ request: new Request('https://socialfactory.co.kr/api/visit', { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://socialfactory.co.kr', 'user-agent': ua, 'cf-connecting-ip': ip }, body: JSON.stringify(body) }), env });
  const r1 = await send({ t: 'pv', sid: 'sessiona1', pvid: 'pageview1', path: '/space.html?token=secret', title: '공간 안내', ref: 'https://search.naver.com/search.naver', entry: 1 });
  assert.equal(r1.status, 204); assert.equal(r1.headers.get('set-cookie'), null);
  await send({ t: 'leave', sid: 'sessiona1', pvid: 'pageview1', ms: 42000, scroll: 80 });
  await send({ t: 'leave', sid: 'sessiona1', pvid: 'pageview1', ms: 30000, scroll: 50 });   // 작은 값은 무시
  await send({ t: 'pv', sid: 'sessiona1', pvid: 'pageview2', path: '/booking', title: '예약', ref: 'https://socialfactory.co.kr/space', entry: 0 });
  await send({ t: 'click', sid: 'sessiona1', pvid: 'pageview2', path: '/booking', kind: 'kakao', label: '카카오톡 문의', target: 'pf.kakao.com/_uTiFX/chat' });
  await send({ t: 'click', sid: 'nosuchsid', pvid: 'nosuchpv1', path: '/booking', kind: 'kakao', label: 'x' });  // 기록 없는 페이지 → 버림
  await send({ t: 'pv', sid: 'sessionb2', pvid: 'pageview3', path: '/', title: '홈', ref: '', entry: 1, us: 'meta', uc: '11월 이벤트' }, 'Mozilla/5.0 (Windows NT 10.0)', '198.51.100.7');
  await send({ t: 'pv', sid: 'sessionc3', pvid: 'pageview4', path: '/', ref: '', entry: 1 }, 'Googlebot/2.1');   // 로봇 → 버림
  const row = env.sqlite.prepare("SELECT * FROM site_visits WHERE pvid='pageview1'").get();
  assert.equal(row.path, '/space'); assert.equal(row.active_ms, 42000); assert.equal(row.scroll, 80); assert.equal(row.ref_type, 'naver'); assert.equal(row.device, 'mobile');
  assert.equal(row.vh.length, 16); assert(!JSON.stringify(row).includes('203.0.113.5'));
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM site_visits').get().n, 3);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS n FROM site_clicks').get().n, 1);
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const { data } = await get(env, `?from=${today}&to=${today}`);
  const v = data.visits;
  assert.equal(v.pageviews, 3); assert.equal(v.sessions, 2); assert.equal(v.visitors, 2); assert.equal(v.bounceRate, 50);
  assert.equal(v.topPages[0].path, '/'); assert.equal(v.sources.find(s => s.key === 'naver').sessions, 1); assert.equal(v.sources.find(s => s.key === 'campaign').sessions, 1);
  assert.equal(v.campaigns[0].source, 'meta'); assert.equal(v.clicks.byKind[0].kind, 'kakao'); assert.equal(v.funnel.bookingSessions, 1); assert.equal(v.funnel.kakaoSessions, 1);
  assert.equal(v.devices.mobile, 1); assert.equal(v.devices.desktop, 1);
});

test('visit helpers classify sources, normalise paths and reject bad events', () => {
  assert.equal(classifyRef({ ref: 'https://m.blog.naver.com/abc' }).type, 'blog');
  assert.equal(classifyRef({ ref: 'https://www.google.co.kr/' }).type, 'google');
  assert.equal(classifyRef({ ref: '', ua: 'Mozilla KAKAOTALK 10.0' }).type, 'kakao');
  assert.equal(classifyRef({ ref: 'https://megaspot.kr/' }).type, 'family');
  assert.equal(classifyRef({ ref: 'https://socialfactory.co.kr/space', siteHost: 'socialfactory.co.kr' }).type, 'internal');
  assert.equal(classifyRef({ ref: 'https://instagram.com', utmSource: 'meta' }).type, 'campaign');
  assert.equal(normalizePath('/magazine/abc.html?x=1#y'), '/magazine/abc'); assert.equal(normalizePath('/index.html'), '/'); assert.equal(normalizePath('/space/'), '/space');
  assert.equal(parseVisitEvent({ t: 'pv', sid: 'bad id', pvid: 'pageview1' }), null);
  assert.equal(parseVisitEvent({ t: 'click', sid: 'sessiona1', pvid: 'pageview1', kind: 'evil' }), null);
  assert.equal(parseVisitEvent({ t: 'leave', sid: 'sessiona1', pvid: 'pageview1', ms: 99999999 }).ms, 1800000);
  assert.equal(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0)'), 'tablet'); assert.equal(isBot(''), true); assert.equal(isBot('Mozilla/5.0 Chrome/130'), false);
});

test('admin page has a KPI menu and public pages load the visit counter', () => {
  const admin = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const privacy = readFileSync(new URL('../privacy.html', import.meta.url), 'utf8');
  assert(admin.includes('data-view="kpi"') && admin.includes('id="view-kpi"') && admin.includes('/js/admin-kpi.js'));
  assert(main.includes('/js/visit.js'));
  assert(privacy.includes('홈페이지 방문 통계') && privacy.includes('13개월'));
});

test('a leave event that arrives before its page view is applied once the page view is recorded', async () => {
  const env = setup();
  const send = body => visit({ request: new Request('https://socialfactory.co.kr/api/visit', { method: 'POST', headers: { origin: 'https://socialfactory.co.kr', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify(body) }), env });
  const early = send({ t: 'leave', sid: 'sessiond4', pvid: 'pageview9', ms: 5000, scroll: 30 });
  await new Promise(r => setTimeout(r, 60));
  await send({ t: 'pv', sid: 'sessiond4', pvid: 'pageview9', path: '/pricing', entry: 1 });
  await early;
  const row = env.sqlite.prepare("SELECT active_ms, scroll FROM site_visits WHERE pvid='pageview9'").get();
  assert.equal(row.active_ms, 5000); assert.equal(row.scroll, 30);
});
