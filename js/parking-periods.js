(function(){'use strict';window.SF_PARKING_PERIODS=function(kind,now=Date.now()){
 const today=new Date(now+9*3600e3);today.setUTCHours(0,0,0,0);let start=new Date(today),end=new Date(today);
 if(kind==='yesterday'){start.setUTCDate(start.getUTCDate()-1);end=new Date(start);}
 else if(kind==='week'){start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7);end=new Date(start);end.setUTCDate(end.getUTCDate()+6);}
 else if(kind==='month'){start.setUTCDate(1);end=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,0));}
 else if(kind!=='today')throw Error('조회 기간을 확인해 주세요.');
 return {start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)};
};})();
