import {json} from '../../_lib/auth.js';
import {adminGate} from '../../_lib/admin.js';
import {syncWebsiteOrders} from '../../_lib/website-passes.js';
export async function onRequestPost({request,env}){
 const deny=await adminGate(request,env);if(deny)return deny;
 try{return json({ok:true,...await syncWebsiteOrders(env)})}catch{return json({ok:false,error:'website-pass-sync',message:'홈페이지 이용권 등록을 완료하지 못했습니다. 잠시 후 새로고침해 주세요.'},500)}
}
