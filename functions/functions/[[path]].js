// 서버 코드 폴더(/functions/...)를 주소로 열지 못하게 막는다
export function onRequest() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" } });
}
