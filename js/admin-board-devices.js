(function(){
  'use strict';
  const link=document.getElementById('board-view-link');
  const button=document.getElementById('board-view-copy');
  const status=document.getElementById('board-view-status');
  if(!link||!button||!status)return;
  button.addEventListener('click',async()=>{
    try{
      await navigator.clipboard.writeText(link.value);
      status.textContent='예약 안내 주소를 복사했습니다. 모니터 브라우저에서 열어 주세요.';
    }catch{
      link.focus();link.select();
      status.textContent='선택된 예약 안내 주소를 복사해 주세요.';
    }
  });
})();
