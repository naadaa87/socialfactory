/**
 * /api/admin/reservations — 관리자 예약 등록 · 조회 · 변경 (로그인 쿠키 또는 Authorization: Bearer ADMIN_KEY)
 *
 * GET    ?from=2026-10-01&to=2026-10-31&status=&space=&pay=&pstatus=&q=   예약 목록 (이용일 순, 최대 3000건)
 * POST   { space, date, start_min, end_min, customer_name, phone, people, purpose, channel,
 *          amount, list_amount, amount_note, pay_method, pay_status, paid_at, memo, inquiry_ref, force }
 * PATCH  { code, action: "update" | "pay" | "unpay" | "cancel" | "restore", ... }
 * DELETE { code }   잘못 등록한 예약을 지웁니다 (매출에서도 빠짐)
 *
 * 시간은 이용일 0시부터 센 분(30분 단위)입니다. 14:00 = 840, 다음 날 01:00 = 1500. 한 예약은 최대 24시간.
 * 1~5번룸은 같은 룸 · 같은 시간에 예약이 겹치면 409(conflict)로 알려 주고, force: true 면 그래도 저장합니다.
 * 매출: 결제 완료 · 환불 건의 (금액 − 환불 금액). 결제 전 건은 미수금으로 따로 셉니다.
 */
import { json, clean, formatPhone } from "../../_lib/auth.js";
import { adminGate, PAY_METHODS, SPACES, ROOM_KEYS, CHANNELS, kstToday, isIsoDate, addDaysIso, dayIndex, makeResCode, hm } from "../../_lib/admin.js";

const COLS = "id, code, created_at, updated_at, status, space, space_note, date, start_min, end_min, customer_name, phone, people, purpose, channel, amount, list_amount, amount_note, pay_method, pay_status, paid_at, refund_amount, refunded_at, cancel_reason, cancelled_at, inquiry_ref, memo";
const int = (v) => { const n = typeof v === "number" ? v : parseInt(String(v == null ? "" : v).replace(/[^0-9-]/g, ""), 10); return Number.isFinite(n) ? Math.round(n) : null; };
const bad = (field, msg) => json({ ok: false, error: "invalid", field, message: msg }, 400);

/** 등록 · 수정 입력값 검사 — 문제가 있으면 { error } */
function readFields(b, prev) {
  const v = {};
  v.space = clean(b.space, 20); if (!SPACES[v.space]) return { error: ["space", "공간을 골라 주세요."] };
  v.space_note = clean(b.space_note, 40);
  v.date = clean(b.date, 10); if (!isIsoDate(v.date)) return { error: ["date", "이용일을 골라 주세요."] };
  v.start_min = int(b.start_min); v.end_min = int(b.end_min);
  if (v.start_min === null || v.start_min < 0 || v.start_min > 1410 || v.start_min % 30) return { error: ["start_min", "시작 시각은 30분 단위로 골라 주세요."] };
  if (v.end_min === null || v.end_min % 30 || v.end_min <= v.start_min) return { error: ["end_min", "끝나는 시각은 시작보다 늦어야 합니다."] };
  if (v.end_min - v.start_min > 1440) return { error: ["end_min", "한 번에 최대 24시간까지 등록할 수 있습니다. 더 길면 나눠서 등록해 주세요."] };
  v.customer_name = clean(b.customer_name, 40); if (!v.customer_name) return { error: ["customer_name", "예약자 이름을 적어 주세요."] };
  v.phone = b.phone ? formatPhone(b.phone).slice(0, 20) : "";
  v.people = b.people === "" || b.people == null ? null : int(b.people);
  if (v.people !== null && (v.people < 0 || v.people > 500)) return { error: ["people", "인원을 확인해 주세요."] };
  v.purpose = clean(b.purpose, 40);
  v.channel = CHANNELS[clean(b.channel, 20)] ? clean(b.channel, 20) : "";
  v.amount = int(b.amount); if (v.amount === null || v.amount < 0 || v.amount > 100000000) return { error: ["amount", "결제 금액을 숫자로 적어 주세요. (무료면 0)"] };
  v.list_amount = b.list_amount === "" || b.list_amount == null ? null : int(b.list_amount);
  v.amount_note = clean(b.amount_note, 200);
  v.pay_method = clean(b.pay_method, 20); if (!PAY_METHODS[v.pay_method]) return { error: ["pay_method", "결제수단을 골라 주세요."] };
  const ps = clean(b.pay_status, 10);
  v.pay_status = prev && prev.pay_status === "refunded" ? "refunded" : (ps === "unpaid" ? "unpaid" : "paid");
  if (v.pay_status === "unpaid") v.paid_at = null;
  else { const pa = clean(b.paid_at, 10); v.paid_at = isIsoDate(pa) ? pa : (prev && prev.paid_at) || kstToday(); }
  v.memo = clean(b.memo, 1000);
  v.inquiry_ref = clean(b.inquiry_ref, 40);
  return { v };
}

/** 같은 룸에 시간이 겹치는 예약 (취소 제외). 한 예약은 24시간 이하라 앞뒤 하루만 보면 됩니다. */
async function conflicts(env, v, exceptCode) {
  if (!ROOM_KEYS.includes(v.space)) return [];
  const { results } = await env.DB.prepare(
    `SELECT code, date, start_min, end_min, customer_name, people FROM reservations
     WHERE status = 'confirmed' AND space = ?1 AND date BETWEEN ?2 AND ?3 AND code <> ?4`
  ).bind(v.space, addDaysIso(v.date, -1), addDaysIso(v.date, 1), exceptCode || "").all();
  const base = dayIndex(v.date) * 1440, s = base + v.start_min, e = base + v.end_min;
  return (results || []).filter((r) => { const b0 = dayIndex(r.date) * 1440; return b0 + r.start_min < e && s < b0 + r.end_min; })
    .map((r) => ({ code: r.code, date: r.date, time: hm(r.start_min) + "–" + hm(r.end_min), name: r.customer_name, people: r.people }));
}

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  const u = new URL(request.url), p = (k, n = 40) => clean(u.searchParams.get(k) || "", n);
  const where = [], args = [];
  const add = (sql, val) => { args.push(val); where.push(sql.replace("?", "?" + args.length)); };
  const code = p("code", 20);
  if (code) add("code = ?", code);
  const from = p("from", 10), to = p("to", 10);
  if (isIsoDate(from)) add("date >= ?", from);
  if (isIsoDate(to)) add("date <= ?", to);
  const st = p("status", 12);
  if (st === "confirmed" || st === "cancelled") add("status = ?", st);
  const space = p("space", 20); if (SPACES[space]) add("space = ?", space);
  const pay = p("pay", 20); if (PAY_METHODS[pay]) add("pay_method = ?", pay);
  const ps = p("pstatus", 10); if (["paid", "unpaid", "refunded"].includes(ps)) add("pay_status = ?", ps);
  const q = p("q", 60).replace(/-/g, "");
  if (q) { args.push("%" + q + "%"); const n = args.length; where.push(`(customer_name LIKE ?${n} OR REPLACE(phone, '-', '') LIKE ?${n} OR REPLACE(code, '-', '') LIKE ?${n} OR memo LIKE ?${n} OR inquiry_ref LIKE ?${n})`); }
  const sql = `SELECT ${COLS} FROM reservations` + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY date ASC, start_min ASC, id ASC LIMIT 3000";
  try {
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    return json({ ok: true, today: kstToday(), results: results || [] });
  } catch (e) { console.error("res-get", e && e.message); return json({ ok: false, error: "db-error" }, 500); }
}

export async function onRequestPost({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const r = readFields(b || {}); if (r.error) return bad(...r.error);
  const v = r.v;
  const clash = await conflicts(env, v, "");
  if (clash.length && !b.force) return json({ ok: false, error: "conflict", conflicts: clash }, 409);
  for (let i = 0; i < 5; i++) {
    const code = makeResCode(v.date);
    try {
      await env.DB.prepare(
        `INSERT INTO reservations (code, status, space, space_note, date, start_min, end_min, customer_name, phone, people, purpose, channel, amount, list_amount, amount_note, pay_method, pay_status, paid_at, memo, inquiry_ref)
         VALUES (?1, 'confirmed', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`
      ).bind(code, v.space, v.space_note, v.date, v.start_min, v.end_min, v.customer_name, v.phone, v.people, v.purpose, v.channel, v.amount, v.list_amount, v.amount_note, v.pay_method, v.pay_status, v.paid_at, v.memo, v.inquiry_ref).run();
      const row = await env.DB.prepare(`SELECT ${COLS} FROM reservations WHERE code = ?1`).bind(code).first();
      return json({ ok: true, code, item: row, overlapped: clash.length });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) { console.error("res-post", e && e.message); return json({ ok: false, error: "db-error" }, 500); }
    }
  }
  return json({ ok: false, error: "db-error" }, 500);
}

export async function onRequestPatch({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const code = clean(b && b.code, 20);
  const prev = code && await env.DB.prepare(`SELECT ${COLS} FROM reservations WHERE code = ?1`).bind(code).first();
  if (!prev) return json({ ok: false, error: "not-found" }, 404);
  const action = clean(b.action || "update", 12);
  let stmt;
  if (action === "update") {
    const r = readFields(b, prev); if (r.error) return bad(...r.error);
    const v = r.v;
    if (prev.status === "confirmed") {
      const clash = await conflicts(env, v, code);
      if (clash.length && !b.force) return json({ ok: false, error: "conflict", conflicts: clash }, 409);
    }
    stmt = env.DB.prepare(
      `UPDATE reservations SET space = ?2, space_note = ?3, date = ?4, start_min = ?5, end_min = ?6, customer_name = ?7, phone = ?8, people = ?9, purpose = ?10, channel = ?11,
       amount = ?12, list_amount = ?13, amount_note = ?14, pay_method = ?15, pay_status = ?16, paid_at = ?17, memo = ?18, inquiry_ref = ?19, updated_at = datetime('now', '+9 hours') WHERE code = ?1`
    ).bind(code, v.space, v.space_note, v.date, v.start_min, v.end_min, v.customer_name, v.phone, v.people, v.purpose, v.channel, v.amount, v.list_amount, v.amount_note, v.pay_method, v.pay_status, v.paid_at, v.memo, v.inquiry_ref);
  } else if (action === "pay") {
    const pa = clean(b.paid_at, 10), pm = clean(b.pay_method, 20);
    stmt = env.DB.prepare("UPDATE reservations SET pay_status = 'paid', paid_at = ?2, pay_method = ?3, updated_at = datetime('now', '+9 hours') WHERE code = ?1")
      .bind(code, isIsoDate(pa) ? pa : kstToday(), PAY_METHODS[pm] ? pm : prev.pay_method);
  } else if (action === "unpay") {
    if (prev.pay_status === "refunded") return json({ ok: false, error: "invalid", message: "환불한 예약은 결제 전으로 바꿀 수 없습니다." }, 400);
    stmt = env.DB.prepare("UPDATE reservations SET pay_status = 'unpaid', paid_at = NULL, updated_at = datetime('now', '+9 hours') WHERE code = ?1").bind(code);
  } else if (action === "cancel") {
    if (prev.status === "cancelled") return json({ ok: true, already: true });
    const refund = Math.max(0, Math.min(prev.amount, int(b.refund_amount) || 0));
    const reason = clean(b.cancel_reason, 200);
    if (prev.pay_status === "unpaid" || refund === 0) {
      stmt = env.DB.prepare("UPDATE reservations SET status = 'cancelled', cancelled_at = datetime('now', '+9 hours'), cancel_reason = ?2, updated_at = datetime('now', '+9 hours') WHERE code = ?1").bind(code, reason);
    } else {
      stmt = env.DB.prepare("UPDATE reservations SET status = 'cancelled', cancelled_at = datetime('now', '+9 hours'), cancel_reason = ?2, pay_status = 'refunded', refund_amount = ?3, refunded_at = ?4, updated_at = datetime('now', '+9 hours') WHERE code = ?1")
        .bind(code, reason, refund, kstToday());
    }
  } else if (action === "restore") {
    if (prev.status !== "cancelled") return json({ ok: true, already: true });
    const clash = await conflicts(env, prev, code);
    if (clash.length && !b.force) return json({ ok: false, error: "conflict", conflicts: clash }, 409);
    stmt = env.DB.prepare(
      `UPDATE reservations SET status = 'confirmed', cancelled_at = NULL, cancel_reason = NULL,
       pay_status = CASE WHEN pay_status = 'refunded' THEN 'paid' ELSE pay_status END, refund_amount = 0, refunded_at = NULL, updated_at = datetime('now', '+9 hours') WHERE code = ?1`
    ).bind(code);
  } else return json({ ok: false, error: "invalid" }, 400);
  try {
    await stmt.run();
    const row = await env.DB.prepare(`SELECT ${COLS} FROM reservations WHERE code = ?1`).bind(code).first();
    return json({ ok: true, item: row });
  } catch (e) { console.error("res-patch", e && e.message); return json({ ok: false, error: "db-error" }, 500); }
}

export async function onRequestDelete({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const code = clean(b && b.code, 20);
  if (!code) return json({ ok: false, error: "invalid" }, 400);
  try {
    const r = await env.DB.prepare("DELETE FROM reservations WHERE code = ?1").bind(code).run();
    return json({ ok: true, deleted: (r && r.meta && r.meta.changes) || 0 });
  } catch (e) { console.error("res-del", e && e.message); return json({ ok: false, error: "db-error" }, 500); }
}
