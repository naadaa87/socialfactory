/** 관리자 전용 알리고 연결 확인. ALIGO_TEST_MODE=Y 일 때만 실행되며 고객 번호·대기열을 사용하지 않습니다. */
import { json, sameOrigin } from "../../_lib/auth.js";
import { adminGate } from "../../_lib/admin.js";
import { sendAligo } from "../../_lib/aligo.js";
import { buildMessage, TEMPLATES } from "../../_lib/notify.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ ok: false, error: "origin" }, 403);
  const deny = await adminGate(request, env); if (deny) return deny;
  if (String(env.ALIGO_TEST_MODE || "").toUpperCase() !== "Y") return json({ ok: false, error: "test-mode-only" }, 409);
  try {
    const message = buildMessage("purchase", {
      이용권: "연결 확인", 금액: "0", 시작일시: "2026-10-28 12:00", 종료일시: "2026-10-28 14:00"
    }, env);
    const result = await sendAligo(env, { phone: env.ALIGO_SENDER }, message, TEMPLATES.purchase);
    return json({ ok: true, provider: "aligo", test: result.test === true, accepted: true });
  } catch (e) {
    return json({ ok: false, provider: "aligo", test: true, error: String(e?.message || e).slice(0, 200) }, 502);
  }
}
