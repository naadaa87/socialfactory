/**
 * /api/kiosk/* 공통 — 토스프론트 플러그인은 다른 주소(토스 쪽)에서 열리므로 CORS 를 허용합니다.
 * 쿠키를 쓰지 않고 단말기 토큰(Authorization 헤더)으로만 인증하므로 다른 주소에서 불러도 안전합니다.
 * KIOSK_ORIGINS 에 주소를 쉼표로 적으면 그 주소만 허용합니다 (비워 두면 모두 허용).
 * 다른 /api 주소(홈페이지 · 관리자)에는 영향이 없습니다.
 */
function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const list = String(env.KIOSK_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allow = !list.length ? "*" : (list.includes(origin) ? origin : list[0]);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    ...(list.length ? { Vary: "Origin" } : {})
  };
}

export async function onRequest({ request, env, next }) {
  const h = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  const res = await next();
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(h)) out.headers.set(k, v);
  return out;
}
