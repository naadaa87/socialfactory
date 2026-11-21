/**
 * /i/abc123 — 모임 초대장 페이지
 * meet-invite.html 을 그대로 쓰되, 카카오톡 · 메신저가 읽는 제목 · 설명(머리말)을 초대장에 맞게 바꿔 보냅니다.
 * 본문은 화면에서 /api/meet/invite/abc123 으로 불러옵니다. 검색엔진에는 나오지 않게 합니다.
 */
import { ensureMeetSchema, resolveInvite, SPACES, hhmm, SITE } from '../_lib/meet.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
export function dateLabel(date, min) {
  const d = new Date(date + 'T00:00:00Z');
  const m = Number(min), h = Math.floor((m % 1440) / 60), mm = m % 60;
  const time = (h < 12 ? '오전 ' : '오후 ') + ((h % 12) || 12) + (mm ? ':' + String(mm).padStart(2, '0') : '시');
  return `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${DAYS[d.getUTCDay()]}) ${time}`;
}
export function metaBlock(inv, slug) {
  if (!inv) {
    return `<title>초대장을 찾을 수 없습니다 | 소셜팩토리 건대</title>
  <meta name="description" content="주소가 바뀌었거나 지난 모임의 초대장입니다. 모임장에게 새 초대장을 받아 주세요.">
  <meta name="robots" content="noindex, nofollow">`;
  }
  const room = SPACES[inv.space]?.name || '';
  const title = `${inv.title} · ${dateLabel(inv.date, inv.start_min)}`;
  const desc = `${inv.host_name ? inv.host_name + '님이 ' : ''}소셜팩토리 건대 ${room}에서 여는 모임에 초대합니다. 일시와 장소, 찾아오는 길과 주차를 확인하고 참석 여부를 알려 주세요.`;
  const url = `${SITE}/i/${slug}`;
  return `<title>${esc(title)} | 소셜팩토리 건대</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="robots" content="noindex, nofollow">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="소셜팩토리">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${SITE}/images/og-image.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="ko_KR">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">`;
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const slug = String((params && params.slug) || url.pathname.split('/')[2] || '');
  if (!/^[a-z0-9]{6,16}$/.test(slug)) return context.next ? context.next() : new Response('Not found', { status: 404 });
  let tpl = '';
  try {
    const r = env.ASSETS ? await env.ASSETS.fetch(new Request(url.origin + '/meet-invite')) : null;
    if (r && r.ok) tpl = await r.text();
  } catch (e) { console.error('meet-page', e && e.message); }
  if (!tpl || !tpl.includes('<!-- MEET:META:START -->')) return Response.redirect(url.origin + '/meet-invite?c=' + slug, 302);
  let inv = null;
  if (env.DB) {
    try {
      await ensureMeetSchema(env);
      inv = await resolveInvite(env, await env.DB.prepare('SELECT * FROM meet_invites WHERE slug = ?1').bind(slug).first());
    } catch (e) { console.error('meet-page-db', e && e.message); }
  }
  const start = tpl.indexOf('<!-- MEET:META:START -->'), end = tpl.indexOf('<!-- MEET:META:END -->');
  const html = start >= 0 && end > start ? tpl.slice(0, start) + '<!-- MEET:META:START -->\n  ' + metaBlock(inv, slug) + '\n  ' + tpl.slice(end) : tpl;
  return new Response(html, { status: inv ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' } });
}
export { hhmm };
