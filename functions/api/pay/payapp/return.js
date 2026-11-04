// 고객 화면 이동은 승인 증거가 아닙니다. 결제 상태는 feedback에서만 변경합니다.
import { safeEqual } from "../../../_lib/auth.js";
import { orderToken } from "../../../_lib/shop.js";
export async function onRequest({request,env}) {
  const url=new URL(request.url),oid=url.searchParams.get("oid") || "";
  if (!/^SF[A-Z0-9]{16}$/.test(oid)) return new Response("Invalid order",{status:400});
  const token=url.searchParams.get("t") || "";
  if (!safeEqual(token,await orderToken(env,oid))) return new Response("Forbidden",{status:403});
  const row=await env.DB?.prepare("SELECT product_id FROM orders WHERE oid=?").bind(oid).first();
  const page=row?.product_id?.startsWith("parking-")?"/parking-order":"/order-complete";
  return new Response(null,{status:303,headers:{Location:url.origin+page+"?oid="+oid+"&t="+token,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"}});
}
