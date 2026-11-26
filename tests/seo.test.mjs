import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { build, loadData } from '../scripts/magazine.mjs';
import { hubsFor, LANDING_ROUTES, llmsTxt } from '../scripts/landing.mjs';
import { audit, stampSitemap, fingerprint } from '../scripts/seo.mjs';
import { INDEXNOW_KEY, INDEXNOW_HOST, parseSitemap, changedUrls, pingIndexNow } from '../functions/_lib/indexnow.js';
import { onRequestGet as communitySitemap } from '../functions/sitemap-community.xml.js';
import { COMMUNITY_SCHEMA } from '../functions/_lib/community.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://socialfactory.co.kr';
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const result = build({ write: false });
const data = loadData();
const landing = LANDING_ROUTES.map((r) => ({ route: r, file: `${r.slice(1)}.html` }));
const ldOf = (html) => JSON.parse(/<script type="application\/ld\+json" id="sf-ldjson">(.*?)<\/script>/s.exec(html)[1]);
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  const DB = { prepare(sql) { let args = []; const st = { bind(...v) { args = v; return st; },
    async first() { return sqlite.prepare(sql).get(...args) || null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; },
    async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; } }; return st; } };
  return { DB, sqlite };
}

test('안내 페이지 13개가 만들어지고 저장소 파일과 같습니다', () => {
  assert.equal(landing.length, 13);
  for (const { file } of landing) {
    assert.ok(result.contents.has(file), `${file} 가 만들어지지 않았습니다`);
    assert.equal(read(file), result.contents.get(file), `${file} 가 원본과 다릅니다 — node scripts/magazine.mjs 를 실행하세요`);
  }
});

test('안내 페이지: 제목 · 설명 · 대표 주소 · h1 · 자리표시 · 예약 링크', () => {
  const titles = new Set();
  for (const { route, file } of landing) {
    const html = result.contents.get(file);
    assert.ok(html.includes(`<link rel="canonical" href="${SITE}${route}">`), `${file}: canonical`);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${file}: h1 한 개`);
    assert.ok(!html.includes('{{'), `${file}: 채워지지 않은 자리표시가 있습니다`);
    const title = /<title>(.*?)<\/title>/.exec(html)[1];
    assert.ok(title.length >= 20 && title.length <= 60, `${file}: 제목 길이 ${title.length}`);
    assert.ok(/건대/.test(title) && /소셜팩토리 건대$/.test(title), `${file}: 제목에 지역과 상호`);
    assert.ok(!titles.has(title), `${file}: 제목이 겹칩니다`); titles.add(title);
    const desc = /<meta name="description" content="([^"]*)"/.exec(html)[1];
    assert.ok(desc.length >= 60 && desc.length <= 160, `${file}: 설명 길이 ${desc.length}`);
    assert.ok(html.includes('class="site-header"') && html.includes('class="site-footer"'), `${file}: 머리글 · 바닥글`);
    assert.ok(html.includes('/css/landing.css?v='), `${file}: landing.css`);
    assert.ok(!/(src|href)="(images|css|js)\//.test(html), `${file}: 상대 경로가 남아 있습니다`);
    assert.ok(/href="\/booking|href="\/contact\?purpose=office|href="#pass"/.test(html), `${file}: 예약 · 문의로 가는 길`);
    for (const banned of ['업계 1위', '국내 최초', '최고의', '페이앱', '스페이스클라우드']) assert.ok(!textOf(html.slice(html.indexOf('<main'), html.indexOf('</main>'))).includes(banned), `${file}: '${banned}' 표현`);
  }
});

test('안내 페이지: 구조화 데이터와 화면의 질문 · 답이 같습니다', () => {
  for (const { route, file } of landing) {
    const html = result.contents.get(file); const ld = ldOf(html); const graph = ld['@graph'];
    const types = graph.map((n) => n['@type']);
    for (const t of ['WebPage', 'BreadcrumbList', 'FAQPage']) assert.ok(types.includes(t), `${file}: ${t} 없음`);
    const faq = graph.find((n) => n['@type'] === 'FAQPage');
    assert.ok(faq.mainEntity.length >= 4, `${file}: 질문 4개 이상`);
    const text = textOf(html);
    for (const q of faq.mainEntity) {
      assert.ok(text.includes(q.name), `${file}: 화면에 없는 질문 — ${q.name}`);
      assert.ok(text.includes(q.acceptedAnswer.text), `${file}: 화면과 다른 답 — ${q.name}`);
    }
    const crumbs = graph.find((n) => n['@type'] === 'BreadcrumbList').itemListElement;
    assert.equal(crumbs.at(-1).item, SITE + route);
    if (route.startsWith('/rooms/')) {
      const room = graph.find((n) => n['@type'] === 'MeetingRoom'); const key = `r${route.at(-1)}`;
      assert.equal(room.maximumAttendeeCapacity, data.rate[key].max);
      assert.deepEqual(room.containedInPlace, { '@id': `${SITE}/#place` });
      const offer = graph.find((n) => n['@type'] === 'Service').offers;
      assert.equal(offer.lowPrice, Math.min(data.rate[key].wdEarly, data.rate[key].hdEarly));
      assert.equal(offer.highPrice, Math.max(data.rate[key].wdStd, data.rate[key].hdStd));
      assert.ok(text.includes(`${data.rate[key].wdEarly.toLocaleString('en-US')}원`), `${file}: 화면에 요금`);
    }
  }
});

test('안내 페이지 · 주요 페이지의 내부 링크가 실제 파일과 위치를 가리킵니다', () => {
  const pages = [...landing.map((l) => l.file), 'index.html', 'space.html', 'guide.html', 'pricing.html'];
  const fileFor = (u) => {
    const base = u.split(/[?#]/)[0];
    if (base === '/') return 'index.html';
    const rel = base.replace(/^\//, '');
    if (fs.existsSync(path.join(ROOT, rel)) && fs.statSync(path.join(ROOT, rel)).isFile()) return rel;
    return rel + '.html';
  };
  for (const rel of pages) {
    const html = result.contents.get(rel) || read(rel);
    for (const [, attr, u] of html.matchAll(/\b(href|src)="(\/[^"/][^"]*|\/)"/g)) {
      if (u.startsWith('/api/')) continue;
      const f = fileFor(u);
      assert.ok(fs.existsSync(path.join(ROOT, f)) || result.contents.has(f), `${rel}: ${attr}=${u} → ${f} 없음`);
      const hash = u.split('#')[1];
      if (attr === 'href' && hash && f.endsWith('.html') && f !== 'magazine.html') {
        const target = result.contents.get(f) || read(f);
        assert.ok(target.includes(`id="${hash}"`), `${rel}: ${u} 의 #${hash} 위치가 없습니다`);
      }
    }
  }
});

test('모든 페이지 머리글이 코워킹 · 독립사무실 안내 페이지로 연결됩니다', () => {
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.html'))) {
    const html = read(f);
    if (!html.includes('class="nav-links"')) continue;
    const nav = html.slice(html.indexOf('class="nav-links"'), html.indexOf('</nav>', html.indexOf('class="nav-links"')));
    assert.ok(nav.includes('href="/coworking"') && nav.includes('href="/office"'), `${f}: 머리글 메뉴`);
    assert.ok(!html.includes('href="/space#coworking"') && !html.includes('href="/space#office"'), `${f}: 예전 주소가 남아 있습니다`);
  }
});

test('검색용 기본 항목 점검에 오류가 없습니다', () => {
  const r = audit();
  assert.deepEqual(r.errors, []);
  assert.ok(r.indexable >= 60);
});

test('사이트맵 · robots.txt · llms.txt · RSS', () => {
  const sitemap = result.contents.get('sitemap.xml');
  for (const { route } of landing) assert.ok(sitemap.includes(`<loc>${SITE}${route}</loc>`), `사이트맵에 ${route} 없음`);
  assert.ok(result.contents.get('rss.xml').includes(`<link>${SITE}/coworking</link>`));
  const robots = read('robots.txt');
  assert.ok(robots.includes(`Sitemap: ${SITE}/sitemap.xml`) && robots.includes(`Sitemap: ${SITE}/sitemap-community.xml`));
  assert.ok(!/Disallow:\s*\/\s*$/m.test(robots), '전체 차단 규칙이 없어야 합니다');
  const llms = result.contents.get('llms.txt');
  assert.equal(read('llms.txt'), llms);
  assert.equal(llms, llmsTxt(data));
  assert.ok(llms.startsWith('# 소셜팩토리 건대'));
  for (const r of Object.values(data.rate)) assert.ok(llms.includes(`최대 ${r.max}명`));
  for (const { route } of landing) assert.ok(llms.includes(`${SITE}${route}`), `llms.txt 에 ${route} 없음`);
});

test('매거진 글: 요점 상자 · 한눈에 보기 · 이어지는 안내', () => {
  for (const p of result.posts) {
    const html = result.contents.get(`magazine/${p.slug}.html`);
    assert.ok(p.summary.length >= 2 && p.summary.length <= 4, `${p.slug}: summary`);
    assert.ok(html.includes('class="mz-summary"') && html.includes('class="mz-facts"'), `${p.slug}: 상자`);
    assert.ok(!p.seoTitle || p.seoTitle.length <= 42, `${p.slug}: seoTitle ${p.seoTitle && p.seoTitle.length}자`);
    assert.equal(ldOf(html)['@graph'][0].abstract, p.summary.join(' '));
    for (const h of hubsFor(p)) assert.ok(LANDING_ROUTES.includes(h.href));
  }
  assert.deepEqual(hubsFor({ title: '건대 소규모 회의실 3번룸', tags: ['건대 회의실', '건대 스터디룸'] }).map((h) => h.href), ['/rooms/3', '/for/meeting', '/for/study']);
  assert.deepEqual(hubsFor({ title: '아무 글', tags: [], hubs: ['/office', '/없는주소'] }).map((h) => h.href), ['/office']);
});

test('사이트맵 수정일: 본문이 바뀐 페이지만 오늘 날짜로', () => {
  const page = (body) => `<html><head><title>t</title><link href="/css/style.css?v=1"></head><body><header>h</header><main id="main">${body}</main></body></html>`;
  const xml = `<urlset>\n  <url><loc>${SITE}/a</loc><lastmod>2026-01-01</lastmod></url>\n  <url><loc>${SITE}/b</loc><lastmod>2026-01-01</lastmod></url>\n  <!-- MAGAZINE:START -->\n  <url><loc>${SITE}/rooms/1</loc><lastmod>2026-02-02</lastmod></url>\n  <!-- MAGAZINE:END -->\n</urlset>`;
  const files = { 'a.html': page('가'), 'b.html': page('나'), 'rooms/1.html': page('방') };
  const memory = { '/a': { hash: fingerprint(files['a.html']), lastmod: '2026-03-03' }, '/b': { hash: 'old', lastmod: '2026-03-03' } };
  const r = stampSitemap(xml, { read: (rel) => files[rel] ?? null, memory, today: '2026-12-01' });
  assert.ok(r.xml.includes(`<loc>${SITE}/a</loc><lastmod>2026-03-03</lastmod>`));
  assert.ok(r.xml.includes(`<loc>${SITE}/b</loc><lastmod>2026-12-01</lastmod>`));
  assert.ok(r.xml.includes(`<loc>${SITE}/rooms/1</loc><lastmod>2026-02-02</lastmod>`), '매거진 구역은 건드리지 않습니다');
  assert.deepEqual(r.changed, ['/b']);
  assert.equal(fingerprint(page('가')), fingerprint(page('가').replace('?v=1', '?v=2').replace('<header>h</header>', '<header>바뀐 머리글</header>')), '버전값 · 머리글만 바뀐 것은 수정으로 치지 않습니다');
  assert.notEqual(fingerprint(page('가')), fingerprint(page('가나')));
});

test('IndexNow: 열쇠 파일과 배포 묶음', () => {
  assert.match(INDEXNOW_KEY, /^[0-9a-f]{32}$/);
  assert.equal(read(`${INDEXNOW_KEY}.txt`), INDEXNOW_KEY);
  const pages = read('scripts/build-pages.mjs');
  for (const s of ["'rooms'", "'for'", "'llms.txt'", '[0-9a-f]{32}']) assert.ok(pages.includes(s), `build-pages.mjs 에 ${s} 없음`);
});

test('IndexNow: 새로 생기거나 수정일이 바뀐 주소만 알립니다', async () => {
  assert.deepEqual(parseSitemap(`<url><loc>${SITE}/a</loc><lastmod>2026-01-01</lastmod></url><url><loc>${SITE}/b</loc></url>`), { [`${SITE}/a`]: '2026-01-01', [`${SITE}/b`]: '' });
  assert.deepEqual(changedUrls({ a: '1', b: '1' }, { a: '1', b: '2', c: '1' }), ['b', 'c']);
  const env = d1(); const origin = `https://${INDEXNOW_HOST}`;
  let sitemap = `<urlset><url><loc>${SITE}/</loc><lastmod>2026-11-27</lastmod></url><url><loc>${SITE}/space</loc><lastmod>2026-11-27</lastmod></url></urlset>`;
  let community = `<urlset><url><loc>${SITE}/community/3</loc><lastmod>2026-11-20</lastmod></url></urlset>`;
  const sent = []; let status = 200;
  const fetcher = async (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/sitemap.xml') return new Response(sitemap);
    if (u.pathname === '/sitemap-community.xml') return community == null ? new Response('x', { status: 500 }) : new Response(community);
    sent.push({ host: u.host, body: JSON.parse(await req.text()) });
    return new Response('', { status });
  };
  assert.deepEqual(await pingIndexNow(env, 'https://preview.pages.dev', { fetcher }), { skipped: 'not-production' });
  const t0 = 1_800_000_000_000;
  let r = await pingIndexNow(env, origin, { fetcher, now: t0 });
  assert.equal(r.submitted, 3);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((s) => s.host), ['api.indexnow.org', 'searchadvisor.naver.com']);
  assert.equal(sent[0].body.key, INDEXNOW_KEY); assert.equal(sent[0].body.host, INDEXNOW_HOST);
  assert.equal(sent[0].body.keyLocation, `${SITE}/${INDEXNOW_KEY}.txt`);
  assert.equal(sent[0].body.urlList.length, 3);
  assert.deepEqual(await pingIndexNow(env, origin, { fetcher, now: t0 + 60_000 }), { skipped: 'recent' });
  assert.deepEqual(await pingIndexNow(env, origin, { fetcher, now: t0 + 31 * 60_000 }), { submitted: 0 });
  // 한 페이지가 바뀌고 커뮤니티 사이트맵을 못 읽은 경우: 바뀐 한 주소만 보내고, 커뮤니티 주소는 다시 보내지 않습니다
  sitemap = sitemap.replace(`${SITE}/space</loc><lastmod>2026-11-27`, `${SITE}/space</loc><lastmod>2026-12-01`); community = null; sent.length = 0;
  r = await pingIndexNow(env, origin, { fetcher, now: t0 + 62 * 60_000 });
  assert.equal(r.submitted, 1); assert.deepEqual(sent[0].body.urlList, [`${SITE}/space`]);
  // 검색엔진이 받지 않으면 기록하지 않고 다음에 다시 보냅니다
  sitemap = sitemap.replace(`${SITE}/</loc><lastmod>2026-11-27`, `${SITE}/</loc><lastmod>2026-12-02`); status = 500; sent.length = 0;
  r = await pingIndexNow(env, origin, { fetcher, now: t0 + 93 * 60_000 });
  assert.equal(r.submitted, 0); assert.equal(sent.length, 2);
  status = 202; sent.length = 0;
  r = await pingIndexNow(env, origin, { fetcher, now: t0 + 124 * 60_000 });
  assert.equal(r.submitted, 1); assert.deepEqual(sent[0].body.urlList, [`${SITE}/`]);
});

test('커뮤니티 사이트맵: 공개된 글만 넣습니다', async () => {
  const env = d1();
  for (const sql of COMMUNITY_SCHEMA) env.sqlite.exec(sql);
  const add = (id, status, publish, deleted = null) => env.sqlite.prepare("INSERT INTO community_posts (id, board, category, status, author_name, title, body, publish_at, updated_at, deleted_at) VALUES (?, 'groups', 'study', ?, '모임장', '제목', '본문', ?, ?, ?)").run(id, status, publish, publish, deleted);
  add(1, 'published', '2026-11-01 10:00:00'); add(2, 'hidden', '2026-11-02 10:00:00'); add(3, 'published', '2999-01-01 10:00:00'); add(4, 'published', '2026-11-03 10:00:00', '2026-11-04 10:00:00');
  const res = await communitySitemap({ env });
  assert.equal(res.headers.get('content-type'), 'application/xml; charset=utf-8');
  const xml = await res.text();
  assert.ok(xml.includes(`<loc>${SITE}/community/1</loc><lastmod>2026-11-01</lastmod>`));
  for (const id of [2, 3, 4]) assert.ok(!xml.includes(`/community/${id}<`), `글 ${id} 는 빠져야 합니다`);
  assert.ok((await (await communitySitemap({ env: {} })).text()).includes('<urlset'));
});
