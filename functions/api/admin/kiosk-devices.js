/**
 * /api/admin/kiosk-devices — 토스프론트 단말기 연결 (관리자 로그인)
 * GET                         : 단말기 목록
 * POST  { name }              : 새 단말기 + 연결 코드(8자리, 30분) — 코드는 이 응답에서 한 번만 보입니다
 * PATCH { id, action: "code" | "revoke" | "rename", name } : 연결 코드 다시 만들기(기존 연결은 끊김) · 연결 해제 · 이름 바꾸기
 */
import { json, clean } from "../../_lib/auth.js";
import { adminGate } from "../../_lib/admin.js";
import { makePairCode, pairCodeHash } from "../../_lib/kiosk.js";

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  const { results } = await env.DB.prepare("SELECT id, name, status, serial, created_at, paired_at, last_seen_at, pair_expires_at FROM kiosk_devices ORDER BY id").all();
  return json({ ok: true, results, test: env.KIOSK_TEST === "1" });
}

export async function onRequestPost({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let b; try { b = await request.json(); } catch { b = {}; }
  const code = makePairCode();
  const res = await env.DB.prepare("INSERT INTO kiosk_devices (name, status, pair_hash, pair_expires_at) VALUES (?1, 'pairing', ?2, datetime('now', '+9 hours', '+30 minutes'))")
    .bind(clean(b.name, 40) || "토스프론트", await pairCodeHash(code)).run();
  return json({ ok: true, id: res.meta.last_row_id, code });
}

export async function onRequestPatch({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let b; try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const id = parseInt(b && b.id, 10); if (!id) return json({ ok: false, error: "invalid" }, 400);
  if (b.action === "code") {
    const code = makePairCode();
    await env.DB.prepare("UPDATE kiosk_devices SET status = 'pairing', token_hash = NULL, pair_hash = ?1, pair_expires_at = datetime('now', '+9 hours', '+30 minutes') WHERE id = ?2").bind(await pairCodeHash(code), id).run();
    return json({ ok: true, code });
  }
  if (b.action === "revoke") { await env.DB.prepare("UPDATE kiosk_devices SET status = 'revoked', token_hash = NULL, pair_hash = NULL WHERE id = ?1").bind(id).run(); return json({ ok: true }); }
  if (b.action === "rename") { await env.DB.prepare("UPDATE kiosk_devices SET name = ?1 WHERE id = ?2").bind(clean(b.name, 40) || "토스프론트", id).run(); return json({ ok: true }); }
  return json({ ok: false, error: "invalid" }, 400);
}
