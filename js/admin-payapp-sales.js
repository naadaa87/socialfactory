(function(){
  'use strict';var A=window.SF_ADMIN;if(!A)return;var $=A.$,esc=A.esc,page=1,version=0,busy=false,rows=[],review=null;
  var states={paid:'결제 완료',refunded:'전액 환불',pending:'결제 대기',cancelled:'요청 취소',used:'이용 완료',refund_requested:'환불 요청',failed:'결제 실패'};
  var decisions={website:'홈페이지 주문에 반영',include:'합산',exclude:'제외',duplicate:'기존 예약에 반영',review:'확인 필요'};
  var methods={'payapp:1':'카드','payapp:2':'휴대폰','payapp:4':'대면·수기 카드','payapp:6':'계좌이체','payapp:7':'가상계좌','payapp:15':'카카오페이','payapp:16':'네이버페이','payapp:25':'토스페이'};
  function request(body){return A.api('/api/admin/payapp-sales',{method:'POST',body:body});}
  function close(){review=null;$('#pa-review-form').hidden=true;}
  function error(e){if(!A.guard(e))$('#pa-review-status').textContent=e.message||'처리하지 못했습니다. 다시 시도해 주세요.';}
  function lock(value){busy=value;['#pa-filter','#pa-refresh','#pa-import','#pa-save'].forEach(function(s){$(s).disabled=value;});}
  function draw(){
    $('#pa-rows').innerHTML='<table class="tbl"><thead><tr><th>결제일시 · 거래번호</th><th>상품명</th><th>상태 · 수단</th><th>결제금액</th><th>환불금액</th><th>매출 합산</th></tr></thead><tbody>'+rows.map(function(r){
      var controls=r.disposition==='website'?'':(['paid','refunded'].includes(r.state)?'<div class="acts">'+(r.disposition!=='include'?'<button type="button" class="btn btn-light btn-xs" data-pa-id="'+esc(r.mul_no)+'" data-pa-decision="include">합산</button>':'')+(r.disposition!=='duplicate'?'<button type="button" class="btn btn-light btn-xs" data-pa-id="'+esc(r.mul_no)+'" data-pa-decision="duplicate">기존 예약 중복</button>':'')+(r.disposition!=='exclude'?'<button type="button" class="btn btn-light btn-xs" data-pa-id="'+esc(r.mul_no)+'" data-pa-decision="exclude">매출에서 제외</button>':'')+(r.disposition!=='review'?'<button type="button" class="btn btn-light btn-xs" data-pa-id="'+esc(r.mul_no)+'" data-pa-decision="review">확인 보류</button>':'')+'</div>':'');
      return '<tr><td>'+esc(r.paid_at||r.requested_at||'승인일시 없음')+'<br><small class="mono">'+esc(r.mul_no)+'</small></td><td>'+esc(r.product_name)+'</td><td>'+esc(states[r.state]||r.state)+'<br><small>'+esc(methods[r.method]||r.method||'—')+'</small></td><td>'+A.won(r.amount)+'</td><td>'+A.won(r.refund_amount)+'</td><td>'+esc(decisions[r.disposition]||r.disposition)+(r.review_note?'<br><small>'+esc(r.review_note)+'</small>':'')+controls+'</td></tr>';
    }).join('')+(!rows.length?'<tr><td colspan="6">조건에 맞는 페이앱 내역이 없습니다.</td></tr>':'')+'</tbody></table>';
  }
  async function load(){
    var n=++version;close();
    try{
      var d=await A.api('/api/admin/payapp-sales?page='+page+'&filter='+$('#pa-filter').value);if(n!==version)return;
      var last=Math.max(1,Math.ceil(d.total/d.pageSize));if(page>last){page=last;return load();}
      rows=d.rows;draw();$('#pa-page').textContent=A.num(d.total)+'건 · '+page+' / '+last+'페이지';
      $('#pa-prev').disabled=page<=1;$('#pa-next').disabled=page>=last;
      $('#pa-status').textContent=(d.configured?'페이앱 서버 수신 준비됨':'페이앱 서버 설정 필요')+' · 공통 통보 마지막 수신: '+(d.lastWebhook||'아직 없음 · 판매자센터 연결 후 신규 내역부터 수신');
      $('#pa-webhook-url').textContent=d.webhookUrl;
    }catch(e){if(n===version){rows=[];draw();error(e);}}
  }
  $('#pa-filter').addEventListener('change',function(){if(!busy){page=1;load();}});
  $('#pa-refresh').addEventListener('click',function(){if(!busy)load();});
  $('#pa-prev').addEventListener('click',function(){if(!busy&&page>1){page--;load();}});
  $('#pa-next').addEventListener('click',function(){if(!busy&&!this.disabled){page++;load();}});
  $('#pa-rows').addEventListener('click',function(e){
    var b=e.target.closest('[data-pa-id]');if(!b||busy)return;
    var row=rows.find(function(r){return r.mul_no===b.dataset.paId&&r.disposition!=='website';});if(!row||!['include','exclude','duplicate','review'].includes(b.dataset.paDecision))return;
    review={id:row.mul_no,decision:b.dataset.paDecision};$('#pa-review-title').textContent=row.product_name+' · '+A.won(row.amount)+' · '+decisions[review.decision];
    $('#pa-note').value=row.review_note||'';$('#pa-review-form').hidden=false;$('#pa-note').focus();
  });
  $('#pa-cancel').addEventListener('click',function(){if(!busy)close();});
  $('#pa-review-form').addEventListener('submit',async function(e){
    e.preventDefault();if(busy||!review)return;var note=$('#pa-note').value.trim(),target=review;
    if(note.length<3||note.length>300){$('#pa-review-status').textContent='사유를 3~300자로 적어주세요.';return;}
    lock(true);try{await request({action:'review',mulNo:target.id,decision:target.decision,note:note});$('#pa-review-status').textContent='페이앱 매출 합산 여부를 저장했습니다.';await load();previous();}catch(ex){error(ex);}finally{lock(false);}
  });
  $('#pa-import-form').addEventListener('submit',async function(e){
    e.preventDefault();if(busy)return;var raw;try{raw=JSON.parse($('#pa-json').value);}catch{$('#pa-review-status').textContent='페이앱 JSON 배열을 확인해 주세요.';return;}
    lock(true);try{var d=await request({action:'import',rows:raw});$('#pa-review-status').textContent=A.num(d.changed)+'건 가져오기 완료. 홈페이지와 같은 거래는 중복 합산하지 않습니다. 직접 결제는 확인 후 합산하세요.';$('#pa-json').value='';page=1;await load();}catch(ex){error(ex);}finally{lock(false);}
  });
  var previous=A.LOAD.sales;A.LOAD.sales=function(){previous();load();};
})();
