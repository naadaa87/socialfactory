// 날짜·시간 입력은 브라우저/서버 시간대와 관계없이 한국 시간으로 해석합니다.
export function validateWebsiteStart(value, now=Date.now()) {
 if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))return {error:'datetime'};
 const ms=Date.parse(value+':00+09:00');
 if(!Number.isFinite(ms) || new Date(ms+9*36e5).toISOString().slice(0,16)!==value)return {error:'datetime'};
 const canonical=value.replace('T',' ')+':00';
 if(ms<=now)return {error:'pastTime',value:canonical};
 if(ms>now+90*864e5)return {error:'farTime',value:canonical};
 return {value:value.replace('T',' ')+':00'};
}
