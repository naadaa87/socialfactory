/**
 * /api/admin/customers — 이용권 고객 (전화번호 기준, 관리자 로그인)
 * GET   ?q=검색어             : 고객 목록 (최근 500명) — 지금 이용권 만료 시각 · 누적 결제
 * GET   ?id=고객번호           : 고객 상세 — 이용권 · 결제 · 알림 · 같은 번호의 룸 예약 · 홈페이지 주문
 * PATCH { id, name, memo, notifyOff } : 이름 · 메모 · 알림톡 수신 거부
 */
import { json, clean, phoneDigits } from "../../_lib/auth.js";
import { adminGate, kstNow } from "../../_lib/admin.js";

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  const u = new URL(request.url);
  const now = kstNow();
  try {
    const id = parseInt(u.searchParams.get("id") || "", 10);
    if (id) {
      const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ?1").bind(id).first();
      if (!c) return json({ ok: false, error: "not-found" }, 404);
      const all = async (sql, ...a) => { try { return (await env.DB.prepare(sql).bind(...a).all()).results || []; } catch (e) { return []; } };
      const digitsSql = (col) => `REPLACE(REPLACE(REPLACE(${col}, '-', ''), ' ', ''), '.', '')`;
      return json({
        ok: true, now, customer: c,
        passes: await all("SELECT p.*, pp.amount, pp.pay_method, pp.channel, pp.status AS pay_status, pp.refund_amount FROM passes p JOIN pass_payments pp ON pp.id = p.payment_id WHERE p.customer_id = ?1 ORDER BY p.starts_at DESC", id),
        payments: await all("SELECT id, payment_key, created_at, status, channel, product_name, amount, pay_method, approval_number, card_issuer, masked_card, paid_at, fail_reason, refund_amount, test_mode FROM pass_payments WHERE customer_id = ?1 ORDER BY id DESC LIMIT 100", id),
        jobs: await all("SELECT id, kind, status, send_after, sent_at, attempts, last_error, rendered FROM notification_jobs WHERE customer_id = ?1 ORDER BY send_after DESC LIMIT 50", id),
        reservations: await all(`SELECT code, date, start_min, end_min, space, space_note, status, amount, pay_status FROM reservations WHERE ${digitsSql("phone")} = ?1 ORDER BY date DESC LIMIT 30`, c.phone),
        orders: await all(`SELECT oid, created_at, status, product_name, amount FROM orders WHERE ${digitsSql("buyer_phone")} = ?1 ORDER BY id DESC LIMIT 30`, c.phone)
      });
    }
    const q = clean(u.searchParams.get("q") || "", 60), qd = phoneDigits(q);
    const args = [now], where = [];
    if (q) { args.push("%" + q + "%", "%" + (qd || q) + "%"); where.push("(c.name LIKE ?2 OR c.memo LIKE ?2 OR c.phone LIKE ?3)"); }
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.phone_fmt, c.name, c.memo, c.created_at,
         (SELECT MAX(ends_at) FROM passes WHERE customer_id = c.id AND status = 'active' AND pass_group = 'seat' AND ends_at > ?1) AS active_until,
         (SELECT COUNT(*) FROM passes WHERE customer_id = c.id AND status = 'active') AS pass_count,
         (SELECT COALESCE(SUM(amount - refund_amount), 0) FROM pass_payments WHERE customer_id = c.id AND status IN ('paid', 'refunded') AND test_mode = 0) AS paid_total,
         (SELECT MAX(paid_at) FROM pass_payments WHERE customer_id = c.id AND status IN ('paid', 'refunded')) AS last_paid
       FROM customers c` + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY COALESCE(last_paid, c.created_at) DESC LIMIT 500"
    ).bind(...args).all();
    return json({ ok: true, now, results });
  } catch (e) {
    console.error("admin-customers", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}

export async function onRequestPatch({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const id = parseInt(b && b.id, 10);
  if (!id) return json({ ok: false, error: "invalid" }, 400);
  await env.DB.prepare("UPDATE customers SET name = ?1, memo = ?2, notify_off = ?3, updated_at = datetime('now', '+9 hours') WHERE id = ?4").bind(clean(b.name, 40) || null, clean(b.memo, 500) || null, b.notifyOff === true ? 1 : 0, id).run();
  return json({ ok: true });
}
