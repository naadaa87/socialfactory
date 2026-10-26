/**
 * 카카오 알림톡 발송 준비 — 알림 대기열(notification_jobs)을 꺼내 보내는 곳
 * ------------------------------------------------------------------
 * 발송 업체(솔라피 · NHN Cloud · 알리고 등)를 아직 정하지 않았으므로, 지금은 두 가지 방식만 있습니다.
 *  - ALIMTALK_PROVIDER 를 비워 두면 : 보낼 문구를 만들어 'logged'(기록만)로 남깁니다. 관리자 화면에서 문구를 확인할 수 있습니다.
 *  - ALIMTALK_PROVIDER = "webhook"  : ALIMTALK_WEBHOOK_URL 로 { to, templateCode, text, variables } 를 POST 합니다
 *                                     (발송 업체 앞에 둔 중계 서버 · 자동화 도구용, ALIMTALK_WEBHOOK_TOKEN 이 있으면 Bearer 로 붙임).
 * 업체를 정하면 PROVIDERS 에 그 업체용 함수 하나만 추가합니다. 템플릿 문구는 카카오 심사를 받은 문구와 글자 하나까지 같아야 합니다.
 *
 * 템플릿 코드(카카오 심사 후 받는 값)는 Cloudflare 설정값 ALIMTALK_TPL_PURCHASE · ALIMTALK_TPL_EXPIRE 에 넣습니다.
 */
import { kstNow } from "./admin.js";

export const TEMPLATES = {
  purchase: {
    title: "구매 완료",
    env: "ALIMTALK_TPL_PURCHASE",
    text: "[소셜팩토리 건대]\n#{고객}님, 이용권 구매가 완료되었습니다.\n\n■ 이용권: #{이용권}\n■ 이용 기간: #{시작} ~ #{만료}\n■ 결제 금액: #{금액}원\n\n24시간 자유롭게 이용하실 수 있습니다.\n문의는 카카오톡 채널로 보내 주세요."
  },
  expire_soon: {
    title: "만료 예정",
    env: "ALIMTALK_TPL_EXPIRE",
    text: "[소셜팩토리 건대]\n#{고객}님, 이용권이 #{남은시간} 뒤 만료됩니다.\n\n■ 이용권: #{이용권}\n■ 만료: #{만료}\n\n계속 이용하시려면 매장 프론트에서 이용권을 구매해 주세요. 지금 이용권이 끝나는 시각부터 이어서 시작됩니다."
  }
};

export function render(kind, vars) {
  const t = TEMPLATES[kind];
  if (!t) return "";
  return t.text.replace(/#\{([^}]+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
}

const PROVIDERS = {
  async webhook(env, job, text, vars) {
    if (!env.ALIMTALK_WEBHOOK_URL) throw new Error("ALIMTALK_WEBHOOK_URL 없음");
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(env.ALIMTALK_WEBHOOK_URL, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", ...(env.ALIMTALK_WEBHOOK_TOKEN ? { Authorization: "Bearer " + env.ALIMTALK_WEBHOOK_TOKEN } : {}) },
        body: JSON.stringify({ id: job.dedupe_key, to: job.phone, kind: job.kind, templateCode: env[TEMPLATES[job.kind].env] || "", text, variables: vars })
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
  // 'sending' 에서 10분 넘게 멈춘 건은 다시 대기열로 (발송 중 오류로 끊긴 경우)
  await env.DB.prepare("UPDATE notification_jobs SET status = 'queued' WHERE status = 'sending' AND updated_at < datetime('now', '+9 hours', '-10 minutes')").run().catch(() => {});
  // 알림 수신을 거부한 고객의 대기 알림은 보내지 않습니다
  await env.DB.prepare("UPDATE notification_jobs SET status = 'cancelled', last_error = '수신 거부', updated_at = datetime('now', '+9 hours') WHERE status = 'queued' AND customer_id IN (SELECT id FROM customers WHERE notify_off = 1)").run().catch(() => {});
  await cleanup(env).catch((e) => console.error("cleanup", e && e.message));
  const { results } = await env.DB.prepare("SELECT * FROM notification_jobs WHERE status = 'queued' AND send_after <= ?1 ORDER BY send_after LIMIT ?2").bind(now, limit).all();
  const provider = String(env.ALIMTALK_PROVIDER || "").trim();
  const out = { ok: true, picked: results.length, sent: 0, logged: 0, failed: 0, retry: 0, provider: provider || "log" };
  for (const job of results) {
    // 먼저 '보내는 중'으로 잡아 둔 것만 보냅니다 (동시에 돈 다른 발송기와 겹치지 않게)
    const claim = await env.DB.prepare("UPDATE notification_jobs SET status = 'sending', attempts = attempts + 1, updated_at = datetime('now', '+9 hours') WHERE id = ?1 AND status = 'queued'").bind(job.id).run();
    if (!claim.meta || !claim.meta.changes) continue;
    let vars = {}; try { vars = JSON.parse(job.vars || "{}"); } catch {}
    const text = render(job.kind, vars);
    if (!provider) {
      await env.DB.prepare("UPDATE notification_jobs SET status = 'logged', rendered = ?1, provider = 'log', updated_at = datetime('now', '+9 hours') WHERE id = ?2").bind(text, job.id).run();
      out.logged++; continue;
    }
    try {
      const send = PROVIDERS[provider];
      if (!send) throw new Error("알 수 없는 발송 방식: " + provider);
      const r = await send(env, job, text, vars);
      await env.DB.prepare("UPDATE notification_jobs SET status = 'sent', rendered = ?1, provider = ?2, provider_msg_id = ?3, sent_at = datetime('now', '+9 hours'), last_error = NULL, updated_at = datetime('now', '+9 hours') WHERE id = ?4")
        .bind(text, provider, (r && r.messageId) || null, job.id).run();
      out.sent++;
    } catch (e) {
      const tries = (job.attempts || 0) + 1, wait = RETRY_MIN[tries - 1];
      const msg = String((e && e.message) || e).slice(0, 300);
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
