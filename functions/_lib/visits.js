/**
 * 홈페이지 방문 통계 — 관리자 KPI의 방문자 · 체류시간 · 자주 보는 페이지 · 링크 클릭 수에 씁니다.
 * - 쿠키를 쓰지 않습니다. 브라우저는 탭을 닫으면 사라지는 sessionStorage 에 임의 세션 번호만 둡니다.
 * - 방문자 구분은 접속 IP + 브라우저 정보를 '날마다 바뀌는 값'과 섞어 되돌릴 수 없게 바꾼 값(vh)으로 하루 단위로만 셉니다.
 *   원래 IP와 브라우저 정보(User-Agent)는 저장하지 않습니다.
 * - 쿼리 문자열은 저장하지 않습니다(예약 조회 주소의 토큰 등). 광고 캠페인 표시(utm_*)만 따로 남깁니다.
 * - 13개월(400일)이 지난 기록은 지웁니다 (개인정보 처리방침 2. 보유 기간).
 */
import { sha256Hex, clean } from './auth.js';

export const VISIT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS site_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, ts TEXT NOT NULL,
    sid TEXT NOT NULL, pvid TEXT NOT NULL UNIQUE, vh TEXT NOT NULL,
    path TEXT NOT NULL, title TEXT, ref_host TEXT, ref_type TEXT NOT NULL DEFAULT 'direct',
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, device TEXT NOT NULL DEFAULT 'desktop',
    entry INTEGER NOT NULL DEFAULT 0, active_ms INTEGER NOT NULL DEFAULT 0, scroll INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_visits_day ON site_visits (day, path)`,
  `CREATE INDEX IF NOT EXISTS idx_visits_sid ON site_visits (sid, day)`,
  `CREATE INDEX IF NOT EXISTS idx_visits_vh ON site_visits (vh, day)`,
  `CREATE TABLE IF NOT EXISTS site_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, ts TEXT NOT NULL,
    sid TEXT NOT NULL, pvid TEXT NOT NULL, path TEXT NOT NULL,
    kind TEXT NOT NULL, label TEXT, target TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_clicks_day ON site_clicks (day, kind)`
];
const ready = new WeakMap();
export async function ensureVisitSchema(env) {
  if (!env.DB) throw new Error('no-db');
  if (!ready.has(env.DB)) {
    const task = env.DB.batch(VISIT_SCHEMA.map(sql => env.DB.prepare(sql)));
    ready.set(env.DB, task); task.catch(() => ready.delete(env.DB));
  }
  await ready.get(env.DB);
}

export const VISIT_KEEP_DAYS = 400;
export const CLICK_KINDS = {
  kakao: '카카오톡 문의', tel: '전화', mail: '이메일', booking: '예약 페이지로 이동', booking_submit: '예약 신청 버튼',
  inquiry: '문의 페이지로 이동', inquiry_submit: '문의 보내기 버튼', quote: '견적서 PDF', shop: '이용권 · 결제',
  map: '지도 · 길찾기', family: '패밀리 사이트', external: '다른 사이트', internal: '홈페이지 안 이동', download: '파일 내려받기', button: '기타 버튼'
};
export const REF_TYPES = {
  direct: '직접 방문 · 북마크', naver: '네이버', google: '구글', daum: '다음 · 카카오 검색', kakao: '카카오톡', instagram: '인스타그램',
  facebook: '페이스북', youtube: '유튜브', blog: '블로그 · 카페', spacecloud: '스페이스클라우드', family: '패밀리 사이트', campaign: '광고 · 캠페인 링크', other: '기타 사이트', internal: '홈페이지 안'
};
const FAMILY = ['megaspot.kr', 'hellomingle.kr', 'ssople.com', 'playtion.kr', 'vacancy.co.kr', 'coremood.kr', 'orbis-estate.com', 'choisijun.com', 'yeodeol.kr'];
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|kakaotalk-scrap|yeti|daumoa|bingpreview|python|curl|wget|httpclient|monitor/i;

export const isBot = ua => !ua || BOT.test(ua);
export const deviceOf = ua => /iPad|Tablet|SM-T|Tab/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone|iPod/i.test(ua) ? 'mobile' : 'desktop';
const hostOf = v => { try { return new URL(v).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const ends = (host, list) => list.some(d => host === d || host.endsWith('.' + d));

/** 유입 경로 — 광고 표시(utm) > 이전 사이트 > 앱 안 브라우저 순서로 봅니다. */
export function classifyRef({ ref = '', ua = '', utmSource = '', siteHost = '' }) {
  const host = hostOf(ref), src = utmSource.toLowerCase();
  if (src) return { type: 'campaign', host };
  if (host && siteHost && (host === siteHost || ends(host, [siteHost]))) return { type: 'internal', host };
  if (host) {
    if (/(^|\.)blog\.naver\.com$|(^|\.)cafe\.naver\.com$|tistory\.com$|brunch\.co\.kr$|velog\.io$/.test(host)) return { type: 'blog', host };
    if (ends(host, ['naver.com', 'naver.me'])) return { type: 'naver', host };
    if (/(^|\.)google\.[a-z.]+$/.test(host)) return { type: 'google', host };
    if (ends(host, ['daum.net', 'search.daum.net'])) return { type: 'daum', host };
    if (ends(host, ['kakao.com', 'kakaocdn.net', 'kakao.co.kr'])) return { type: 'kakao', host };
    if (ends(host, ['instagram.com'])) return { type: 'instagram', host };
    if (ends(host, ['facebook.com', 'fb.com', 'fb.me'])) return { type: 'facebook', host };
    if (ends(host, ['youtube.com', 'youtu.be'])) return { type: 'youtube', host };
    if (ends(host, ['spacecloud.kr'])) return { type: 'spacecloud', host };
    if (ends(host, FAMILY)) return { type: 'family', host };
    return { type: 'other', host };
  }
  if (/KAKAOTALK/i.test(ua)) return { type: 'kakao', host: '' };
  if (/Instagram/i.test(ua)) return { type: 'instagram', host: '' };
  if (/FBAN|FBAV/i.test(ua)) return { type: 'facebook', host: '' };
  if (/NAVER\(inapp/i.test(ua)) return { type: 'naver', host: '' };
  return { type: 'direct', host: '' };
}

/** 주소는 경로만 남깁니다. /space.html → /space, /index → / */
export function normalizePath(v) {
  let p = typeof v === 'string' ? v.split(/[?#]/)[0] : '';
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/{2,}/g, '/').replace(/\.html$/i, '').replace(/\/index$/i, '/');
  if (p.length > 1) p = p.replace(/\/$/, '');
  try { p = decodeURIComponent(p); } catch { /* 그대로 */ }
  return p.replace(/[\u0000-\u001f<>"'`]/g, '').slice(0, 120) || '/';
}

const ID = /^[a-z0-9]{8,24}$/;
const textOf = (v, max) => clean(typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ') : '', max);
export const kstNow = (now = Date.now()) => new Date(now + 9 * 3600000).toISOString().slice(0, 19).replace('T', ' ');

/** 하루 단위 방문자 구분값 — 날짜가 바뀌면 같은 사람도 다른 값이 됩니다. */
export async function visitorHash(ip, ua, day, salt) {
  return (await sha256Hex([ip || '-', ua || '-', day, salt || 'socialfactory-visits'].join('|'))).slice(0, 16);
}

/** 브라우저가 보낸 한 건을 확인합니다. 잘못된 값은 null (조용히 버림). */
export function parseVisitEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const t = body.t, sid = textOf(body.sid, 24), pvid = textOf(body.pvid, 24);
  if (!ID.test(sid) || !ID.test(pvid)) return null;
  if (t === 'pv') {
    return { t, sid, pvid, path: normalizePath(body.path), title: textOf(body.title, 80), ref: textOf(body.ref, 300), entry: body.entry ? 1 : 0,
      utm_source: textOf(body.us, 40).toLowerCase(), utm_medium: textOf(body.um, 40).toLowerCase(), utm_campaign: textOf(body.uc, 80) };
  }
  if (t === 'leave') {
    const ms = Number(body.ms), scroll = Number(body.scroll);
    return { t, sid, pvid, ms: Number.isFinite(ms) ? Math.max(0, Math.min(Math.round(ms), 1800000)) : 0, scroll: Number.isFinite(scroll) ? Math.max(0, Math.min(Math.round(scroll), 100)) : 0 };
  }
  if (t === 'click') {
    const kind = textOf(body.kind, 20);
    if (!CLICK_KINDS[kind]) return null;
    return { t, sid, pvid, path: normalizePath(body.path), kind, label: textOf(body.label, 60), target: textOf(body.target, 120) };
  }
  return null;
}

export async function purgeOldVisits(env, now = Date.now(), chance = 0.01) {
  if (Math.random() >= chance) return 0;
  const cut = new Date(now + 9 * 3600000 - VISIT_KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  try {
    const a = await env.DB.prepare('DELETE FROM site_visits WHERE day < ?1').bind(cut).run();
    const b = await env.DB.prepare('DELETE FROM site_clicks WHERE day < ?1').bind(cut).run();
    return (Number(a?.meta?.changes) || 0) + (Number(b?.meta?.changes) || 0);
  } catch { return 0; }
}
