/**
 * 토스프론트(현장 무인 결제)에서 파는 이용권
 * ------------------------------------------------------------------
 * 홈페이지 온라인 판매 상품(products.js)과 따로 관리합니다.
 * 이 목록은 D1 kiosk_products 표의 초기값이자 기존 결제의 조건 복구용입니다.
 * 운영 상품 등록·수정·노출은 관리자 '토스프론트 상품' 화면에서 합니다.
 * - id        : 바꾸지 않습니다 (결제 · 이용권 기록에 남는 값)
 * - price     : 실제 결제 금액
 * - listPrice : 할인 전 금액 (할인 상품만, 화면에 할인 표시용)
 * - duration  : 이용 기간 — { hours } · { days } · { months } 중 하나. 결제한 시각부터 시작합니다.
 *               months 는 '다음 달 같은 날 같은 시각'까지이고, 그 날이 없는 달은 그 달 마지막 날로 맞춥니다.
 * - group     : 같은 group 의 이용권은 한 고객 안에서 이어 붙습니다 (이용 중에 또 사면 지금 이용권이 끝나는 시각부터 시작)
 * - remind    : 만료 알림을 보낼 시점 — 만료 몇 분 전 (여러 개 가능). 이어 붙인 경우 마지막 만료 시각 기준입니다.
 * - image     : 프론트 화면 아이콘 (toss-front-plugin/images/ 안의 파일 이름)
 */
const H = 60, D = 24 * H;

export const KIOSK_PRODUCTS = [
  { id: "seat-2h",  name: "2시간권",      price: 4000,   duration: { hours: 2 },   group: "seat", remind: [20],        image: "pass-2h.webp",  short: "결제한 때부터 2시간" },
  { id: "seat-1d",  name: "1일권 (24시간)", price: 6000,   duration: { hours: 24 },  group: "seat", remind: [2 * H],     image: "pass-1d.webp",  short: "결제한 때부터 24시간" },
  { id: "seat-15d", name: "15일 이용권",   price: 55000,  duration: { days: 15 },   group: "seat", remind: [D],         image: "pass-15d.webp", short: "결제한 때부터 15일" },
  { id: "seat-1m",  name: "1개월 이용권",  price: 99000,  duration: { months: 1 },  group: "seat", remind: [3 * D, D],  image: "pass-1m.webp",  short: "다음 달 같은 날 같은 시각까지" },
  { id: "seat-3m",  name: "3개월 이용권",  price: 297000, duration: { months: 3 },  group: "seat", remind: [3 * D, D],  image: "pass-3m.webp",  short: "3개월 뒤 같은 날 같은 시각까지" },
  // 친구 동반 할인 — 친구와 함께 오면 각자 할인된 가격으로 한 장씩 삽니다 (현장 확인은 따로 하지 않음)
  { id: "seat-1m-friend", name: "1개월 이용권 (친구 동반 35% 할인)", price: 64350,  listPrice: 99000,  duration: { months: 1 }, group: "seat", remind: [3 * D, D], image: "pass-1m.webp", short: "친구와 함께 오면 각자 35% 할인", friend: true },
  { id: "seat-3m-friend", name: "3개월 이용권 (친구 동반 35% 할인)", price: 193050, listPrice: 297000, duration: { months: 3 }, group: "seat", remind: [3 * D, D], image: "pass-3m.webp", short: "친구와 함께 오면 각자 35% 할인", friend: true }
];

export const KIOSK_PRODUCT_MAP = Object.fromEntries(KIOSK_PRODUCTS.map((p) => [p.id, p]));

/* 부가세 포함 금액 → 부가세 · 공급가 (토스 예제와 같은 계산: 부가세 = 금액 ÷ 11 버림) */
export function splitVat(total) {
  const tax = Math.floor(total / 11);
  return { tax, supplyValue: total - tax };
}
