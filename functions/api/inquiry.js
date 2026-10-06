/**
 * 소셜팩토리 문의 폼 API — Cloudflare Pages Functions
 * ------------------------------------------------------------------
 * POST /api/inquiry  : 문의 저장 (D1 바인딩 DB가 있을 때) + 웹훅 알림(선택)
 * GET  /api/inquiry  : 최근 문의 100건 조회 (?key=ADMIN_KEY)
 *
 * 설정 (Cloudflare Pages → Settings → Bindings / Variables)
 *  - D1 database binding  : 이름 "DB"  (schema.sql 로 테이블 생성)
 *  - 환경변수 ADMIN_KEY     : 조회용 비밀 키 (선택)
 *  - 환경변수 NOTIFY_WEBHOOK: 새 문의를 JSON으로 전송할 웹훅 주소 (선택, Slack·Discord·Make 등)
 *
 * DB 바인딩이 없으면 503 을 돌려주고, 홈페이지는 자동으로 메일 앱(mailto)으로 전환합니다.
 */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });

const clean = (v, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }

  if (clean(body.website)) return json({ ok: true, spam: true }); // 스팸 봇은 조용히 무시

  const row = {
    name: clean(body.name, 80),
    phone: clean(body.phone, 40),
    email: clean(body.email, 120),
    type: clean(body.type, 80),
    when_text: clean(body.when, 120),
    people: clean(body.people, 40),
    message: clean(body.message, 3000),
    page: clean(body.page, 300),
    ua: clean(request.headers.get("user-agent") || "", 300),
    ip: request.headers.get("cf-connecting-ip") || ""
  };
  if (!row.name || !row.phone || !row.message) return json({ ok: false, error: "missing-fields" }, 400);

  if (!env.DB) return json({ ok: false, reason: "no-db" }, 503);

  try {
    await env.DB.prepare(
      `INSERT INTO inquiries (name, phone, email, type, when_text, people, message, page, ua, ip)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    ).bind(row.name, row.phone, row.email, row.type, row.when_text, row.people, row.message, row.page, row.ua, row.ip).run();
  } catch (e) {
    return json({ ok: false, error: "db-error", detail: String(e && e.message || e) }, 500);
  }

  if (env.NOTIFY_WEBHOOK) {
    const text = [
      `[소셜팩토리 문의] ${row.type || "일반 문의"}`,
      `이름: ${row.name}`, `연락처: ${row.phone}`, `이메일: ${row.email || "-"}`,
      `희망 일시: ${row.when_text || "-"}`, `인원: ${row.people || "-"}`, "", row.message
    ].join("\n");
    try {
      await fetch(env.NOTIFY_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content: text, ...row })
      });
    } catch { /* 알림 실패는 접수 자체에 영향을 주지 않음 */ }
  }

  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, reason: "no-db" }, 503);
  const { results } = await env.DB.prepare(
    "SELECT id, created_at, name, phone, email, type, when_text, people, message, page FROM inquiries ORDER BY id DESC LIMIT 100"
  ).all();
  return json({ ok: true, count: results.length, results });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { "Allow": "GET, POST, OPTIONS" } });
}
