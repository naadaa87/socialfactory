/**
 * 카카오 알림톡 발송 준비 — 알림 대기열(notification_jobs)을 꺼내 보내는 곳
 * ------------------------------------------------------------------
 *  - ALIMTALK_ENABLED != "1" 또는 PROVIDER 가 비어 있으면 문구만 'logged'로 기록합니다.
 *  - ALIMTALK_PROVIDER = "aligo" : 알리고 알림톡 API (aligo.js). 검수 승인 후에만 ENABLED=1로 켭니다.
 *  - ALIMTALK_PROVIDER = "webhook"  : ALIMTALK_WEBHOOK_URL 로 { to, templateCode, text, variables } 를 POST 합니다
 *                                     (발송 업체 앞에 둔 중계 서버 · 자동화 도구용, ALIMTALK_WEBHOOK_TOKEN 이 있으면 Bearer 로 붙임).
 * 템플릿 본문·버튼은 승인본과 같아야 하며, 종류별 ALIMTALK_TEXT_* · BUTTONS_* 로 재정의할 수 있습니다.
 *
 * 템플릿 코드: ALIMTALK_TPL_PURCHASE · EXPIRE · RENEWAL · REFUND.
 */
import { kstNow } from "./admin.js";
import { sendAligo } from "./aligo.js";

export const TEMPLATES = {
  purchase: {
    title: "구매 완료", env: "ALIMTALK_TPL_PURCHASE", code: "UM_9903",
    text: "[소셜팩토리 건대] 이용권 구매 완료\n\n이용권이 정상적으로 등록되었습니다.\n\n■ 구매 상품: #{이용권}\n■ 결제 금액: #{금액}원\n■ 이용 시작: #{시작일시}\n■ 이용 종료: #{종료일시}\n\n공간 이용 방법과 시설 안내는 아래 이용 안내를 통해 확인 부탁드립니다.",
    buttons: { button: [{ name: "이용 안내", linkType: "WL", linkMo: "https://socialfactory.co.kr/guide" }] }
  },
  expire_soon: {
    title: "만료 예정", env: "ALIMTALK_TPL_EXPIRE", code: "UM_9905",
    text: "[소셜팩토리 건대] 이용권 만료 예정\n\n현재 이용 중인 이용권의 종료 시각을 안내드립니다.\n\n· 이용권: #{이용권}\n· 이용 종료: #{종료일시}\n\n추가 구매 또는 기간 변경을 완료하셨다면 변경된 이용 내역을 확인해 주세요.\n\n이용권 추가 구매는 아래 버튼을 통해 혹은 현장결제를 부탁드립니다.",
    buttons: { button: [{ name: "이용권 추가 구매", linkType: "WL", linkMo: "https://socialfactory.co.kr/shop" }] }
  },
  renewal: {
    title: "연장 완료", env: "ALIMTALK_TPL_RENEWAL", code: "UM_9906",
    text: "[소셜팩토리 건대] 이용 기간 연장 완료\n\n추가 구매한 이용권이 등록되었습니다.\n기존 이용 기간에 이어서 적용됩니다.\n\n· 추가 구매: #{이용권}\n· 결제 금액: #{금액}원\n· 기존 종료: #{기존종료일시}\n· 최종 종료: #{최종종료일시}"
  },
  refund: {
    title: "취소 완료", env: "ALIMTALK_TPL_REFUND", code: "UM_9907",
    text: "[소셜팩토리 건대] 이용권 취소·환불 완료\n\n요청하신 이용권의 취소·환불 처리가 완료되었습니다.\n\n· 취소 상품: #{이용권}\n· 환불 금액: #{환불금액}원\n· 처리 일시: #{처리일시}\n\n카드 결제 취소 금액의 반영 시점은 카드사에 따라 다를 수 있습니다."
  }
};

// 이미 쌓인 대기열(시작/만료/금액)과 제안 문구의 변수명(시작일시/종료일시/결제금액)을 함께 지원합니다.
function templateVars(vars = {}) {
  return { 시작일시: vars.시작, 종료일시: vars.만료, 결제금액: vars.금액, ...vars };
}
function substitute(text, vars) {
  return String(text).replace(/#\{([^}]+)\}/g, (_, key) => {
    if (vars[key] === undefined || vars[key] === null || vars[key] === "") {
      throw Object.assign(new Error("알림톡 변수 누락: " + key), { retryable: false });
    }
    return String(vars[key]);
  });
}
export function render(kind, vars, env = {}) {
  const t = TEMPLATES[kind];
  if (!t) return "";
  return substitute(env[t.env.replace("_TPL_", "_TEXT_")] || t.text, templateVars(vars));
}
export function buildMessage(kind, vars, env = {}) {
  const t = TEMPLATES[kind];
  if (!t) throw Object.assign(new Error("알 수 없는 알림 종류"), { retryable: false });
  const setting = name => env[t.env.replace("_TPL_", "_" + name + "_")];
  const values = templateVars(vars);
  const message = {
    text: render(kind, vars, env),
    title: substitute(setting("SUBJECT") || t.title, values),
    emtitle: setting("EMTITLE") ? substitute(setting("EMTITLE"), values) : ""
  };
  const raw = env[t.env.replace("_TPL_", "_BUTTONS_")] || t.buttons;
  if (raw) {
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!Array.isArray(parsed.button) || parsed.button.length > 5 || parsed.button.some(b => !b?.name || !b?.linkType)) throw new Error();
      const fill = value => typeof value === "string" ? substitute(value, templateVars(vars))
        : Array.isArray(value) ? value.map(fill)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)])) : value;
      message.buttons = fill(parsed);
    } catch (e) {
      throw Object.assign(new Error(e.retryable === false ? e.message : "알림톡 버튼 JSON 형식 오류"), { retryable: false });
    }
  }
  return message;
}
export const deliveryEnabled = env => String(env.ALIMTALK_ENABLED || "") === "1" && !!String(env.ALIMTALK_PROVIDER || "").trim();

const PROVIDERS = {
  aligo: (env, job, text, vars, message) => sendAligo(env, job, message, TEMPLATES[job.kind]),
  async webhook(env, job, text, vars, message) {
    if (!env.ALIMTALK_WEBHOOK_URL) throw new Error("ALIMTALK_WEBHOOK_URL 없음");
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(env.ALIMTALK_WEBHOOK_URL, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", ...(env.ALIMTALK_WEBHOOK_TOKEN ? { Authorization: "Bearer " + env.ALIMTALK_WEBHOOK_TOKEN } : {}) },
        body: JSON.stringify({ id: job.dedupe_key, to: job.phone, kind: job.kind, templateCode: env[TEMPLATES[job.kind].env] || TEMPLATES[job.kind].code || "", text, variables: vars, title: message.title, buttons: message.buttons, emtitle: message.emtitle })
      });
      const body = await r.text();
      if (!r.ok) throw new Error("HTTP " + r.status + " " + body.slice(0, 120));
      let id = ""; try { id = String(JSON.parse(body).id || ""); } catch {}
      return { messageId: id };
    } finally { clearTimeout(t); }
  }
};

const RETRY_MIN = [1, 5, 30, 120];   // 실패 후 다시 보내기까지 (분), 4번 넘게 실패하면 failed

/** 보낼 시각이 된 알림을 최대 limit 건 보냅니다. 여러 곳에서 동시에 불러도 같은 알림을 두 번 보내지 않습니다. */
export async function runQueue(env, { limit = 30 } = {}) {
  if (!env.DB) return { ok: false, error: "no-db" };
  const now = kstNow();
  // 알리고는 요청 중단 전에 접수됐을 수 있어 자동 재발송 대신 전송내역 확인을 요청합니다.
  await env.DB.prepare("UPDATE notification_jobs SET status = 'failed', last_error = '알리고 요청 결과 미확인 — 전송내역 확인 후 수동 재시도' WHERE status = 'sending' AND provider = 'aligo' AND updated_at < datetime('now', '+9 hours', '-10 minutes')").run();
  await env.DB.prepare("UPDATE notification_jobs SET status = 'queued' WHERE status = 'sending' AND COALESCE(provider, '') <> 'aligo' AND updated_at < datetime('now', '+9 hours', '-10 minutes')").run();

  // 알림 수신을 거부한 고객의 대기 알림은 보내지 않습니다
  await env.DB.prepare("UPDATE notification_jobs SET status = 'cancelled', last_error = '수신 거부', updated_at = datetime('now', '+9 hours') WHERE status = 'queued' AND customer_id IN (SELECT id FROM customers WHERE notify_off = 1)").run().catch(() => {});
  await cleanup(env).catch((e) => console.error("cleanup", e && e.message));
  const { results } = await env.DB.prepare("SELECT * FROM notification_jobs WHERE status = 'queued' AND send_after <= ?1 ORDER BY send_after LIMIT ?2").bind(now, limit).all();
  const provider = deliveryEnabled(env) ? String(env.ALIMTALK_PROVIDER).trim() : "";
  const out = { ok: true, picked: results.length, sent: 0, logged: 0, failed: 0, retry: 0, cancelled: 0, provider: provider || "log" };
  for (const job of results) {
    // 먼저 '보내는 중'으로 잡아 둔 것만 보냅니다 (동시에 돈 다른 발송기와 겹치지 않게)
    const claim = await env.DB.prepare("UPDATE notification_jobs SET status = 'sending', provider = ?1, attempts = attempts + 1, updated_at = datetime('now', '+9 hours') WHERE id = ?2 AND status = 'queued'").bind(provider || "log", job.id).run();
    if (!claim.meta || !claim.meta.changes) continue;
    let text = "", accepted = false;
    try {
      const vars = JSON.parse(job.vars || "{}");
      if (!(await currentJob(env, job, vars, now))) {
        await env.DB.prepare("UPDATE notification_jobs SET status = 'cancelled', updated_at = datetime('now', '+9 hours') WHERE id = ?1").bind(job.id).run();
        out.cancelled++; continue;
      }
      const message = buildMessage(job.kind, vars, env);
      text = message.text;
      if (!provider) {
        await env.DB.prepare("UPDATE notification_jobs SET status = 'logged', rendered = ?1, provider = 'log', updated_at = datetime('now', '+9 hours') WHERE id = ?2").bind(text, job.id).run();
        out.logged++; continue;
      }
      const send = PROVIDERS[provider];
      if (!send) throw new Error("알 수 없는 발송 방식: " + provider);
      const r = await send(env, job, text, vars, message);
      accepted = true;
      if (r?.test) {
        await env.DB.prepare("UPDATE notification_jobs SET status = 'logged', rendered = ?1, provider = 'aligo-test', provider_msg_id = ?2, last_error = NULL, updated_at = datetime('now', '+9 hours') WHERE id = ?3").bind(text, r.messageId || null, job.id).run();
        out.logged++; continue;
      }
      await env.DB.prepare("UPDATE notification_jobs SET status = 'sent', rendered = ?1, provider = ?2, provider_msg_id = ?3, sent_at = datetime('now', '+9 hours'), last_error = NULL, updated_at = datetime('now', '+9 hours') WHERE id = ?4")
        .bind(text, provider, (r && r.messageId) || null, job.id).run();
      out.sent++;
    } catch (e) {
      const tries = (job.attempts || 0) + 1, wait = e.retryable === false || (provider === "aligo" && accepted) ? null : RETRY_MIN[tries - 1];
      const msg = provider === "aligo" && accepted ? "알리고 접수 후 기록 실패 — 전송내역 확인 후 수동 재시도" : String((e && e.message) || e).slice(0, 300);
      if (wait) {
        await env.DB.prepare("UPDATE notification_jobs SET status = 'queued', send_after = datetime('now', '+9 hours', ?1), last_error = ?2, rendered = ?3, updated_at = datetime('now', '+9 hours') WHERE id = ?4").bind(`+${wait} minutes`, msg, text, job.id).run();
        out.retry++;
      } else {
        await env.DB.prepare("UPDATE notification_jobs SET status = 'failed', last_error = ?1, rendered = ?2, updated_at = datetime('now', '+9 hours') WHERE id = ?3").bind(msg, text, job.id).run();
        out.failed++;
      }
    }
  }
  return out;
}

// 재시도·수동 재발송 시에도 취소된 이용권, 지난 만료 알림, 시험 결제는 보내지 않습니다.
async function currentJob(env, job, vars, now) {
  const p = await env.DB.prepare("SELECT p.*, pp.status AS payment_status, pp.test_mode, pp.refund_amount FROM passes p JOIN pass_payments pp ON pp.id = p.payment_id WHERE p.id = ?1").bind(job.pass_id).first();
  if (!p || p.test_mode || p.customer_id !== job.customer_id) return false;
  if (job.kind === "refund") return p.status === "cancelled" && p.payment_status === "refunded" && p.refund_amount > 0;
  if (p.status !== "active" || p.payment_status !== "paid") return false;
  if (job.kind !== "expire_soon") return true;
  if (p.ends_at <= now || (vars.__endsAt && vars.__endsAt !== p.ends_at)) return false;
  const last = await env.DB.prepare("SELECT id FROM passes WHERE customer_id = ?1 AND pass_group = ?2 AND status = 'active' AND ends_at > ?3 ORDER BY ends_at DESC, id DESC LIMIT 1").bind(job.customer_id, p.pass_group, now).first();
  const displayEnd = (+p.ends_at.slice(5, 7)) + "월 " + (+p.ends_at.slice(8, 10)) + "일 " + p.ends_at.slice(11, 16);
  return last?.id === p.id && vars.만료 === displayEnd;
}

/**
 * 개인정보 처리방침의 보유 기간대로 지웁니다 (발송기가 돌 때마다 조금씩).
 * - 알림 발송 기록: 6개월 지난 것 삭제
 * - 현장 이용권 고객: 마지막 이용권이 끝난 지 1년 지났고 최근 1년 결제가 없으면 휴대폰 번호 · 이용권 내역 삭제.
 *   결제 · 취소 기록(pass_payments)은 법정 기간 동안 남기되 고객과의 연결만 끊깁니다 (전화번호는 customers 에만 있음).
 */
export async function cleanup(env) {
  await env.DB.prepare("DELETE FROM notification_jobs WHERE status <> 'queued' AND created_at < datetime('now', '+9 hours', '-6 months')").run();
  const { results } = await env.DB.prepare(
    `SELECT c.id FROM customers c
     WHERE c.created_at < datetime('now', '+9 hours', '-1 year')
       AND NOT EXISTS (SELECT 1 FROM passes p WHERE p.customer_id = c.id AND p.ends_at > datetime('now', '+9 hours', '-1 year'))
       AND NOT EXISTS (SELECT 1 FROM pass_payments pp WHERE pp.customer_id = c.id AND pp.created_at > datetime('now', '+9 hours', '-1 year'))
     LIMIT 50`
  ).all();
  for (const r of results) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM passes WHERE customer_id = ?1").bind(r.id),
      env.DB.prepare("DELETE FROM notification_jobs WHERE customer_id = ?1").bind(r.id),
      env.DB.prepare("DELETE FROM customers WHERE id = ?1").bind(r.id)
    ]);
  }
  return results.length;
}
