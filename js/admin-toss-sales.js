(function () {
  'use strict';
  var A=window.SF_ADMIN; if(!A)return;
  var $=A.$,esc=A.esc,payments=null,serial=0,busy=false;
  var status=$('#ts-import-status'),preview=$('#ts-preview'),commit=$('#ts-commit');
  var labels={new:'신규',updated:'변경 반영',unchanged:'이미 반영',blocked:'확인 필요',included:'합산',duplicate:'이용권 중복 제외',exclude:'제외',review:'확인 필요'};
  var types={CARD:'카드',CASH:'현금',BARCODE:'간편결제',ACCOUNT_TRANSFER:'계좌이체',PREPAID_VALUE:'선불수단',EXTERNAL:'외부 결제수단'};
  function request(body){return A.api('/api/admin/toss-sales',{method:'POST',body:body});}
  function locked(value){busy=value;['#ts-fetch','#ts-file','#ts-from','#ts-to','#ts-commit'].forEach(function(s){$(s).disabled=value;});}
  function error(e){if(!A.guard(e))status.textContent=e.message||'처리하지 못했습니다. 다시 시도해 주세요.';}
  function table(rows,recent){
    return '<table class="tbl"><thead><tr><th>승인일시 · 결제 ID</th><th>수단</th><th>결제금액</th><th>취소금액</th><th>처리</th></tr></thead><tbody>'+rows.map(function(r){
      var state=recent?r.disposition:r.result;
      var controls=recent&&state==='review'&&r.source_type!=='EXTERNAL'?'<div class="acts"><button class="btn btn-light btn-xs" type="button" data-ts-id="'+esc(r.payment_id)+'" data-ts-decision="exclude">중복으로 제외</button><button class="btn btn-light btn-xs" type="button" data-ts-id="'+esc(r.payment_id)+'" data-ts-decision="include">별도 결제로 합산</button></div>':'';
      var reason=r.reason||r.review_note||(state==='review'?'기존 수기 매출/직접 발급분과 중복 여부를 확인해 주세요.':'');
      return '<tr><td>'+esc(r.paid_at)+'<br><small class="mono">'+esc(r.payment_id)+'</small></td><td>'+esc(types[r.source_type]||r.source_type)+'</td><td>'+A.won(r.amount)+'</td><td>'+A.won(r.refund_amount)+'</td><td>'+esc(labels[state]||state)+(reason?'<br><small>'+esc(reason)+'</small>':'')+controls+'</td></tr>';
    }).join('')+'</tbody></table>';
  }
  async function load(){
    try{
      var d=await A.api('/api/admin/toss-sales');
      $('#ts-status').textContent=(d.apiReady?'과거 내역 조회 설정됨':'과거 내역 조회: API 키·매장 연결 필요')+' · '+(d.webhookReady?'실시간 수신 설정됨':'실시간 수신: 웹훅 연결 필요');
      $('#ts-times').textContent='일반 단말기 합산 '+A.num(d.summary.n)+'건 · '+A.won(d.summary.total)+' / 마지막 수신: '+(d.lastWebhook||'아직 없음');
      $('#ts-webhook-url').textContent=d.webhookUrl;
      $('#ts-recent').innerHTML=d.rows.length?table(d.rows,true):'<p class="small muted">아직 가져온 일반 단말기 결제가 없습니다.</p>';
    }catch(e){if(!A.guard(e))$('#ts-status').textContent=e.message||'연결 상태를 확인하지 못했습니다.';}
  }
  function reset(){serial++;payments=null;commit.hidden=true;preview.innerHTML='';status.textContent='';}
  async function previewAll(raw,version){
    var rows=[];
    if(!Array.isArray(raw)||!raw.length||raw.length>10000)throw Error('1~10,000건의 결제를 선택해 주세요.');
    var ids=new Set();raw.forEach(function(r){var key=String(r&&r.merchantId)+':'+String(r&&r.id);if(ids.has(key))throw Error('같은 결제 ID가 여러 번 있습니다.');ids.add(key);});
    for(var i=0;i<raw.length;i+=200){
      var d=await request({action:'preview',payments:raw.slice(i,i+200)});if(version!==serial)return;
      rows=rows.concat(d.rows);
    }
    payments=raw;
    preview.innerHTML=table(rows.slice(0,200),false);
    status.textContent='총 '+A.num(rows.length)+'건 조회 · 중복/보류 제외 조회 내역 순매출 '+A.won(rows.filter(function(r){return r.counted&&r.result!=='blocked';}).reduce(function(n,r){return n+r.amount-r.refund_amount;},0))+(rows.length>200?' · 첫 200건 표시':'')+' · 이미 반영된 결제는 다시 더하지 않습니다.';
    commit.hidden=rows.some(function(r){return r.result==='blocked';});
    if(commit.hidden)status.textContent+=' 원거래가 다른 결제가 있어 반영을 중지했습니다.';
  }
  $('#ts-history-form').addEventListener('submit',async function(e){
    e.preventDefault();if(busy)return;reset();var version=serial,from=$('#ts-from').value,to=$('#ts-to').value;
    if(!from||!to||from>to){status.textContent='조회 시작일·종료일을 확인해 주세요.';return;}
    locked(true);
    try{
      var raw=[],page=1;
      do{
        status.textContent='토스 과거 거래 조회 중… '+A.num(raw.length)+'건 확인';
        var d=await request({action:'fetch',from:from,to:to,page:page});if(version!==serial)return;
        raw=raw.concat(d.payments);page=d.nextPage;
        if(raw.length>10000||page>1000)throw Error('조회할 거래가 많습니다. 기간을 나누어 조회해 주세요.');
      }while(page);
      if(!raw.length){status.textContent='선택한 기간에 조회 가능한 거래가 없습니다.';return;}
      await previewAll(raw,version);
    }catch(e){payments=null;commit.hidden=true;error(e);}finally{locked(false);}
  });
  $('#ts-file').addEventListener('change',async function(){
    if(busy)return;reset();var version=serial,file=this.files[0];if(!file)return;
    locked(true);
    try{if(file.size>5000000)throw Error('5MB 이하의 JSON 파일을 선택해 주세요.');var data=JSON.parse(await file.text());await previewAll(Array.isArray(data)?data:data.payments,version);}
    catch(e){payments=null;commit.hidden=true;error(e);}finally{locked(false);}
  });
  commit.addEventListener('click',async function(){
    if(busy||!payments)return;locked(true);var changed=0,done=0;
    try{
      for(var i=0;i<payments.length;i+=200){
        var d=await request({action:'commit',payments:payments.slice(i,i+200)});changed+=d.changed;done+=d.rows.length;
        status.textContent=A.num(done)+' / '+A.num(payments.length)+'건 반영 중…';
      }
      commit.hidden=true;payments=null;preview.innerHTML='';status.textContent=A.num(changed)+'건 반영 완료. 기존 이용권 중복과 확인 필요 내역은 합산에서 제외했습니다.';
      await load();A.LOAD.sales();
    }catch(e){error(e);status.textContent+=' 완료한 '+A.num(done)+'건은 저장됐습니다. 같은 내역을 다시 반영해도 중복 합산하지 않습니다.';}
    finally{locked(false);}
  });
  $('#ts-recent').addEventListener('click',function(e){
    var b=e.target.closest('[data-ts-id]');if(!b)return;
    var panel=document.createElement('form');panel.className='card mt-s';
    panel.innerHTML='<p class="small">결제 '+esc(b.dataset.tsId)+' · '+(b.dataset.tsDecision==='include'?'기존 수기 매출과 별개 거래로 합산':'기존 매출과 중복되어 합산 제외')+'</p><label>확인 메모 <input class="input" name="note" required minlength="3" maxlength="300"></label><button class="btn btn-primary btn-sm" type="submit">확인한 처리 저장</button><button class="btn btn-light btn-sm" type="button">닫기</button>';
    b.closest('td').appendChild(panel);panel.querySelector('button[type="button"]').addEventListener('click',function(){panel.remove();});
    panel.addEventListener('submit',async function(event){event.preventDefault();var button=panel.querySelector('button');button.disabled=true;try{await request({action:'review',paymentId:b.dataset.tsId,decision:b.dataset.tsDecision,note:panel.elements.note.value});await load();A.LOAD.sales();}catch(ex){error(ex);button.disabled=false;}});
    panel.querySelector('input').focus();
  });
  $('#ts-refresh').addEventListener('click',load);
  $('#ts-from').addEventListener('change',reset);$('#ts-to').addEventListener('change',reset);
  $('#ts-from').value='2020-01-01';$('#ts-to').value=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
  var previous=A.LOAD.sales;A.LOAD.sales=function(){previous();load();};
})();
