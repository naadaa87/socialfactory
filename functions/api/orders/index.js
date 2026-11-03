/**
 * POST /api/orders — 주문 만들기 (결제 대기) → 결제창 요청값 반환
 * 금액은 화면 값을 믿지 않고 서버의 상품표(_lib/products.js)로 다시 계산합니다.
 */
import { PRODUCT_MAP } from "../../_lib/products.js";
import { payConfig, makeOid, orderToken, pcPayFields, mobilePayFields, pcJsUrl, sha256 } from "../../_lib/shop.js";
import { json, clean, normEmail, validEmail, phoneDigits, formatPhone, sameOrigin, getMember, ipHashOf } from "../../_lib/auth.js";

import { ensurePayapp, requestPayment } from "../../_lib/payapp.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "origin" }, 403);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  const cfg = payConfig(env);
  if (!cfg.ready) return json({ ok: false, error: "pay-off" }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  if (!b || typeof b !== "object") return json({ ok: false, error: "bad-json" }, 400);
  if (clean(b.website)) return json({ ok: false, error: "invalid" }, 400);

  const product = PRODUCT_MAP[clean(b.productId, 40)];
  const qty = Math.max(1, Math.min(10, parseInt(b.qty, 10) || 1));
  const name = clean(b.name, 30), phone = clean(b.phone, 20), email = normEmail(b.email);
  const startDate = clean(b.startDate, 10), memo = clean(b.memo, 300);
  const payMethod = clean(b.payMethod, 10) === "bank" ? "bank" : "card";
  const device = clean(b.device, 10) === "mobile" && (cfg.provider === "payapp" || cfg.mobileKey) ? "mobile" : "pc";
  const fields = {};
  if (!product) fields.productId = "required";
  if (!name) fields.name = "required";
  const d = phoneDigits(phone);
  if (cfg.provider === "payapp" ? !/^01[016789]\d{7,8}$/.test(d) : d.length < 9 || d.length > 15) fields.phone = "phone";
  if (email && !validEmail(email)) fields.email = "email";
  if (product && product.start === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) fields.startDate = "required";
    else {
      const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
      const limit = new Date(Date.now() + 9 * 3600 * 1000 + 30 * 86400000).toISOString().slice(0, 10);
      if (startDate < today) fields.startDate = "past";
      else if (startDate > limit) fields.startDate = "far";
    }
  }
  if (b.agreeTerms !== true || b.agreePrivacy !== true || b.agreeRefund !== true) fields.agree = "required";
  if (cfg.provider === "payapp" && !/^[a-f0-9-]{32,36}$/i.test(b.requestId || "")) fields.requestId = "required";
  if (Object.keys(fields).length) return json({ ok: false, error: "invalid", fields }, 400);

  const member = await getMember(request, env);
  const ipHash = await ipHashOf(request, env);
  const order = {
    oid: makeOid(), product_id: product.id, product_name: product.name + (qty > 1 ? ` × ${qty}` : ""), qty,
    amount: product.price * qty, buyer_name: name, buyer_phone: formatPhone(phone), buyer_email: email,
    start_date: product.start === "date" ? startDate : "", memo, pay_method: payMethod, device, member_id: member ? member.id : null
  };
  if (cfg.provider === "payapp") {
    return preparePayapp(request, env, cfg, order, ipHash, b.requestId);
  }
  try {
    await env.DB.prepare(
      `INSERT INTO orders (oid, status, product_id, product_name, qty, amount, buyer_name, buyer_phone, buyer_email, start_date, memo, pay_method, device, member_id, ip_hash, test_mode)
       VALUES (?1, 'pending', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
    ).bind(order.oid, order.product_id, order.product_name, order.qty, order.amount, order.buyer_name, order.buyer_phone, order.buyer_email,
      order.start_date, order.memo, order.pay_method, order.device, order.member_id, ipHash, cfg.test ? 1 : 0).run();
  } catch (e) {
    console.error("order-insert", e && e.message);
    return json({ ok: false, error: /no such table/i.test(String(e && e.message)) ? "no-table" : "db-error" }, 500);
  }
  const origin = new URL(request.url).origin;
  const token = await orderToken(env, order.oid);
  const pay = device === "mobile"
    ? { mode: "mobile", ...(await mobilePayFields(cfg, order, origin)) }
    : { mode: "pc", js: pcJsUrl(cfg), fields: await pcPayFields(cfg, order, origin) };
  return json({ ok: true, oid: order.oid, token, amount: order.amount, test: cfg.test, pay });
}


async function preparePayapp(request, env, cfg, order, ipHash, requestId) {
  const origin = new URL(request.url).origin;
  const hash = await sha256(JSON.stringify([order.product_id, order.qty, order.amount, order.buyer_name,
    order.buyer_phone, order.buyer_email, order.start_date, order.memo, order.pay_method, order.member_id]));
  const reply = async row => {
    if (row.request_hash !== hash) return json({ok:false, error:"request-conflict"},409);
    const token = await orderToken(env, row.oid);
    if (row.status === "failed") return json({ok:false,error:"pay-rejected"},502);
    return json({ok:true,oid:row.oid,token,amount:row.amount,test:false,pay:{mode:"payapp",
      url: row.status === "pending" && row.payurl ? row.payurl : origin + "/order-complete?oid=" + encodeURIComponent(row.oid) + "&t=" + token}});
  };
  try {
    await ensurePayapp(env);
    const existing = await env.DB.prepare("SELECT p.*, o.status, o.amount FROM payapp_payments p JOIN orders o ON o.oid=p.oid WHERE request_id=?").bind(requestId).first();
    if (existing) return reply(existing);
    const recent = ipHash && await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE ip_hash=? AND created_at > datetime('now','+9 hours','-10 minutes')").bind(ipHash).first();
    if (recent && recent.n >= 30) return json({ok:false,error:"rate-limit"},429);
    const nonce = crypto.randomUUID();
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO orders (oid,status,product_id,product_name,qty,amount,buyer_name,buyer_phone,buyer_email,start_date,memo,pay_method,device,member_id,ip_hash,test_mode,pg_method)
          VALUES (?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?,0,'payapp:pending')`).bind(order.oid,order.product_id,order.product_name,order.qty,order.amount,order.buyer_name,order.buyer_phone,order.buyer_email,order.start_date,order.memo,order.pay_method,order.device,order.member_id,ipHash),
        env.DB.prepare("INSERT INTO payapp_payments (oid,nonce,request_id,request_hash) VALUES (?,?,?,?)").bind(order.oid,nonce,requestId,hash)
      ]);
    } catch (e) {
      const concurrent = await env.DB.prepare("SELECT p.*, o.status, o.amount FROM payapp_payments p JOIN orders o ON o.oid=p.oid WHERE request_id=?").bind(requestId).first();
      if (concurrent) return reply(concurrent);
      throw e;
    }
    let result;
    try {
      result = await requestPayment(cfg.payapp, {
        goodname:("소셜팩토리 건대 · " + order.product_name).slice(0,100), price:String(order.amount),
        recvphone:order.buyer_phone.replace(/[^0-9]/g,""), recvemail:order.buyer_email || "",
        reqaddr:"0",smsuse:"n",checkretry:"y",skip_cstpage:"y",
        openpaytype:order.pay_method === "bank" ? "rbank" : "card,kakaopay,naverpay,applepay,payco,smilepay,tosspay",
        feedbackurl:origin+"/api/pay/payapp/feedback",returnurl:origin+"/api/pay/payapp/return?oid="+order.oid+"&t="+await orderToken(env,order.oid),
        var1:order.oid,var2:nonce
      });
    } catch {
      // 통신 실패는 요청 실패를 의미하지 않습니다. 재발급 없이 기존 주문 결과를 확인합니다.
      return reply({...order,request_hash:hash,status:"pending",payurl:null});
    }
    if (!result.ok) {
      await env.DB.prepare("UPDATE orders SET status='failed',fail_msg='페이앱 결제 요청 거절' WHERE oid=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM payapp_payments WHERE oid=? AND mul_no IS NOT NULL)").bind(order.oid,order.oid).run();
      const latest=await env.DB.prepare("SELECT p.*,o.status,o.amount FROM payapp_payments p JOIN orders o ON o.oid=p.oid WHERE p.oid=?").bind(order.oid).first();
      return reply(latest);
    }
    await env.DB.prepare("UPDATE payapp_payments SET mul_no=?,payurl=? WHERE oid=? AND (mul_no IS NULL OR mul_no=?)").bind(result.mulNo,result.payurl,order.oid,result.mulNo).run();
    const latest=await env.DB.prepare("SELECT p.*,o.status,o.amount FROM payapp_payments p JOIN orders o ON o.oid=p.oid WHERE p.oid=?").bind(order.oid).first();
    if (latest.mul_no !== result.mulNo) return json({ok:false,error:"pay-conflict"},502);
    return reply(latest);
  } catch {
    // 키·개인정보가 포함될 수 있는 외부 오류 원문은 로그/응답에 남기지 않습니다.
    return json({ok:false,error:"db-error"},500);
  }
}
