import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '../functions/_lib/auth.js';
import { handlePublic, readJpeg, nicknameProblem, safeUrl } from '../functions/_lib/community.js';
import { handleAdmin, kstStamp } from '../functions/_lib/community-admin.js';
import { onRequestGet as postPage, metaBlock } from '../functions/community/[id].js';

const SITE = 'https://socialfactory.co.kr';
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const DB = { prepare(sql) {
    let args = [];
    const st = { bind(...v) { args = v; return st; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async first() { return sqlite.prepare(sql).get(...args) || null; }, async run() { return { meta: sqlite.prepare(sql).run(...args) }; } };
    return st;
  }, async batch(list) { sqlite.exec('BEGIN'); try { const r = []; for (const s of list) r.push(await s.run()); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
  return { DB, sqlite, ADMIN_KEY: 'community-admin-key', IP_SALT: 'salt' };
}
async function member(env, name) {
  const id = env.sqlite.prepare("INSERT INTO members (provider, email, name, phone) VALUES ('email', ?, ?, '010-1111-2222')").run(name + '@example.com', name).lastInsertRowid;
  const token = 'token-' + name + '-'.repeat(24);
  env.sqlite.prepare("INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?, ?, datetime('now', '+9 hours', '+1 day'))").run(await sha256Hex(token), id);
  return { id: Number(id), token };
}
async function call(env, method, path, { body, who, admin, headers = {} } = {}) {
  const h = { origin: SITE, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', 'content-type': 'application/json', ...headers };
  if (who) h.cookie = 'sf_session=' + who.token;
  if (admin) h.authorization = 'Bearer ' + env.ADMIN_KEY;
  const request = new Request(SITE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await (path.startsWith('/api/admin/') ? handleAdmin : handlePublic)({ request, env });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : null, res };
}
function jpeg(w = 640, h = 480, pad = 300) {
  const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  for (let i = 0; i < pad; i++) bytes.push(i % 251);
  bytes.push(0xff, 0xd9);
  return Buffer.from(bytes).toString('base64');
}
const group = (extra = {}) => ({
  board: 'groups', category: 'book', title: '건대 새벽 독서모임', summary: '토요일 아침, 한 달에 한 권 같이 읽어요',
  body: '한 달에 한 권을 정해 함께 읽고 이야기합니다. 처음 오시는 분도 편하게 오세요.', recruit: 'open',
  info: { schedule: '매주 토요일 오전 8시', room: 'r3', audience: '20~40대 · 8명 내외', fee: '회당 1만 원', joinUrl: 'open.kakao.com/o/abc123', contactText: '카톡 ID sfbook' },
  ...extra
});

test('helpers validate nicknames, links, JPEG headers and admin timestamps', () => {
  assert.equal(nicknameProblem('독서왕'), '');
  assert.match(nicknameProblem('소셜팩토리 운영팀'), /운영자/);
  assert.match(nicknameProblem('a'), /2~12/);
  assert.match(nicknameProblem('<b>x</b>'), /한글/);
  assert.equal(safeUrl('open.kakao.com/o/x'), 'https://open.kakao.com/o/x');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl(''), '');
  assert.deepEqual(readJpeg(jpeg(800, 600)), { bytes: Buffer.from(jpeg(800, 600), 'base64').length, width: 800, height: 600 });
  assert.equal(readJpeg(Buffer.from('GIF89a' + 'x'.repeat(200)).toString('base64')), null);
  assert.equal(kstStamp('2026-12-01T09:30'), '2026-12-01 09:30:00');
  assert.equal(kstStamp('2026-13-01T09:30'), '');
});

test('members write group posts with links, photos and nickname; anyone can read', async () => {
  const env = setup(); const kim = await member(env, 'kim'); const lee = await member(env, 'lee');
  assert.equal((await call(env, 'POST', '/api/community/posts', { body: group() })).status, 401);
  const noNick = await call(env, 'POST', '/api/community/posts', { body: group(), who: kim });
  assert.equal(noNick.status, 400); assert.equal(noNick.data.error, 'nickname');
  const img = await call(env, 'POST', '/api/community/images', { body: { base64: jpeg() }, who: kim });
  assert.equal(img.status, 200); assert.equal(img.data.width, 640);
  const bad = await call(env, 'POST', '/api/community/posts', { body: group({ info: { joinUrl: 'javascript:x' }, nickname: '독서왕' }), who: kim });
  assert.equal(bad.status, 400); assert.ok(bad.data.fields.joinUrl);
  const created = await call(env, 'POST', '/api/community/posts', { body: group({ nickname: '독서왕', images: [img.data.id, 9999] }), who: kim });
  assert.equal(created.status, 200, JSON.stringify(created.data)); const id = created.data.id;
  const list = await call(env, 'GET', '/api/community/posts?board=groups');
  assert.equal(list.data.total, 1); assert.equal(list.data.posts[0].author.name, '독서왕'); assert.equal(list.data.posts[0].cover, `/api/community/images/${img.data.id}`);
  assert.equal(list.data.posts[0].info.joinUrl, undefined);   // 목록에는 연락처를 싣지 않음
  const detail = await call(env, 'GET', `/api/community/posts/${id}`);
  assert.equal(detail.data.post.info.joinUrl, 'https://open.kakao.com/o/abc123'); assert.equal(detail.data.post.info.roomName, '소셜팩토리 건대 3번룸');
  assert.equal(detail.data.post.mine, false); assert.equal(detail.data.post.images.length, 1);
  assert.equal((await call(env, 'GET', `/api/community/posts/${id}`, { who: kim })).data.post.mine, true);
  // 남의 글은 고치거나 지울 수 없음
  await call(env, 'PUT', '/api/community/profile', { body: { nickname: '보드게임러' }, who: lee });
  assert.equal((await call(env, 'PATCH', `/api/community/posts/${id}`, { body: group(), who: lee })).status, 403);
  assert.equal((await call(env, 'DELETE', `/api/community/posts/${id}`, { who: lee })).status, 403);
  // 같은 닉네임은 못 씀, 운영자 사칭 금지
  assert.equal((await call(env, 'PUT', '/api/community/profile', { body: { nickname: '독서왕' }, who: lee })).status, 400);
  // 사진: 공개 글에 붙은 사진은 누구나, 붙지 않은 사진은 올린 사람만
  const pub = await handlePublic({ request: new Request(`${SITE}/api/community/images/${img.data.id}`), env });
  assert.equal(pub.status, 200); assert.equal(pub.headers.get('content-type'), 'image/jpeg');
  const loose = await call(env, 'POST', '/api/community/images', { body: { base64: jpeg(100, 100) }, who: kim });
  assert.equal((await handlePublic({ request: new Request(`${SITE}/api/community/images/${loose.data.id}`), env })).status, 404);
  // 고치기: 사진 빼고 모집 마감
  const upd = await call(env, 'PATCH', `/api/community/posts/${id}`, { body: group({ recruit: 'closed', images: [] }), who: kim });
  assert.equal(upd.status, 200);
  const after = (await call(env, 'GET', `/api/community/posts/${id}`)).data.post;
  assert.equal(after.recruit, 'closed'); assert.equal(after.images.length, 0);
  assert.equal((await call(env, 'GET', '/api/community/posts?board=groups&recruit=open')).data.total, 0);
  // 다른 사람 출처에서 보낸 요청은 거절
  assert.equal((await call(env, 'POST', '/api/community/posts', { body: group(), who: kim, headers: { origin: 'https://evil.example' } })).status, 403);
  // 지우기
  assert.equal((await call(env, 'DELETE', `/api/community/posts/${id}`, { who: kim })).status, 200);
  assert.equal((await call(env, 'GET', `/api/community/posts/${id}`)).status, 404);
});

test('free board: comments, likes, views, reports and limits', async () => {
  const env = setup(); const kim = await member(env, 'kim'); const lee = await member(env, 'lee');
  const p = await call(env, 'POST', '/api/community/posts', { body: { board: 'free', category: 'question', title: '3번룸 모니터 연결 질문', body: '노트북 HDMI로 바로 연결되나요?', nickname: '질문러' }, who: kim });
  assert.equal(p.status, 200); const id = p.data.id;
  // 공지는 운영자만
  const notice = await call(env, 'POST', '/api/community/posts', { body: { board: 'free', category: 'notice', title: '공지 흉내', body: '공지처럼 쓰기' }, who: lee });
  assert.equal(notice.status, 400);
  // 너무 빨리 또 쓰면 막힘
  assert.equal((await call(env, 'POST', '/api/community/posts', { body: { board: 'free', category: 'talk', title: '두 번째 글', body: '바로 이어서 쓰기' }, who: kim })).status, 429);
  const c1 = await call(env, 'POST', `/api/community/posts/${id}/comments`, { body: { body: '네, HDMI 케이블이 있어요.', nickname: '답변러' }, who: lee });
  assert.equal(c1.status, 200); assert.equal(c1.data.comments.length, 1); assert.equal(c1.data.comments[0].mine, true);
  assert.equal((await call(env, 'POST', `/api/community/posts/${id}/comments`, { body: { body: '' }, who: lee })).status, 400);
  const like = await call(env, 'POST', `/api/community/posts/${id}/like`, { who: lee });
  assert.deepEqual([like.data.liked, like.data.likes], [true, 1]);
  const unlike = await call(env, 'POST', `/api/community/posts/${id}/like`, { who: lee });
  assert.deepEqual([unlike.data.liked, unlike.data.likes], [false, 0]);
  assert.equal((await call(env, 'POST', `/api/community/posts/${id}/like`)).status, 401);
  await call(env, 'POST', `/api/community/posts/${id}/view`);
  await call(env, 'POST', `/api/community/posts/${id}/view`, { headers: { 'user-agent': 'Googlebot/2.1' } });
  const d = (await call(env, 'GET', `/api/community/posts/${id}`)).data.post;
  assert.equal(d.views, 1); assert.equal(d.comments, 1);
  // 신고: 내 글은 못 하고, 같은 사람은 한 번만
  assert.equal((await call(env, 'POST', '/api/community/report', { body: { type: 'post', id, reason: 'spam' }, who: kim })).status, 400);
  assert.equal((await call(env, 'POST', '/api/community/report', { body: { type: 'post', id, reason: 'spam', detail: '광고 같아요' }, who: lee })).data.already, false);
  assert.equal((await call(env, 'POST', '/api/community/report', { body: { type: 'post', id, reason: 'spam' }, who: lee })).data.already, true);
  assert.equal(env.sqlite.prepare('SELECT reports FROM community_posts WHERE id = ?').get(id).reports, 1);
  // 댓글 지우기는 본인만
  const cid = c1.data.comments[0].id;
  assert.equal((await call(env, 'DELETE', `/api/community/comments/${cid}`, { who: kim })).status, 403);
  assert.equal((await call(env, 'DELETE', `/api/community/comments/${cid}`, { who: lee })).data.comments.length, 0);
  // 검색
  assert.equal((await call(env, 'GET', '/api/community/posts?board=free&q=HDMI')).data.total, 1);
  assert.equal((await call(env, 'GET', '/api/community/posts?board=free&q=없는말')).data.total, 0);
});

test('admin manages posts, scheduled notices, reports, settings and member bans', async () => {
  const env = setup(); const kim = await member(env, 'kim'); const lee = await member(env, 'lee');
  assert.equal((await call(env, 'GET', '/api/admin/community/summary')).status, 401);
  const p = await call(env, 'POST', '/api/community/posts', { body: group({ nickname: '독서왕' }), who: kim });
  const id = p.data.id;
  await call(env, 'PUT', '/api/community/profile', { body: { nickname: '신고자' }, who: lee });
  await call(env, 'POST', '/api/community/report', { body: { type: 'post', id, reason: 'privacy' }, who: lee });
  let s = (await call(env, 'GET', '/api/admin/community/summary', { admin: true })).data.summary;
  assert.equal(s.groups, 1); assert.equal(s.openReports, 1);
  const reports = (await call(env, 'GET', '/api/admin/community/reports', { admin: true })).data.groups;
  assert.equal(reports.length, 1); assert.equal(reports[0].target.title, '건대 새벽 독서모임');
  await call(env, 'POST', '/api/admin/community/reports/resolve', { body: { type: 'post', id, action: 'hide' }, admin: true });
  assert.equal((await call(env, 'GET', `/api/community/posts/${id}`)).status, 404);
  const own = (await call(env, 'GET', `/api/community/posts/${id}`, { who: kim })).data.post;
  assert.equal(own.status, 'hidden'); assert.match(own.hiddenReason, /신고/);
  // 다시 공개 + 추천 모임
  const re = await call(env, 'PATCH', `/api/admin/community/posts/${id}`, { body: { status: 'published', featured: true }, admin: true });
  assert.equal(re.data.post.status, 'published'); assert.equal(re.data.post.featured, true);
  assert.equal((await call(env, 'GET', '/api/community/posts?board=groups&featured=1')).data.total, 1);
  // 운영자 공지 — 예약 발행
  const future = new Date(Date.now() + 9 * 3600e3 + 86400e3).toISOString().slice(0, 16);
  const n1 = await call(env, 'POST', '/api/admin/community/posts', { body: { board: 'free', category: 'notice', title: '12월 운영 안내', body: '연말 운영 시간을 안내합니다.', status: 'scheduled', publishAt: future, pinned: true }, admin: true });
  assert.equal(n1.status, 200);
  assert.equal((await call(env, 'GET', '/api/community/posts?board=free')).data.total, 0);
  assert.equal((await call(env, 'GET', '/api/admin/community/posts?status=scheduled', { admin: true })).data.total, 1);
  await call(env, 'PATCH', `/api/admin/community/posts/${n1.data.id}`, { body: { status: 'published' }, admin: true });
  const free = (await call(env, 'GET', '/api/community/posts?board=free')).data.posts;
  assert.equal(free[0].author.staff, true); assert.equal(free[0].pinned, true); assert.equal(free[0].author.name, '소셜팩토리');
  // 운영자 댓글
  const withReply = await call(env, 'POST', `/api/admin/community/posts/${id}/comments`, { body: { body: '좋은 모임 소개 감사합니다.' }, admin: true });
  assert.equal(withReply.data.comments[0].staff, true);
  // 설정: 금지어 · 게시판 닫기 · 자동 숨김
  await call(env, 'PUT', '/api/admin/community/settings', { body: { bannedWords: '도박, 대출', freeOpen: false, autoHide: 1 }, admin: true });
  assert.equal((await call(env, 'POST', '/api/community/posts', { body: { board: 'free', category: 'talk', title: '안녕하세요', body: '첫 글입니다' }, who: lee })).status, 403);
  env.sqlite.exec("UPDATE community_posts SET created_at = datetime('now', '+9 hours', '-1 hour')");
  const banned = await call(env, 'POST', '/api/community/posts', { body: group({ body: '급전 대출 상담 받습니다. 연락 주세요. 언제든 가능합니다.' }), who: kim });
  assert.equal(banned.status, 400); assert.match(banned.data.message, /대출/);
  const c = await call(env, 'POST', `/api/community/posts/${id}/comments`, { body: { body: '모임 시간이 궁금해요' }, who: lee });
  await call(env, 'POST', '/api/community/report', { body: { type: 'comment', id: c.data.comments.at(-1).id, reason: 'abuse' }, who: kim });
  assert.equal(env.sqlite.prepare("SELECT status FROM community_comments WHERE id = ?").get(c.data.comments.at(-1).id).status, 'hidden');
  // 회원 글쓰기 제한
  const members = (await call(env, 'GET', '/api/admin/community/members', { admin: true })).data.members;
  assert.equal(members.length, 2);
  await call(env, 'PATCH', `/api/admin/community/members/${kim.id}`, { body: { banned: true, banReason: '도배' }, admin: true });
  assert.equal((await call(env, 'POST', `/api/community/posts/${id}/comments`, { body: { body: '다시 씁니다' }, who: kim })).status, 403);
  // 완전 삭제
  assert.equal((await call(env, 'DELETE', `/api/admin/community/posts/${id}`, { admin: true })).status, 200);
  assert.equal(env.sqlite.prepare('SELECT COUNT(*) AS c FROM community_comments WHERE post_id = ?').get(id).c, 0);
});

test('/community/123 page carries the post title and photo for link previews', async () => {
  const env = setup(); const kim = await member(env, 'kim');
  const img = await call(env, 'POST', '/api/community/images', { body: { base64: jpeg() }, who: kim });
  const p = await call(env, 'POST', '/api/community/posts', { body: group({ nickname: '독서왕', images: [img.data.id], title: '건대 "새벽" <독서>' }), who: kim });
  const tpl = readFileSync(new URL('../community-post.html', import.meta.url), 'utf8');
  env.ASSETS = { fetch: async (req) => (new URL(req.url).pathname === '/community-post' ? new Response(tpl, { status: 200 }) : new Response('nf', { status: 404 })) };
  const res = await postPage({ request: new Request(`${SITE}/community/${p.data.id}`), env, params: { id: String(p.data.id) } });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes('<meta property="og:title" content="건대 &quot;새벽&quot; &lt;독서&gt;">'));
  assert.ok(html.includes(`content="https://socialfactory.co.kr/api/community/images/${img.data.id}"`));
  assert.ok(html.includes(`<link rel="canonical" href="https://socialfactory.co.kr/community/${p.data.id}">`));
  assert.ok(!/<script type="application\/ld\+json">[^<]*<\/?[a-z]/i.test(html.replace(/<\/script>/g, '')));
  const missing = await postPage({ request: new Request(`${SITE}/community/999`), env, params: { id: '999' } });
  assert.equal(missing.status, 404); assert.ok((await missing.text()).includes('noindex'));
  assert.match(metaBlock(null, 1), /noindex/);
});

test('community pages are linked from the site and admin', () => {
  const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  for (const f of ['index.html', 'about.html', 'space.html', 'magazine.html', 'community.html']) assert.ok(read(f).includes('<a href="/community">커뮤니티</a>'), f);
  const admin = read('admin.html');
  assert.ok(admin.includes('data-view="community"') && admin.includes('id="view-community"') && admin.includes('/js/admin-community.js'));
  assert.ok(read('privacy.html').includes('커뮤니티'));
  assert.ok(read('sitemap.xml').includes('<loc>https://socialfactory.co.kr/community</loc>'));
});
