import { payappConfig, validFeedback, equalSecret, ensurePayapp } from "../../../_lib/payapp.js";
const response=(text,status=200)=>new Response(text,{status,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}});
export async function onRequestPost({request,env}) {
  if (!env.DB) return response("FAIL",503);
  if (Number(request.headers.get("content-length"))>32768) return response("FAIL",413);
  const raw=await request.text();
  if (raw.length>32768) return response("FAIL",413);
  const params=new URLSearchParams(raw);
  for (const k of params.keys()) if (params.getAll(k).length!==1) return response("FAIL",400);
  const f=Object.fromEntries(params);
  if (!await validFeedback(payappConfig(env),f)) return response("FAIL",403);
  const state=f.pay_state,partial=["70","71"].includes(state);
  if (!["1","4","8","16","31","32","9","64","10","70","71"].includes(state) || !/^\d{1,30}$/.test(f.mul_no || "")) return response("FAIL",400);
  try {
    await ensurePayapp(env);
    const row=await env.DB.prepare("SELECT o.*,p.nonce,p.mul_no AS payapp_no FROM orders o JOIN payapp_payments p ON p.oid=o.oid WHERE o.oid=?").bind(f.var1 || "").first();
    if (!row || !equalSecret(f.var2,row.nonce)) return response("FAIL",403);
    const amount=partial ? f.orig_price : f.price,no=partial ? f.orig_mul_no : f.mul_no;
    if (!/^\d+$/.test(amount || "") || Number(amount)!==row.amount || !/^\d{1,30}$/.test(no || "") || (row.payapp_no && row.payapp_no!==no)) return response("FAIL",400);
    if (partial && (!/^\d+$/.test(f.price || "") || Number(f.price)<=0 || Number(f.price)>row.amount || f.mul_no===no)) return response("FAIL",400);
    await env.DB.prepare("UPDATE payapp_payments SET mul_no=? WHERE oid=? AND mul_no IS NULL").bind(no,row.oid).run();
    const bound=await env.DB.prepare("SELECT mul_no FROM payapp_payments WHERE oid=?").bind(row.oid).first();
    if (bound.mul_no!==no) return response("FAIL",400);
    const sql=(q,...a)=>env.DB.prepare(q).bind(...a),oid=row.oid;
    if (state==="4") {
      // 마스킹 전 카드번호와 통보 원문은 저장하지 않습니다.
      const card=(f.card_num || "").replace(/[^0-9]/g,"");
      await sql(`UPDATE orders SET status='paid',tid=?,pg_method=?,card_name=?,card_num=?,
        paid_at=datetime('now','+9 hours'),fail_msg=NULL WHERE oid=? AND status='pending'
        AND (SELECT refunded_amount FROM payapp_payments WHERE oid=?)=0`,
        no,"payapp:"+(f.pay_type || "unknown").slice(0,20),(f.card_name || "").slice(0,40),card.length>=4 ? "****-****-****-"+card.slice(-4) : "",oid,oid).run();
    } else if (["9","64"].includes(state)) {
      await env.DB.batch([
        sql("UPDATE payapp_payments SET refunded_amount=? WHERE oid=?",row.amount,oid),
        sql("UPDATE orders SET status='refunded',tid=?,fail_msg='페이앱 승인 취소' WHERE oid=?",no,oid)
      ]);
    } else if (partial) {
      const event=await env.DB.prepare("SELECT oid,amount FROM payapp_refunds WHERE mul_no=?").bind(f.mul_no).first();
      if (event && (event.oid!==oid || event.amount!==Number(f.price))) return response("FAIL",400);
      await env.DB.batch([
        sql("INSERT OR IGNORE INTO payapp_refunds (mul_no,oid,amount) VALUES (?,?,?)",f.mul_no,oid,Number(f.price)),
        sql("UPDATE payapp_payments SET refunded_amount=MIN(?,MAX(refunded_amount,(SELECT COALESCE(SUM(amount),0) FROM payapp_refunds WHERE oid=?))) WHERE oid=?",row.amount,oid,oid),
        sql(`UPDATE orders SET status=CASE WHEN (SELECT refunded_amount FROM payapp_payments WHERE oid=?)>=amount THEN 'refunded' WHEN status='pending' THEN 'paid' ELSE status END,
          tid=?,pg_method=COALESCE(NULLIF(pg_method,'payapp:pending'),?),paid_at=COALESCE(paid_at,datetime('now','+9 hours')),
          fail_msg='페이앱 부분 취소' WHERE oid=?`,oid,no,'payapp:'+(f.pay_type || 'unknown').slice(0,20),oid)
      ]);
    } else if (["8","16","31","32"].includes(state)) {
      await sql("UPDATE orders SET status='cancelled',fail_msg='페이앱 결제 요청 취소' WHERE oid=? AND status='pending'",oid).run();
    }
    return response("SUCCESS");
  } catch { return response("FAIL",500); }
}
