import { json } from '../../_lib/auth.js';
import { adminGate, isIsoDate } from '../../_lib/admin.js';
import { ensureTossSales, tossConfig, TOSS_SOURCE, PASS_MATCH, MANUAL_CANDIDATE, preparePayments, savePayments, tossGet, saveOrderProducts, withOrderProducts, refreshOrderProducts } from '../../_lib/toss-sales.js';

export async function onRequestGet({request,env}) {
  const deny = await adminGate(request,env); if (deny) return deny;
  await ensureTossSales(env);
  const cfg = tossConfig(env);
  const params=new URL(request.url).searchParams;
  const page=Number(params.get('page')||1),filter=params.get('filter')||'all';
  if(!Number.isInteger(page)||page<1||page>20000||!['all','included','exclude','review','duplicate','amount-input'].includes(filter))
    return json({ok:false,message:'결제 목록 조회 조건을 확인해 주세요.'},400);
  const summary = await env.DB.prepare(`SELECT COUNT(*) AS n,COALESCE(SUM(amount-refund_amount),0) AS total,MAX(received_at) AS latest FROM ${TOSS_SOURCE}`).first();
  const webhook = await env.DB.prepare("SELECT received_at FROM toss_webhook_events WHERE event_type IN ('payment.payment.approved.v1','payment.payment.cancelled.v1') ORDER BY received_at DESC LIMIT 1").first();
  const installations=(await env.DB.prepare('SELECT merchant_id,merchant_name,installed,received_at FROM toss_installations ORDER BY received_at DESC LIMIT 20').all()).results||[];
  const ledger=`SELECT t.merchant_id,t.payment_id,t.order_id,t.paid_at,t.source_type,t.amount,t.refund_amount,t.approval_no,t.state,t.origin,
    CASE WHEN EXISTS(SELECT 1 FROM pass_payments p WHERE ${PASS_MATCH}) THEN 'duplicate'
      WHEN t.review_state='exclude' THEN 'exclude'
      WHEN t.review_state='review' OR t.source_type='EXTERNAL' THEN 'review'
      WHEN t.review_state<>'include' AND ${MANUAL_CANDIDATE} THEN 'review'
      ELSE 'included' END AS disposition, t.review_note
    FROM toss_payments t WHERE t.merchant_id=?`+(filter==='amount-input'?` AND EXISTS (
      SELECT 1 FROM toss_order_products op,json_each(op.items_json) item
      WHERE op.merchant_id=t.merchant_id AND op.order_id=t.order_id
        AND json_extract(item.value,'$.title')='금액 입력'
    )`:'');
  const dispositionFilter=!['all','amount-input'].includes(filter);
  const where=dispositionFilter?' WHERE disposition=?':'',args=[cfg.merchantId,...(dispositionFilter?[filter]:[])];
  const total=await env.DB.prepare('SELECT COUNT(*) n FROM ('+ledger+')'+where).bind(...args).first();
  const rows=(await env.DB.prepare('SELECT * FROM ('+ledger+')'+where+' ORDER BY paid_at DESC,payment_id DESC LIMIT 50 OFFSET ?')
    .bind(...args,(page-1)*50).all()).results||[];
  return json({ok:true,...cfg,summary,lastWebhook:webhook?.received_at || null,rows:await withOrderProducts(env,rows),installations,
    page,total:Number(total?.n)||0,pageSize:50,
    webhookUrl:new URL('/api/toss-place/webhook',request.url).href});
}

export async function onRequestPost({request,env}) {
  const deny = await adminGate(request,env); if (deny) return deny;
  if (Number(request.headers.get('content-length')) > 1000000) return json({ok:false,message:'1MB 이하의 데이터를 가져와 주세요.'},413);
  const raw = await request.text();
  if (raw.length > 1000000) return json({ok:false,message:'1MB 이하의 데이터를 가져와 주세요.'},413);
  let b; try { b = JSON.parse(raw); } catch { return json({ok:false,message:'가져오기 요청을 읽을 수 없습니다.'},400); }
  if (!b || typeof b !== 'object') return json({ok:false,message:'요청을 확인해 주세요.'},400);
  await ensureTossSales(env);
  if(b.action==='label') {
    if(typeof b.paymentId!=='string'||!/^\d{1,24}$/.test(b.paymentId)||typeof b.productName!=='string'||b.productName.length>160||typeof b.memo!=='string'||b.memo.length>500)
      return json({ok:false,message:'결제와 상품명(160자 이하)·메모(500자 이하)를 확인해 주세요.'},400);
    const merchantId=tossConfig(env).merchantId;
    const row=await env.DB.prepare('SELECT payment_id FROM toss_payments WHERE merchant_id=? AND payment_id=?').bind(merchantId,b.paymentId).first();
    if(!row)return json({ok:false,message:'저장된 결제를 확인해 주세요.'},400);
    await env.DB.prepare(`INSERT INTO toss_payment_labels(merchant_id,payment_id,product_name,memo) VALUES(?,?,?,?)
      ON CONFLICT(merchant_id,payment_id) DO UPDATE SET product_name=excluded.product_name,memo=excluded.memo,updated_at=datetime('now','+9 hours')`)
      .bind(merchantId,b.paymentId,b.productName.trim(),b.memo.trim()).run();
    return json({ok:true});
  }
  if(b.action==='refresh-products') {
    const after=b.after||'';
    if(typeof after!=='string'||(after&&!/^\d{1,24}$/.test(after)))return json({ok:false,message:'상품정보 조회 위치를 확인해 주세요.'},400);
    const ids=((await env.DB.prepare('SELECT DISTINCT order_id FROM toss_payments WHERE merchant_id=? AND order_id>? ORDER BY order_id LIMIT 25')
      .bind(tossConfig(env).merchantId,after).all()).results||[]).map(x=>x.order_id);
    if(!ids.length)return json({ok:true,processed:0,updated:0,missing:0,nextCursor:null});
    try {
      const updated=await refreshOrderProducts(env,ids);
      return json({ok:true,processed:ids.length,updated,missing:ids.length-updated,nextCursor:ids.length===25?ids.at(-1):null});
    }catch(e){return json({ok:false,message:e.message||'상품정보를 불러오지 못했습니다.'},422);}
  }
  if (b.action === 'fetch') {
    if (!isIsoDate(b.from) || !isIsoDate(b.to) || b.from > b.to || !Number.isInteger(b.page) || b.page < 1 || b.page > 10000)
      return json({ok:false,message:'조회 시작일·종료일을 확인해 주세요.'},400);
    if(b.to<'2022-01-01')return json({ok:false,message:'토스 Open API는 2022년 1월 1일 이후 거래부터 조회할 수 있습니다.'},400);
    try {
      // Fixed range and pages make an interrupted backfill resumable. All order states
      // are requested, including partly paid/open orders that the API otherwise excludes.
      // The provider's earliest instant is UTC 2022-01-01, i.e. 09:00 KST.
      const from=b.from<='2022-01-01'?'2022-01-01T00:00:00Z':b.from+'T00:00:00+09:00';
      const params = new URLSearchParams({from,to:b.to+'T23:59:59.999+09:00',page:String(b.page),size:'25',sortOrder:'ASC',orderStates:'REQUESTED,OPENED,COMPLETED,CANCELLED'});
      const orders = await tossGet(env,'/order/orders?'+params);
      if (!Array.isArray(orders)) throw Error('토스 주문 응답 형식이 다릅니다.');
      const payments = [];
      for (const order of orders) {
        if (String(order.merchantId) !== tossConfig(env).merchantId || !Array.isArray(order.payments)) throw Error('주문 매장·결제 응답을 확인할 수 없습니다.');
        payments.push(...order.payments);
      }
      if (payments.length > 200) throw Error('결제가 많은 주문이 있습니다. 토스 결제 JSON 파일로 나누어 가져와 주세요.');
      await saveOrderProducts(env,orders);
      const rows = payments.length ? await preparePayments(env,payments) : [];
      return json({ok:true,rows:await withOrderProducts(env,rows),payments,nextPage:orders.length === 25 ? b.page+1 : null});
    } catch (e) {
      console.warn('toss-history-failed', {message:e.message || 'unknown'});
      // Keep actionable connection/validation errors in the admin response. Edge
      // gateways may replace 502 responses with a generic non-JSON error page.
      return json({ok:false,code:'TOSS_HISTORY_FAILED',message:e.message || '토스 과거 거래를 조회하지 못했습니다.'},422);
    }
  }
  if (b.action === 'review') {
    const ids=b.paymentIds===undefined?[b.paymentId]:b.paymentIds;
    if (!Array.isArray(ids)||!ids.length||ids.length>50||ids.some(x=>typeof x!=='string'||!/^\d{1,24}$/.test(x))||new Set(ids).size!==ids.length || !['include','exclude'].includes(b.decision) || typeof b.note !== 'string' || b.note.trim().length < 3 || b.note.length > 300)
      return json({ok:false,message:'처리 방식과 확인 메모(3~300자)를 입력해 주세요.'},400);
    const merchantId=tossConfig(env).merchantId;
    const rows=(await env.DB.prepare('SELECT payment_id,source_type FROM toss_payments WHERE merchant_id=? AND payment_id IN ('+ids.map(()=>'?').join(',')+')').bind(merchantId,...ids).all()).results||[];
    if(rows.length!==ids.length||rows.some(p=>p.source_type==='EXTERNAL'))return json({ok:false,message:'대상 결제를 확인해 주세요. 외부 결제수단은 자동 합산하지 않습니다.'},400);
    await env.DB.batch(ids.map(paymentId=>env.DB.prepare('UPDATE toss_payments SET review_state=?,review_note=? WHERE merchant_id=? AND payment_id=?')
      .bind(b.decision,b.note.trim(),merchantId,paymentId)));
    return json({ok:true,changed:ids.length});
  }
  if (!['preview','commit'].includes(b.action)) return json({ok:false,message:'지원하지 않는 요청입니다.'},400);
  try {
    const rows = await preparePayments(env,b.payments);
    const changed = b.action === 'commit' ? await savePayments(env,rows,'import') : 0;
    return json({ok:true,rows:await withOrderProducts(env,rows),changed});
  } catch (e) { return json({ok:false,message:e.message},400); }
}
