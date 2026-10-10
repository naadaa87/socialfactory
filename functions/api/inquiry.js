/**
 * 소셜팩토리 문의 API — Cloudflare Pages Functions
 * ------------------------------------------------------------------
 * POST  /api/inquiry : 문의 저장 (D1 바인딩 DB 필요) → 접수번호 반환 → 운영자 알림(선택)
 * GET   /api/inquiry : 최근 문의 200건 조회 (관리자용, Authorization: Bearer ADMIN_KEY)
 * PATCH /api/inquiry : 처리 상태 변경 (관리자용) { id, status }
 *
 * 설정 (Cloudflare Pages → Settings → Bindings / Variables and Secrets)
 *  - D1 database binding : 이름 "DB"  (schema.sql 로 테이블 생성)
 *  - ADMIN_KEY           : 관리자 조회용 비밀 키 (admin.html 에서 입력). URL 에 넣지 않고 헤더로만 받습니다.
 *  - NOTIFY_WEBHOOK      : 새 문의를 JSON 으로 전송할 웹훅 주소 (선택, Slack · Discord · Make 등)
 *  - IP_SALT             : IP 해시에 섞는 임의 문자열 (선택, 권장)
 *
 * 저장에 성공했을 때만 { ok: true, receipt } 를 돌려줍니다. 알림 실패는 접수와 별개로 기록합니다.
 * 오류 응답에는 내부 상세(DB 메시지 등)를 담지 않습니다.
 */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }
  });

const clean = (v, max = 500) => (typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "");

const PURPOSES = ["rental", "regular", "business", "coworking", "office", "partner", "proposal", "other"];
const SPACES = ["r1", "r2", "r3", "r4", "r5", "coworking", "office", "undecided", ""];
const STATUSES = ["new", "in_progress", "done"];

const PURPOSE_LABEL = {
  rental: "공간 대관", regular: "반복 모임·정기대관", business: "기업·단체 이용", coworking: "코워킹 이용권",
  office: "독립사무실 이용권", partner: "제휴·협력·파트너", proposal: "공간 제안", other: "기타"
};
const SPACE_LABEL = { r1: "1번룸", r2: "2번룸", r3: "3번룸", r4: "4번룸", r5: "5번룸", coworking: "코워킹", office: "독립사무실", undecided: "아직 정하지 못함", "": "-" };

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeReceipt() {
  const d = new Date(Date.now() + 9 * 3600 * 1000); // KST
  const ymd = String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let code = "";
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return `SF-${ymd}-${code}`;
}

function isAdmin(request, env) {
  if (!env.ADMIN_KEY) return false;
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  const headerKey = request.headers.get("x-admin-key") || "";
  return bearer === env.ADMIN_KEY || headerKey === env.ADMIN_KEY;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  if (!body || typeof body !== "object") return json({ ok: false, error: "bad-json" }, 400);

  // 스팸 봇은 조용히 통과시킨 것처럼 응답 (저장하지 않음)
  if (clean(body.website)) return json({ ok: true, receipt: "SF-000000-0000", spam: true });

  const phoneRaw = clean(body.phone, 40);
  const phoneDigits = phoneRaw.replace(/[^0-9]/g, "");
  const email = clean(body.email, 120);
  const purpose = clean(body.purpose, 20);
  const space = clean(body.space, 20);
  const row = {
    submission_id: clean(body.submissionId, 64),
    purpose,
    space,
    name: clean(body.name, 80),
    phone: phoneRaw,
    email,
    company: clean(body.company, 120),
    when_text: clean(body.when, 160),
    people: clean(body.people, 40),
    schedule: clean(body.schedule, 200),
    message: clean(body.message, 3000),
    consent: body.consent === true || body.consent === "true" || body.consent === 1 ? 1 : 0,
    notice_version: clean(body.noticeVersion, 20),
    page: clean(body.page, 300)
  };

  const errors = [];
  if (!row.name) errors.push("name");
  if (phoneDigits.length < 9 || phoneDigits.length > 15) errors.push("phone");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push("email");
  if (!PURPOSES.includes(row.purpose)) errors.push("purpose");
  if (!SPACES.includes(row.space)) errors.push("space");
  if (!row.message) errors.push("message");
  if (row.purpose === "business" && !email) errors.push("email");
  if (!row.consent) errors.push("consent");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(row.submission_id)) errors.push("submissionId");
  if (errors.length) return json({ ok: false, error: "invalid", fields: errors }, 400);

  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);

  const ip = request.headers.get("cf-connecting-ip") || "";
  const ipHash = ip ? (await sha256Hex(ip + "|" + (env.IP_SALT || "socialfactory"))).slice(0, 24) : "";

  // 같은 제출값이 이미 저장돼 있으면 (재시도 · 중복 클릭) 같은 접수번호를 돌려준다
  try {
    const dup = await env.DB.prepare("SELECT receipt FROM inquiries WHERE submission_id = ?1").bind(row.submission_id).first();
    if (dup && dup.receipt) return json({ ok: true, receipt: dup.receipt, duplicate: true });
  } catch (e) { console.error("dup-check", e && e.message); }

  // 같은 접속에서 10분 안에 5건 넘게 들어오면 잠시 막는다
  if (ipHash) {
    try {
      const r = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM inquiries WHERE ip_hash = ?1 AND created_at > datetime('now', '+9 hours', '-10 minutes')"
      ).bind(ipHash).first();
      if (r && Number(r.n) >= 5) return json({ ok: false, error: "too-many" }, 429);
    } catch (e) { console.error("rate-check", e && e.message); }
  }

  let receipt = "";
  let inserted = false;
  for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
    receipt = makeReceipt();
    try {
      await env.DB.prepare(
        `INSERT INTO inquiries (receipt, submission_id, purpose, space, name, phone, email, company, when_text, people, schedule, message, consent, notice_version, page, ip_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`
      ).bind(receipt, row.submission_id, row.purpose, row.space, row.name, row.phone, row.email, row.company, row.when_text,
        row.people, row.schedule, row.message, row.consent, row.notice_version, row.page, ipHash).run();
      inserted = true;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (/UNIQUE/i.test(msg) && /submission_id/i.test(msg)) {
        const dup = await env.DB.prepare("SELECT receipt FROM inquiries WHERE submission_id = ?1").bind(row.submission_id).first().catch(() => null);
        if (dup && dup.receipt) return json({ ok: true, receipt: dup.receipt, duplicate: true });
      }
      if (/UNIQUE/i.test(msg) && /receipt/i.test(msg)) continue; // 접수번호 충돌 → 다시 생성
      console.error("insert", msg);
      return json({ ok: false, error: "db-error" }, 500);
    }
  }
  if (!inserted) return json({ ok: false, error: "db-error" }, 500);

  // 운영자 알림 (실패해도 접수는 유효 · 결과를 기록)
  let notifyStatus = "skipped";
  if (env.NOTIFY_WEBHOOK) {
    const text = [
      `[소셜팩토리 문의 ${receipt}] ${PURPOSE_LABEL[row.purpose] || row.purpose} · ${SPACE_LABEL[row.space] || "-"}`,
      `이름: ${row.name}`, `연락처: ${row.phone}`, `이메일: ${row.email || "-"}`,
      row.company ? `회사·단체: ${row.company}` : null,
      `희망 일시: ${row.when_text || "-"}`, `인원: ${row.people || "-"}`,
      row.schedule ? `정기 일정: ${row.schedule}` : null,
      "", row.message
    ].filter((l) => l !== null).join("\n");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(env.NOTIFY_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, content: text, receipt, purpose: row.purpose, space: row.space, name: row.name, phone: row.phone, email: row.email, when: row.when_text, people: row.people, schedule: row.schedule, message: row.message }),
        signal: ctrl.signal
      });
      notifyStatus = res.ok ? "sent" : `failed:${res.status}`;
    } catch (e) {
      notifyStatus = "failed:" + (e && e.name === "AbortError" ? "timeout" : "network");
    } finally { clearTimeout(timer); }
  }
  try { await env.DB.prepare("UPDATE inquiries SET notify_status = ?1 WHERE receipt = ?2").bind(notifyStatus, receipt).run(); } catch (e) { console.error("notify-status", e && e.message); }

  return json({ ok: true, receipt, notified: notifyStatus === "sent" });
}

export async function onRequestGet({ request, env }) {
  if (!isAdmin(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
  try {
    const stmt = STATUSES.includes(status)
      ? env.DB.prepare("SELECT id, receipt, created_at, status, purpose, space, name, phone, email, company, when_text, people, schedule, message, consent, notice_version, page, notify_status FROM inquiries WHERE status = ?1 ORDER BY id DESC LIMIT ?2").bind(status, limit)
      : env.DB.prepare("SELECT id, receipt, created_at, status, purpose, space, name, phone, email, company, when_text, people, schedule, message, consent, notice_version, page, notify_status FROM inquiries ORDER BY id DESC LIMIT ?1").bind(limit);
    const { results } = await stmt.all();
    return json({ ok: true, count: results.length, results });
  } catch (e) {
    console.error("list", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}

export async function onRequestPatch({ request, env }) {
  if (!isAdmin(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.DB) return json({ ok: false, error: "no-db" }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad-json" }, 400); }
  const id = parseInt(body && body.id, 10);
  const status = clean(body && body.status, 20);
  if (!id || !STATUSES.includes(status)) return json({ ok: false, error: "invalid" }, 400);
  try {
    await env.DB.prepare("UPDATE inquiries SET status = ?1 WHERE id = ?2").bind(status, id).run();
    return json({ ok: true });
  } catch (e) {
    console.error("patch", e && e.message);
    return json({ ok: false, error: "db-error" }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: { "Allow": "GET, POST, PATCH, OPTIONS" } });
}
