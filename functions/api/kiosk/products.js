// GET /api/kiosk/products — 프론트에서 파는 이용권 목록 (단말기 토큰 필요)
import { json } from "../../_lib/auth.js";
import { getKioskProducts, getKioskCategories } from "../../_lib/kiosk-catalog.js";
import { deviceGate, durationText } from "../../_lib/kiosk.js";

export async function onRequestGet({ request, env }) {
  const { deny, device } = await deviceGate(request, env); if (deny) return deny;
  const origin = new URL(request.url).origin;
  const products = await getKioskProducts(env);
  const categories = await getKioskCategories(env);
  return json({
    ok: true, device: { id: device.id, name: device.name },
    privacyUrl: origin + "/privacy",
    categories: categories.map((c) => ({ id: c.id, name: c.name, description: c.description, image: c.image,
      imageUrl: c.imageVersion ? origin + "/api/kiosk/category-images/" + encodeURIComponent(c.id) + "?v=" + c.imageVersion : null })),
    products: products.map((p) => ({
      id: p.id, name: p.name, price: p.price, listPrice: p.listPrice || null, friend: !!p.friend,
      short: p.short, duration: durationText(p.duration), image: p.image, category: p.category,
      imageUrl: p.imageVersion ? origin + "/api/kiosk/product-images/" + encodeURIComponent(p.id) + "?v=" + p.imageVersion : null
    }))
  });
}
