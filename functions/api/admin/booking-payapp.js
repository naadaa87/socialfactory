import { json, clean } from '../../_lib/auth.js';
import { adminGate } from '../../_lib/admin.js';
import { payappConfig, ensurePayappSchema, createPayment, cancelBookingPayment, checkoutUrl } from '../../_lib/booking-payapp.js';

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  await ensurePayappSchema(env);
  const rows = await env.DB.prepare(`SELECT p.code,p.kind,p.inquiry_id,p.label,p.amount,p.mul_no,p.token,p.pay_url,p.status,p.paid_at,p.refund_amount,p.failure,p.created_at,
    i.name,i.phone,i.company,i.receipt FROM booking_payapp_requests p LEFT JOIN inquiries i ON i.id=p.inquiry_id WHERE p.kind='office' ORDER BY p.created_at DESC LIMIT 300`).all();
  const inquiries = await env.DB.prepare("SELECT id,receipt,name,phone,company,when_text,status FROM inquiries WHERE purpose='office' ORDER BY id DESC LIMIT 300").all();
  const results=(rows.results || []).map(row=>{row.pay_url=checkoutUrl(env,row);delete row.token;return row;});
  return json({ ok:true, ready:payappConfig(env).ready, results, inquiries:inquiries.results || [] });
}
export async function onRequestPost({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let body;
  try { body = await request.json(); } catch { return json({ok:false,message:'입력값을 확인해 주세요.'},400); }
  if (!body || typeof body !== 'object') return json({ok:false,message:'입력값을 확인해 주세요.'},400);
  try {
    if (body.action === 'cancel') {
      await ensurePayappSchema(env);
      const row = await env.DB.prepare("SELECT code FROM booking_payapp_requests WHERE code=?1 AND kind='office'").bind(clean(body.code,64)).first();
      if (!row) return json({ok:false,message:'청구 내역이 없습니다.'},404);
      await cancelBookingPayment(env,{booking:row});
      return json({ok:true});
    }
    const id = Number(body.inquiry_id), amount = Number(body.amount), label = clean(body.label,80);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(amount) || amount < 1000 || amount > 100000000 || !label || body.contract_confirmed !== true)
      return json({ok:false,message:'상담, 입주 조건과 청구금액을 확인한 뒤 발급해 주세요.'},400);
    const inquiry = await env.DB.prepare("SELECT * FROM inquiries WHERE id=?1 AND purpose='office'").bind(id).first();
    if (!inquiry) return json({ok:false,message:'독립사무실 상담 접수 내역을 선택해 주세요.'},404);
    const result = await createPayment(env,{code:'OF-'+inquiry.receipt,kind:'office',inquiry_id:id,label,amount,phone:inquiry.phone,email:inquiry.email || ''});
    return json({ok:true,...result,message:'결제 링크가 생성되었습니다. 상담 고객에게 직접 전달해 주세요.'});
  } catch(error) {
    console.error('payapp-admin',error.code || 'internal');
    return json({ok:false,code:error.code || 'PAYAPP_ERROR',message:error.code ? error.message : '결제요청을 처리하지 못했습니다.'},error.status || 500);
  }
}
