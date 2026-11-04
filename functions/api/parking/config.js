import {json} from '../../_lib/auth.js';
import {ensureParking,parkingSettings,operationText,TICKETS,PARKING_POLICY} from '../../_lib/parking.js';
import {payConfig} from '../../_lib/shop.js';
export async function onRequestGet({env}){if(!env.DB)return json({ok:false},503);await ensureParking(env);const s=await parkingSettings(env),pay=payConfig(env);return json({ok:true,ready:s.enabled&&s.confirmed&&pay.ready&&pay.provider==='payapp',confirmed:s.confirmed,operation:s.confirmed?operationText(s):'주차 등록 운영 조건을 확인 중입니다. 카카오톡으로 문의해 주세요.',dailyEnabled:s.daily_enabled,dailyDetails:s.daily_details,policy:PARKING_POLICY,tickets:Object.entries(TICKETS).map(([id,t])=>({id,...t,available:id!=='daily'||s.daily_enabled})),holidays:s.holidays});}
