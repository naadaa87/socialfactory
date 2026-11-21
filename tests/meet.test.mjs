import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { handlePublic, purgeOld, DEFAULT_WIFI, kstDate } from '../functions/_lib/meet.js';
import { handleAdmin } from '../functions/_lib/meet-admin.js';
import { onRequestGet as invitePage, metaBlock } from '../functions/i/[slug].js';

const SITE = 'https://socialfactory.co.kr';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(read('schema.sql'));
  const DB = { prepare(sql) {
    let args = [];
    const st = { bind(...v) { args = v; return st; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async first() { return sqlite.prepare(sql).get(...args) || null; }, async run() { return { meta: sqlite.prepare(sql).run(...args) }; } };
    return st;
  }, async batch(list) { sqlite.exec('BEGIN'); try { const r = []; for (const s of list) r.push(await s.run()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
  return { DB, sqlite, ADMIN_KEY: 'meet-admin-key', IP_SALT: 'salt' };
}
async function call(env, method, path, { body, admin, headers = {} } = {}) {
  const h = { origin: SITE, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers };
  if (admin) h.authorization = 'Bearer ' + env.ADMIN_KEY;
  const request = new Request(SITE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await (path.startsWith('/api/admin/') ? handleAdmin : handlePublic)({ request, env });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : null, text: type.includes('json') ? '' : await res.text(), res };
}
const plusDays = (n) => kstDate(Date.now() + n * 86400e3);
function booking(env, { code = 'R261124-ABCD', token = 'tok-' + 'x'.repeat(28), date = plusDays(3), room = 'r3', start = 1140, end = 1320, status = 'confirmed', purpose = 'study' } = {}) {
  env.sqlite.prepare(`INSERT INTO booking_requests (code, submission_id, fingerprint, status, room, date, start_min, end_min, people, customer_name, phone, purpose, amount, consent, notice_version)
    VALUES (?, ?, 'fp', ?, ?, ?, ?, ?, 8, '김예약', '010-0000-0000', ?, 60000, 1, 'v1')`).run(code, 'sub-' + code, status, room, date, start, end, purpose);
  env.sqlite.prepare("INSERT INTO booking_payapp_requests (code, kind, label, amount, token, status) VALUES (?, 'room', '3번룸', 60000, ?, 'paid')").run(code, token);
  return { code, token };
}
const dev = (n) => 'device' + String(n).padStart(12, '0');

test('예약 확인: 조회 링크가 맞아야 하고, 확정된 예약만 초대장을 만들 수 있습니다', async () => {
  const env = setup();
  const b = booking(env);
  assert.equal((await call(env, 'POST', '/api/meet/booking', { body: { code: b.code, t: 'wrong-token' } })).status, 404);
  const ok = await call(env, 'POST', '/api/meet/booking', { body: { code: b.code, t: b.token } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.eligible, true);
  assert.equal(ok.data.invite, null);
  assert.equal(ok.data.booking.spaceName, '3번룸');
  assert.equal(ok.data.booking.suggestedTheme, 'study');
  const foreign = await call(env, 'POST', '/api/meet/booking', { body: { code: b.code, t: b.token }, headers: { origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403);
  const p = booking(env, { code: 'R261124-WAIT', token: 'tok-' + 'w'.repeat(28), status: 'awaiting_payment', room: 'r1' });
  const notYet = await call(env, 'POST', '/api/meet/booking/invite', { body: { code: p.code, t: p.token, title: '모임' } });
  assert.equal(notYet.status, 409);
});

test('초대장 만들기 → 공개 화면 → 참석 응답 → 관리 화면', async () => {
  const env = setup();
  const b = booking(env);
  const made = await call(env, 'POST', '/api/meet/booking/invite', { body: { code: b.code, t: b.token, title: '화요 독서모임', hostName: '민지', message: '책 꼭 읽어 오세요\nhttps://open.kakao.com/o/test' } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.match(made.data.url, /^https:\/\/socialfactory\.co\.kr\/i\/[a-z0-9]{10}$/);
  assert.match(made.data.key, /^[A-Za-z0-9_-]{16,80}$/);
  const again = await call(env, 'POST', '/api/meet/booking/invite', { body: { code: b.code, t: b.token, title: '다른 이름' } });
  assert.equal(again.data.slug, made.data.slug, '한 예약에는 초대장이 하나만 생깁니다');
  const status = await call(env, 'POST', '/api/meet/booking', { body: { code: b.code, t: b.token } });
  assert.equal(status.data.invite.slug, made.data.slug);

  const slug = made.data.slug;
  const pub = await call(env, 'GET', '/api/meet/invite/' + slug, { headers: { 'x-device': dev(1) } });
  const inv = pub.data.invite;
  assert.equal(inv.title, '화요 독서모임');
  assert.equal(inv.host, '민지');
  assert.equal(inv.theme, 'study');
  assert.equal(inv.spaceName, '3번룸');
  assert.equal(inv.capacity, 16);
  assert.equal(inv.phase, 'upcoming');
  assert.deepEqual(inv.wifi, [], '사흘 뒤 모임에는 아직 와이파이가 보이지 않습니다');
  assert.equal(inv.mine, null);
  assert.equal(inv.place.road, '서울 광진구 능동로13길 39');
  assert.ok(!('names' in inv), '이름 공개를 고르지 않으면 이름 목록이 없습니다');

  assert.equal((await call(env, 'POST', `/api/meet/invite/${slug}/rsvp`, { body: { device: 'short', name: '준호', answer: 'yes' } })).status, 400);
  assert.equal((await call(env, 'POST', `/api/meet/invite/${slug}/rsvp`, { body: { device: dev(1), name: ' ', answer: 'yes' } })).status, 400);
  const r1 = await call(env, 'POST', `/api/meet/invite/${slug}/rsvp`, { body: { device: dev(1), name: '준호', answer: 'yes', note: '10분 늦어요', car: true } });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.invite.counts.yes, 1);
  assert.equal(r1.data.invite.mine.car, true);
  await call(env, 'POST', `/api/meet/invite/${slug}/rsvp`, { body: { device: dev(2), name: '서연', answer: 'no', car: true } });
  const r1b = await call(env, 'POST', `/api/meet/invite/${slug}/rsvp`, { body: { device: dev(1), name: '준호', answer: 'yes', note: '' } });
  assert.equal(r1b.data.invite.counts.yes, 1, '같은 기기에서 다시 보내면 고쳐집니다');

  assert.equal((await call(env, 'GET', '/api/meet/manage/' + slug, { headers: { 'x-invite-key': 'wrong-key-wrong-key' } })).status, 404);
  const man = await call(env, 'GET', '/api/meet/manage/' + slug, { headers: { 'x-invite-key': made.data.key } });
  assert.equal(man.status, 200);
  assert.equal(man.data.invite.responses.length, 2);
  assert.deepEqual(man.data.invite.counts, { yes: 1, no: 1, cars: 0 }, '불참 응답의 차량은 세지 않습니다');
  assert.equal(man.data.invite.people, 8);

  const patched = await call(env, 'PATCH', '/api/meet/manage/' + slug, { body: { title: '화요 독서모임 3회차', showNames: true }, headers: { 'x-invite-key': made.data.key } });
  assert.equal(patched.data.invite.title, '화요 독서모임 3회차');
  const pub2 = await call(env, 'GET', '/api/meet/invite/' + slug);
  assert.deepEqual(pub2.data.invite.names, ['준호']);

  const no = man.data.invite.responses.find((r) => r.answer === 'no');
  const del = await call(env, 'DELETE', `/api/meet/manage/${slug}/rsvp/${no.id}`, { headers: { 'x-invite-key': made.data.key } });
  assert.equal(del.data.invite.responses.length, 1);
  const mine = await call(env, 'DELETE', `/api/meet/invite/${slug}/rsvp`, { body: { device: dev(1) } });
  assert.equal(mine.data.invite.counts.yes, 0);

  const closed = await call(env, 'PATCH', '/api/meet/manage/' + slug, { body: { status: 'closed' }, headers: { 'x-invite-key': made.data.key } });
  assert.equal(closed.data.invite.phase, 'closed');
  assert.equal((await call(env, 'POST', `/api/meet/invite/${slug}/rsvp`, { body: { device: dev(3), name: '도윤', answer: 'yes' } })).status, 409);

  const ics = await call(env, 'GET', `/api/meet/invite/${slug}/calendar.ics`);
  assert.match(ics.text, /BEGIN:VCALENDAR/);
  assert.match(ics.text, /SUMMARY:화요 독서모임 3회차/);
  assert.match(ics.text, /TRIGGER:-PT1H/);
});

test('예약이 취소되면 초대장도 닫힙니다', async () => {
  const env = setup();
  const b = booking(env);
  const made = await call(env, 'POST', '/api/meet/booking/invite', { body: { code: b.code, t: b.token, title: '스터디' } });
  env.sqlite.prepare("UPDATE booking_requests SET status = 'cancelled' WHERE code = ?").run(b.code);
  const pub = await call(env, 'GET', '/api/meet/invite/' + made.data.slug);
  assert.equal(pub.data.invite.phase, 'closed');
  assert.equal(pub.data.invite.rsvpOpen, false);
});

test('룸 가이드: 방 키가 맞을 때만 와이파이가 보이고, 주소를 바꾸면 예전 QR은 막힙니다', async () => {
  const env = setup();
  const none = await call(env, 'GET', '/api/meet/room/r3');
  assert.equal(none.data.keyValid, false);
  assert.deepEqual(none.data.wifi, []);
  assert.equal((await call(env, 'GET', '/api/meet/room/r9')).status, 404);
  assert.equal((await call(env, 'GET', '/api/admin/meet/rooms')).status, 401, '관리자 로그인이 필요합니다');
  const rooms = (await call(env, 'GET', '/api/admin/meet/rooms', { admin: true })).data.rooms;
  assert.deepEqual(rooms.map((r) => r.id), ['r1', 'r2', 'r3', 'r4', 'r5', 'coworking', 'lounge', 'office']);
  const keyOf = (id) => new URL(rooms.find((r) => r.id === id).url).searchParams.get('k');
  const wifi = async (id, k) => (await call(env, 'GET', `/api/meet/room/${id}?k=${k}`)).data;
  const r3 = await wifi('r3', keyOf('r3'));
  assert.equal(r3.keyValid, true);
  assert.deepEqual(r3.wifi.map((n) => n.ssids[0]), ['SocialFactory_2.4G', 'SocialFactory2_2.4G'], '3번룸은 두 와이파이가 모두 잡힙니다');
  assert.equal(r3.wifi[0].password, '1234567890');
  assert.deepEqual((await wifi('r1', keyOf('r1'))).wifi.map((n) => n.ssids.length), [2], '1번룸은 SocialFactory2 만');
  assert.deepEqual((await wifi('r5', keyOf('r5'))).wifi[0].ssids, ['SocialFactory_2.4G', 'SocialFactory_5G', 'SocialFactory_6G']);
  for (const id of ['coworking', 'lounge', 'office']) assert.equal((await wifi(id, keyOf(id))).wifi.length, 1, id);
  assert.equal((await wifi('r1', keyOf('r3'))).keyValid, false, '다른 방의 키로는 열리지 않습니다');

  const old = keyOf('r3');
  await call(env, 'POST', '/api/admin/meet/rooms/rotate', { admin: true, body: { space: 'r3' } });
  assert.equal((await wifi('r3', old)).keyValid, false);
  assert.equal((await wifi('r4', keyOf('r4'))).keyValid, true, '다른 방 키는 그대로입니다');

  const bad = await call(env, 'PUT', '/api/admin/meet/wifi', { admin: true, body: { networks: [{ ssids: 'New_5G', password: 'pw', spaces: [] }] } });
  assert.equal(bad.status, 400);
  const saved = await call(env, 'PUT', '/api/admin/meet/wifi', { admin: true, body: { networks: [{ ssids: 'SF_New_5G, SF_New_2.4G', password: 'newpass11', spaces: ['r4', 'nope'] }] } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.wifi.networks[0].spaces, ['r4']);
  assert.deepEqual((await wifi('r4', keyOf('r4'))).wifi, [{ ssids: ['SF_New_5G', 'SF_New_2.4G'], password: 'newpass11' }]);
  assert.deepEqual((await wifi('r5', keyOf('r5'))).wifi, [], '저장한 목록에 없는 공간은 비어 있습니다');
  const got = await call(env, 'GET', '/api/admin/meet/wifi', { admin: true });
  assert.deepEqual(got.data.defaults, DEFAULT_WIFI);
});

test('관리자: 다른 채널 예약용 초대장을 만들면 모임 당일에는 와이파이와 출입 안내가 보입니다', async () => {
  const env = setup();
  const today = kstDate();
  const made = await call(env, 'POST', '/api/admin/meet/invites', { admin: true, body: { space: 'r3', date: today, startMin: 0, endMin: 1410, title: '스페이스클라우드 워크숍', hostName: '박팀장', entryNote: '현관 비밀번호는 담당자 문자 확인', memo: '스클 예약' } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const pub = (await call(env, 'GET', '/api/meet/invite/' + made.data.slug)).data.invite;
  assert.equal(pub.wifi.length, 2);
  assert.equal(pub.entry, '현관 비밀번호는 담당자 문자 확인');
  assert.equal((await call(env, 'POST', '/api/admin/meet/invites', { admin: true, body: { space: 'office', date: today, startMin: 600, endMin: 720, title: 'x' } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/admin/meet/invites', { admin: true, body: { space: 'r2', date: today, startMin: 615, endMin: 720, title: 'x' } })).status, 400);
  assert.equal((await call(env, 'POST', '/api/admin/meet/invites', { admin: true, body: { space: 'r2', date: plusDays(-5), startMin: 600, endMin: 720, title: 'x' } })).status, 400);

  const list = await call(env, 'GET', '/api/admin/meet/invites?scope=upcoming', { admin: true });
  assert.equal(list.data.invites.length, 1);
  assert.equal(list.data.invites[0].source, 'admin');
  assert.equal((await call(env, 'GET', '/api/admin/meet/invites?q=' + encodeURIComponent('스클'), { admin: true })).data.invites.length, 1, '운영 메모로도 찾습니다');
  const id = list.data.invites[0].id;
  const moved = await call(env, 'PATCH', '/api/admin/meet/invites/' + id, { admin: true, body: { space: 'r5', startMin: 600, endMin: 780 } });
  assert.equal(moved.data.invite.spaceName, '5번룸');
  const sum = await call(env, 'GET', '/api/admin/meet/summary', { admin: true });
  assert.equal(sum.data.summary.today, 1);
  assert.equal((await call(env, 'DELETE', '/api/admin/meet/invites/' + id, { admin: true })).status, 200);
  assert.equal((await call(env, 'GET', '/api/meet/invite/' + made.data.slug)).status, 404);
});

test('지난 모임의 초대장과 응답은 30일 뒤 지워집니다', async () => {
  const env = setup();
  const made = await call(env, 'POST', '/api/admin/meet/invites', { admin: true, body: { space: 'r1', date: kstDate(), startMin: 600, endMin: 720, title: '지난 모임' } });
  env.sqlite.prepare("INSERT INTO meet_rsvps (invite_id, device, name, answer) VALUES (?, ?, '누군가', 'yes')").run(made.data.id, dev(9));
  env.sqlite.prepare('UPDATE meet_invites SET date = ? WHERE id = ?').run(plusDays(-31), made.data.id);
  await purgeOld(env);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS c FROM meet_invites').get().c, 0);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS c FROM meet_rsvps').get().c, 0);
});

test('/i/초대장: 카카오톡 미리보기용 제목을 넣고 검색에는 나오지 않게 합니다', async () => {
  const env = setup();
  const b = booking(env);
  const made = await call(env, 'POST', '/api/meet/booking/invite', { body: { code: b.code, t: b.token, title: '화요 <독서> 모임', hostName: '민지' } });
  const tpl = read('meet-invite.html');
  env.ASSETS = { fetch: async () => new Response(tpl, { status: 200 }) };
  const res = await invitePage({ request: new Request(SITE + '/i/' + made.data.slug), env, params: { slug: made.data.slug } });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(html, /<title>화요 &lt;독서&gt; 모임 · \d+월 \d+일\([일월화수목금토]\) 오후 7시 \| 소셜팩토리 건대<\/title>/);
  assert.match(html, /og:description" content="민지님이 소셜팩토리 건대 3번룸에서 여는 모임에 초대합니다/);
  assert.equal((html.match(/<title>/g) || []).length, 1, '원래 제목은 바뀐 제목으로 대신합니다');
  const missing = await invitePage({ request: new Request(SITE + '/i/zzzzzzzzzz'), env, params: { slug: 'zzzzzzzzzz' } });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /초대장을 찾을 수 없습니다/);
  assert.match(metaBlock(null, 'x'), /noindex/);
});

test('페이지 · 바닥글 · 모임 도구 데이터', () => {
  for (const f of ['meet-invite.html', 'meet-manage.html', 'room.html', 'play.html']) {
    const html = read(f);
    assert.ok(html.includes('class="site-header"') && html.includes('class="site-footer"'), f);
    assert.ok(!/(src|href)="(images|css|js)\//.test(html), f + ': 상대 경로');
    assert.equal(/noindex/.test(html), f !== 'play.html', f + ': 검색 노출 설정');
  }
  assert.match(read('meet-invite.html'), /<!-- MEET:META:START -->[\s\S]+<!-- MEET:META:END -->/);
  assert.match(read('booking-status.html'), /data-meet-booking/);
  assert.match(read('admin.html'), /data-view="meet"/);
  assert.match(read('sitemap.xml'), /socialfactory\.co\.kr\/play</);
  for (const f of ['index.html', 'guide.html', 'about.html', 'community.html', 'privacy.html']) assert.match(read(f), /<a href="\/play">모임 도구 · 게임<\/a>/, f);
  assert.ok(existsSync(new URL('../js/vendor/qrcode.js', import.meta.url)));
  const ctx = { window: {} }; vm.createContext(ctx);
  vm.runInContext(read('js/play-data.js'), ctx);
  const D = ctx.window.SF_PLAY_DATA;
  assert.ok(D.decks.every((d) => d.items.length >= 12 && new Set(d.items).size === d.items.length), '대화 카드 묶음마다 12문항 이상, 중복 없음');
  assert.ok(D.bingo.length >= 25, '5×5 빙고를 채울 만큼 있어야 합니다');
  assert.ok(D.words.filter((c) => !c.quiz).every((c) => c.items.length >= 10 && new Set(c.items).size === c.items.length), '라이어 게임 주제마다 10개 이상');
  const tools = new Set(['timer', 'teams', 'order', 'wheel', 'ladder', 'split', 'cards', 'balance', 'bingo', 'liar', 'chosung', 'speed']);
  for (const r of D.recipes) for (const s of r.steps) assert.ok(tools.has(s[0]), r.name + ': ' + s[0]);
  const play = read('play.html');
  for (const t of tools) assert.ok(play.includes(`href="#${t}"`), t + ' 카드');
});
