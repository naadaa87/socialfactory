/** 관리자 전용 프론트 분류 이미지 업로드. 브라우저가 줄인 WebP만 저장합니다. */
import { json, clean } from "../../_lib/auth.js";
import { adminGate } from "../../_lib/admin.js";

const validId = (id) => /^[a-z0-9-]{3,40}$/.test(id);

export async function onRequestPost({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  if (Number(request.headers.get("content-length") || 0) > 220000) return json({ ok: false, error: "too-large" }, 413);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const id = clean(b && b.categoryId, 40), base64 = b && b.base64;
  if (!validId(id) || typeof base64 !== "string" || base64.length < 40 || base64.length > 200000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return json({ ok: false, error: "invalid-image" }, 400);
  let bytes;
  try { bytes = atob(base64); } catch { return json({ ok: false, error: "invalid-image" }, 400); }
  if (bytes.length < 30 || bytes.length > 150000 || bytes.slice(0, 4) !== "RIFF" ||
      bytes.slice(8, 12) !== "WEBP" || !["VP8 ", "VP8L", "VP8X"].includes(bytes.slice(12, 16)) ||
      (bytes.charCodeAt(4) | bytes.charCodeAt(5) << 8 | bytes.charCodeAt(6) << 16 | bytes.charCodeAt(7) << 24) >>> 0 !== bytes.length - 8)
    return json({ ok: false, error: "invalid-image", message: "WebP 이미지 크기나 형식을 확인해 주세요." }, 400);
  try {
    const category = await env.DB.prepare("SELECT id FROM kiosk_categories WHERE id=?1").bind(id).first();
    if (!category) return json({ ok: false, error: "not-found" }, 404);
    await env.DB.prepare(
      `INSERT INTO kiosk_category_images (category_id,data_base64,version) VALUES (?1,?2,?3)
       ON CONFLICT(category_id) DO UPDATE SET data_base64=excluded.data_base64,
         version=max(kiosk_category_images.version+1,excluded.version),updated_at=datetime('now','+9 hours')`
    ).bind(id, base64, Date.now()).run();
    const row = await env.DB.prepare("SELECT version FROM kiosk_category_images WHERE category_id=?1").bind(id).first();
    return json({ ok: true, version: row.version });
  } catch (e) {
    console.error("kiosk-category-image-upload", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}

export async function onRequestDelete({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const id = clean(b && b.categoryId, 40);
  if (!validId(id)) return json({ ok: false, error: "invalid" }, 400);
  await env.DB.prepare("DELETE FROM kiosk_category_images WHERE category_id=?1").bind(id).run();
  return json({ ok: true });
}
