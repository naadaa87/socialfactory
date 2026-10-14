// 결제창 닫기 (closeUrl) — 결제창 안에서 열리며 부모 창의 결제창을 닫는다
export function onRequest() {
  return new Response(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>try{parent.INIStdPay.viewOff();}catch(e){try{window.top.location.reload();}catch(e2){}}</script></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
