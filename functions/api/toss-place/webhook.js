import { json } from '../../_lib/auth.js';
import { ensureSchema } from '../../_lib/admin.js';
import { ensureTossSales, tossConfig, verifyWebhook, preparePayments, paymentStatement, installationFields } from '../../_lib/toss-sales.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.TOSS_PLACE_WEBHOOK_SECRET) return json({ok:false,error:'not-configured'},503);
  if (Number(request.headers.get('content-length')) > 100000) return json({ok:false,error:'too-large'},413);
  const raw = await request.text();
  if (raw.length > 100000) return json({ok:false,error:'too-large'},413);
  if (!await verifyWebhook(request,raw,env.TOSS_PLACE_WEBHOOK_SECRET)) return json({ok:false,error:'signature'},401);
  let event;
  try { event = JSON.parse(raw); } catch { return json({ok:false,error:'bad-json'},400); }
  const eventId = request.headers.get('x-toss-webhook-id');
  if (!eventId || !/^[A-Za-z0-9_-]{1,100}$/.test(eventId) || event?.id !== eventId)
    return json({ok:false,error:'event-or-merchant'},400);
  if(event.type==='_test.v1')return json({ok:true,test:true});
  if(['app.installation.created.v1','app.installation.deleted.v1'].includes(event.type)) {
    const candidate=installationFields(event);
    if(!candidate)return json({ok:false,error:'installation'},400);
    try {
      await ensureTossSales(env);
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO toss_installations(merchant_id,merchant_name,installed,provider_updated) VALUES(?,?,?,?)
          ON CONFLICT(merchant_id) DO UPDATE SET merchant_name=CASE WHEN excluded.merchant_name<>'' THEN excluded.merchant_name ELSE toss_installations.merchant_name END,
            installed=excluded.installed,provider_updated=excluded.provider_updated,received_at=datetime('now','+9 hours')
          WHERE excluded.provider_updated>toss_installations.provider_updated
            OR (excluded.provider_updated=toss_installations.provider_updated AND excluded.installed<=toss_installations.installed)`)
          .bind(candidate.merchantId,candidate.name,candidate.installed,candidate.updated),
        env.DB.prepare('INSERT INTO toss_webhook_events(event_id,merchant_id,payment_id,event_type) VALUES (?,?,?,?) ON CONFLICT(event_id) DO NOTHING')
          .bind(eventId,candidate.merchantId,'',event.type)
      ]);
      return json({ok:true,installation:true});
    }catch{return json({ok:false,error:'storage'},500);}
  }
  if (!tossConfig(env).merchantId) return json({ok:false,error:'merchant-not-configured'},503);
  if (String(event.merchantId)!==tossConfig(env).merchantId)return json({ok:false,error:'event-or-merchant'},400);
  const types = {'payment.payment.approved.v1':'APPROVED','payment.payment.cancelled.v1':'CANCELLED'};
  if (!types[event.type]) return json({ok:true,ignored:true});
  if (event.data?.payment?.state !== types[event.type]) return json({ok:false,error:'event-state'},400);
  try {
    await ensureSchema(env);
    await ensureTossSales(env);
    if (await env.DB.prepare('SELECT event_id FROM toss_webhook_events WHERE event_id=?').bind(eventId).first()) return json({ok:true,duplicate:true});
    const rows = await preparePayments(env,[event.data.payment]);
    if (rows[0].result === 'blocked') return json({ok:false,error:'payment-conflict'},409);
    // Record both in one transaction. A failed DB write must be retried by Toss.
    await env.DB.batch([
      paymentStatement(env,rows[0],'webhook'),
      env.DB.prepare('INSERT INTO toss_webhook_events(event_id,merchant_id,payment_id,event_type) VALUES (?,?,?,?) ON CONFLICT(event_id) DO NOTHING')
        .bind(eventId,rows[0].merchant_id,rows[0].payment_id,event.type)
    ]);
    return json({ok:true});
  } catch { return json({ok:false,error:'storage-or-payment'},500); }
}
