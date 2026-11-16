// 소셜팩토리 전용 템플릿. 메가스팟의 코드는 다른 채널이므로 재사용하지 않습니다.
const buttons={button:[{name:'주차권 내역 확인',linkType:'WL',linkMo:'https://socialfactory.co.kr/parking-order?oid=#{주문번호}&t=#{주문토큰}',linkPc:'https://socialfactory.co.kr/parking-order?oid=#{주문번호}&t=#{주문토큰}'},{name:'카카오톡 문의',linkType:'WL',linkMo:'https://pf.kakao.com/_uTiFX/chat',linkPc:'https://pf.kakao.com/_uTiFX/chat'}]};
export const PARKING_TEMPLATES={
 paid:{title:'주차권 결제 완료',env:'ALIMTALK_TPL_PARKING_PAID',code:'UN_3127',name:'소셜팩토리_주차권_결제완료_v1',text:'[소셜팩토리 건대] 주차권 결제 완료\n\n주차권 결제가 완료되었습니다.\n\n■ 주문번호: #{주문번호}\n■ 차량 끝번호: #{차량끝번호}\n■ 이용일: #{이용일}\n■ 주차권: #{주차권}\n■ 결제금액: #{결제금액}원\n\n결제만으로 주차 할인이 적용되지는 않습니다.\n입차 후 아래 구매 내역에서 ‘입차했어요 · 등록 요청’을 눌러 주세요.\n\n#{운영안내}\n등록 완료를 확인하고 출차해 주세요.',buttons},
 arrival:{title:'주차 등록 요청 접수',env:'ALIMTALK_TPL_PARKING_ARRIVAL',code:'UN_3130',name:'소셜팩토리_주차권_입차접수_v1',text:'[소셜팩토리 건대] 주차 등록 요청 접수\n\n입차 알림이 접수되었습니다.\n운영자가 입차 기록을 확인하고 주차권을 등록합니다.\n\n■ 주문번호: #{주문번호}\n■ 차량 끝번호: #{차량끝번호}\n■ 주차권: #{주차권}\n■ 접수일시: #{처리일시}\n\n현재는 등록 완료 전입니다.\n#{운영안내}\n구매 내역에서 등록 완료를 확인하고 출차해 주세요.',buttons},
 applied:{title:'주차 할인 적용 완료',env:'ALIMTALK_TPL_PARKING_APPLIED',code:'UN_3131',name:'소셜팩토리_주차권_등록완료_v1',text:'[소셜팩토리 건대] 주차 할인 적용 완료\n\n구매하신 주차권을 주차 시스템에 등록했습니다.\n\n■ 주문번호: #{주문번호}\n■ 차량 끝번호: #{차량끝번호}\n■ 이용일: #{이용일}\n■ 주차권: #{주차권}\n■ 등록일시: #{처리일시}\n\n출차 시 적용 내역을 확인해 주세요.\n구매하신 주차권 적용 범위를 초과한 추가 요금은 현장에서 정산해 주세요.\n적용 내역이 다르면 출차 정산 전에 카카오톡으로 문의해 주세요.',buttons},
 refund:{title:'주차권 취소·환불 안내',env:'ALIMTALK_TPL_PARKING_REFUND',code:'UN_3132',name:'소셜팩토리_주차권_환불완료_v1',text:'[소셜팩토리 건대] 주차권 취소·환불 안내\n\n주차권 결제의 환불 처리가 반영되었습니다.\n\n■ 주문번호: #{주문번호}\n■ 차량 끝번호: #{차량끝번호}\n■ 최초 결제금액: #{결제금액}원\n■ 누적 환불금액: #{누적환불금액}원\n■ 남은 결제금액: #{남은결제금액}원\n\n실제 환급·한도 복원 시점은 결제수단에 따라 다를 수 있습니다.\n주차장 할인 등록 상태와 현장 추가 요금은 별도 확인이 필요할 수 있습니다.\n구매 내역을 확인하시거나 카카오톡으로 문의해 주세요.',buttons}
};

// 새 안내는 카카오 승인 후 자동 선택합니다. 기존 승인본은 검수 중 발송을 유지합니다.
export const AUTOMATIC_PARKING_TEMPLATES={
 paid:{...PARKING_TEMPLATES.paid,env:'ALIMTALK_TPL_PARKING_PAID_AUTO',code:'UN_7420',name:'소셜팩토리_주차권_결제완료_자동등록_v2',text:PARKING_TEMPLATES.paid.text.replace('결제만으로 주차 할인이 적용되지는 않습니다.\n입차 후 아래 구매 내역에서 ‘입차했어요 · 등록 요청’을 눌러 주세요.','결제 승인 후 이용일 당일 실제 입차를 확인해 아마노에 자동 등록합니다.\n아직 입차 전이면 1분마다 입차 여부를 다시 확인합니다.\n‘입차했어요’ 버튼을 누르지 않아도 자동 처리되며, 버튼을 누르면 즉시 재확인을 요청할 수 있습니다.')},
 arrival:{...PARKING_TEMPLATES.arrival,env:'ALIMTALK_TPL_PARKING_ARRIVAL_AUTO',code:'UN_7421',name:'소셜팩토리_주차권_입차확인_자동등록_v2',text:PARKING_TEMPLATES.arrival.text.replace('입차 알림이 접수되었습니다.\n운영자가 입차 기록을 확인하고 주차권을 등록합니다.','입차 확인 요청이 접수되었습니다.\n결제 승인 후 실제 입차를 확인해 아마노에 자동 등록합니다.\n아직 입차 전이면 1분마다 입차 여부를 다시 확인합니다.\n‘입차했어요’ 버튼을 누르지 않아도 자동 처리됩니다.')}
};
