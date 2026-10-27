/** 토스프론트 SDK가 불러오는 공개 분류 이미지. */
import { ensureSchema } from "../../../_lib/admin.js";

export async function onRequestGet({ params, env }) {
  const id = String(params && params.id || "");
  if (!/^[a-z0-9-]{3,40}$/.test(id)) return new Response(null, { status: 404 });
  if (!env.DB) return new Response(null, { status: 503 });
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT data_base64 FROM kiosk_category_images WHERE category_id=?1").bind(id).first();
  if (!row) return new Response(null, { status: 404 });
  const bytes = Uint8Array.from(atob(row.data_base64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: {
    "Content-Type": "image/webp", "Content-Length": String(bytes.length),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "cross-origin"
  } });
}
