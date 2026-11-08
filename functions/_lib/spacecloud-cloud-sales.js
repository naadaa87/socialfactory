const FIRST = '2026-10-01';
const DAY = 86400000, MINUTE = 60000;
export const SALES_INTERVAL_MS = 6 * 60 * MINUTE;
const kstDay = ms => new Date(ms + 9 * 3600000).toISOString().slice(0,10);
const shift = (date,days) => new Date(Date.parse(date+'T00:00:00Z')+days*DAY).toISOString().slice(0,10);
const later = (a,b) => a > b ? a : b;
const earlier = (a,b) => a < b ? a : b;

export async function cloudSalesState(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS spacecloud_cloud_sales (
    id INTEGER PRIMARY KEY CHECK(id=1), last_attempt INTEGER NOT NULL DEFAULT 0,
    last_success INTEGER, status TEXT, message TEXT, counts TEXT, through_date TEXT,
    history_next TEXT, last_history INTEGER, scan_kind TEXT, scan_from TEXT, scan_to TEXT
  )`).run();
  await env.DB.prepare('INSERT OR IGNORE INTO spacecloud_cloud_sales(id) VALUES (1)').run();
  return env.DB.prepare('SELECT * FROM spacecloud_cloud_sales WHERE id=1').first();
}

export function paymentScan(state,now,retry=false) {
  const today = kstDay(now);
  if (today < FIRST) return null;
  const catchup = !state.through_date || state.through_date < shift(today,-1);
  const recentDue = catchup || !state.last_success || now-state.last_success>=SALES_INTERVAL_MS;
  // A running/failed pass is retried using the same dates before advancing.
  if (state.status==='running' || state.status==='error') {
    if (now-state.last_attempt < 30*MINUTE && !(retry && state.status==='error')) return null;
    if(state.scan_kind==='recent' || !recentDue)return {kind:state.scan_kind,from:state.scan_from,to:state.scan_to};
  }
  if (recentDue) {
    const from = state.through_date ? later(FIRST,earlier(shift(today,-60),shift(state.through_date,1))) : FIRST;
    return {kind:'recent',from,to:earlier(today,shift(from,89))};
  }
  // Revisit older payment dates for late refunds and bookings that moved
  // between the draft and completed lists. This never delays the recent scan.
  const boundary = shift(today,-61);
  if (boundary<FIRST || now-(state.last_history || 0)<DAY) return null;
  const from = state.history_next && state.history_next<=boundary ? state.history_next : FIRST;
  return {kind:'history',from,to:earlier(boundary,shift(from,29))};
}

export async function beginCloudSales(env, {now=Date.now(),retry=false}={}) {
  const state = await cloudSalesState(env);
  const plan = paymentScan(state,now,retry);
  if (!plan) return null;
  const update = await env.DB.prepare(`UPDATE spacecloud_cloud_sales SET last_attempt=?1,status='running',
    message='스페이스클라우드 정산 내역 확인 중',scan_kind=?2,scan_from=?3,scan_to=?4
    WHERE id=1 AND last_attempt=?5`).bind(now,plan.kind,plan.from,plan.to,state.last_attempt).run();
  return update.meta?.changes ? {...plan,observed_at:now} : null;
}

export async function finishCloudSales(env,state,status,message,counts=null,now=Date.now()) {
  const recent = status!=='error' && state.scan_kind==='recent';
  const history = status!=='error' && state.scan_kind==='history';
  await env.DB.prepare(`UPDATE spacecloud_cloud_sales SET status=?2,message=?3,
    counts=COALESCE(?4,counts),last_success=CASE WHEN ?5 THEN ?7 ELSE last_success END,
    through_date=CASE WHEN ?5 THEN MAX(COALESCE(through_date,?8),?8) ELSE through_date END,
    last_history=CASE WHEN ?6 THEN ?7 ELSE last_history END,history_next=CASE WHEN ?6 THEN ?9 ELSE history_next END
    WHERE id=1 AND last_attempt=?1 AND status='running'`)
    .bind(state.last_attempt,status,message,counts&&JSON.stringify(counts),recent?1:0,history?1:0,
      now,state.scan_to,shift(state.scan_to,1)).run();
}

export async function cloudSalesSummary(env) {
  const row=await cloudSalesState(env);
  if (!row.last_attempt) return null;
  const {last_attempt,last_success,status,message,counts,through_date,last_history}=row;
  return {last_attempt,last_success,status,message,counts,through_date,last_history,interval_ms:SALES_INTERVAL_MS};
}

