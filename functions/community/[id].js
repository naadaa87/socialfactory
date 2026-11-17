/**
 * /community/123 — 커뮤니티 글 보기 페이지
 * community-post.html 을 그대로 쓰되, 카카오톡 · 검색엔진이 읽는 제목 · 설명 · 대표 사진(머리말)을 글에 맞게 바꿔 보냅니다.
 * 본문은 화면에서 /api/community/posts/123 으로 불러옵니다.
 */
import { ensureCommunitySchema, isVisible, shapePost, excerpt } from '../_lib/community.js';

const SITE = 'https://socialfactory.co.kr';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iso = (kst) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(kst || '') ? kst.replace(' ', 'T') + '+09:00' : undefined);

export function metaBlock(post, id) {
  if (!post) {
    return `<title>글을 찾을 수 없습니다 | 소셜팩토리 커뮤니티</title>
  <meta name="description" content="삭제되었거나 비공개로 바뀐 글입니다. 소셜팩토리 커뮤니티에서 다른 모임과 글을 둘러보세요.">
  <meta name="robots" content="noindex">`;
  }
  const s = shapePost(post);
  const title = post.board === 'groups' ? `${s.title} — ${s.categoryName} 모임 | 소셜팩토리 커뮤니티` : `${s.title} | 소셜팩토리 자유게시판`;
  const desc = excerpt(post.board === 'groups' ? `${post.summary || ''} ${post.body}` : post.body, 150) || '소셜팩토리 커뮤니티';
  const url = `${SITE}/community/${id}`;
  const image = s.cover ? SITE + s.cover : `${SITE}/images/og-image.jpg`;
  const ld = {
    '@context': 'https://schema.org', '@type': 'DiscussionForumPosting', headline: s.title, text: desc, url,
    author: { '@type': s.author.staff ? 'Organization' : 'Person', name: s.author.name },
    datePublished: iso(post.publish_at), dateModified: iso(post.updated_at || post.publish_at), image: s.cover ? image : undefined,
    isPartOf: { '@type': 'WebPage', '@id': `${SITE}/community` },
    interactionStatistic: [
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: s.likes },
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: s.comments }
    ]
  };
  return `<title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="${esc(url)}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="소셜팩토리">
  <meta property="og:title" content="${esc(s.title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:locale" content="ko_KR">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(s.title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <meta name="twitter:image" content="${esc(image)}">
  <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`;
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const id = String((params && params.id) || url.pathname.split('/')[2] || '');
  if (!/^\d{1,9}$/.test(id)) return context.next ? context.next() : new Response('Not found', { status: 404 });
  let tpl = '';
  try {
    const r = env.ASSETS ? await env.ASSETS.fetch(new Request(url.origin + '/community-post')) : null;
    if (r && r.ok) tpl = await r.text();
  } catch (e) { console.error('community-page', e && e.message); }
  if (!tpl || !tpl.includes('<!-- COMMUNITY:META:START -->')) return Response.redirect(url.origin + '/community-post?id=' + id, 302);
  let post = null;
  if (env.DB) {
    try {
      await ensureCommunitySchema(env);
      const p = await env.DB.prepare('SELECT * FROM community_posts WHERE id = ?1').bind(Number(id)).first();
      if (isVisible(p)) post = p;
    } catch (e) { console.error('community-page-db', e && e.message); }
  }
  const start = tpl.indexOf('<!-- COMMUNITY:META:START -->'), end = tpl.indexOf('<!-- COMMUNITY:META:END -->');
  const html = start >= 0 && end > start ? tpl.slice(0, start) + '<!-- COMMUNITY:META:START -->\n  ' + metaBlock(post, id) + '\n  ' + tpl.slice(end) : tpl;
  return new Response(html, { status: post ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' } });
}
