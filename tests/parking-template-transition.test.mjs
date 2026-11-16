import test from 'node:test';
import assert from 'node:assert/strict';
import {parkingDeliveryTemplate} from '../functions/_lib/parking-notify.js';
import {PARKING_TEMPLATES,AUTOMATIC_PARKING_TEMPLATES} from '../functions/_lib/parking-templates.js';
test('검수 중 기존 승인본을 유지하고 본문·버튼이 일치하는 승인본만 자동 전환',async()=>{
 const original=globalThis.fetch;
 try{
  let status='REQ',mismatch=false;
  globalThis.fetch=async(_url,options)=>{const code=options.body.get('tpl_code');const t=Object.values(AUTOMATIC_PARKING_TEMPLATES).find(t=>t.code===code);return Response.json({code:0,list:[{templtCode:code,inspStatus:status,status:'A',templtContent:mismatch?'다른 본문':t.text,buttons:t.buttons.button}]});};
  assert.equal(await parkingDeliveryTemplate({ALIGO_SENDER_KEY:'pending-test'},'paid'),PARKING_TEMPLATES.paid);
  status='APR';
  assert.equal(await parkingDeliveryTemplate({ALIGO_SENDER_KEY:'approved-test'},'paid'),AUTOMATIC_PARKING_TEMPLATES.paid);
  assert.equal(await parkingDeliveryTemplate({ALIGO_SENDER_KEY:'approved-arrival'},'arrival'),AUTOMATIC_PARKING_TEMPLATES.arrival);
  mismatch=true;
  assert.equal(await parkingDeliveryTemplate({ALIGO_SENDER_KEY:'mismatch-test'},'paid'),PARKING_TEMPLATES.paid);
  assert.equal(await parkingDeliveryTemplate({},'applied'),PARKING_TEMPLATES.applied);
 }finally{globalThis.fetch=original;}
});
