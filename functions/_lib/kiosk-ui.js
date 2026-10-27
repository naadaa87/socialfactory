/** 프론트 UI 설정: 토스가 공개한 목록형·그리드형만 선택할 수 있습니다. */
export const DEFAULT_KIOSK_UI = Object.freeze({ categoryLayout: "list", productLayout: "list" });
const TABLE = `CREATE TABLE IF NOT EXISTS kiosk_ui_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1), category_layout TEXT NOT NULL,
  product_layout TEXT NOT NULL, updated_at TEXT NOT NULL)`;

export function validateKioskUi(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_KIOSK_UI, key))
    || !["list", "grid"].includes(value.categoryLayout) || !["list", "grid"].includes(value.productLayout)) {
    throw new Error("kiosk-ui-invalid");
  }
  return { categoryLayout: value.categoryLayout, productLayout: value.productLayout };
}

export async function readKioskUi(env) {
  await env.DB.prepare(TABLE).run();
  const row = await env.DB.prepare("SELECT * FROM kiosk_ui_settings WHERE id = 1").first();
  if (!row) return { ...DEFAULT_KIOSK_UI, updatedAt: null };
  let layout;
  try { layout = validateKioskUi({ categoryLayout: row.category_layout, productLayout: row.product_layout }); }
  catch { layout = DEFAULT_KIOSK_UI; }
  return { ...layout, updatedAt: row.updated_at };
}

export async function saveKioskUi(env, value) {
  const layout = validateKioskUi(value);
  await env.DB.prepare(TABLE).run();
  await env.DB.prepare(`INSERT INTO kiosk_ui_settings (id, category_layout, product_layout, updated_at)
    VALUES (1, ?1, ?2, strftime('%Y-%m-%d %H:%M:%f', 'now', '+9 hours'))
    ON CONFLICT(id) DO UPDATE SET category_layout=excluded.category_layout,
      product_layout=excluded.product_layout, updated_at=excluded.updated_at`)
    .bind(layout.categoryLayout, layout.productLayout).run();
  return readKioskUi(env);
}
