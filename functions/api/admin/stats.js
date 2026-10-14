// GET /api/admin/stats — 대시보드 숫자 (오늘 · 7일 · 30일) 와 설정 상태
import { json, isAdmin } from "../../_lib/auth.js";
import { payConfig } from "../../_lib/shop.js";
import { PRODUCTS } from "../../_lib/products.js";

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  const cfg = payConfig(env);
  const setup = {
    db: !!env.DB, adminKey: !!env.ADMIN_KEY, sessionSecret: !!env.SESSION_SECRET, ipSalt: !!env.IP_SALT, webhook: !!env.NOTIFY_WEBHOOK,
    inicis: cfg.ready, inicisMid: cfg.mid ? cfg.mid.slice(0, 3) + "…" + cfg.mid.slice(-2) : "", inicisMobile: !!cfg.mobileKey, inicisTest: cfg.test,
    tables: {}
  };
  const out = { ok: true, setup, periods: {}, recent: { inquiries: [], orders: [] }, products: PRODUCTS.map((p) => ({ id: p.id, name: p.name, price: p.price, category: p.category, sold: 0, sales: 0 })) };
  if (!env.DB) return json(out);
  const count = async (sql, ...args) => { try { const r = await env.DB.prepare(sql).bind(...args).first(); return Number(r && r.n) || 0; } catch { return null; } };
  const sum = async (sql, ...args) => { try { const r = await env.DB.prepare(sql).bind(...args).first(); return Number(r && r.s) || 0; } catch { return null; } };
  for (const t of ["inquiries", "members", "orders", "sessions"]) setup.tables[t] = (await count(`SELECT COUNT(*) AS n FROM ${t}`)) !== null;
  for (const [key, mod] of [["today", "start of day"], ["week", "-7 days"], ["month", "-30 days"], ["all", "-100 years"]]) {
    const since = `datetime('now', '+9 hours', '${mod}')`;
    out.periods[key] = {
      inquiries: await count(`SELECT COUNT(*) AS n FROM inquiries WHERE created_at >= ${since}`),
      newInquiries: await count(`SELECT COUNT(*) AS n FROM inquiries WHERE status = 'new' AND created_at >= ${since}`),
      members: await count(`SELECT COUNT(*) AS n FROM members WHERE created_at >= ${since}`),
      orders: await count(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid','used') AND test_mode = 0 AND paid_at >= ${since}`),
      sales: await sum(`SELECT COALESCE(SUM(amount),0) AS s FROM orders WHERE status IN ('paid','used') AND test_mode = 0 AND paid_at >= ${since}`),
      testOrders: await count(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid','used') AND test_mode = 1 AND paid_at >= ${since}`)
    };
  }
  out.pending = { inquiries: await count("SELECT COUNT(*) AS n FROM inquiries WHERE status = 'new'"), refunds: await count("SELECT COUNT(*) AS n FROM orders WHERE status = 'refund_requested'"), marketing: await count("SELECT COUNT(*) AS n FROM members WHERE marketing = 1") };
  try { out.recent.inquiries = (await env.DB.prepare("SELECT id, receipt, created_at, status, purpose, space, name, phone FROM inquiries ORDER BY id DESC LIMIT 5").all()).results; } catch {}
  try { out.recent.orders = (await env.DB.prepare("SELECT id, oid, created_at, status, product_name, amount, buyer_name, test_mode FROM orders WHERE status <> 'pending' ORDER BY id DESC LIMIT 5").all()).results; } catch {}
  try {
    const { results } = await env.DB.prepare("SELECT product_id, SUM(qty) AS sold, SUM(amount) AS sales FROM orders WHERE status IN ('paid','used') AND test_mode = 0 GROUP BY product_id").all();
    for (const r of results) { const p = out.products.find((x) => x.id === r.product_id); if (p) { p.sold = Number(r.sold) || 0; p.sales = Number(r.sales) || 0; } }
  } catch {}
  return json(out);
}
