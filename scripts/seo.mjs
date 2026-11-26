#!/usr/bin/env node
/* ==========================================================================
   검색 노출 점검 · 사이트맵 수정일 관리
   --------------------------------------------------------------------------
   실행:  node scripts/seo.mjs           사이트맵(sitemap.xml)의 수정일을 실제로 바뀐 페이지만 오늘 날짜로 고칩니다
          node scripts/seo.mjs --check   검색용 기본 항목 점검만 (제목 · 설명 · 대표 주소 · 구조화 데이터 · 사이트맵)

   수정일은 이렇게 정합니다.
   - 페이지마다 본문(<main>)의 지문(해시)을 content/seo/lastmod.json 에 적어 둡니다.
   - 지문이 그대로면 적어 둔 날짜를 쓰고, 달라졌으면 오늘 날짜로 바꿉니다. 머리글 · 바닥글 · 파일 버전값만 바뀐 것은 수정으로 치지 않습니다.
   - 사이트맵의 <!-- MAGAZINE:START --> ~ <!-- MAGAZINE:END --> 구역(매거진 글 · 브랜드 스토리 · 방별/용도별 안내 페이지)은
     scripts/magazine.mjs 가 관리하므로 여기서 건드리지 않습니다. 그 페이지들의 수정일은 글 머리말(date · updated)과 원본의 lastmod 값입니다.
   - 배포할 때(scripts/build-pages.mjs)도 같은 계산을 해서, 이 스크립트를 돌리지 않고 올린 변경도 사이트맵에는 배포일로 반영됩니다.
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://socialfactory.co.kr';
const MEMORY = 'content/seo/lastmod.json';
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export const fileOf = (loc) => {
  const p = loc.replace(SITE, '').split(/[?#]/)[0] || '/';
  return p === '/' ? 'index.html' : `${p.replace(/^\//, '')}.html`;
};

/** 본문의 지문 — 버전값 · 최신 글 칸처럼 내용과 상관없이 바뀌는 부분은 빼고 계산합니다. */
export function fingerprint(html) {
  const a = html.indexOf('<main'); const b = html.lastIndexOf('</main>');
  let s = a >= 0 && b > a ? html.slice(a, b) : html;
  s = s.replace(/<!-- MAGAZINE:LATEST:START -->[\s\S]*?<!-- MAGAZINE:LATEST:END -->/g, '')
    .replace(/\?v=[\w.-]+/g, '').replace(/\s+/g, ' ');
  const title = /<title>([\s\S]*?)<\/title>/.exec(html);
  const desc = /<meta\s+name="description"\s+content="([^"]*)"/.exec(html);
  return crypto.createHash('sha1').update(`${title ? title[1] : ''}\n${desc ? desc[1] : ''}\n${s}`).digest('hex').slice(0, 16);
}

/**
 * 사이트맵의 수정일을 고쳐 돌려줍니다.
 * @param {string} xml sitemap.xml 내용
 * @param {{read:(rel:string)=>string|null, memory:object, today?:string}} o
 */
export function stampSitemap(xml, { read, memory = {}, today = todayKST() }) {
  const next = { ...memory }; const changed = [];
  const a = xml.indexOf('<!-- MAGAZINE:START -->'); const b = xml.indexOf('<!-- MAGAZINE:END -->');
  const parts = a >= 0 && b > a ? [xml.slice(0, a), xml.slice(a, b), xml.slice(b)] : [xml, '', ''];
  const stamp = (part) => part.replace(/<url>([\s\S]*?)<\/url>/g, (row, inner) => {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(inner);
    if (!loc || !loc[1].startsWith(SITE)) return row;
    const p = loc[1].replace(SITE, '') || '/';
    if (p.startsWith('/magazine')) return row;
    const html = read(fileOf(loc[1]));
    if (html == null) return row;
    const hash = fingerprint(html);
    const m = memory[p];
    const day = m && m.hash === hash ? m.lastmod : today;
    if (!m || m.hash !== hash) { next[p] = { hash, lastmod: day }; changed.push(p); }
    return /<lastmod>[^<]*<\/lastmod>/.test(row) ? row.replace(/<lastmod>[^<]*<\/lastmod>/, `<lastmod>${day}</lastmod>`) : row.replace('</loc>', `</loc><lastmod>${day}</lastmod>`);
  });
  return { xml: stamp(parts[0]) + parts[1] + stamp(parts[2]), memory: next, changed };
}

const readRel = (rel) => { const f = path.join(ROOT, rel); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
export const loadMemory = () => { try { return JSON.parse(readRel(MEMORY) || '{}'); } catch { return {}; } };

/* --------------------------------------------------------------------------
   점검 — 검색에 나올 페이지가 기본 항목을 갖췄는지
   -------------------------------------------------------------------------- */
function htmlFiles(dir = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) { if (['magazine', 'rooms', 'for', 'product'].includes(rel)) out.push(...htmlFiles(rel)); }
    else if (e.name.endsWith('.html')) out.push(rel);
  }
  return out;
}

export function audit() {
  const errors = []; const warnings = [];
  const sitemap = readRel('sitemap.xml') || '';
  const locs = new Set([...sitemap.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]));
  const titles = new Map(); const descs = new Map();
  let indexable = 0;
  for (const f of htmlFiles()) {
    const h = readRel(f);
    const robots = (/<meta\s+name="robots"\s+content="([^"]*)"/.exec(h) || [])[1] || '';
    if (/noindex/.test(robots)) continue;
    if (['404.html', 'community-post.html'].includes(f)) continue;
    indexable++;
    const title = ((/<title>([\s\S]*?)<\/title>/.exec(h) || [])[1] || '').trim();
    const desc = (/<meta\s+name="description"\s+content="([^"]*)"/.exec(h) || [])[1] || '';
    const canon = (/<link\s+rel="canonical"\s+href="([^"]*)"/.exec(h) || [])[1] || '';
    const want = f === 'index.html' ? `${SITE}/` : `${SITE}/${f.replace(/\.html$/, '')}`;
    if (!title) errors.push(`${f}: <title> 이 없습니다`);
    if (title.length > 62) warnings.push(`${f}: 제목이 깁니다 (${title.length}자)`);
    if (desc.length < 50 || desc.length > 165) (f.startsWith('magazine/') || desc.length < 30 ? errors : warnings).push(`${f}: 설명(description)은 60~160자로 씁니다 (지금 ${desc.length}자)`);
    if (canon !== want) errors.push(`${f}: 대표 주소(canonical)가 ${want} 가 아닙니다 (${canon || '없음'})`);
    if (!robots) warnings.push(`${f}: robots 메타가 없습니다`);
    if (!/<meta property="og:image" content="https:\/\//.test(h)) warnings.push(`${f}: og:image 가 없습니다`);
    const h1 = (h.match(/<h1[\s>]/g) || []).length;
    if (h1 !== 1) errors.push(`${f}: <h1> 은 한 개여야 합니다 (지금 ${h1}개)`);
    for (const m of h.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
      try { JSON.parse(m[1]); } catch (e) { errors.push(`${f}: 구조화 데이터(JSON-LD) 문법 오류 — ${e.message}`); }
    }
    if (!locs.has(want) && !['privacy.html', 'terms.html'].includes(f)) errors.push(`${f}: 사이트맵에 ${want} 가 없습니다`);
    if (titles.has(title)) errors.push(`${f}: 제목이 ${titles.get(title)} 와 같습니다`); else titles.set(title, f);
    if (desc && descs.has(desc)) errors.push(`${f}: 설명이 ${descs.get(desc)} 와 같습니다`); else descs.set(desc, f);
  }
  for (const loc of locs) {
    if (!loc.startsWith(SITE)) { errors.push(`사이트맵: 다른 도메인 주소 ${loc}`); continue; }
    const f = fileOf(loc); const h = readRel(f);
    if (h == null) errors.push(`사이트맵: ${loc} 에 해당하는 파일(${f})이 없습니다`);
    else if (/<meta\s+name="robots"\s+content="[^"]*noindex/.test(h)) errors.push(`사이트맵: 검색 제외(noindex) 페이지가 들어 있습니다 — ${loc}`);
  }
  return { errors, warnings, indexable, locs: locs.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const r = audit();
    for (const w of r.warnings) console.warn('경고  ' + w);
    for (const e of r.errors) console.error('오류  ' + e);
    console.log(`검색에 나오는 페이지 ${r.indexable}개 · 사이트맵 주소 ${r.locs}개 점검${r.errors.length ? ` — 오류 ${r.errors.length}건` : ' — 이상 없음'}`);
    process.exit(r.errors.length ? 1 : 0);
  }
  const src = readRel('sitemap.xml');
  const r = stampSitemap(src, { read: readRel, memory: loadMemory() });
  if (r.xml !== src) fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), r.xml);
  const mem = JSON.stringify(Object.fromEntries(Object.entries(r.memory).sort(([a], [b]) => a.localeCompare(b))), null, 1) + '\n';
  if (mem !== (readRel(MEMORY) || '')) { fs.mkdirSync(path.join(ROOT, path.dirname(MEMORY)), { recursive: true }); fs.writeFileSync(path.join(ROOT, MEMORY), mem); }
  console.log(r.changed.length ? `수정일을 오늘로 바꾼 페이지 ${r.changed.length}개\n  ${r.changed.join('\n  ')}` : '수정일이 바뀐 페이지가 없습니다');
}
