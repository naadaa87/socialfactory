/* ==========================================================================
   소셜팩토리 홈페이지 설정 파일
   --------------------------------------------------------------------------
   연락처·예약 채널·운영 정보는 이 파일 한 곳만 고치면 모든 페이지에 반영됩니다.
   값이 비어 있으면("") 해당 버튼이나 문구는 화면에 나타나지 않습니다.
   GitHub에서 이 파일을 열어 연필 아이콘(Edit)으로 수정한 뒤 Commit 하면
   Cloudflare Pages가 자동으로 다시 배포합니다.
   ========================================================================== */

window.SF_CONFIG = {
  /* 배포 후 실제 주소로 바꿔 주세요. (예: https://socialfactory.pages.dev 또는 https://socialfactory.co.kr) */
  siteUrl: "https://socialfactory.pages.dev",

  brand: "소셜팩토리",
  branch: "소셜팩토리 건대",
  openLabel: "2026 OPEN",            /* 메인 상단 배너와 히어로에 쓰이는 오픈 표기 */

  /* 위치 */
  address: "서울 광진구 화양동 10-1 한아름건물 4층",
  addressShort: "화양동 10-1 한아름건물 4F",
  directions: "",                    /* 예: "지하철 2·7호선 건대입구역 2번 출구에서 도보 5분" — 확인 후 입력 */
  parking: "",                       /* 예: "건물 주차 불가, 인근 공영주차장 이용" — 확인 후 입력 */

  /* 운영 시간 */
  hours: {
    rooms: "예약제 · 예약한 시간에 맞춰 이용",
    coworking: "24시간",
    office: "24시간 출입"
  },

  /* 예약·문의 채널 — 주소가 비어 있으면 버튼이 숨겨집니다. */
  contact: {
    phone: "",                       /* 예: "010-0000-0000" */
    email: "",                       /* 예: "hello@socialfactory.co.kr" */
    kakao: "",                       /* 예: "https://pf.kakao.com/_xxxxx" */
    naver: "",                       /* 예: "https://booking.naver.com/booking/..." 또는 네이버 플레이스 주소 */
    spacecloud: "",                  /* 예: "https://www.spacecloud.kr/space/00000" */
    instagram: ""                    /* 예: "https://www.instagram.com/socialfactory.official" */
  },

  /* 운영 주체 — 채우면 푸터 하단에 표기됩니다. 비워 두면 '소셜팩토리'만 표기됩니다. */
  company: {
    name: "",                        /* 예: "주식회사 지유공간개발" */
    ceo: "",                         /* 예: "대표 최시준" */
    regNo: "",                       /* 예: "사업자등록번호 000-00-00000" */
    address: ""                      /* 예: "서울 광진구 ..." */
  },

  /* 요금 — show 를 true 로 바꾸고 문구를 채우면 공간 페이지에 요금 안내가 나타납니다. */
  pricing: {
    show: false,
    rooms: "",                       /* 예: "시간당 20,000원부터 (인원·시간대에 따라 다름)" */
    coworking: "",                   /* 예: "1일권 10,000원 · 월 이용권 120,000원" */
    office: ""                       /* 예: "월 450,000원부터 (관리비 포함)" */
  }
};
