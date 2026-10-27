/** 관리자 전용 토스프론트 상품 등록·수정·노출 관리. */
import { json, clean } from "../../_lib/auth.js";
import { adminGate } from "../../_lib/admin.js";
import { getKioskProducts, backfillLegacyTerms, IMAGES } from "../../_lib/kiosk-catalog.js";

const UNITS = ["hours", "days", "months"];
function checked(b) {
  const name = clean(b && b.name, 60), short = clean(b && b.short, 120);
  const usesRate = b && Object.prototype.hasOwnProperty.call(b, "discountPercent");
  const basePrice = Number(b && b.basePrice), rate = Number(b && b.discountPercent);
  const price = usesRate ? Math.round(basePrice * (100 - rate) / 100) : Number(b && b.price);
  const listPrice = usesRate ? (rate > 0 ? basePrice : null) :
    b && b.listPrice !== "" && b.listPrice != null ? Number(b.listPrice) : null;
  const unit = clean(b && b.durationUnit, 10), value = Number(b && b.durationValue);
  const group = clean(b && b.group, 30), category = clean(b && b.category, 40);
  const image = clean(b && b.image, 40), sortOrder = Number(b && b.sortOrder);
  if ((usesRate && (!Number.isInteger(basePrice) || basePrice < 100 || basePrice > 10000000 ||
      !Number.isInteger(rate) || rate < 0 || rate > 90)) ||
      name.length < 2 || !Number.isInteger(price) || price < 100 || price > 10000000 ||
      (listPrice !== null && (!Number.isInteger(listPrice) || listPrice < price || listPrice > 10000000)) ||
      !UNITS.includes(unit) || !Number.isInteger(value) || value < 1 ||
      (unit === "hours" && value > 72) || (unit === "days" && value > 365) || (unit === "months" && value > 12) ||
      !/^[a-z0-9-]{2,30}$/.test(group) || !/^[a-z0-9-]{3,40}$/.test(category) || !IMAGES.includes(image) ||
      !Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 999 ||
      (category === "friend" && !(listPrice > price))) return null;
  return { name, short, price, listPrice, unit, value, group, category, image, sortOrder, active: b.active === true };
}

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  try { return json({ ok: true, products: await getKioskProducts(env, { all: true }) }); }
  catch (e) { console.error("admin-kiosk-products", e && e.message); return json({ ok: false, error: "db-error" }, 500); }
}

async function save(request, env, update) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const p = checked(b);
  if (!p) return json({ ok: false, error: "invalid", message: "상품명·가격·기간·카테고리를 확인해 주세요." }, 400);
  try {
    await getKioskProducts(env, { all: true });
    const category = await env.DB.prepare("SELECT id FROM kiosk_categories WHERE id=?1 AND active=1").bind(p.category).first();
    if (!category) return json({ ok: false, error: "invalid-category", message: "사용 중인 카테고리를 골라 주세요." }, 400);
    await backfillLegacyTerms(env);
    const id = update ? clean(b.id, 40) : "custom-" + Date.now().toString(36) + "-" +
      Array.from(crypto.getRandomValues(new Uint8Array(4)), (x) => x.toString(16).padStart(2, "0")).join("");
    if (update) {
      const old = await env.DB.prepare("SELECT id FROM kiosk_products WHERE id = ?1").bind(id).first();
      if (!old) return json({ ok: false, error: "not-found" }, 404);
      await env.DB.prepare(
        `UPDATE kiosk_products SET name=?1, price=?2, list_price=?3, duration_unit=?4, duration_value=?5,
         pass_group=?6, image=?7, short=?8, category=?9, active=?10, sort_order=?11,
         updated_at=datetime('now', '+9 hours') WHERE id=?12`
      ).bind(p.name,p.price,p.listPrice,p.unit,p.value,p.group,p.image,p.short,p.category,p.active ? 1 : 0,p.sortOrder,id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO kiosk_products (id,name,price,list_price,duration_unit,duration_value,pass_group,image,short,category,active,sort_order)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
      ).bind(id,p.name,p.price,p.listPrice,p.unit,p.value,p.group,p.image,p.short,p.category,p.active ? 1 : 0,p.sortOrder).run();
    }
    return json({ ok: true, id });
  } catch (e) {
    console.error("admin-kiosk-product-save", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}
export const onRequestPost = ({ request, env }) => save(request, env, false);
export const onRequestPatch = ({ request, env }) => save(request, env, true);
