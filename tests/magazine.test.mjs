import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdown, resolveTokens, parseFrontMatter, loadData, build } from '../scripts/magazine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('마크다운: 소제목 · 목록 · 표 · 안내 상자 · 링크', () => {
  const { blocks, toc } = markdown([
    '## 첫째 소제목', '문단 **강조** 와 [공간](/space#rooms), [외부](https://megaspot.kr).', '',
    '- 하나', '- 둘', '', '1. 첫째', '2. 둘째', '',
    '> **팁**', '> 안내 문장', '',
    '| 룸 | 인원 |', '| --- | --- |', '| 3번룸 | 16명 |', '',
    '![설명](/images/og-image.jpg "캡션")'
  ].join('\n'));
  const html = blocks.filter((b) => typeof b === 'string').join('');
  assert.equal(toc.length, 1);
  assert.match(html, /<h2 id="sec-1">첫째 소제목<\/h2>/);
  assert.match(html, /<strong>강조<\/strong>/);
  assert.match(html, /<a href="\/space#rooms">공간<\/a>/);
  assert.match(html, /<a href="https:\/\/megaspot\.kr" target="_blank" rel="noopener">외부<\/a>/);
  assert.match(html, /<ul><li>하나<\/li><li>둘<\/li><\/ul>/);
  assert.match(html, /<ol><li>첫째<\/li><li>둘째<\/li><\/ol>/);
  assert.match(html, /<aside class="mz-callout"><strong class="mz-callout-t">팁<\/strong><p>안내 문장<\/p><\/aside>/);
  assert.match(html, /<td>3번룸<\/td><td>16명<\/td>/);
  assert.ok(blocks.some((b) => typeof b === 'object' && b.figure.caption === '캡션'));
});

test('마크다운: html 은 그대로 나오지 않고 글자로 바뀝니다', () => {
  const html = markdown('<script>alert(1)</script>').blocks.join('');
  assert.ok(!html.includes('<script>'));
});

test('자리표시: 설정값과 계산을 채우고, 없는 값은 오류', () => {
  const data = loadData();
  assert.equal(resolveTokens('{{rate.r3.max}}명', data), `${data.rate.r3.max}명`);
  assert.equal(resolveTokens('{{= rate.r3.wdEarly * 3 }}원', data), (data.rate.r3.wdEarly * 3).toLocaleString('en-US') + '원');
  assert.equal(resolveTokens('{{= ceil(10 / 4) }}', data), '3');
  assert.throws(() => resolveTokens('{{rate.r9.max}}', data), /설정값을 찾지 못한/);
  assert.throws(() => resolveTokens('{{= process.exit(1) }}', data), /설정값을 찾지 못한/);
});

test('머리말 읽기', () => {
  const { meta, body } = parseFrontMatter('---\ntitle: 제목\ntags: ["a", "b"]\n---\n본문');
  assert.equal(meta.title, '제목');
  assert.deepEqual(meta.tags, ['a', 'b']);
  assert.equal(body.trim(), '본문');
});

const result = build({ write: false });

test('모든 글이 편집 기준 검사를 통과합니다', () => {
  assert.deepEqual(result.errors, []);
  assert.ok(result.posts.length >= 12);
});

test('저장소의 생성 파일이 원본과 같습니다 (node scripts/magazine.mjs 를 실행했는지)', () => {
  for (const [rel, content] of result.contents) {
    assert.equal(read(rel), content, `${rel} 가 원본과 다릅니다 — node scripts/magazine.mjs 를 실행하세요`);
  }
});

test('글 페이지: 정식 주소 · 구조화 데이터 · 머리글 · 바닥글', () => {
  for (const p of result.posts) {
    const html = result.contents.get(`magazine/${p.slug}.html`);
    assert.ok(html.includes(`<link rel="canonical" href="https://socialfactory.co.kr/magazine/${p.slug}">`));
    const ld = JSON.parse(/<script type="application\/ld\+json" id="sf-ldjson">(.*?)<\/script>/s.exec(html)[1]);
    assert.equal(ld['@graph'][0]['@type'], 'BlogPosting');
    assert.ok(html.includes('class="site-header"') && html.includes('class="site-footer"'));
    assert.ok(!/(src|href)="(images|css|js)\//.test(html), `${p.slug}: 상대 경로가 남아 있습니다`);
  }
});

test('내부 링크와 이미지가 모두 실제 파일 · 위치를 가리킵니다', () => {
  const pages = [...result.contents].filter(([rel]) => rel.endsWith('.html'));
  const fileFor = (u) => {
    const base = u.split(/[?#]/)[0];
    if (base === '/') return 'index.html';
    const rel = base.replace(/^\//, '');
    if (fs.existsSync(path.join(ROOT, rel)) && fs.statSync(path.join(ROOT, rel)).isFile()) return rel;
    return rel + '.html';
  };
  for (const [rel, html] of pages) {
    if (!['magazine.html', 'story.html', 'founder.html'].includes(rel) && !rel.startsWith('magazine/')) continue;
    for (const [, attr, u] of html.matchAll(/\b(href|src)="(\/[^"/][^"]*|\/)"/g)) {
      const f = fileFor(u);
      const exists = fs.existsSync(path.join(ROOT, f)) || result.contents.has(f);
      assert.ok(exists, `${rel}: ${attr}=${u} → ${f} 없음`);
      const hash = u.split('#')[1];
      if (attr === 'href' && hash && f.endsWith('.html') && f !== 'magazine.html') {
        const target = result.contents.get(f) || read(f);
        assert.ok(target.includes(`id="${hash}"`), `${rel}: ${u} 의 #${hash} 위치가 없습니다`);
      }
    }
  }
});

test('사이트맵 · RSS · 메인 페이지에 매거진이 들어 있습니다', () => {
  const sitemap = result.contents.get('sitemap.xml');
  const rss = result.contents.get('rss.xml');
  const home = result.contents.get('index.html');
  for (const p of result.posts) {
    assert.ok(sitemap.includes(`<loc>${p.url}</loc>`), `사이트맵에 ${p.slug} 없음`);
    assert.ok(rss.includes(`<link>${p.url}</link>`), `RSS 에 ${p.slug} 없음`);
  }
  for (const u of ['/story', '/founder', '/magazine']) assert.ok(sitemap.includes(`<loc>https://socialfactory.co.kr${u}</loc>`));
  assert.equal((sitemap.match(/<loc>https:\/\/socialfactory\.co\.kr\/magazine\/[^<]+<\/loc>/g) || []).length, result.posts.length);
  for (const p of result.posts.slice(0, 3)) assert.ok(home.includes(`href="${p.path}"`), `메인 최신 글에 ${p.slug} 없음`);
  assert.match(home, /\/css\/magazine\.css\?v=[0-9a-f]{10}/);
});

test('Pages 배포 묶음에 magazine 폴더가 포함됩니다', () => {
  assert.match(read('scripts/build-pages.mjs'), /'magazine'/);
});
