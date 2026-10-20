/* 소셜팩토리 토스프론트 플러그인 설정
   apiBase : 이용권 서버(홈페이지) 주소. 개발자센터 ACL 에도 같은 주소를 등록해야 호출됩니다.
   이 PC 에서 시험할 때(localhost)는 플러그인을 열어 준 로컬 서버 주소를 그대로 씁니다. */
window.SF_PLUGIN = {
  apiBase: /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? location.origin : "https://socialfactory.co.kr",
  storeName: "소셜팩토리 건대"
};
