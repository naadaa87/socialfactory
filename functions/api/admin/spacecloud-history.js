import { json } from '../../_lib/auth.js';
import { adminGate, isIsoDate } from '../../_lib/admin.js';
import { sha256Hex } from '../../_lib/auth.js';
import { readFeedConfig } from '../../_lib/spacecloud.js';
import { ensureCalendarHistory, historicalInterval } from '../../_lib/spacecloud-history.js';
import { ensureSpacecloudSales } from '../../_lib/spacecloud-sales.js';

// One-time host-center backfill. It adds occupancy only; paid sales remain in spacecloud_sales.
export async function onRequestPost({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  if (Number(request.headers.get('content-length')) > 100000) return json({ ok:false, message:'파일이 너무 큽니다.' }, 413);
  let body;
  try { const raw = await request.text(); if (raw.length > 100000) throw Error(); body = JSON.parse(raw); }
  catch { return json({ ok:false, message:'예약 자료를 읽을 수 없습니다.' }, 400); }
  if (!['preview','commit'].includes(body?.action) || !Array.isArray(body.rows) || !body.rows.length || body.rows.length > 200)
    return json({ ok:false, message:'한 번에 1~200건을 확인해 주세요.' }, 400);
  await ensureSpacecloudSales(env);
  await ensureCalendarHistory(env);
  const feeds = new Map((await readFeedConfig(env)).map(f => [f.space, f.url]));
  const seen = new Set(), rows = [], statements = [];
  for (const x of body.rows) {
    const id = String(x?.reservation_id || ''), space = x?.space, date = x?.date;
    const startMin = x?.start_min, endMin = x?.end_min;
    let reason = '';
    if (x?.venue !== '소셜팩토리 건대 (초특가)' || x?.status !== 'USEDC') reason = '소셜팩토리 이용완료 예약만 반영할 수 있습니다.';
    if (!/^\d{1,16}$/.test(id) || !feeds.has(space) || !isIsoDate(date)
      || !Number.isSafeInteger(startMin) || !Number.isSafeInteger(endMin)
      || startMin < 0 || startMin >= 1440 || endMin <= startMin || endMin > startMin + 1440
      || startMin % 30 || endMin % 30) reason = '예약번호·공간·날짜·시간을 확인해 주세요.';
    const key = `${id}|${space}`;
    if (seen.has(key)) reason = '파일 안에 같은 예약번호·공간이 중복됐습니다.';
    seen.add(key);
    let start, end, sale, existing, configHash;
    if (!reason) {
      ({ start, end } = historicalInterval(date, startMin, endMin));
      if (end > Date.now()) reason = '완료되지 않은 이용 시간입니다.';
      sale = await env.DB.prepare('SELECT reservation_id,use_date,end_date,space FROM spacecloud_sales WHERE reservation_id=?1').bind(id).first();
      if (!sale || date < sale.use_date || date > sale.end_date) reason = '자동 수집된 결제내역과 이용일이 일치하지 않습니다.';
      else if (sale.space !== 'other' && sale.space !== space) reason = '결제내역의 공간과 다릅니다.';
      configHash = await sha256Hex(feeds.get(space));
      existing = await env.DB.prepare(`SELECT start_ms,end_ms FROM spacecloud_calendar_history
        WHERE reservation_id=?1 AND space=?2 LIMIT 1`).bind(id, space).first();
      if (existing && (existing.start_ms !== start || existing.end_ms !== end)) reason = '이미 다른 시간으로 보관된 예약입니다. 직접 확인해 주세요.';
    }
    const state = reason ? 'blocked' : existing ? 'unchanged' : 'new';
    rows.push({ reservation_id:id, space, date, start_min:startMin, end_min:endMin, state, reason });
    if (state === 'new') statements.push(env.DB.prepare(`INSERT INTO spacecloud_calendar_history
      (space,uid,reservation_id,config_hash,start_ms,end_ms,title,source,recorded_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,'host_verified',?8)
      ON CONFLICT(space,uid) DO NOTHING`)
      .bind(space, `host:${id}:${space}`, id, configHash, start, end, `스페이스클라우드 예약 #${id}`, Date.now()));
  }
  if (body.action === 'commit') {
    if (rows.some(r => r.state === 'blocked')) return json({ ok:false, message:'확인이 필요한 예약이 있습니다. 수정 후 다시 확인해 주세요.', rows }, 409);
    for (let i = 0; i < statements.length; i += 100) await env.DB.batch(statements.slice(i, i + 100));
  }
  return json({ ok:true, rows, new_count:rows.filter(r => r.state === 'new').length,
    message:body.action === 'commit' ? '과거 예약 시간표에 반영했습니다. 매출은 중복으로 합산하지 않습니다.' : undefined });
}
