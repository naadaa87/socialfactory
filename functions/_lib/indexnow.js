/**
 * 새 글 · 바뀐 페이지를 검색엔진에 바로 알립니다 (IndexNow).
 * ------------------------------------------------------------------
 * 네이버 · 빙 등이 함께 쓰는 알림 방식입니다. 사이트맵(sitemap.xml · sitemap-community.xml)의 주소와 수정일을
 * 지난번에 알린 값과 견주어, 새로 생겼거나 수정일이 바뀐 주소만 보냅니다. 알린다고 색인이 보장되지는 않습니다.
 *
 * - 5분마다 도는 알림 발송기(/api/notify/run)가 부르고, 실제 확인은 30분에 한 번만 합니다.
 * - 정식 주소(socialfactory.co.kr)에서만 동작합니다. 미리 보기 주소(*.pages.dev)에서는 아무것도 하지 않습니다.
 * - 열쇠(INDEXNOW_KEY)는 공개 값입니다. 같은 이름의 파일(/<열쇠>.txt)이 사이트 맨 위에 있어야 검색엔진이 받아 줍니다.
 */
export const INDEXNOW_KEY = '33d5c77fcb07b5c41db66852fecae5ce';
export const INDEXNOW_HOST = 'socialfactory.co.kr';
const ENDPOINTS = ['https://api.indexnow.org/indexnow', 'https://searchadvisor.naver.com/indexnow'];
const INTERVAL_MS = 30 * 60 * 1000;
const MAX_URLS = 2000;

export function parseSitemap(xml) {
  const out = {};
  for (const m of String(xml || '').matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(m[1]);
    if (!loc) continue;
    const mod = /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(m[1]);
    out[loc[1].replace(/&amp;/g, '&')] = mod ? mod[1] : '';
  }
  return out;
}

/** 지난번에 알린 목록(prev)과 지금 사이트맵(now)을 견주어 알릴 주소를 고릅니다. */
export function changedUrls(prev, now) {
  return Object.keys(now).filter((u) => !(u in prev) || prev[u] !== now[u]);
}

async function ensure(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS seo_state (k TEXT PRIMARY KEY, v TEXT NOT NULL DEFAULT \'\', updated_at INTEGER NOT NULL DEFAULT 0)').run();
}

async function readSitemap(env, origin, path, fetcher) {
  try {
    const req = new Request(origin + path, { headers: { accept: 'application/xml' } });
    const r = path === '/sitemap.xml' && env.ASSETS ? await env.ASSETS.fetch(req) : await fetcher(req);
    return r && r.ok ? parseSitemap(await r.text()) : null;
  } catch { return null; }
}

/**
 * @returns {Promise<{skipped?:string, submitted?:number, results?:object[]}>}
 */
export async function pingIndexNow(env, origin, { fetcher = fetch, now = Date.now(), force = false } = {}) {
  let host = '';
  try { host = new URL(origin).hostname; } catch { return { skipped: 'bad-origin' }; }
  if (host !== INDEXNOW_HOST) return { skipped: 'not-production' };
  if (!env || !env.DB) return { skipped: 'no-db' };
  await ensure(env);
  // 여러 요청이 동시에 와도 한 번만 확인하도록 시각을 먼저 차지합니다.
  const claim = await env.DB.prepare(`INSERT INTO seo_state (k, v, updated_at) VALUES ('indexnow-lock', '', ?1)
    ON CONFLICT(k) DO UPDATE SET updated_at = excluded.updated_at WHERE seo_state.updated_at <= ?2`).bind(now, force ? now : now - INTERVAL_MS).run();
  if (!claim || !claim.meta || !claim.meta.changes) return { skipped: 'recent' };

  const main = await readSitemap(env, origin, '/sitemap.xml', fetcher);
  if (!main || !Object.keys(main).length) return { skipped: 'no-sitemap' };
  const community = await readSitemap(env, origin, '/sitemap-community.xml', fetcher);
  const current = { ...main, ...(community || {}) };
  const row = await env.DB.prepare("SELECT v FROM seo_state WHERE k = 'indexnow'").first();
  let prev = {}; try { prev = JSON.parse((row && row.v) || '{}') || {}; } catch { prev = {}; }
  // 커뮤니티 사이트맵을 못 읽었을 때는 지난번 커뮤니티 주소를 그대로 둡니다 (다음에 한꺼번에 다시 알리지 않도록).
  if (!community) for (const [u, d] of Object.entries(prev)) if (!(u in current) && /\/community\/\d+$/.test(u)) current[u] = d;
  const urls = changedUrls(prev, current).filter((u) => u.startsWith(`https://${INDEXNOW_HOST}/`)).slice(0, MAX_URLS);
  if (!urls.length) return { submitted: 0 };

  const body = JSON.stringify({ host: INDEXNOW_HOST, key: INDEXNOW_KEY, keyLocation: `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`, urlList: urls });
  const results = [];
  for (const endpoint of ENDPOINTS) {
    try {
      const r = await fetcher(new Request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body }));
      results.push({ endpoint, status: r.status });
    } catch (e) { results.push({ endpoint, status: 0, error: String((e && e.message) || e).slice(0, 80) }); }
  }
  // 한 곳이라도 받아 주면(200 · 202) 알린 것으로 기록합니다. 모두 실패하면 다음 확인 때 다시 보냅니다.
  const accepted = results.some((r) => r.status === 200 || r.status === 202);
  if (accepted) {
    const next = { ...prev }; for (const u of urls) next[u] = current[u];
    for (const u of Object.keys(next)) if (!(u in current)) delete next[u];
    await env.DB.prepare("INSERT INTO seo_state (k, v, updated_at) VALUES ('indexnow', ?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at").bind(JSON.stringify(next), now).run();
  }
  await env.DB.prepare("INSERT INTO seo_state (k, v, updated_at) VALUES ('indexnow-last', ?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
    .bind(JSON.stringify({ at: now, count: urls.length, accepted, results, sample: urls.slice(0, 5) }), now).run();
  return { submitted: accepted ? urls.length : 0, results };
}
