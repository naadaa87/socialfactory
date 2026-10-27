// GET /api/kiosk/products — 프론트에서 파는 이용권 목록 (단말기 토큰 필요)
import { readKioskUi } from "../../_lib/kiosk-ui.js";
import { json } from "../../_lib/auth.js";
import { getKioskProducts, getKioskCategories, seedKioskProducts } from "../../_lib/kiosk-catalog.js";
import { deviceGate, durationText } from "../../_lib/kiosk.js";

export async function onRequestGet({ request, env }) {
  const started = performance.now();
  const { deny, device } = await deviceGate(request, env); if (deny) return deny;
  const authenticated = performance.now();
  const origin = new URL(request.url).origin;
  await seedKioskProducts(env);
  const [products, categories, layout] = await Promise.all([
    getKioskProducts(env), getKioskCategories(env), readKioskUi(env)
  ]);
  const loaded = performance.now();
  return json({
    ok: true, device: { id: device.id, name: device.name },
    privacyUrl: origin + "/privacy",
    layout,
    categories: categories.map((c) => ({ id: c.id, name: c.name, description: c.description, image: c.image,
      imageUrl: c.imageVersion ? origin + "/api/kiosk/category-images/" + encodeURIComponent(c.id) + "?v=" + c.imageVersion : null })),
    products: products.map((p) => ({
      id: p.id, name: p.name, price: p.price, listPrice: p.listPrice || null, friend: !!p.friend,
      short: p.short, duration: durationText(p.duration), image: p.image, category: p.category,
      imageUrl: p.imageVersion ? origin + "/api/kiosk/product-images/" + encodeURIComponent(p.id) + "?v=" + p.imageVersion : null
    }))
  }, 200, { "Server-Timing": "auth;dur=" + (authenticated - started).toFixed(1) +
    ", catalog;dur=" + (loaded - authenticated).toFixed(1) });
}
