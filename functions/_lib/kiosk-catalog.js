/**
 * 토스프론트 상품 카탈로그. 기존 코드 상품을 D1에 처음 한 번 등록하고,
 * 결제마다 당시 이용 조건을 별도 보관해 이후 상품 변경이 결제·연장에 영향을 주지 않게 합니다.
 */
import { KIOSK_PRODUCTS, KIOSK_PRODUCT_MAP } from "./kiosk-products.js";

const DURATION = ["hours", "days", "months"];
export const CATEGORIES = ["day", "regular", "friend"];
export const IMAGES = ["pass-2h.webp", "pass-1d.webp", "pass-15d.webp", "pass-1m.webp", "pass-3m.webp"];

const defaultCategory = (p) => p.friend ? "friend" : ["seat-2h", "seat-1d"].includes(p.id) ? "day" : "regular";
const defaultUnit = (p) => DURATION.find((u) => p.duration[u]);
const reminder = (unit, value) => unit === "months" ? [4320, 1440] :
  unit === "days" && value >= 3 ? [1440] : unit === "hours" && value >= 24 ? [120] : [20];

function productFromRow(r) {
  return {
    id: r.id, name: r.name, price: Number(r.price), listPrice: r.list_price == null ? null : Number(r.list_price),
    duration: { [r.duration_unit]: Number(r.duration_value) }, group: r.pass_group,
    remind: reminder(r.duration_unit, Number(r.duration_value)), image: r.image,
    short: r.short, category: r.category, friend: r.category === "friend",
    active: !!r.active, sortOrder: Number(r.sort_order)
  };
}

export async function seedKioskProducts(env) {
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
    "SELECT * FROM kiosk_products" + (all ? "" : " WHERE active = 1") + " ORDER BY sort_order, id"
  ).all();
  return results.map(productFromRow);
}

export async function getKioskProduct(env, id, { includeInactive = false } = {}) {
  await seedKioskProducts(env);
  const row = await env.DB.prepare("SELECT * FROM kiosk_products WHERE id = ?1").bind(id).first();
  return row && (includeInactive || row.active) ? productFromRow(row) : null;
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
