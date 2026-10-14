/**
 * 주문 · 결제 공통 도구 (KG이니시스 표준결제 PC · 모바일)
 * ------------------------------------------------------------------
 * Cloudflare Pages 설정값
 *  - INICIS_MID             : 상점 아이디 (심사 기간에는 KG이니시스가 준 테스트 MID)
 *  - INICIS_SIGN_KEY        : 웹결제 Sign Key (PC 결제)
 *  - INICIS_MOBILE_HASH_KEY : 모바일 결제 위변조 Hash Key (모바일 결제) — 없으면 모바일도 PC 결제창을 씁니다
 *  - INICIS_TEST            : "1" 이면 화면에 '테스트 결제' 표시
 * 세 값이 없으면 상품은 보이되 결제 버튼 대신 '결제 준비 중' 안내가 나옵니다.
 */
import { PRODUCT_MAP } from "./products.js";

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
export const sha512b64 = async (s) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-512", enc.encode(s)))));

export function payConfig(env) {
  const mid = (env.INICIS_MID || "").trim(), signKey = (env.INICIS_SIGN_KEY || "").trim(), mobileKey = (env.INICIS_MOBILE_HASH_KEY || "").trim();
  return { ready: !!(mid && signKey), mid, signKey, mobileKey, test: env.INICIS_TEST === "1" || /test/i.test(mid) };
}

/* 주문번호: SF + 년월일시분초 + 무작위 4자 (이니시스 oid 규칙: 영문·숫자·-_ 40자 이내) */
export function makeOid() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const ymd = String(d.getUTCFullYear()).slice(2) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const r = crypto.getRandomValues(new Uint8Array(4));
  let code = ""; for (const b of r) code += abc[b % abc.length];
  return "SF" + ymd + code;
}

/* 주문 조회 토큰 — 주문번호를 아는 사람이 아무나 내역을 못 보게 서명한 값 */
export async function orderToken(env, oid) {
  return (await sha256("order|" + oid + "|" + (env.SESSION_SECRET || env.INICIS_SIGN_KEY || "socialfactory"))).slice(0, 20);
}

export const priceOf = (productId, qty) => { const p = PRODUCT_MAP[productId]; return p ? p.price * qty : 0; };

/* PC 결제창 스크립트 주소 — 테스트 MID 는 테스트(stg) 서버, 실제 MID 는 운영 서버 */
export const pcJsUrl = (cfg) => cfg.test ? "https://stgstdpay.inicis.com/stdjs/INIStdPay.js" : "https://stdpay.inicis.com/stdjs/INIStdPay.js";

/* 결제창 요청값 — PC(웹표준) */
export async function pcPayFields(cfg, order, origin) {
  const timestamp = String(Date.now());
  const price = String(order.amount);
  return {
    version: "1.0", gopaymethod: order.pay_method === "bank" ? "DirectBank" : "Card", mid: cfg.mid, oid: order.oid, price, timestamp, use_chkfake: "Y",
    signature: await sha256(`oid=${order.oid}&price=${price}&timestamp=${timestamp}`),
    verification: await sha256(`oid=${order.oid}&price=${price}&signKey=${cfg.signKey}&timestamp=${timestamp}`),
    mKey: await sha256(cfg.signKey),
    currency: "WON", goodname: order.product_name.slice(0, 80), buyername: order.buyer_name.slice(0, 30),
    buyertel: order.buyer_phone.slice(0, 20), buyeremail: (order.buyer_email || "").slice(0, 100),
    returnUrl: origin + "/api/pay/inicis/return", closeUrl: origin + "/api/pay/inicis/close",
    acceptmethod: "below1000:HPP(1):va_receipt:centerCd(Y)", charset: "UTF-8", payViewType: "overlay", languageView: "ko",
    merchantData: order.oid
  };
}

/* 결제창 요청값 — 모바일 */
export async function mobilePayFields(cfg, order, origin) {
  const ts = String(Date.now());
  return {
    action: "https://mobile.inicis.com/smart/payment/",
    fields: {
      P_INI_PAYMENT: order.pay_method === "bank" ? "BANK" : "CARD", P_MID: cfg.mid, P_OID: order.oid, P_AMT: String(order.amount), P_GOODS: order.product_name.slice(0, 80),
      P_UNAME: order.buyer_name.slice(0, 30), P_MOBILE: order.buyer_phone.slice(0, 20), P_EMAIL: (order.buyer_email || "").slice(0, 100),
      P_NEXT_URL: origin + "/api/pay/inicis/mobile", P_CHARSET: "utf8", P_TIMESTAMP: ts,
      P_CHKFAKE: await sha512b64(String(order.amount) + order.oid + ts + cfg.mobileKey),
      P_RESERVED: "centerCd=Y&amt_hash=Y&below1000=Y", P_NOTI: order.oid
    }
  };
}

/* 승인요청 · 망취소 공통 (PC) */
export async function pcAuthFields(cfg, authToken) {
  const timestamp = String(Date.now());
  return {
    mid: cfg.mid, authToken, timestamp, charset: "UTF-8", format: "JSON",
    signature: await sha256(`authToken=${authToken}&timestamp=${timestamp}`),
    verification: await sha256(`authToken=${authToken}&signKey=${cfg.signKey}&timestamp=${timestamp}`)
  };
}

/* 이니시스 응답 주소 검증: *.inicis.com 이고 idc_name 과 맞아야 한다 */
export function validInicisUrl(url, idc) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !/\.inicis\.com$/.test(u.hostname)) return false;
    if (idc && !u.hostname.startsWith(idc)) return false;
    return true;
  } catch { return false; }
}

export async function postForm(url, fields, env) {
  const body = new URLSearchParams(fields);
  // INICIS_DEV_PROXY 는 개발용 흉내 서버 주소 (로컬 테스트 전용 — 운영 설정에는 넣지 않습니다)
  const target = env && env.INICIS_DEV_PROXY ? env.INICIS_DEV_PROXY + "?to=" + encodeURIComponent(url) : url;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(target, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", Accept: "*/*" }, body, signal: ctrl.signal });
    return await r.text();
  } finally { clearTimeout(t); }
}
export const parseNvp = (s) => Object.fromEntries(new URLSearchParams(s));

export const PAY_METHOD = { Card: "신용 · 체크카드", DirectBank: "실시간 계좌이체", VBank: "가상계좌", HPP: "휴대폰", Kakaopay: "카카오페이", NaverPay: "네이버페이", Samsungpay: "삼성페이", Payco: "페이코", "0": "신용 · 체크카드", "1": "계좌이체", "2": "가상계좌", "3": "휴대폰" };

/* 간단한 HTML 응답 (결제창 안에서 열리므로 맨 위 창을 이동시킨다) */
export function htmlRedirect(to, note) {
  const safe = String(to).replace(/[<>"']/g, "");
  return new Response(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>결제 처리 중</title><meta name="robots" content="noindex"></head><body style="font-family:sans-serif;padding:24px;color:#18233A">${note || "결제 결과를 확인하고 있습니다…"}<script>try{if(window.top&&window.top!==window){window.top.location.href=${JSON.stringify(safe)};}else{location.href=${JSON.stringify(safe)};}}catch(e){location.href=${JSON.stringify(safe)};}</script><noscript><a href="${safe}">계속</a></noscript></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

export async function notify(env, text) {
  if (!env.NOTIFY_WEBHOOK) return "skipped";
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(env.NOTIFY_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }), signal: ctrl.signal });
    return r.ok ? "sent" : "failed:" + r.status;
  } catch (e) { return "failed:" + (e && e.name === "AbortError" ? "timeout" : "network"); } finally { clearTimeout(t); }
}

export const ORDER_STATUS = { pending: "결제 대기", paid: "결제 완료", used: "이용 완료", cancelled: "취소", refund_requested: "환불 요청", refunded: "환불 완료", failed: "결제 실패" };
