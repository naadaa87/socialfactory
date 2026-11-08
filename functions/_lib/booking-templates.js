const details = 'https://socialfactory.co.kr/booking-status?code=#{예약번호}&t=#{조회키}';
const webButton = (name, url) => ({button:[{name,linkType:'WL',linkMo:url,linkPc:url}]});
const buttons = webButton('예약 상세 보기', details);
const schedule = '예약번호: #{예약번호}\n공간: #{공간}\n이용 일시: #{이용일시}';
const timing = '실제 환급 및 카드 한도 복원 시점은 결제수단에 따라 다를 수 있습니다.';
const template = (title,name,env,code,text,links=buttons) => ({title,name,env,code,buttons:links,text:'[소셜팩토리 건대] '+title+'\n\n'+text});

export const BOOKING_TEMPLATES = {
  received:template('공간대관 신청 접수','소셜팩토리_공간대관_신청접수_v1','BOOKING_ALIMTALK_RECEIVED',null,
    '공간대관 신청이 접수되었습니다. 일정 확인 후 결제 방법을 안내해 드립니다.\n\n'+schedule+'\n\n예약은 결제와 최종 일정 확인 후 확정됩니다.',
    webButton('예약 문의', 'https://socialfactory.co.kr/contact#inquiry')),
  payment_ready:template('공간대관 결제 안내','소셜팩토리_공간대관_결제안내_v1','BOOKING_ALIMTALK_PAYMENT_READY',null,
    '신청하신 공간대관의 결제가 가능합니다.\n\n'+schedule+'\n결제금액: #{결제금액}원\n결제 기한: #{결제기한}\n\n아래에서 예약 내용을 확인한 뒤 기한 내에 결제해 주세요. 이미 결제하셨다면 다시 결제하지 않으셔도 됩니다.',
    webButton('예약 확인 및 결제', details)),
  unpaid_expired:template('공간대관 신청 만료','소셜팩토리_공간대관_미결제만료_v1','BOOKING_ALIMTALK_UNPAID_EXPIRED',null,
    '기한 내 결제가 확인되지 않아 공간대관 신청이 만료되었습니다.\n\n'+schedule+'\n\n다시 신청하시려면 예약 가능 시간을 확인해 주세요.',
    webButton('예약 가능 시간 확인', 'https://socialfactory.co.kr/booking')),
  confirmed:template('공간대관 예약 확정','소셜팩토리_공간대관_예약확정_v1','BOOKING_ALIMTALK_CONFIRMED','UN_4601','결제가 완료되어 예약이 확정되었습니다.\n\n'+schedule+'\n이용 인원: #{인원}명\n결제금액: #{결제금액}원\n\n입실 및 이용 안내는 예약 상세에서 확인해 주세요.'),
  cancelled:template('공간대관 예약 취소','소셜팩토리_공간대관_예약취소_v1','BOOKING_ALIMTALK_CANCELLED','UN_4602','공간대관 예약이 취소되었습니다.\n\n'+schedule+'\n환불금액: #{환불금액}원\n\n'+timing),
  partial:template('공간대관 부분환불 안내','소셜팩토리_공간대관_부분환불_v1','BOOKING_ALIMTALK_PARTIAL','UN_4603','부분환불이 처리되었습니다. 아래 일정의 예약은 유지됩니다.\n\n'+schedule+'\n누적 환불금액: #{환불금액}원\n남은 결제금액: #{남은금액}원\n\n'+timing)
};
