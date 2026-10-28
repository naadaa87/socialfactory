/**
 * 소셜팩토리 알림 발송기 (Cloudflare Worker · Cron Trigger)
 * ------------------------------------------------------------------
 * Pages Functions 에는 정해진 시각에 저절로 도는 기능이 없어, 이 작은 Worker 가 5분마다 홈페이지의
 * /api/notify/run 을 불러 '보낼 때가 된 알림'(구매 · 만료 · 연장 · 환불)을 보내게 합니다. 발송 내용은 모두 홈페이지 쪽 코드에 있습니다.
 *
 * 설정 (Cloudflare 대시보드 → Workers & Pages → 이 Worker → Settings)
 *  - Variables: SITE_URL = https://socialfactory.co.kr  (끝에 / 없이)
 *  - Secret   : CRON_KEY = Pages 프로젝트에 넣은 CRON_KEY 와 같은 값
 *  - Triggers → Cron Triggers: 5분마다 (wrangler.toml 의 crons 값)
 */
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  // 브라우저로 Worker 주소를 열면 마지막 실행 결과 대신 간단한 안내만 보여 줍니다 (발송은 하지 않음)
  async fetch() {
    return new Response("socialfactory notify-cron: scheduled only", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
};

async function run(env) {
  if (!env.SITE_URL || !env.CRON_KEY) { console.error("SITE_URL 또는 CRON_KEY 가 없습니다"); return; }
  const r = await fetch(env.SITE_URL.replace(/\/+$/, "") + "/api/notify/run", { method: "POST", headers: { "X-Cron-Key": env.CRON_KEY } });
  console.log("notify-run", r.status, (await r.text()).slice(0, 300));
}
