// GET /api/kiosk/products — 프론트에서 파는 이용권 목록 (단말기 토큰 필요)
import { json } from "../../_lib/auth.js";
import { KIOSK_PRODUCTS } from "../../_lib/kiosk-products.js";
import { deviceGate, durationText } from "../../_lib/kiosk.js";

export async function onRequestGet({ request, env }) {
  const { deny, device } = await deviceGate(request, env); if (deny) return deny;
  const origin = new URL(request.url).origin;
  return json({
    ok: true, device: { id: device.id, name: device.name },
    privacyUrl: origin + "/privacy",
    products: KIOSK_PRODUCTS.map((p) => ({
      id: p.id, name: p.name, price: p.price, listPrice: p.listPrice || null, friend: !!p.friend,
      short: p.short, duration: durationText(p.duration), image: p.image
    }))
  });
}
