/**
 * /sitemap-community.xml — 공개된 커뮤니티 글(모임 소개 · 자유게시판)의 사이트맵
 * 글이 데이터베이스에 있어 정적 sitemap.xml 에 넣을 수 없으므로, 요청이 올 때 만들어 보냅니다.
 * robots.txt 에 이 주소를 함께 적어 두었습니다. 숨김 · 삭제 · 예약 발행 전 글은 넣지 않습니다.
 */
import { ensureCommunitySchema, kstNow } from './_lib/community.js';

const SITE = 'https://socialfactory.co.kr';
const xml = (rows) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.join('\n')}
</urlset>
`;
const send = (body) => new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=1800', 'X-Content-Type-Options': 'nosniff' } });

export async function onRequestGet({ env }) {
  if (!env || !env.DB) return send(xml([]));
  try {
    await ensureCommunitySchema(env);
    const { results } = await env.DB.prepare(`SELECT id, board, COALESCE(updated_at, publish_at) AS changed FROM community_posts
      WHERE status = 'published' AND publish_at <= ?1 AND deleted_at IS NULL ORDER BY publish_at DESC LIMIT 2000`).bind(kstNow()).all();
    const rows = (results || []).map((p) => {
      const day = /^\d{4}-\d{2}-\d{2}/.test(String(p.changed || '')) ? String(p.changed).slice(0, 10) : '';
      return `  <url><loc>${SITE}/community/${Number(p.id)}</loc>${day ? `<lastmod>${day}</lastmod>` : ''}<changefreq>weekly</changefreq><priority>${p.board === 'groups' ? '0.6' : '0.4'}</priority></url>`;
    });
    return send(xml(rows));
  } catch (e) {
    console.error('sitemap-community', e && e.message);
    return send(xml([]));
  }
}
