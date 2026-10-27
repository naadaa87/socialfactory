/** 프론트 SDK가 직접 불러오는 공개 상품 아이콘. 상품 데이터만 제공하며 고객 정보는 없습니다. */
import { ensureSchema } from "../../../_lib/admin.js";

export async function onRequestGet({ params, env }) {
  const id = String(params && params.id || "");
  if (!/^[a-z0-9-]{3,40}$/.test(id)) return new Response(null, { status: 404 });
  if (!env.DB) return new Response(null, { status: 503 });
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT data_base64 FROM kiosk_product_images WHERE product_id = ?1").bind(id).first();
  if (!row) return new Response(null, { status: 404 });
  const raw = atob(row.data_base64);
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/webp", "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin"
    }
  });
}
