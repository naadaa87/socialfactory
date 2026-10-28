/** 알리고 알림톡 API: https://smartsms.aligo.in/alimapi.html
 * API의 성공은 발송 요청 접수입니다. 실제 도착 결과는 알리고 전송내역에서 확인합니다.
 * 응답을 받지 못한 요청은 접수됐을 수 있으므로 자동 재발송하지 않습니다.
 */
const ENDPOINT = "https://kakaoapi.aligo.in/akv10/alimtalk/send/";
const RELAY_ENDPOINT = "https://relay.naranhistory.com/socialfactory/aligo/send";

function deliveryTarget(env) {
  const url = String(env.ALIGO_RELAY_URL || "").trim();
  const secret = String(env.ALIGO_RELAY_SECRET || "");
  const headers = { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" };
  if (!url && !secret) return { url: ENDPOINT, headers };
  // 설정이 일부만 있거나 목적지가 다르면 인증정보를 보내지 않고 중단합니다.
  if (url.replace(/\/+$/, "") !== RELAY_ENDPOINT || !/^[A-Za-z0-9_-]{43,128}$/.test(secret)) {
    throw Object.assign(new Error("알리고 중계 URL·전용 인증키 설정 확인 필요"), { retryable: false });
  }
  headers.Authorization = "Bearer " + secret;
  return { url: RELAY_ENDPOINT, headers };
}

function safeTestReason(value, env) {
  let reason = String(value || "").slice(0, 180);
  for (const key of ["ALIGO_API_KEY", "ALIGO_SENDER_KEY", "ALIGO_USER_ID", "ALIGO_SENDER", "ALIGO_RELAY_SECRET"]) {
    if (env[key]) reason = reason.replaceAll(String(env[key]), "[가림]");
  }
  return reason.replace(/01[016789][- ]?\d{3,4}[- ]?\d{4}/g, "[전화번호]").replace(/[A-Za-z0-9_-]{32,}/g, "[가림]");
}

export async function sendAligo(env, job, message, template) {
  const required = ["ALIGO_API_KEY", "ALIGO_USER_ID", "ALIGO_SENDER_KEY", "ALIGO_SENDER"];
  for (const key of required) {
    if (!String(env[key] || "").trim()) throw Object.assign(new Error(key + " 설정 없음"), { retryable: false });
  }
  const sender = String(env.ALIGO_SENDER).replace(/\D/g, "");
  const receiver = String(job.phone || "").replace(/\D/g, "");
  if (!/^\d{8,16}$/.test(sender) || !/^01[016789]\d{7,8}$/.test(receiver)) {
    throw Object.assign(new Error("알리고 발신번호 또는 수신번호 형식 오류"), { retryable: false });
  }
  const testMode = String(env.ALIGO_TEST_MODE || "N").toUpperCase();
  if (!["Y", "N"].includes(testMode)) throw Object.assign(new Error("ALIGO_TEST_MODE 는 Y 또는 N"), { retryable: false });
  if (!String(env[template.env] || template.code || "").trim()) throw Object.assign(new Error("알림톡 템플릿 코드 없음"), { retryable: false });
  const form = new URLSearchParams({
    apikey: env.ALIGO_API_KEY, userid: env.ALIGO_USER_ID, senderkey: env.ALIGO_SENDER_KEY,
    tpl_code: env[template.env] || template.code, sender, receiver_1: receiver,
    subject_1: message.title, message_1: message.text, failover: "N", testMode
  });
  if (message.buttons) form.set("button_1", JSON.stringify(message.buttons));
  if (message.emtitle) form.set("emtitle_1", message.emtitle);
  const target = deliveryTarget(env);
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    let response, data;
    try {
      response = await fetch(target.url, {
        method: "POST", signal: ctrl.signal, redirect: "manual",
        headers: target.headers, body: form
      });
    } catch (e) {
      if (testMode === "Y") {
        const safe = value => safeTestReason(value, env).replace(/\b(apikey|senderkey|userid)=\S+/gi, "$1=[redacted]").slice(0, 160);
        console.error("aligo-connect", safe(e?.name), safe(e?.message), safe(e?.cause?.name), safe(e?.cause?.message));
      }
      throw Object.assign(new Error("알리고 연결 실패 — 전송내역 확인 후 수동 재시도"), { retryable: false });
    }
    if (response.status >= 300 && response.status < 400) {
      throw Object.assign(new Error("알리고 리다이렉트 응답 (HTTP " + response.status + ") — 전송내역 확인 후 수동 재시도"), { retryable: false });
    }
    try {
      data = await response.json();
    } catch {
      const type = String(response.headers.get("content-type") || "없음").slice(0, 60);
      throw Object.assign(new Error("알리고 응답 해석 실패 (HTTP " + response.status + ", 유형 " + type + ") — 전송내역 확인 후 수동 재시도"), { retryable: false });
    }
    if (!response.ok || !data || data.code === undefined || data.code === null || data.code === "") {
      throw Object.assign(new Error("알리고 응답 미확인 (HTTP " + response.status + ") — 전송내역 확인 후 수동 재시도"), { retryable: false });
    }
    if (Number(data.code) !== 0) {
      // 업체 응답에 전화번호나 인증정보가 섞여도 대기열 오류에 남기지 않습니다.
      const detail = testMode === "Y" ? safeTestReason(data.message, env) : "";
      throw new Error("알리고 요청 거절 (코드 " + String(data.code).slice(0, 12) + ")" + (detail ? ": " + detail : " — 알리고 전송내역·설정 확인"));
    }
    if (testMode === "Y") return { messageId: String(data.info?.mid || ""), test: true };
    if (!data.info?.mid || Number(data.info.scnt) !== 1 || Number(data.info.fcnt) !== 0) {
      throw Object.assign(new Error("알리고 접수 건수 미확인 — 전송내역 확인 후 수동 재시도"), { retryable: false });
    }
    return { messageId: String(data.info.mid) };
  } finally { clearTimeout(timer); }
}
