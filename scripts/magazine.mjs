#!/usr/bin/env node
/* ==========================================================================
   소셜팩토리 매거진 · 브랜드 페이지 생성기
   --------------------------------------------------------------------------
   원본                                    → 만들어지는 파일
   content/magazine/posts/*.md             → magazine/<slug>.html (글 한 편)
                                           → magazine.html (매거진 목록)
   content/pages/*.html                    → story.html, founder.html (브랜드 스토리 · 대표 이야기)
   그리고 index.html 의 '최신 글' 칸, sitemap.xml, rss.xml 의 매거진 구역을 다시 씁니다.

   실행:  node scripts/magazine.mjs          만들기
          node scripts/magazine.mjs --check  검사만 (파일을 쓰지 않음, 문제가 있으면 종료 코드 1)

   머리글(헤더) · 바닥글(푸터)은 about.html 에서 그대로 가져오므로, 메뉴를 바꾸면
   다음 실행 때 매거진 페이지에도 같이 반영됩니다. 생성된 html 은 직접 고치지 말고 원본을 고칩니다.
   글쓰기 기준은 content/magazine/EDITORIAL.md 에 있습니다.
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://socialfactory.co.kr';
const POSTS_DIR = 'content/magazine/posts';
const PAGES_DIR = 'content/pages';
const OUT_DIR = 'magazine';
const TEMPLATE = 'about.html';
const SITE_NAME = '소셜팩토리';
const MAG_NAME = '소셜팩토리 매거진';

export const CATEGORIES = {
  space:   { name: '공간 가이드',      en: 'Space Guide' },
  meeting: { name: '모임 준비',        en: 'Meeting How-to' },
  work:    { name: '일과 공부',        en: 'Work & Study' },
  host:    { name: '호스트 · 클래스',  en: 'Hosts & Classes' },
  story:   { name: '소셜팩토리 이야기', en: 'Our Story' },
  local:   { name: '건대 · 동네',      en: 'Neighborhood' }
};

/* 본문 안에서 쓸 수 있는 내부 주소 — 이 목록에 없는 / 주소는 검사에서 오류로 잡습니다 */
const ROUTES = ['/', '/space', '/pricing', '/booking', '/guide', '/contact', '/about', '/story', '/founder', '/history',
  '/family', '/shop', '/program', '/parking', '/tour', '/magazine', '/guest-orders', '/terms', '/privacy'];

/* AI 같은 말투나 과장 표현 — 검사에서 경고(일부는 오류)로 알려 줍니다 */
const BANNED = [
  ['업계 1위', 'error'], ['업계 최초', 'error'], ['국내 최초', 'error'], ['최고의', 'warn'], ['완벽 가이드', 'error'], ['완벽한', 'warn'],
  ['알아보겠습니다', 'error'], ['알아볼까요', 'error'], ['살펴보겠습니다', 'warn'], ['결론적으로', 'error'], ['마무리하며', 'warn'],
  ['특별한 경험', 'error'], ['잊지 못할', 'warn'], ['최적의', 'warn'], ['다양한', 'warn'], ['혁신적', 'error'], ['획기적', 'error'],
  ['여러분', 'warn'], ['오늘은', 'warn'], ['것입니다.', 'warn'], ['!', 'warn']
];

const KAKAO_SVG = '<svg class="kk" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.6c-5.3 0-9.6 3.4-9.6 7.6 0 2.7 1.8 5.1 4.5 6.4l-.95 3.5c-.08.3.25.55.52.38l4.15-2.75c.45.05.91.07 1.38.07 5.3 0 9.6-3.4 9.6-7.6S17.3 3.6 12 3.6z"/></svg>';
const KAKAO = 'https://pf.kakao.com/_uTiFX/chat';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
const comma = (n) => Number(n).toLocaleString('en-US');

/* --------------------------------------------------------------------------
   설정값 — js/booking-rates.js · js/site-config.js 를 그대로 읽어 본문의 {{...}} 를 채웁니다
   -------------------------------------------------------------------------- */
export function loadData() {
  const ctx = {}; ctx.window = ctx; ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(read('js/booking-rates.js'), ctx, { filename: 'booking-rates.js' });
  vm.runInContext(read('js/site-config.js'), ctx, { filename: 'site-config.js' });
  const rate = JSON.parse(JSON.stringify(ctx.SF_BOOKING_RATES.rooms));
  const cfg = JSON.parse(JSON.stringify(ctx.SF_CONFIG));
  const rooms = Object.values(rate);
  const caps = rooms.map((r) => r.max);
  const prices = rooms.flatMap((r) => [r.wdEarly, r.wdStd, r.hdEarly, r.hdStd]);
  return {
    rate, cfg,
    booking: { minHours: ctx.SF_BOOKING_RATES.min_minutes / 60, stepMinutes: ctx.SF_BOOKING_RATES.step_minutes },
    stat: { minCap: Math.min(...caps), maxCap: Math.max(...caps), from: Math.min(...prices), top: Math.max(...prices), rooms: rooms.length }
  };
}

const lookup = (data, key) => { let v = data; for (const k of key.split('.')) v = v == null ? undefined : v[k]; return v; };

/* {{rate.r3.max}} 처럼 설정값을 넣거나, {{= rate.r3.wdEarly * 3 }} 처럼 간단한 계산(+ - * / 괄호, ceil · floor · round)을 넣습니다.
   계산 결과는 반올림하고, 1,000 이상은 쉼표를 붙입니다. */
export function resolveTokens(text, data, where = '') {
  const missing = [];
  const out = String(text).replace(/\{\{\s*(=)?\s*([^}]+?)\s*\}\}/g, (m, calc, expr) => {
    if (calc) {
      let bad = false;
      const js = expr.replace(/[A-Za-z_][\w.]*/g, (key) => {
        if (['ceil', 'floor', 'round'].includes(key)) return `Math.${key}`;
        const v = lookup(data, key); if (typeof v !== 'number') { bad = true; missing.push(key); return '0'; } return String(v);
      });
      if (bad) return m;
      if (!/^[\d\s+\-*/().,]+$/.test(js.replace(/Math\.(ceil|floor|round)/g, ''))) { missing.push(expr); return m; }
      const v = Math.round(Function(`"use strict"; return (${js});`)());
      return Math.abs(v) >= 1000 ? comma(v) : String(v);
    }
    if (!/^[\w.]+$/.test(expr)) { missing.push(expr); return m; }
    const v = lookup(data, expr);
    if (v == null || typeof v === 'object') { missing.push(expr); return m; }
    return typeof v === 'number' && Math.abs(v) >= 1000 ? comma(v) : String(v);
  });
  if (missing.length) throw new Error(`${where}: 설정값을 찾지 못한 자리표시 {{${missing.join('}}, {{')}}}`);
  return out;
}

/* --------------------------------------------------------------------------
   글 원본(마크다운) 읽기
   -------------------------------------------------------------------------- */
export function parseFrontMatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error('맨 위에 --- 로 감싼 머리말이 없습니다');
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) throw new Error(`머리말 줄 형식 오류: ${line}`);
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (val.startsWith('[')) val = JSON.parse(val);
    else if (/^".*"$/.test(val)) val = JSON.parse(val);
    meta[key] = val;
  }
  return { meta, body: m[2] };
}

export function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const h = href.replace(/&amp;/g, '&');
    if (/^https?:\/\//.test(h)) return `<a href="${esc(h)}" target="_blank" rel="noopener">${label}</a>`;
    return `<a href="${esc(h)}">${label}</a>`;
  });
  return t;
}

const slugId = (text, used) => {
  let base = 'sec-' + (used.size + 1);
  used.add(base); return base;
};

/* 지원하는 문법: ## / ### 제목, 문단, - 목록, 1. 목록, > 인용(첫 줄이 **팁** 등이면 안내 상자), | 표 |, ![설명](이미지 "캡션"), --- 구분선 */
export function markdown(body) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const html = []; const toc = []; const used = new Set();
  let i = 0;
  const isBlockStart = (l) => /^(#{2,3}\s|[-*]\s|\d+\.\s|>|\||!\[|---\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{2,3})\s+(.*)$/.exec(line))) {
      const level = m[1].length; const text = m[2].trim();
      if (level === 2) { const id = slugId(text, used); toc.push({ id, text }); html.push(`<h2 id="${id}">${inline(text)}</h2>`); }
      else html.push(`<h3>${inline(text)}</h3>`);
      i++; continue;
    }
    if (/^---\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
    if ((m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\s*$/.exec(line))) {
      html.push({ figure: { alt: m[1], src: m[2], caption: m[3] || '' } });
      i++; continue;
    }
    if (/^[-*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, '')); i++; }
      html.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`); continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, '')); i++; }
      html.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`); continue;
    }
    if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      const head = /^\*\*([^*]+)\*\*\s*$/.exec(buf[0] || '');
      const paras = []; let cur = [];
      for (const b of (head ? buf.slice(1) : buf)) { if (!b.trim()) { if (cur.length) paras.push(cur.join(' ')); cur = []; } else cur.push(b); }
      if (cur.length) paras.push(cur.join(' '));
      const inner = paras.map((p) => /^[-*]\s/.test(p) ? `<ul>${p.split(/\s(?=[-*]\s)/).map((x) => `<li>${inline(x.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>` : `<p>${inline(p)}</p>`).join('');
      html.push(head ? `<aside class="mz-callout"><strong class="mz-callout-t">${inline(head[1])}</strong>${inner}</aside>` : `<blockquote>${inner}</blockquote>`);
      continue;
    }
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const bodyRows = rows.slice(/^\|\s*:?-{2,}/.test(rows[1] || '') ? 2 : 1).map(cells);
      html.push(`<div class="table-wrap mz-table"><table class="table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i].trim()); i++; }
    html.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return { blocks: html, toc };
}

export const plainText = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/* --------------------------------------------------------------------------
   이미지 크기 (webp · jpg · png) — 화면 밀림을 막기 위해 width/height 를 적습니다
   -------------------------------------------------------------------------- */
export function imageSize(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return null;
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const n = b.readUInt32LE(21); return { w: (n & 0x3fff) + 1, h: ((n >> 14) & 0x3fff) + 1 }; }
  }
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const mk = b[o + 1]; const len = b.readUInt16BE(o + 2);
      if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
      o += 2 + len;
    }
  }
  return null;
}
const smallOf = (rel) => { const s = rel.replace(/\.(webp|jpg|png)$/, '-sm.$1'); return exists(s) ? s : null; };

function figureHtml({ src, alt, caption }, { eager = false, sizes = '(max-width: 900px) 100vw, 760px' } = {}) {
  const rel = src.replace(/^\//, '');
  const dim = imageSize(rel) || { w: 1600, h: 900 };
  const sm = smallOf(rel); const smDim = sm ? imageSize(sm) : null;
  const srcset = sm && smDim ? ` srcset="/${sm} ${smDim.w}w, /${rel} ${dim.w}w" sizes="${sizes}"` : '';
  return `<figure class="mz-figure"><img src="/${rel}"${srcset} alt="${esc(alt)}" width="${dim.w}" height="${dim.h}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">${caption ? `<figcaption>${inline(caption)}</figcaption>` : ''}</figure>`;
}

/* --------------------------------------------------------------------------
   about.html 에서 머리글 · 바닥글 · 스크립트를 가져옵니다
   -------------------------------------------------------------------------- */
const absolutize = (html) => html
  .replace(/\b(src|href)="(?!https?:|\/|#|mailto:|tel:|data:|javascript:)([^"]+)"/g, '$1="/$2"')
  .replace(/\bsrcset="([^"]+)"/g, (m, v) => `srcset="${v.split(',').map((p) => p.trim().replace(/^(?!https?:|\/)/, '/')).join(', ')}"`);

export function loadTemplate() {
  const t = read(TEMPLATE);
  const style = /href="\/?(css\/style\.css\?v=[^"]+)"/.exec(t);
  const fonts = /<link rel="stylesheet" href="(https:\/\/cdn\.jsdelivr\.net[^"]+)">/.exec(t);
  const bodyStart = t.indexOf('<body>'); const mainStart = t.indexOf('<main id="main">');
  const mainEnd = t.indexOf('</main>'); const bodyEnd = t.lastIndexOf('</body>');
  if ([bodyStart, mainStart, mainEnd, bodyEnd].some((x) => x < 0) || !style) throw new Error(`${TEMPLATE} 에서 머리글 · 바닥글을 찾지 못했습니다`);
  const magCss = read('css/magazine.css');
  return {
    style: '/' + style[1],
    fonts: fonts ? fonts[1] : 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css',
    magCss: `/css/magazine.css?v=${hash(magCss)}`,
    header: absolutize(t.slice(bodyStart + '<body>'.length, mainStart)).trim(),
    footer: absolutize(t.slice(mainEnd + '</main>'.length, bodyEnd)).trim()
  };
}

function pageShell(tpl, { title, description, canonical, ogType = 'website', image, imageAlt, ld, extraHead = '', main, source, robots = 'index, follow, max-image-preview:large' }) {
  const img = image ? (image.startsWith('http') ? image : SITE + '/' + image.replace(/^\//, '')) : `${SITE}/images/og-image.jpg`;
  const imgRel = image && !image.startsWith('http') ? image.replace(/^\//, '') : 'images/og-image.jpg';
  const dim = imageSize(imgRel);
  return `<!DOCTYPE html>
<!-- 이 파일은 scripts/magazine.mjs 가 ${source} 에서 만듭니다. 직접 고치지 말고 원본을 고친 뒤 node scripts/magazine.mjs 를 실행하세요. -->
<html lang="ko" class="no-js">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script>document.documentElement.className=document.documentElement.className.replace("no-js","js");</script>
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="${robots}">
  <meta name="theme-color" content="#2855E8">
  <link rel="canonical" href="${canonical}">
  <link rel="alternate" type="application/rss+xml" title="소셜팩토리 건대" href="${SITE}/rss.xml">
  <meta property="og:type" content="${ogType}">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${img}">${dim ? `
  <meta property="og:image:width" content="${dim.w}">
  <meta property="og:image:height" content="${dim.h}">` : ''}
  <meta property="og:image:alt" content="${esc(imageAlt || title)}">
  <meta property="og:locale" content="ko_KR">${extraHead}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${img}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
  <link rel="stylesheet" href="${tpl.fonts}">
  <link rel="stylesheet" href="${tpl.style}">
  <link rel="stylesheet" href="${tpl.magCss}">
  <script type="application/ld+json" id="sf-ldjson">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
</head>
<body>
${tpl.header}
<main id="main">
${main}
</main>
${tpl.footer}
</body>
</html>
`;
}

/* --------------------------------------------------------------------------
   글 목록 불러오기
   -------------------------------------------------------------------------- */
const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

export function loadPosts(data, { includeFuture = false } = {}) {
  const dir = path.join(ROOT, POSTS_DIR);
  if (!fs.existsSync(dir)) return [];
  const posts = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const { meta, body } = parseFrontMatter(src);
    const where = `${POSTS_DIR}/${file}`;
    const m = {}; for (const [k, v] of Object.entries(meta)) m[k] = typeof v === 'string' ? resolveTokens(v, data, where) : v;
    const md = markdown(resolveTokens(body, data, where));
    const text = plainText(md.blocks.filter((b) => typeof b === 'string').join(' '));
    const post = {
      file: where, ...m, body: md, text,
      time: m.time || '12:00',
      tags: Array.isArray(m.tags) ? m.tags : [],
      related: Array.isArray(m.related) ? m.related : [],
      url: `${SITE}/magazine/${m.slug}`, path: `/magazine/${m.slug}`,
      minutes: Math.max(2, Math.round(text.length / 550))
    };
    post.iso = `${post.date}T${post.time}:00+09:00`;
    post.updatedIso = m.updated ? `${m.updated}T${m.updatedTime || post.time}:00+09:00` : post.iso;
    if (!includeFuture && post.date > todayKST()) continue;
    posts.push(post);
  }
  return posts.sort((a, b) => (b.iso.localeCompare(a.iso)) || a.slug.localeCompare(b.slug));
}

const fmtDate = (d) => d.replace(/-/g, '.');
const rfc822 = (iso) => {
  const d = new Date(iso); const k = new Date(d.getTime() + 9 * 3600e3);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][k.getUTCDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][k.getUTCMonth()];
  const p = (n) => String(n).padStart(2, '0');
  return `${day}, ${p(k.getUTCDate())} ${mon} ${k.getUTCFullYear()} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())} +0900`;
};

/* --------------------------------------------------------------------------
   화면 조각
   -------------------------------------------------------------------------- */
export function card(post, { headingTag = 'h3', sizes = '(max-width: 700px) 100vw, (max-width: 1100px) 50vw, 380px' } = {}) {
  const rel = post.cover.replace(/^\//, ''); const sm = smallOf(rel) || rel; const dim = imageSize(sm) || { w: 800, h: 450 };
  const cat = CATEGORIES[post.category];
  return `<article class="mz-card" data-cat="${post.category}"><a class="mz-card-link" href="${post.path}"><div class="mz-card-media"><img src="/${sm}" alt="${esc(post.coverAlt)}" width="${dim.w}" height="${dim.h}" loading="lazy" decoding="async"></div><div class="mz-card-body"><span class="mz-cat">${esc(cat.name)}</span><${headingTag} class="mz-card-title">${esc(post.title)}</${headingTag}><p class="mz-card-desc">${esc(post.description)}</p><span class="mz-meta"><time datetime="${post.iso}">${fmtDate(post.date)}</time><span aria-hidden="true">·</span>${post.minutes}분 읽기</span></div></a></article>`;
}

function ctaBlock(kind) {
  const kk = (label) => `<a class="btn btn-kakao" data-channel="kakao" href="${KAKAO}" target="_blank" rel="noopener">${KAKAO_SVG}${label}</a>`;
  const blocks = {
    rooms: ['모임 날짜가 정해졌다면', '방과 날짜, 시간을 고르면 홈페이지에서 바로 예약을 신청할 수 있습니다. 어떤 방이 맞을지 아직 고민된다면 일자 · 시간 · 인원 · 모임 유형 네 가지만 카카오톡으로 보내 주세요.',
      `<a class="btn btn-primary" href="/booking">방과 일정 골라 예약 신청</a><a class="btn btn-outline" href="/pricing#estimate">예상 금액 계산</a>${kk('카카오톡 문의')}`],
    work: ['혼자 일하거나 공부할 자리를 찾고 있다면', '코워킹은 현장 무인 키오스크에서 이용권을 골라 바로 쓰고, 독립사무실은 월 단위로 상담 후 이용합니다.',
      `<a class="btn btn-primary" href="/space#coworking">코워킹 안내</a><a class="btn btn-outline" href="/space#office">독립사무실 안내</a>${kk('카카오톡 문의')}`],
    host: ['소셜팩토리에서 모임이나 클래스를 열고 싶다면', '강사, 호스트, 모임장과 함께 공간과 시간, 운영 방식을 맞춰 갑니다. 정기 클래스나 제휴는 따로 조건을 안내해 드립니다.',
      `<a class="btn btn-primary" href="/program#host">함께하는 방법 보기</a><a class="btn btn-outline" href="/contact?purpose=partner#inquiry">제휴 · 협업 문의</a>${kk('카카오톡으로 미팅 요청')}`],
    story: ['소셜팩토리 건대에서 이어지는 이야기', '2015년 홍대에서 시작한 소셜팩토리는 지금 건대입구역 근처 한아름건물 4층 한 층 전체를 운영합니다. 공간과 이용 방법을 먼저 둘러보세요.',
      `<a class="btn btn-primary" href="/space">공간 안내 보기</a><a class="btn btn-outline" href="/story">브랜드 스토리</a>${kk('카카오톡 문의')}`]
  };
  const [h, p, actions] = blocks[kind] || blocks.rooms;
  return `<aside class="mz-cta" aria-label="이용 안내"><div><span class="eyebrow">Social Factory Kondae</span><h2 class="mz-cta-title">${h}</h2><p>${p}</p></div><div class="actions">${actions}</div></aside>`;
}

const defaultCta = (cat) => ({ space: 'rooms', meeting: 'rooms', work: 'work', host: 'host', story: 'story', local: 'rooms' }[cat] || 'rooms');

function relatedFor(post, posts) {
  const pick = []; const seen = new Set([post.slug]);
  for (const s of post.related) { const p = posts.find((x) => x.slug === s); if (p && !seen.has(s)) { pick.push(p); seen.add(s); } }
  for (const p of posts.filter((x) => x.category === post.category)) if (pick.length < 3 && !seen.has(p.slug)) { pick.push(p); seen.add(p.slug); }
  for (const p of posts) if (pick.length < 3 && !seen.has(p.slug)) { pick.push(p); seen.add(p.slug); }
  return pick.slice(0, 3);
}

/* --------------------------------------------------------------------------
   글 한 편
   -------------------------------------------------------------------------- */
function renderPost(tpl, post, posts) {
  const cat = CATEGORIES[post.category];
  const ogImg = exists(`images/og/${post.slug}.jpg`) ? `images/og/${post.slug}.jpg` : post.cover;
  const body = post.body.blocks.map((b) => typeof b === 'string' ? b : figureHtml(b.figure)).join('\n');
  const toc = post.body.toc.length >= 3 ? `<nav class="mz-toc" aria-label="이 글의 차례"><strong>이 글의 차례</strong><ol>${post.body.toc.map((t) => `<li><a href="#${t.id}">${inline(t.text)}</a></li>`).join('')}</ol></nav>` : '';
  const related = relatedFor(post, posts);
  const ld = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'BlogPosting', '@id': `${post.url}#article`, headline: post.title, description: post.description,
      image: [SITE + '/' + ogImg.replace(/^\//, ''), SITE + '/' + post.cover.replace(/^\//, '')].filter((v, i, a) => a.indexOf(v) === i),
      datePublished: post.iso, dateModified: post.updatedIso, inLanguage: 'ko-KR', articleSection: cat.name,
      keywords: post.tags.join(', '), wordCount: post.text.length,
      author: { '@type': 'Organization', '@id': `${SITE}/#org`, name: SITE_NAME, url: `${SITE}/` },
      publisher: { '@type': 'Organization', '@id': `${SITE}/#org`, name: SITE_NAME, logo: { '@type': 'ImageObject', url: `${SITE}/apple-touch-icon.png` } },
      mainEntityOfPage: { '@type': 'WebPage', '@id': post.url }, isPartOf: { '@type': 'Blog', '@id': `${SITE}/magazine#blog`, name: MAG_NAME },
      about: { '@id': `${SITE}/#place` } },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: '홈', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: '매거진', item: `${SITE}/magazine` },
      { '@type': 'ListItem', position: 3, name: post.title, item: post.url }] }
  ] };
  const extraHead = `
  <meta property="article:published_time" content="${post.iso}">
  <meta property="article:modified_time" content="${post.updatedIso}">
  <meta property="article:section" content="${esc(cat.name)}">${post.tags.map((t) => `
  <meta property="article:tag" content="${esc(t)}">`).join('')}`;
  const main = `<article class="mz-article">
<header class="page-hero mz-hero">
  <div class="container mz-narrow">
    <div class="crumbs"><a href="/">Home</a> / <a href="/magazine">Magazine</a> / ${esc(cat.name)}</div>
    <a class="mz-cat mz-cat-lg" href="/magazine#${post.category}">${esc(cat.name)}</a>
    <h1 class="mz-title">${esc(post.title)}</h1>
    <p class="lead">${esc(post.lead || post.description)}</p>
    <p class="mz-meta mz-meta-hero"><span>글 · ${SITE_NAME}</span><span aria-hidden="true">·</span><time datetime="${post.iso}">${fmtDate(post.date)}</time>${post.updated ? `<span aria-hidden="true">·</span><span>수정 ${fmtDate(post.updated)}</span>` : ''}<span aria-hidden="true">·</span><span>${post.minutes}분 읽기</span></p>
  </div>
</header>
<div class="container mz-narrow mz-cover-wrap">${figureHtml({ src: post.cover, alt: post.coverAlt, caption: post.coverNote || '' }, { eager: true, sizes: '(max-width: 900px) 100vw, 900px' })}</div>
<div class="container mz-layout">
  ${toc ? `<div class="mz-side">${toc}</div>` : ''}
  <div class="mz-prose">
${body}
${post.tags.length ? `<ul class="mz-tags" aria-label="관련 검색어">${post.tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
${ctaBlock(post.cta || defaultCta(post.category))}
  </div>
</div>
</article>
${related.length ? `<section class="section bg mz-related" aria-labelledby="mz-related-t">
  <div class="container">
    <div class="mz-section-head"><h2 class="h3" id="mz-related-t">함께 읽으면 좋은 글</h2><a class="btn btn-ghost" href="/magazine">매거진 전체 보기 →</a></div>
    <div class="mz-grid">${related.map((p) => card(p)).join('')}</div>
  </div>
</section>` : ''}`;
  return pageShell(tpl, { title: `${post.seoTitle || post.title} | ${MAG_NAME}`, description: post.description, canonical: post.url, ogType: 'article',
    image: ogImg, imageAlt: post.coverAlt, ld, extraHead, main, source: post.file });
}

/* --------------------------------------------------------------------------
   매거진 목록
   -------------------------------------------------------------------------- */
function renderIndex(tpl, posts) {
  const used = Object.keys(CATEGORIES).filter((k) => posts.some((p) => p.category === k));
  const title = '소셜팩토리 매거진 · 모임과 공간 이야기 | 건대 세미나실 · 스터디룸 · 코워킹';
  const description = '건대입구 소셜팩토리가 쓰는 모임과 공간 이야기입니다. 세미나실 고르는 법, 강의실 대관 체크리스트, 스터디 · 워크숍 진행 노하우, 코워킹 활용법, 2015년부터 이어 온 브랜드 이야기를 모았습니다.';
  const ld = { '@context': 'https://schema.org', '@graph': [
    { '@type': ['Blog', 'CollectionPage'], '@id': `${SITE}/magazine#blog`, url: `${SITE}/magazine`, name: MAG_NAME, description, inLanguage: 'ko-KR',
      publisher: { '@id': `${SITE}/#org` }, isPartOf: { '@id': `${SITE}/#website` },
      blogPost: posts.slice(0, 30).map((p) => ({ '@type': 'BlogPosting', '@id': `${p.url}#article`, headline: p.title, url: p.url, datePublished: p.iso })) },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: '홈', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: '매거진', item: `${SITE}/magazine` }] }
  ] };
  const main = `<section class="page-hero mz-index-hero">
  <div class="container">
    <div class="crumbs"><a href="/">Home</a> / Magazine</div>
    <span class="eyebrow">Social Factory Magazine</span>
    <h1 class="mt-16">모이면 만들어진다, <br>그 과정을 기록합니다</h1>
    <p class="lead">모임을 준비하는 분께 필요한 공간 고르는 법과 진행 노하우, 그리고 2015년 홍대에서 시작해 건대로 이어진 소셜팩토리의 이야기를 씁니다. 새 글은 낮 12시에 올라옵니다.</p>
  </div>
</section>
<section class="section tight">
  <div class="container">
    <div class="mz-feature">
      <a class="mz-feature-item" href="/story"><span class="mz-cat">Brand Story</span><strong>모이면 만들어진다 — 소셜팩토리 이야기</strong><span>홍대 지하 40평에서 건대 4층 전체까지, 2015년부터의 기록</span><span class="mz-more">브랜드 스토리 읽기 →</span></a>
      <a class="mz-feature-item" href="/founder"><span class="mz-cat">Founder</span><strong>최시준 대표 이야기</strong><span>10년 넘게 340곳 이상의 공간을 기획 · 운영한 사람</span><span class="mz-more">대표 이야기 읽기 →</span></a>
      <a class="mz-feature-item" href="/history"><span class="mz-cat">Archive</span><strong>지난 기록 2015–2021</strong><span>홍대 · 연남 · 신촌 · 합정 · 인천에서 운영했던 공간과 프로그램</span><span class="mz-more">지난 기록 보기 →</span></a>
    </div>
    <div class="mz-filter" role="group" aria-label="주제로 고르기">
      <button type="button" class="mz-chip is-on" data-filter="all" aria-pressed="true">전체 <span>${posts.length}</span></button>${used.map((k) => `
      <button type="button" class="mz-chip" data-filter="${k}" aria-pressed="false">${esc(CATEGORIES[k].name)} <span>${posts.filter((p) => p.category === k).length}</span></button>`).join('')}
    </div>
    <h2 class="sr-only">전체 글</h2>
    <div class="mz-grid mz-list">${posts.map((p) => card(p)).join('')}</div>
    <p class="mz-empty" hidden>이 주제의 글을 준비하고 있습니다.</p>
  </div>
</section>
<section class="section bg">
  <div class="container">
    <div class="cta-band">
      <div>
        <h2>읽다가 우리 모임에 맞는 방이 떠올랐다면</h2>
        <p>일자 · 시간 · 인원 · 모임 유형을 알려 주시면 맞는 룸과 예상 금액, 예약할 수 있는 시간을 안내해 드립니다. 홈페이지에서 바로 예약을 신청할 수도 있습니다.</p>
      </div>
      <div class="actions">
        <a class="btn btn-lg btn-kakao" data-channel="kakao" href="${KAKAO}" target="_blank" rel="noopener">${KAKAO_SVG}카카오톡 문의</a>
        <a class="btn btn-primary btn-lg" href="/booking">예약 신청</a>
        <a class="btn btn-outline btn-lg" href="/space">공간 안내</a>
      </div>
    </div>
  </div>
</section>
<script>
(function () {
  var chips = document.querySelectorAll('.mz-chip'), cards = document.querySelectorAll('.mz-list .mz-card'), empty = document.querySelector('.mz-empty');
  function apply(cat) {
    var shown = 0;
    chips.forEach(function (c) { var on = c.getAttribute('data-filter') === cat; c.classList.toggle('is-on', on); c.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    cards.forEach(function (el) { var ok = cat === 'all' || el.getAttribute('data-cat') === cat; el.hidden = !ok; if (ok) shown++; });
    if (empty) empty.hidden = shown > 0;
  }
  chips.forEach(function (c) { c.addEventListener('click', function () { var cat = c.getAttribute('data-filter'); apply(cat); try { history.replaceState(null, '', cat === 'all' ? location.pathname : '#' + cat); } catch (e) {} }); });
  var h = (location.hash || '').slice(1); if (h && document.querySelector('.mz-chip[data-filter="' + h + '"]')) apply(h);
})();
</script>`;
  return pageShell(tpl, { title, description, canonical: `${SITE}/magazine`, ld, main, source: `${POSTS_DIR}/ (목록)` });
}

/* --------------------------------------------------------------------------
   content/pages/*.html — 브랜드 스토리 · 대표 이야기
   파일 맨 위 <!--meta { ... } --> 에 제목 · 설명 · 구조화 데이터를 적고, 그 아래가 <main> 안쪽 내용입니다.
   -------------------------------------------------------------------------- */
export function loadPages(data) {
  const dir = path.join(ROOT, PAGES_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort().map((f) => {
    const where = `${PAGES_DIR}/${f}`;
    const src = resolveTokens(fs.readFileSync(path.join(dir, f), 'utf8'), data, where);
    const m = /^<!--meta\s*([\s\S]*?)-->\s*([\s\S]*)$/.exec(src);
    if (!m) throw new Error(`${where}: 맨 위에 <!--meta {...} --> 가 없습니다`);
    const meta = JSON.parse(m[1]);
    return { file: where, out: f, meta, main: m[2].trim(), url: `${SITE}/${f.replace(/\.html$/, '')}` };
  });
}

function renderPage(tpl, page, posts) {
  let main = page.main;
  main = main.replace(/<!--\s*MAGAZINE:STORY\s*-->/g, () => {
    const list = posts.filter((p) => p.category === 'story').slice(0, 3);
    const fill = list.length < 3 ? posts.filter((p) => p.category !== 'story').slice(0, 3 - list.length) : [];
    return `<div class="mz-grid">${[...list, ...fill].map((p) => card(p)).join('')}</div>`;
  });
  return pageShell(tpl, { title: page.meta.title, description: page.meta.description, canonical: page.url, image: page.meta.image, imageAlt: page.meta.imageAlt,
    ogType: page.meta.ogType || 'website', ld: page.meta.ld, main, source: page.file });
}

/* --------------------------------------------------------------------------
   index.html · sitemap.xml · rss.xml 의 매거진 구역 고치기 (표시 사이만 바꿉니다)
   -------------------------------------------------------------------------- */
function replaceBetween(src, start, end, content, file) {
  const a = src.indexOf(start); const b = src.indexOf(end);
  if (a < 0 || b < a) throw new Error(`${file}: ${start} … ${end} 표시를 찾지 못했습니다`);
  return src.slice(0, a + start.length) + content + src.slice(b);
}

function homeHtml(src, posts, tpl) {
  let out = replaceBetween(src, '<!-- MAGAZINE:LATEST:START -->', '<!-- MAGAZINE:LATEST:END -->',
    `\n      <div class="mz-grid">${posts.slice(0, 3).map((p) => card(p)).join('')}</div>\n      `, 'index.html');
  out = out.replace(/\/css\/magazine\.css\?v=[^"]*/g, tpl.magCss);
  return out;
}

function sitemapXml(src, posts, pages) {
  const idx = posts[0] ? posts[0].updatedIso.slice(0, 10) : todayKST();
  const pageLast = (p) => p.meta.lastmod || idx;
  const img = (rel) => `<image:image><image:loc>${SITE}/${rel.replace(/^\//, '')}</image:loc></image:image>`;
  const rows = [
    ...pages.map((p) => `  <url><loc>${p.url}</loc><lastmod>${pageLast(p)}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority>${(p.meta.images || []).map(img).join('')}</url>`),
    `  <url><loc>${SITE}/magazine</loc><lastmod>${idx}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    ...posts.map((p) => `  <url><loc>${p.url}</loc><lastmod>${p.updatedIso.slice(0, 10)}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority>${img(p.cover)}</url>`)
  ];
  if (!src.includes('<!-- MAGAZINE:START -->')) src = src.replace('</urlset>', '  <!-- MAGAZINE:START -->\n  <!-- MAGAZINE:END -->\n</urlset>');
  return replaceBetween(src, '<!-- MAGAZINE:START -->', '<!-- MAGAZINE:END -->', `\n${rows.join('\n')}\n  `, 'sitemap.xml');
}

function rssXml(src, posts, pages) {
  const cdata = (s) => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
  const items = posts.slice(0, 30).map((p) => `    <item><title>${esc(p.title)}</title><link>${p.url}</link><guid isPermaLink="true">${p.url}</guid><category>${esc(CATEGORIES[p.category].name)}</category><description>${cdata(p.description)}</description><pubDate>${rfc822(p.iso)}</pubDate></item>`);
  const pageItems = pages.map((p) => `    <item><title>${esc(p.meta.title)}</title><link>${p.url}</link><guid isPermaLink="true">${p.url}</guid><description>${cdata(p.meta.description)}</description><pubDate>${rfc822((p.meta.lastmod || '2026-11-07') + 'T00:00:00+09:00')}</pubDate></item>`);
  if (!src.includes('<!-- MAGAZINE:START -->')) src = src.replace(/(<lastBuildDate>[^<]*<\/lastBuildDate>\n)/, '$1    <!-- MAGAZINE:START -->\n    <!-- MAGAZINE:END -->\n');
  let out = replaceBetween(src, '<!-- MAGAZINE:START -->', '<!-- MAGAZINE:END -->', `\n${[...items, ...pageItems].join('\n')}\n    `, 'rss.xml');
  if (posts[0]) out = out.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/, `<lastBuildDate>${rfc822(posts[0].updatedIso)}</lastBuildDate>`);
  return out;
}

/* --------------------------------------------------------------------------
   검사
   -------------------------------------------------------------------------- */
export function checkPosts(posts) {
  const errors = []; const warnings = [];
  const slugs = new Map();
  for (const p of posts) {
    const at = p.file;
    for (const k of ['title', 'slug', 'date', 'category', 'description', 'cover', 'coverAlt']) if (!p[k]) errors.push(`${at}: '${k}' 가 비어 있습니다`);
    if (p.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug)) errors.push(`${at}: slug 는 영문 소문자 · 숫자 · 하이픈만 씁니다 (${p.slug})`);
    if (p.slug && slugs.has(p.slug)) errors.push(`${at}: slug 가 ${slugs.get(p.slug)} 와 겹칩니다`);
    slugs.set(p.slug, at);
    if (p.date && !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) errors.push(`${at}: date 형식은 YYYY-MM-DD 입니다`);
    if (p.time && !/^\d{2}:\d{2}$/.test(p.time)) errors.push(`${at}: time 형식은 HH:MM 입니다`);
    if (p.category && !CATEGORIES[p.category]) errors.push(`${at}: category 는 ${Object.keys(CATEGORIES).join(' · ')} 중 하나입니다`);
    if (p.title && p.title.length > 44) warnings.push(`${at}: 제목이 깁니다(${p.title.length}자, 44자 이하 권장)`);
    if (p.description && (p.description.length < 60 || p.description.length > 160)) errors.push(`${at}: description 은 60~160자로 씁니다 (지금 ${p.description.length}자)`);
    if (p.cover && !exists(p.cover.replace(/^\//, ''))) errors.push(`${at}: 대표 이미지가 없습니다 (${p.cover})`);
    if (p.text.length < 1500) errors.push(`${at}: 본문이 짧습니다 (${p.text.length}자, 1,500자 이상)`);
    if (p.body.toc.length < 3) errors.push(`${at}: ## 소제목을 3개 이상 둡니다`);
    if (p.cta && !['rooms', 'work', 'host', 'story'].includes(p.cta)) errors.push(`${at}: cta 는 rooms · work · host · story 중 하나입니다`);
    const html = p.body.blocks.map((b) => typeof b === 'string' ? b : '').join(' ');
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    const internal = links.filter((h) => h.startsWith('/'));
    if (internal.length < 3) errors.push(`${at}: 본문 안 내부 링크를 3개 이상 겁니다 (지금 ${internal.length}개)`);
    for (const h of internal) {
      const base = h.split(/[?#]/)[0];
      const ok = ROUTES.includes(base) || (base.startsWith('/magazine/') && posts.some((x) => x.path === base)) || base.startsWith('/product/');
      if (!ok) errors.push(`${at}: 없는 내부 주소 ${h}`);
    }
    for (const b of p.body.blocks) if (typeof b !== 'string' && !exists(b.figure.src.replace(/^\//, ''))) errors.push(`${at}: 본문 이미지가 없습니다 (${b.figure.src})`);
    for (const s of p.related) if (!posts.some((x) => x.slug === s)) warnings.push(`${at}: related 의 ${s} 글이 없습니다`);
    const all = `${p.title} ${p.description} ${p.text}`;
    for (const [w, level] of BANNED) {
      const n = all.split(w).length - 1;
      if (!n) continue;
      if (w === '!' && n < 2) continue;
      if (w === '다양한' && n < 2) continue;
      (level === 'error' ? errors : warnings).push(`${at}: '${w}' 표현 ${n}회 — 편집 기준(EDITORIAL.md) 참고`);
    }
    if (/주류|술/.test(p.text) && /(가져와|반입 가능|마셔도)/.test(p.text) && !/반입할 수 없/.test(p.text)) errors.push(`${at}: 주류 안내는 '반입할 수 없습니다' 기준과 맞아야 합니다`);
  }
  return { errors, warnings };
}

/* --------------------------------------------------------------------------
   실행
   -------------------------------------------------------------------------- */
export function build({ write = true } = {}) {
  const data = loadData();
  const posts = loadPosts(data);
  const pages = loadPages(data);
  const result = checkPosts(posts);
  if (result.errors.length) return { ...result, posts, pages, files: [], contents: new Map(), changed: [] };
  const tpl = loadTemplate();
  const files = new Map();
  for (const p of posts) files.set(`${OUT_DIR}/${p.slug}.html`, renderPost(tpl, p, posts));
  files.set('magazine.html', renderIndex(tpl, posts));
  for (const pg of pages) files.set(pg.out, renderPage(tpl, pg, posts));
  files.set('index.html', homeHtml(read('index.html'), posts, tpl));
  files.set('sitemap.xml', sitemapXml(read('sitemap.xml'), posts, pages));
  files.set('rss.xml', rssXml(read('rss.xml'), posts, pages));
  const changed = [];
  if (write) {
    fs.mkdirSync(path.join(ROOT, OUT_DIR), { recursive: true });
    const keep = new Set(posts.map((p) => `${p.slug}.html`));
    for (const f of fs.readdirSync(path.join(ROOT, OUT_DIR))) {
      if (f.endsWith('.html') && !keep.has(f) && fs.readFileSync(path.join(ROOT, OUT_DIR, f), 'utf8').includes('scripts/magazine.mjs')) { fs.unlinkSync(path.join(ROOT, OUT_DIR, f)); changed.push(`${OUT_DIR}/${f} (삭제)`); }
    }
    for (const [rel, content] of files) {
      const abs = path.join(ROOT, rel);
      if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') === content) continue;
      fs.writeFileSync(abs, content); changed.push(rel);
    }
  }
  return { ...result, posts, pages, files: [...files.keys()], contents: files, changed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkOnly = process.argv.includes('--check');
  try {
    const r = build({ write: !checkOnly });
    for (const w of r.warnings) console.warn('경고  ' + w);
    for (const e of r.errors) console.error('오류  ' + e);
    if (r.errors.length) { console.error(`\n오류 ${r.errors.length}건 — 파일을 만들지 않았습니다.`); process.exit(1); }
    console.log(`글 ${r.posts.length}편 · 페이지 ${r.pages.length}개 확인${checkOnly ? '' : ` · 바뀐 파일 ${r.changed.length}개${r.changed.length ? '\n  ' + r.changed.join('\n  ') : ''}`}`);
  } catch (e) { console.error('오류  ' + e.message); process.exit(1); }
}
