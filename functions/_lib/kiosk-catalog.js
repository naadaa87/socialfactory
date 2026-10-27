/**
 * 토스프론트 상품 카탈로그. 기존 코드 상품을 D1에 처음 한 번 등록하고,
 * 결제마다 당시 이용 조건을 별도 보관해 이후 상품 변경이 결제·연장에 영향을 주지 않게 합니다.
 */
import { KIOSK_PRODUCTS, KIOSK_PRODUCT_MAP } from "./kiosk-products.js";

const DURATION = ["hours", "days", "months"];
export const IMAGES = ["pass-2h.webp", "pass-1d.webp", "pass-15d.webp", "pass-1m.webp", "pass-3m.webp"];
const DEFAULT_CATEGORIES = [
  { id: "day", name: "잠깐 · 하루", description: "오늘 필요한 만큼 가볍게", image: "pass-1d.webp", sortOrder: 10 },
  { id: "regular", name: "꾸준히 이용", description: "정기 이용권과 사물함", image: "pass-1m.webp", sortOrder: 20 },
  { id: "friend", name: "친구와 함께", description: "친구 동반 할인권", image: "pass-3m.webp", sortOrder: 30 }
];

const defaultCategory = (p) => p.friend ? "friend" : ["seat-2h", "seat-1d"].includes(p.id) ? "day" : "regular";
const defaultUnit = (p) => DURATION.find((u) => p.duration[u]);
const reminder = (unit, value) => unit === "months" ? [4320, 1440] :
  unit === "days" && value >= 3 ? [1440] : unit === "hours" && value >= 24 ? [120] : [20];

function productFromRow(r) {
  const price = Number(r.price), listPrice = r.list_price == null ? null : Number(r.list_price);
  return {
    id: r.id, name: r.name, price, listPrice,
    discountPercent: listPrice ? Math.round((listPrice - price) / listPrice * 100) : 0,
    duration: { [r.duration_unit]: Number(r.duration_value) }, group: r.pass_group,
    remind: reminder(r.duration_unit, Number(r.duration_value)), image: r.image,
    short: r.short, category: r.category, friend: r.category === "friend",
    active: !!r.active, sortOrder: Number(r.sort_order), imageVersion: r.image_version || null,
    categoryName: r.category_name || r.category
  };
}

export async function seedKioskCategories(env) {
  for (const c of DEFAULT_CATEGORIES) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO kiosk_categories (id,name,description,image,sort_order) VALUES (?1,?2,?3,?4,?5)"
    ).bind(c.id, c.name, c.description, c.image, c.sortOrder).run();
  }
}

export async function getKioskCategories(env, { all = false } = {}) {
  await seedKioskCategories(env);
  const { results } = await env.DB.prepare(
    `SELECT c.id,c.name,c.description,c.image,c.sort_order,c.active,
      (SELECT COUNT(*) FROM kiosk_products p WHERE p.category=c.id AND p.active=1) AS active_products
     FROM kiosk_categories c` + (all ? "" : " WHERE c.active=1") + " ORDER BY c.sort_order,c.id"
  ).all();
  return results.map((r) => ({
    id: r.id, name: r.name, description: r.description, image: r.image,
    sortOrder: Number(r.sort_order), active: !!r.active, activeProducts: Number(r.active_products)
  }));
}

export async function seedKioskProducts(env) {
  await seedKioskCategories(env);
  for (let i = 0; i < KIOSK_PRODUCTS.length; i++) {
    const p = KIOSK_PRODUCTS[i], unit = defaultUnit(p);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO kiosk_products
       (id,name,price,list_price,duration_unit,duration_value,pass_group,image,short,category,active,sort_order)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11)`
    ).bind(p.id, p.name, p.price, p.listPrice || null, unit, p.duration[unit], p.group,
      p.image, p.short, defaultCategory(p), i * 10).run();
  }
}

export async function getKioskProducts(env, { all = false } = {}) {
  await seedKioskProducts(env);
  const { results } = await env.DB.prepare(
    "SELECT p.*, i.version AS image_version, c.name AS category_name, c.active AS category_active FROM kiosk_products p" +
    " JOIN kiosk_categories c ON c.id=p.category LEFT JOIN kiosk_product_images i ON i.product_id = p.id" +
    (all ? "" : " WHERE p.active = 1 AND c.active=1") + " ORDER BY c.sort_order,p.sort_order,p.id"
  ).all();
  return results.map(productFromRow);
}

export async function getKioskProduct(env, id, { includeInactive = false } = {}) {
  await seedKioskProducts(env);
  const row = await env.DB.prepare(
    "SELECT p.*, i.version AS image_version, c.name AS category_name, c.active AS category_active FROM kiosk_products p" +
    " JOIN kiosk_categories c ON c.id=p.category LEFT JOIN kiosk_product_images i ON i.product_id = p.id WHERE p.id = ?1"
  ).bind(id).first();
  return row && (includeInactive || (row.active && row.category_active)) ? productFromRow(row) : null;
}

export const termsJson = (p) => JSON.stringify({
  id: p.id, name: p.name, price: p.price, duration: p.duration, group: p.group, remind: p.remind
});

export async function termsForPayment(env, pay) {
  const row = await env.DB.prepare("SELECT terms FROM kiosk_payment_terms WHERE payment_key = ?1").bind(pay.payment_key).first();
  if (row) return JSON.parse(row.terms);
  // 기존 결제의 상품은 원래 코드 조건으로 해석합니다. 첫 관리자 변경 때 일괄 스냅샷을 남깁니다.
  return KIOSK_PRODUCT_MAP[pay.product_id] || null;
}

export async function backfillLegacyTerms(env) {
  for (const p of KIOSK_PRODUCTS) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO kiosk_payment_terms (payment_key, terms) SELECT payment_key, ?1 FROM pass_payments WHERE product_id = ?2"
    ).bind(termsJson(p), p.id).run();
  }
}
