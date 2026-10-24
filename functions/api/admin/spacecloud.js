/** Authenticated configuration and refresh; private URLs never appear in responses. */
import { json } from '../../_lib/auth.js';
import { adminGate } from '../../_lib/admin.js';
import { loadSpacecloud, readFeedConfig, saveFeedConfig } from '../../_lib/spacecloud.js';

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  try {
    const feeds = await readFeedConfig(env);
    const data = await loadSpacecloud(env);
    return json({ ok: true, rooms: feeds.map(f => f.space), spacecloud: data.info });
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
  const data = await loadSpacecloud(env, { force: true });
  return json({ ok: !data.info.error, spacecloud: data.info }, data.info.error ? 503 : 200);
}
