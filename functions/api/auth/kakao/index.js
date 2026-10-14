// GET /api/auth/kakao — 카카오 로그인 시작 (카카오 동의 화면으로 이동)
import { randomToken, plainCookie, safeNext } from "../../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.KAKAO_REST_KEY || !env.SESSION_SECRET || !env.DB) return Response.redirect(url.origin + "/login?error=kakao-off", 302);
  const state = randomToken(16);
  const next = safeNext(url.searchParams.get("next") || "/mypage");
  const auth = (env.KAKAO_AUTH_HOST || "https://kauth.kakao.com") + "/oauth/authorize?" + new URLSearchParams({
    client_id: env.KAKAO_REST_KEY,
    redirect_uri: url.origin + "/api/auth/kakao/callback",
    response_type: "code",
    state
  });
  const h = new Headers({ Location: auth, "Cache-Control": "no-store" });
  h.append("Set-Cookie", plainCookie(request, "sf_ks", state + "|" + next, 600));
  return new Response(null, { status: 302, headers: h });
}
