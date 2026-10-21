/**
 * /api/admin/passes — 토스프론트 이용권 관리 (관리자 로그인)
 * GET   ?view=passes&state=active|upcoming|expiring|expired|cancelled|all&q=  : 이용권 목록 (최근 500장)
 * GET   ?view=payments&status=&q=                                          : 이용권 결제 목록
 * GET   ?view=jobs&status=                                                 : 알림 대기열
 * POST  { phone, name, productId, amount, payMethod, paidAt, startsAt, notify, memo } : 관리자 직접 발급 (POS · 계좌이체 등 프론트 밖에서 판 이용권)
 * PATCH { id, action: "adjust", endsAt, memo }            : 만료 시각 바꾸기 (연장 · 단축)
 * PATCH { id, action: "cancel", refundAmount, rechain }   : 이용권 취소 (+ 환불 금액 기록, 뒤에 이어 붙은 이용권 앞당기기)
 * PATCH { id, action: "move", phone }                     : 다른 전화번호로 옮기기 (번호를 잘못 누른 경우)
 * PATCH { id, action: "memo", memo }
 * PATCH { jobId, action: "job-retry" | "job-cancel" }     : 알림 다시 보내기 · 보내지 않기
 * ※ 카드 결제 취소(환불) 자체는 여기서 하지 않습니다. 토스 단말기에서 취소한 뒤 결과만 기록합니다.
 */
import { json, clean, phoneDigits } from "../../_lib/auth.js";
import { adminGate, kstNow } from "../../_lib/admin.js";
import { KIOSK_PRODUCT_MAP, splitVat } from "../../_lib/kiosk-products.js";
import { issuePassForPayment, expiryNoticeStmts, upsertCustomer, validMobile, addDuration, nextStart, toMs, fromMs, cancelPass } from "../../_lib/kiosk.js";

const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;
const normTs = (s) => { s = clean(s, 19).replace("T", " "); if (!TS.test(s)) return ""; s = s.length === 16 ? s + ":00" : s; return isNaN(toMs(s)) ? "" : fromMs(toMs(s)); };
export const ADMIN_PAY = { card_offline: "카드(현장 단말기 · POS)", bank_other: "계좌이체", cash: "현금", free: "무료 · 보상" };

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  const u = new URL(request.url);
  const view = u.searchParams.get("view") || "passes";
  const q = clean(u.searchParams.get("q") || "", 60), qd = phoneDigits(q);
  const now = kstNow(), in3 = fromMs(toMs(now) + 3 * 864e5);
  try {
    if (view === "payments") {
      const where = [], args = [];
      const st = clean(u.searchParams.get("status") || "", 12);
      if (st) { args.push(st); where.push(`pp.status = ?${args.length}`); }
      if (q) { args.push("%" + q + "%", "%" + (qd || q) + "%"); where.push(`(pp.payment_key LIKE ?${args.length - 1} OR pp.product_name LIKE ?${args.length - 1} OR pp.approval_number LIKE ?${args.length - 1} OR c.phone LIKE ?${args.length} OR c.name LIKE ?${args.length - 1})`); }
      const { results } = await env.DB.prepare(
        `SELECT pp.id, pp.payment_key, pp.created_at, pp.status, pp.channel, pp.product_id, pp.product_name, pp.amount, pp.pay_method, pp.approval_number, pp.approved_ts, pp.tid, pp.card_issuer, pp.masked_card, pp.installment,
                pp.paid_at, pp.fail_reason, pp.refund_amount, pp.refunded_at, pp.admin_memo, pp.test_mode, c.id AS customer_id, c.phone_fmt, c.name AS customer_name, d.name AS device_name,
                (SELECT code FROM passes WHERE payment_id = pp.id) AS pass_code
         FROM pass_payments pp JOIN customers c ON c.id = pp.customer_id LEFT JOIN kiosk_devices d ON d.id = pp.device_id`
        + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY pp.id DESC LIMIT 500").bind(...args).all();
      return json({ ok: true, results });
    }
    if (view === "jobs") {
      const st = clean(u.searchParams.get("status") || "", 12);
      const { results } = await env.DB.prepare(
        `SELECT j.id, j.kind, j.status, j.send_after, j.sent_at, j.attempts, j.last_error, j.provider, j.rendered, j.vars, j.created_at, j.customer_id, c.phone_fmt, c.name AS customer_name
         FROM notification_jobs j LEFT JOIN customers c ON c.id = j.customer_id` + (st ? " WHERE j.status = ?1" : "") + " ORDER BY j.send_after DESC, j.id DESC LIMIT 300"
      ).bind(...(st ? [st] : [])).all();
      const counts = {};
      for (const r of (await env.DB.prepare("SELECT status, COUNT(*) AS n FROM notification_jobs GROUP BY status").all()).results) counts[r.status] = r.n;
      return json({ ok: true, results, counts, provider: String(env.ALIMTALK_PROVIDER || "") || "log", cron: !!env.CRON_KEY });
    }
    // 이용권 목록
    const state = u.searchParams.get("state") || "active";
    const where = [], args = [now];
    const W = {
      active: "p.status = 'active' AND p.starts_at <= ?1 AND p.ends_at > ?1",
      upcoming: "p.status = 'active' AND p.starts_at > ?1",
      expiring: "p.status = 'active' AND p.ends_at > ?1 AND p.ends_at <= ?2",
      expired: "p.status = 'active' AND p.ends_at <= ?1",
      cancelled: "p.status = 'cancelled' AND ?1 = ?1"
    };
    if (state === "expiring") args.push(in3);
    if (W[state]) where.push(W[state]);
    if (q) { args.push("%" + q + "%", "%" + (qd || q) + "%"); where.push(`(p.code LIKE ?${args.length - 1} OR p.product_name LIKE ?${args.length - 1} OR c.name LIKE ?${args.length - 1} OR c.phone LIKE ?${args.length})`); }
    const sql = `SELECT p.*, c.phone_fmt, c.name AS customer_name, pp.amount, pp.pay_method, pp.channel, pp.status AS pay_status, pp.refund_amount, pp.test_mode, pp.payment_key
                 FROM passes p JOIN customers c ON c.id = p.customer_id JOIN pass_payments pp ON pp.id = p.payment_id`
      + (where.length ? " WHERE " + where.join(" AND ") : " WHERE ?1 = ?1") + ` ORDER BY ${state === "expired" || state === "cancelled" || state === "all" ? "p.ends_at DESC" : "p.ends_at ASC"} LIMIT 500`;
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    const one = async (s, ...a) => Number(((await env.DB.prepare(s).bind(...a).first()) || {}).n) || 0;
    const summary = {
      inUse: await one("SELECT COUNT(DISTINCT customer_id) AS n FROM passes WHERE status = 'active' AND starts_at <= ?1 AND ends_at > ?1", now),
      endsToday: await one("SELECT COUNT(DISTINCT customer_id) AS n FROM passes WHERE status = 'active' AND ends_at > ?1 AND substr(ends_at, 1, 10) = substr(?1, 1, 10)", now),
      ends3d: await one("SELECT COUNT(DISTINCT customer_id) AS n FROM passes WHERE status = 'active' AND ends_at > ?1 AND ends_at <= ?2", now, in3),
      customers: await one("SELECT COUNT(*) AS n FROM customers")
    };
    return json({ ok: true, now, state, results, summary, products: Object.values(KIOSK_PRODUCT_MAP).map((p) => ({ id: p.id, name: p.name, price: p.price })), payMethods: ADMIN_PAY });
  } catch (e) {
    console.error("admin-passes", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}

/* 관리자 직접 발급 */
export async function onRequestPost({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const product = KIOSK_PRODUCT_MAP[clean(b && b.productId, 40)];
  const phone = clean(b && b.phone, 20);
  const amount = parseInt(b && b.amount, 10);
  const payMethod = ADMIN_PAY[b && b.payMethod] ? b.payMethod : "";
  const startsAt = b && b.startsAt ? normTs(b.startsAt) : "";
  if (!product) return json({ ok: false, error: "invalid", message: "이용권을 골라 주세요." }, 400);
  if (!validMobile(phone)) return json({ ok: false, error: "invalid", message: "휴대폰 번호를 확인해 주세요." }, 400);
  if (!(amount >= 0) || amount > 10000000) return json({ ok: false, error: "invalid", message: "금액을 확인해 주세요." }, 400);
  if (!payMethod) return json({ ok: false, error: "invalid", message: "결제수단을 골라 주세요." }, 400);
  if (b.startsAt && !startsAt) return json({ ok: false, error: "invalid", message: "시작 시각 형식을 확인해 주세요." }, 400);
  try {
    const c = await upsertCustomer(env, phone, { name: clean(b.name, 40) });
    const { tax, supplyValue } = splitVat(amount);
    const key = "ADM" + kstNow().replace(/[^0-9]/g, "").slice(2) + Math.random().toString(36).slice(2, 8).toUpperCase();
    const ins = await env.DB.prepare(
      `INSERT INTO pass_payments (payment_key, status, channel, customer_id, product_id, product_name, amount, tax, supply, pay_method, paid_at, admin_memo)
       VALUES (?1, 'paid', 'admin', ?2, ?3, ?4, ?5, ?6, ?7, ?8, COALESCE(?9, datetime('now', '+9 hours')), ?10)`
    ).bind(key, c.id, product.id, product.name, amount, tax, supplyValue, payMethod, normTs(b.paidAt) || null, clean(b.memo, 300) || null).run();
    const pay = await env.DB.prepare("SELECT * FROM pass_payments WHERE id = ?1").bind(ins.meta.last_row_id).first();
    const { pass } = await issuePassForPayment(env, pay, { startAt: startsAt || null, purchaseNotice: b.notify === true });
    return json({ ok: true, pass });
  } catch (e) {
    console.error("admin-pass-issue", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}

export async function onRequestPatch({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const action = clean(b && b.action, 20);
  try {
    if (action === "job-retry" || action === "job-cancel") {
      const id = parseInt(b.jobId, 10); if (!id) return json({ ok: false, error: "invalid" }, 400);
      if (action === "job-retry") await env.DB.prepare("UPDATE notification_jobs SET status = 'queued', send_after = datetime('now', '+9 hours'), attempts = 0, last_error = NULL, updated_at = datetime('now', '+9 hours') WHERE id = ?1 AND (status IN ('failed', 'logged') OR (status = 'cancelled' AND kind = 'purchase'))").bind(id).run(); // 바뀐 만료 시각 때문에 취소된 만료 알림은 되살리지 않습니다
      else await env.DB.prepare("UPDATE notification_jobs SET status = 'cancelled', updated_at = datetime('now', '+9 hours') WHERE id = ?1 AND status = 'queued'").bind(id).run();
      return json({ ok: true });
    }
    const id = parseInt(b && b.id, 10);
    const p = id ? await env.DB.prepare("SELECT * FROM passes WHERE id = ?1").bind(id).first() : null;
    if (!p) return json({ ok: false, error: "not-found" }, 404);
    const memo = b.memo !== undefined ? clean(b.memo, 300) : null;
    const customer = async (cid) => env.DB.prepare("SELECT * FROM customers WHERE id = ?1").bind(cid).first();
    const renotice = async (cid) => { const c = await customer(cid); if (c) await env.DB.batch(await expiryNoticeStmts(env, c, p.pass_group)); };

    if (action === "memo") {
      await env.DB.prepare("UPDATE passes SET memo = ?1, updated_at = datetime('now', '+9 hours') WHERE id = ?2").bind(memo, id).run();
    } else if (action === "adjust") {
      const ends = normTs(b.endsAt);
      if (!ends || ends <= p.starts_at) return json({ ok: false, error: "invalid", message: "만료 시각은 시작 시각보다 늦어야 합니다." }, 400);
      await env.DB.prepare("UPDATE passes SET ends_at = ?1, memo = COALESCE(?2, memo), updated_at = datetime('now', '+9 hours') WHERE id = ?3").bind(ends, memo, id).run();
      await renotice(p.customer_id);
    } else if (action === "cancel") {
      if (p.status === "cancelled") return json({ ok: false, error: "invalid", message: "이미 취소된 이용권입니다." }, 400);
      await cancelPass(env, p, { refundAmount: parseInt(b.refundAmount, 10) || 0, rechain: b.rechain !== false, memo });
    } else if (action === "move") {
      if (!validMobile(b.phone)) return json({ ok: false, error: "invalid", message: "옮길 휴대폰 번호를 확인해 주세요." }, 400);
      const to = await upsertCustomer(env, b.phone);
      if (to.id === p.customer_id) return json({ ok: false, error: "invalid", message: "같은 번호입니다." }, 400);
      // 옮겨 간 번호에 이용 중인 이용권이 있으면 그 뒤로 다시 이어 붙입니다
      const prod = KIOSK_PRODUCT_MAP[p.product_id];
      const start = prod && p.starts_at > kstNow() ? await nextStart(env, to.id, p.pass_group) : p.starts_at;
      const ends = prod && start !== p.starts_at ? addDuration(start, prod.duration) : p.ends_at;
      await env.DB.batch([
        env.DB.prepare("UPDATE passes SET customer_id = ?1, starts_at = ?2, ends_at = ?3, memo = COALESCE(?4, memo), updated_at = datetime('now', '+9 hours') WHERE id = ?5").bind(to.id, start, ends, memo, id),
        env.DB.prepare("UPDATE pass_payments SET customer_id = ?1, updated_at = datetime('now', '+9 hours') WHERE id = ?2").bind(to.id, p.payment_id),
        env.DB.prepare("UPDATE notification_jobs SET status = 'cancelled' WHERE pass_id = ?1 AND status = 'queued'").bind(id)
      ]);
      await renotice(p.customer_id); await renotice(to.id);
    } else return json({ ok: false, error: "invalid" }, 400);
    return json({ ok: true, item: await env.DB.prepare("SELECT * FROM passes WHERE id = ?1").bind(id).first() });
  } catch (e) {
    console.error("admin-pass-patch", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}
