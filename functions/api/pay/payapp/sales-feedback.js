import {payappConfig,validFeedback} from '../../../_lib/payapp.js';
import {ensurePayappSales,savePayappSales,payappTime} from '../../../_lib/payapp-sales.js';
const reply=(body,status=200)=>new Response(body,{status,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
export async function onRequestPost({request,env}){
  if(!env.DB)return reply('FAIL',503);
  if(Number(request.headers.get('content-length'))>32768)return reply('FAIL',413);
  const raw=await request.text();if(raw.length>32768)return reply('FAIL',413);
  const params=new URLSearchParams(raw);for(const key of params.keys())if(params.getAll(key).length!==1)return reply('FAIL',400);
  const f=Object.fromEntries(params),config=payappConfig(env);
  if(!await validFeedback(config,f))return reply('FAIL',403);
  if(!['1','4','8','16','31','32','9','64','10','70','71'].includes(f.pay_state))return reply('FAIL',400);
  const partial=['70','71'].includes(f.pay_state),cancel=['9','64'].includes(f.pay_state),amount=partial?f.orig_price:f.price;
  if(!/^\d+$/.test(amount||'')||(partial&&!/^\d+$/.test(f.price||'')))return reply('FAIL',400);
  try{
    await ensurePayappSales(env);
    await savePayappSales(env,[{sellerId:config.userid,mulNo:partial?f.orig_mul_no:f.mul_no,productName:f.goodname||'',state:cancel?'refunded':f.pay_state==='4'||partial?'paid':['8','16','31','32'].includes(f.pay_state)?'cancelled':'pending',amount:Number(amount),refundAmount:cancel?Number(amount):0,paidAt:payappTime(f.pay_date),requestedAt:payappTime(f.reqdate),approvalNo:partial?'':f.payauthcode||'',method:f.pay_type?'payapp:'+f.pay_type:''}],'webhook',partial?{id:f.mul_no,amount:Number(f.price)}:null);
    return reply('SUCCESS');
  }catch{return reply('FAIL',400);}
}
