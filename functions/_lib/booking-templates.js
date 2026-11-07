const details = 'https://socialfactory.co.kr/booking-status?code=#{예약번호}&t=#{조회키}';
const buttons = {button:[{name:'예약 상세 보기',linkType:'WL',linkMo:details,linkPc:details}]};
const schedule = '예약번호: #{예약번호}\n공간: #{공간}\n이용 일시: #{이용일시}';
const timing = '실제 환급 및 카드 한도 복원 시점은 결제수단에 따라 다를 수 있습니다.';
const template = (title,name,env,code,text) => ({title,name,env,code,buttons,text:'[소셜팩토리 건대] '+title+'\n\n'+text});

export const BOOKING_TEMPLATES = {
  confirmed:template('공간대관 예약 확정','소셜팩토리_공간대관_예약확정_v1','BOOKING_ALIMTALK_CONFIRMED','UN_4601','결제가 완료되어 예약이 확정되었습니다.\n\n'+schedule+'\n이용 인원: #{인원}명\n결제금액: #{결제금액}원\n\n입실 및 이용 안내는 예약 상세에서 확인해 주세요.'),
  cancelled:template('공간대관 예약 취소','소셜팩토리_공간대관_예약취소_v1','BOOKING_ALIMTALK_CANCELLED','UN_4602','공간대관 예약이 취소되었습니다.\n\n'+schedule+'\n환불금액: #{환불금액}원\n\n'+timing),
  partial:template('공간대관 부분환불 안내','소셜팩토리_공간대관_부분환불_v1','BOOKING_ALIMTALK_PARTIAL','UN_4603','부분환불이 처리되었습니다. 아래 일정의 예약은 유지됩니다.\n\n'+schedule+'\n누적 환불금액: #{환불금액}원\n남은 결제금액: #{남은금액}원\n\n'+timing)
};
