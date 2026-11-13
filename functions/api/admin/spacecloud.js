/** Authenticated configuration and refresh; private URLs never appear in responses. */
import { json } from '../../_lib/auth.js';
import { adminGate } from '../../_lib/admin.js';
import { loadSpacecloud, readFeedConfig, saveFeedConfig } from '../../_lib/spacecloud.js';
import { requestHostCalendar } from '../../_lib/spacecloud-host-calendar.js';
import { cloudRunnerOrigin } from '../../_lib/spacecloud-runner.js';

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  try {
    const feeds = await readFeedConfig(env);
    const data = await loadSpacecloud(env);
    let audit;
    if(new URL(request.url).searchParams.get('audit')==='1') {
      const rows=(await env.DB.prepare('SELECT space,event_json,checked_at FROM spacecloud_host_calendar_removed ORDER BY space,checked_at DESC').all()).results||[];
      audit=rows.map(r=>{const e=JSON.parse(r.event_json);return {space:r.space,title:e.title,start:e.start,end:e.end,checked_at:r.checked_at};});
    }
    return json({ ok: true, rooms: feeds.map(f => f.space), spacecloud: data.info, ...(audit?{audit_removed:audit}:{}) });
  } catch { return json({ ok: false, message: '캘린더 연결 설정을 읽지 못했습니다.' }, 503); }
}
export async function onRequestPost({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad-json' }, 400); }
  if (body.action === 'configure') {
    try { await saveFeedConfig(env, body.feeds); }
    catch { return json({ ok: false, error: 'feed-config', message: '룸별 스페이스클라우드 캘린더 내보내기 주소를 확인해 주세요.' }, 400); }
  } else if (body.action && body.action !== 'refresh') return json({ ok: false, error: 'invalid' }, 400);
  if(env.SPACECLOUD_SYNC_ENABLED==='true')await requestHostCalendar(env);
  const origin=cloudRunnerOrigin(env.SPACECLOUD_RUNNER_URL),token=env.CLOUD_ADMIN_TOKEN;
  if(body.action!=='configure' && origin && typeof token==='string' && /^[A-Za-z0-9._~+\/=-]{32,512}$/.test(token)) {
    try {
      // Explicit admin refresh may run the read-only audit immediately. Cron
      // retains the durable request if another job is busy or this call fails.
      await fetch(origin+'/calendar/check',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(45000),
        headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});
    } catch { /* Keep the queued audit and last verified calendar. */ }
  }
  const data = await loadSpacecloud(env, { force: true });
  return json({ ok: !data.info.error, spacecloud: data.info }, data.info.error ? 503 : 200);
}
