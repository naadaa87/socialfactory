// GET /api/auth/kakao/callback — 카카오에서 돌아온 뒤 로그인 처리
// 이미 가입한 카카오 회원 → 바로 로그인 / 처음 온 회원 → 약관 동의와 연락처 입력 화면(/signup?kakao=1)으로
import { readCookie, clearCookie, safeEqual, createSession, signedCookie, safeNext, ipHashOf, logEvent } from "../../../_lib/auth.js";

const go = (location, cookies = []) => {
  const h = new Headers({ Location: location, "Cache-Control": "no-store" });
  cookies.forEach((c) => h.append("Set-Cookie", c));
  return new Response(null, { status: 302, headers: h });
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const origin = url.origin;
  const fail = (code) => go(origin + "/login?error=" + code, [clearCookie(request, "sf_ks")]);
  if (!env.KAKAO_REST_KEY || !env.SESSION_SECRET || !env.DB) return fail("kakao-off");
  if (url.searchParams.get("error")) return fail("kakao-cancel"); // 사용자가 동의 화면에서 취소

  const saved = readCookie(request, "sf_ks");
  const [state, nextRaw] = saved.split("|");
  if (!state || !safeEqual(state, url.searchParams.get("state") || "")) return fail("kakao-state");
  const next = safeNext(nextRaw || "/mypage");
  const code = url.searchParams.get("code") || "";
  if (!code) return fail("kakao");

  let profile;
  try {
    const body = new URLSearchParams({ grant_type: "authorization_code", client_id: env.KAKAO_REST_KEY, redirect_uri: origin + "/api/auth/kakao/callback", code });
    if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);
    const tr = await fetch((env.KAKAO_AUTH_HOST || "https://kauth.kakao.com") + "/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" }, body
    });
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.access_token) { console.error("kakao-token", tr.status, tok.error_code || tok.error); return fail("kakao"); }
    const ur = await fetch((env.KAKAO_API_HOST || "https://kapi.kakao.com") + "/v2/user/me", { headers: { Authorization: "Bearer " + tok.access_token } });
    profile = await ur.json().catch(() => ({}));
    if (!ur.ok || !profile.id) { console.error("kakao-user", ur.status); return fail("kakao"); }
  } catch (e) {
    console.error("kakao", e && e.message);
    return fail("kakao");
  }

  const kid = String(profile.id);
  const acc = profile.kakao_account || {};
  const nickname = String((acc.profile && acc.profile.nickname) || (profile.properties && profile.properties.nickname) || "").slice(0, 40);
  const email = acc.email && acc.is_email_valid !== false && acc.is_email_verified ? String(acc.email).toLowerCase().slice(0, 120) : "";

  const m = await env.DB.prepare("SELECT * FROM members WHERE kakao_id = ?1").bind(kid).first().catch(() => null);
  const clear = clearCookie(request, "sf_ks");
  if (m) {
    if (m.status !== "active") return go(origin + "/login?error=blocked", [clear]);
    await logEvent(env, "login_ok", "kakao:" + kid, await ipHashOf(request, env));
    return go(origin + next, [clear, ...(await createSession(request, env, m.id))]);
  }
  // 처음 온 카카오 회원: 30분 동안 유효한 서명 쿠키에 담아 가입 마무리 화면으로
  const pending = await signedCookie(request, env, "sf_kp", { kid, nickname, email, next }, 1800);
  return go(origin + "/signup?kakao=1", [clear, pending]);
}
