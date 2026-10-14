/**
 * /api/admin/members — 회원 관리 (Authorization: Bearer ADMIN_KEY)
 * GET    ?q=검색어&marketing=1 : 회원 목록 (최근 가입 순 500명)
 * PATCH  { id, action }       : reset(임시 비밀번호 발급) | block(이용 정지) | unblock(정지 해제)
 * DELETE { id }               : 회원 삭제
 */
import { json, clean, isAdmin, hashPassword, tempPassword, deleteMember } from "../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  const url = new URL(request.url);
  const q = clean(url.searchParams.get("q") || "", 60);
  const onlyMarketing = url.searchParams.get("marketing") === "1";
  const where = [];
  const args = [];
  if (q) { args.push("%" + q + "%"); where.push(`(name LIKE ?${args.length} OR email LIKE ?${args.length} OR phone LIKE ?${args.length})`); }
  if (onlyMarketing) where.push("marketing = 1");
  const cols = "m.id, m.provider, m.email, m.name, m.phone, m.marketing, m.marketing_at, m.status, m.must_change_pw, m.created_at, m.last_login_at";
  const base = `SELECT ${cols}, (SELECT COUNT(*) FROM inquiries i WHERE i.member_id = m.id) AS inquiries FROM members m`;
  const sql = base + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY m.id DESC LIMIT 500";
  try {
    let results;
    try { results = (await env.DB.prepare(sql).bind(...args).all()).results; }
    catch { results = (await env.DB.prepare(sql.replace(", (SELECT COUNT(*) FROM inquiries i WHERE i.member_id = m.id) AS inquiries", "")).bind(...args).all()).results; }
    const total = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(marketing) AS mk FROM members").first();
    return json({ ok: true, count: results.length, total: Number(total && total.n) || 0, marketing: Number(total && total.mk) || 0, results });
  } catch (e) {
    console.error("admin-members", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}

export async function onRequestPatch({ request, env }) {
  if (!isAdmin(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const id = parseInt(b && b.id, 10);
  const action = clean(b && b.action, 20);
  if (!id) return json({ ok: false, error: "invalid" }, 400);
  const m = await env.DB.prepare("SELECT id, provider FROM members WHERE id = ?1").bind(id).first();
  if (!m) return json({ ok: false, error: "not-found" }, 404);
  try {
    if (action === "reset") {
      if (m.provider !== "email") return json({ ok: false, error: "provider" }, 400);
      const pw = tempPassword();
      await env.DB.batch([
        env.DB.prepare("UPDATE members SET password_hash = ?1, must_change_pw = 1 WHERE id = ?2").bind(await hashPassword(pw), id),
        env.DB.prepare("DELETE FROM sessions WHERE member_id = ?1").bind(id)
      ]);
      return json({ ok: true, tempPassword: pw });
    }
    if (action === "block" || action === "unblock") {
      await env.DB.prepare("UPDATE members SET status = ?1 WHERE id = ?2").bind(action === "block" ? "blocked" : "active", id).run();
      if (action === "block") await env.DB.prepare("DELETE FROM sessions WHERE member_id = ?1").bind(id).run();
      return json({ ok: true });
    }
    return json({ ok: false, error: "invalid" }, 400);
  } catch (e) {
    console.error("admin-member-patch", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  if (!isAdmin(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const id = parseInt(b && b.id, 10);
  if (!id) return json({ ok: false, error: "invalid" }, 400);
  try { await deleteMember(env, id); return json({ ok: true }); }
  catch (e) { console.error("admin-member-delete", e && e.message); return json({ ok: false, error: "db-error" }, 500); }
}
