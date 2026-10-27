/** 관리자 전용 프론트 상품 분류. ID는 상품 연결을 위해 고정하고 이름·설명·정렬을 수정합니다. */
import { json, clean } from "../../_lib/auth.js";
import { adminGate } from "../../_lib/admin.js";
import { getKioskCategories, IMAGES } from "../../_lib/kiosk-catalog.js";

function checked(b) {
  const name = clean(b && b.name, 40), description = clean(b && b.description, 100);
  const image = clean(b && b.image, 40), sortOrder = Number(b && b.sortOrder);
  if (name.length < 2 || !IMAGES.includes(image) || !Number.isInteger(sortOrder) ||
      sortOrder < 0 || sortOrder > 999) return null;
  return { name, description, image, sortOrder, active: b.active === true };
}
export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  try { return json({ ok: true, categories: await getKioskCategories(env, { all: true }) }); }
  catch (e) { console.error("kiosk-categories", e && e.message); return json({ ok: false, error: "db-error" }, 500); }
}
async function save(request, env, update) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const c = checked(b);
  if (!c) return json({ ok: false, error: "invalid", message: "카테고리 이름·이미지·순서를 확인해 주세요." }, 400);
  try {
    await getKioskCategories(env, { all: true });
    const id = update ? clean(b.id, 40) : "category-" + Date.now().toString(36) + "-" +
      Array.from(crypto.getRandomValues(new Uint8Array(4)), (x) => x.toString(16).padStart(2, "0")).join("");
    if (update) {
      const row = await env.DB.prepare("SELECT id FROM kiosk_categories WHERE id=?1").bind(id).first();
      if (!row) return json({ ok: false, error: "not-found" }, 404);
      if (!c.active) {
        const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM kiosk_products WHERE category=?1 AND active=1").bind(id).first();
        if (used && used.n) return json({ ok: false, error: "in-use", message: "판매 중인 상품을 다른 카테고리로 옮기거나 판매 중지한 뒤 비활성화해 주세요." }, 409);
      }
      await env.DB.prepare(
        "UPDATE kiosk_categories SET name=?1, description=?2, image=?3, sort_order=?4, active=?5, updated_at=datetime('now', '+9 hours') WHERE id=?6"
      ).bind(c.name,c.description,c.image,c.sortOrder,c.active ? 1 : 0,id).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO kiosk_categories (id,name,description,image,sort_order,active) VALUES (?1,?2,?3,?4,?5,?6)"
      ).bind(id,c.name,c.description,c.image,c.sortOrder,c.active ? 1 : 0).run();
    }
    return json({ ok: true, id });
  } catch (e) {
    console.error("kiosk-category-save", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}
export const onRequestPost = ({ request, env }) => save(request, env, false);
export const onRequestPatch = ({ request, env }) => save(request, env, true);
