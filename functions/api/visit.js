/**
 * POST /api/visit — 홈페이지 방문 통계 (js/visit.js 가 보냄, 응답 본문 없음)
 * { t:'pv' }    페이지를 열었을 때: 경로 · 제목 · 이전 사이트 · 광고 표시
 * { t:'leave' } 페이지를 떠나거나 탭을 숨길 때: 실제로 보고 있던 시간 · 스크롤 정도 (더 큰 값만 반영)
 * { t:'click' } 링크 · 주요 버튼을 눌렀을 때: 종류 · 글자 · 이동할 곳
 * 기록이 실패해도 홈페이지 이용에는 영향이 없도록 항상 204를 돌려줍니다.
 */
import { sameOrigin } from '../_lib/auth.js';
import { ensureVisitSchema, parseVisitEvent, isBot, deviceOf, classifyRef, visitorHash, kstNow, purgeOldVisits } from '../_lib/visits.js';
import { pingIndexNow } from '../_lib/indexnow.js';

const done = () => new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
const PV_LIMIT = 300;   // 같은 방문자(하루 구분값)의 하루 페이지 기록 상한 — 비정상 반복 요청 차단
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// 새 글 · 바뀐 페이지를 검색엔진에 알리는 확인(IndexNow)을 방문이 있을 때도 한 번씩 깨웁니다.
// 5분마다 도는 알림 발송기가 멈춰 있어도 알림이 끊기지 않게 하는 보조 장치이며, 실제 확인은 30분에 한 번만 이뤄집니다.
let seoTriedAt = 0;
const SEO_RETRY_MS = 10 * 60 * 1000;

export async function onRequestPost({ request, env, waitUntil }) {
  try {
    if (!env.DB || !sameOrigin(request)) return done();
    const ua = request.headers.get('user-agent') || '';
    if (isBot(ua)) return done();
    if (typeof waitUntil === 'function' && Date.now() - seoTriedAt > SEO_RETRY_MS) {
      seoTriedAt = Date.now();
      try { waitUntil(pingIndexNow(env, new URL(request.url).origin).catch(() => null)); } catch { /* 무시 */ }
    }
    const raw = await request.text();
    if (raw.length > 2048) return done();
    let body; try { body = JSON.parse(raw); } catch { return done(); }
    const e = parseVisitEvent(body);
    if (!e) return done();
    await ensureVisitSchema(env);
    const ts = kstNow(), day = ts.slice(0, 10);
    if (e.t === 'pv') {
      const vh = await visitorHash(request.headers.get('cf-connecting-ip') || '', ua, day, env.IP_SALT);
      const seen = await env.DB.prepare('SELECT COUNT(*) AS n FROM site_visits WHERE vh=?1 AND day=?2').bind(vh, day).first();
      if (Number(seen?.n) >= PV_LIMIT) return done();
      const siteHost = new URL(request.url).hostname.replace(/^www\./, '');
      const ref = classifyRef({ ref: e.ref, ua, utmSource: e.utm_source, siteHost });
      await env.DB.prepare(`INSERT OR IGNORE INTO site_visits (day, ts, sid, pvid, vh, path, title, ref_host, ref_type, utm_source, utm_medium, utm_campaign, device, entry)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`)
        .bind(day, ts, e.sid, e.pvid, vh, e.path, e.title || null, ref.host || null, ref.type, e.utm_source || null, e.utm_medium || null, e.utm_campaign || null, deviceOf(ua), e.entry).run();
      await purgeOldVisits(env);
    } else if (e.t === 'leave') {
      // 페이지를 바로 떠나면 '열람'과 '떠남'이 거의 같이 도착할 수 있어, 열람 기록이 생길 때까지 잠깐 기다립니다.
      for (let i = 0; i < 4; i++) {
        const r = await env.DB.prepare('UPDATE site_visits SET active_ms=MAX(active_ms, ?3), scroll=MAX(scroll, ?4) WHERE pvid=?1 AND sid=?2').bind(e.pvid, e.sid, e.ms, e.scroll).run();
        if (Number(r?.meta?.changes) || i === 3) break;
        await wait(200 * (i + 1));
      }
    } else if (e.t === 'click') {
      // 기록된 페이지 보기에 딸린 클릭만 받습니다.
      let pv = null;
      for (let i = 0; i < 4 && !pv; i++) {
        pv = await env.DB.prepare('SELECT day FROM site_visits WHERE pvid=?1 AND sid=?2').bind(e.pvid, e.sid).first();
        if (!pv && i < 3) await wait(200 * (i + 1));
      }
      if (!pv) return done();
      await env.DB.prepare('INSERT INTO site_clicks (day, ts, sid, pvid, path, kind, label, target) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
        .bind(day, ts, e.sid, e.pvid, e.path, e.kind, e.label || null, e.target || null).run();
    }
  } catch (error) { console.error('visit', error?.message); }
  return done();
}
