const BASE='https://a24188.pweb.kr';
export class AmanoClient{
 constructor(credentials,upstream=fetch){this.credentials=credentials;this.upstream=upstream;this.cookies=new Map();}
 async request(path,form){
  const u=new URL(path,BASE);if(u.origin!==BASE)throw Error('Unexpected Amano destination');
  const r=await this.upstream(u.href,{method:form?'POST':'GET',headers:{Accept:form?'application/json,text/plain,*/*':'text/html','User-Agent':'MegaspotParkingServer/1.0 (+https://megaspot.kr)',...(this.cookies.size?{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; ')}:{}),...(form?{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','amano_http_ajax':'true','ajax':'true','X-Requested-With':'XMLHttpRequest'}:{})},...(form?{body:new URLSearchParams(form)}:{}),redirect:'manual',signal:AbortSignal.timeout(20000)});
  for(const raw of r.headers.getSetCookie()){const pair=raw.split(';')[0],i=pair.indexOf('=');if(i>0)this.cookies.set(pair.slice(0,i),pair.slice(i+1));}
  const text=await r.text();if([401,424,428].includes(r.status))throw Error('아마노 추가 인증 또는 약관 확인이 필요합니다.');
  if(r.status>=400)throw Error('아마노 요청 실패 HTTP '+r.status);
  return {status:r.status,location:r.headers.get('location'),text};
 }
 async login(){
  await this.request('/login');
  const r=await this.request('/login',{userId:this.credentials.username,userPwd:this.credentials.passwordHash});
  if(r.status>=300 && new URL(r.location||'/',BASE).pathname==='/login')throw Error('아마노 로그인 정보를 확인해 주세요.');
  const p=await this.request('/discount/registration');
  if(p.status!==200||!p.text.includes('할인정보 등록')||!p.text.includes('차량번호 조회')||p.text.includes('id="loginForm"'))throw Error('아마노 로그인 또는 추가 인증이 필요합니다.');
  return p.text;
 }
}

export const DISCOUNTS={
 '1':{minutes:60,price:0,name:'1시간할인'},
 '6':{minutes:60,price:3000,name:'1시간 유료할인'},
 '7':{minutes:120,price:6000,name:'2시간 유료할인'},
 '8':{minutes:180,price:9000,name:'3시간 유료할인'},
 '10':{minutes:1440,price:20000,name:'당일권'}
};
export const plateParts=s=>String(s||'').split('/').map(x=>x.normalize('NFKC').replace(/[\s-]/g,'')).filter(x=>/^(?:[가-힣]{2})?\d{2,3}[가-힣]\d{4}$/.test(x));
const stamp=s=>{const v=String(s||'').replace(/\D/g,'');if(v.length!==14)throw Error('아마노 입차시각 확인 필요');return v.slice(0,4)+'-'+v.slice(4,6)+'-'+v.slice(6,8)+'T'+v.slice(8,10)+':'+v.slice(10,12)+':'+v.slice(12,14);};
AmanoClient.prototype.json=async function(path,data){const r=await this.request(path,data);if(r.status!==200)throw Error('아마노 세션 확인 필요');try{return JSON.parse(r.text);}catch{throw Error('아마노 응답 형식 확인 필요');}};
AmanoClient.prototype.entries=async function(plate,date){
 const rows=await this.json('/discount/registration/listForDiscount',{iLotArea:'24188',entryDate:date.replaceAll('-',''),carNo:plate});
 if(!Array.isArray(rows))throw Error('아마노 입차 목록 확인 필요');
 return rows.filter(r=>plateParts(r.carNo).includes(plate)).map(r=>({id:String(r.id),plate:String(r.carNo),cardType:String(r.iCardType),entryAt:String(r.entryDateToString).replace(' ','T'),out:String(r.dtOutDate||'')}));
};
AmanoClient.prototype.detail=async function(entry,date){
 const d=await this.json('/discount/registration/getForDiscount',{id:entry.id,iCardType:entry.cardType,member_id:this.credentials.username,startDate:date.replaceAll('-','')});
 const p=d.parkEntry,m=d.member;
 if(!p||!m||String(p.iID)!==entry.id||String(p.iLotArea)!=='24188'||String(m.userId)!==this.credentials.username||!Array.isArray(d.parkVisitCar)||!Array.isArray(d.listDiscountType)||d.flagCustomer!==true)throw Error('아마노 입차·계정 정보 확인 필요');
 const balance=Number(m.dcTimeRemainCharge);if(!Number.isSafeInteger(balance)||balance<0)throw Error('아마노 잔액 확인 필요');
 const types=d.listDiscountType.map(t=>({id:String(t.id),name:String(t.discount_name),price:Number(t.discount_price),minutes:Number(t.discount_value)}));
 const discounts=d.parkVisitCar.filter(x=>String(x.del_yn)==='0').map(x=>({id:String(x.idno),code:String(x.discountTypeId),name:String(x.discount_name),minutes:Number(x.dc_time),price:Number(x.discount_price),charged:Number(x.used_charge),entryId:String(x.tckttrns_id),memo:String(x.memo||''),account:String(x.account_no),at:String(x.create_tm)}));
 return {entry:{id:String(p.iID),plate:String(p.acPlate1),cardType:String(p.iCardType),entryAt:stamp(p.dtInDate),out:!!p.dtOutDate||Number(p.out)!==0},balance,types,discounts};
};
AmanoClient.prototype.register=async function(entry,code,oid){
 if(!Object.hasOwn(DISCOUNTS,code)||!/^(?:MS[A-Z0-9]{1,38}|SF[A-Z0-9]{16})$/.test(oid))throw Error('아마노 할인 등록 입력 확인 필요');
 const result=await this.json('/discount/registration/save',{peId:entry.id,discountType:code,saveCnt:'1',iCardType:entry.cardType,carNo:entry.plate,acPlate2:'',memo:oid});
 if(result!==true)throw Error('아마노 할인 등록 결과 확인 필요');
};
