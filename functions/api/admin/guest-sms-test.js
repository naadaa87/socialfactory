import {json} from '../../_lib/auth.js';
import {adminGate} from '../../_lib/admin.js';
import {sendGuestSms} from '../../_lib/guest-sms.js';
export async function onRequestPost({request,env}){const deny=await adminGate(request,env);if(deny)return deny;try{await sendGuestSms(env,'01000000000','000000',{test:true});return json({ok:true,test:true,message:'인증 문자 API 테스트 성공 (실제 발송 없음)'})}catch(e){return json({ok:false,test:true,error:'sms-test',providerCode:e.providerCode||null,message:'인증 문자 API 설정 또는 중계 경로 확인 필요'},502)}}
