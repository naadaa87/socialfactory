import { json } from "../../_lib/auth.js";
import { adminGate } from "../../_lib/admin.js";
import { readKioskUi, saveKioskUi } from "../../_lib/kiosk-ui.js";
import { getKioskProducts, getKioskCategories } from "../../_lib/kiosk-catalog.js";

export async function onRequestGet({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  try {
    const origin = new URL(request.url).origin;
    const products = await getKioskProducts(env), categories = await getKioskCategories(env);
    return json({ ok: true, layout: await readKioskUi(env),
      products: products.map(p => ({ ...p, imageUrl: p.imageVersion ? origin + "/api/kiosk/product-images/" + encodeURIComponent(p.id) + "?v=" + p.imageVersion : null })),
      categories: categories.map(c => ({ ...c, imageUrl: c.imageVersion ? origin + "/api/kiosk/category-images/" + encodeURIComponent(c.id) + "?v=" + c.imageVersion : null }))
    });
  }
  catch { return json({ ok: false, error: "db-error", message: "화면 설정을 불러오지 못했어요." }, 500); }
}

export async function onRequestPut({ request, env }) {
  const deny = await adminGate(request, env); if (deny) return deny;
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  try { return json({ ok: true, layout: await saveKioskUi(env, body?.layout) }); }
  catch (error) {
    if (error.message === "kiosk-ui-invalid") return json({ ok: false, error: "invalid", message: "분류 화면과 상품 화면의 표시 방식을 선택해 주세요." }, 400);
    return json({ ok: false, error: "db-error", message: "화면 설정을 저장하지 못했어요." }, 500);
  }
}
