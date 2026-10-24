/* Actual Spacecloud HOST settlement XLSX: header row is discovered by names, never amounts inferred from fees. */
(function () {
  'use strict';
  var $=function(s){return document.querySelector(s);}, input=$('#sc-import-file'); if(!input)return;
  var rows=null, status=$('#sc-import-status'), preview=$('#sc-import-preview'), commit=$('#sc-import-commit');
  var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
  function message(s){status.textContent=s;}
  async function api(action){var response=await fetch('/api/admin/spacecloud-import',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action,rows:rows})}); var j=await response.json(); if(!response.ok)throw Error(j.message||'가져오기 실패');return j;}
  async function unzip(file){
    if(file.size>5000000)throw Error('5MB 이하의 정산 엑셀을 선택해 주세요.');
    var bytes=new Uint8Array(await file.arrayBuffer()),v=new DataView(bytes.buffer),end=-1;
    for(var i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(v.getUint32(i,true)===0x06054b50){end=i;break;}
    if(end<0)throw Error('정상적인 XLSX 파일이 아닙니다.');
    var count=v.getUint16(end+10,true),pos=v.getUint32(end+16,true),files={},total=0;
    if(count>200)throw Error('파일 안의 항목이 너무 많습니다.');
    for(i=0;i<count;i++){
      if(v.getUint32(pos,true)!==0x02014b50)throw Error('엑셀 압축 정보를 확인할 수 없습니다.');
      var method=v.getUint16(pos+10,true),size=v.getUint32(pos+20,true),plain=v.getUint32(pos+24,true),nl=v.getUint16(pos+28,true),extra=v.getUint16(pos+30,true),comment=v.getUint16(pos+32,true),off=v.getUint32(pos+42,true);
      var name=new TextDecoder().decode(bytes.slice(pos+46,pos+46+nl));pos+=46+nl+extra+comment;
      if(!/^xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml)$/.test(name))continue;
      if(plain>10000000 || (total+=plain)>20000000 || size>bytes.length || off+30>bytes.length)throw Error('엑셀 데이터가 너무 크거나 손상되었습니다.');
      if(v.getUint32(off,true)!==0x04034b50)throw Error('잘못된 엑셀 파일입니다.');
      var start=off+30+v.getUint16(off+26,true)+v.getUint16(off+28,true);if(start+size>bytes.length)throw Error('잘린 엑셀 파일입니다.');
      var data=bytes.slice(start,start+size);
      if(method===8){
        if(typeof DecompressionStream==='undefined')throw Error('최신 크롬에서 가져오기를 실행해 주세요.');
        var reader=new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(),chunks=[],length=0;
        for(;;){var part=await reader.read();if(part.done)break;length+=part.value.length;if(length>plain || length>10000000){await reader.cancel();throw Error('압축 해제 한도를 초과했습니다.');}chunks.push(part.value);}
        data=new Uint8Array(length);var at=0;chunks.forEach(function(c){data.set(c,at);at+=c.length;});
      }else if(method!==0)throw Error('지원하지 않는 엑셀 압축 형식입니다.');
      if(data.length!==plain)throw Error('엑셀 크기 정보가 잘못되었습니다.');
      var xml=new DOMParser().parseFromString(new TextDecoder().decode(data),'application/xml');if(xml.querySelector('parsererror'))throw Error('엑셀 내용을 읽을 수 없습니다.');files[name]=xml;
    }return files;
  }
  function day(value){var s=String(value||'').trim();if(/^\d{8}$/.test(s))return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6);if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);throw Error('날짜 형식이 다릅니다. 원본 엑셀을 그대로 선택해 주세요.');}
  function money(value){var s=String(value==null?'':value).trim();if(!/^\d+$/.test(s))throw Error('결제/취소금액이 비어 있거나 숫자가 아닙니다.');return Number(s);}
  async function parse(file){
    if(/\.json$/i.test(file.name)) {
      if(file.size>2000000)throw Error('2MB 이하의 수집 파일을 선택해 주세요.');
      var data=JSON.parse(await file.text());
      if(data.format!=='socialfactory-spacecloud-payments'||data.version!==1||data.source!=='host-draft'||!Array.isArray(data.rows))throw Error('스페이스클라우드 결제 수집 도구의 원본 JSON 파일을 선택해 주세요.');
      return data.rows;
    }
    var files=await unzip(file),shared=files['xl/sharedStrings.xml'];var strings=shared?Array.from(shared.querySelectorAll('si')).map(function(si){return Array.from(si.querySelectorAll('t')).map(function(t){return t.textContent;}).join('');}):[];
    var sheet=files['xl/worksheets/sheet1.xml'];if(!sheet)throw Error('첫 시트를 찾지 못했습니다.');
    var data=Array.from(sheet.querySelectorAll('sheetData > row')).map(function(row){var out={};row.querySelectorAll('c').forEach(function(c){var col=(c.getAttribute('r')||'').replace(/\d/g,''),t=c.getAttribute('t'),value=c.querySelector('v');out[col]=t==='s'?strings[Number(value&&value.textContent)]:t==='inlineStr'?Array.from(c.querySelectorAll('t')).map(function(n){return n.textContent;}).join(''):value?value.textContent:'';});return out;});
    if(!data.some(function(r){return Object.values(r).includes('스페이스클라우드 HOST 정산내역');}))throw Error('호스트센터 정산 완료에서 받은 원본 엑셀을 선택해 주세요.');
    var h=data.findIndex(function(r){return Object.values(r).includes('예약번호')&&Object.values(r).includes('결제일시');});if(h<0)throw Error('예약별 결제내역 머리글을 찾지 못했습니다.');
    var cols={};Object.keys(data[h]).forEach(function(k){cols[String(data[h][k]).replace(/\s/g,'').split('(')[0]]=k;});
    var required=['예약번호','예약공간','이용시작일','이용종료일','결제일시','결제금액','취소금액','정산상태'];required.forEach(function(k){if(!cols[k])throw Error('필수 항목 누락: '+k);});
    return data.slice(h+1).filter(function(r){return /^\d+$/.test(r[cols['예약번호']]||'');}).map(function(r){
      if(r[cols['정산상태']]!=='집계완료')throw Error('집계완료 이외의 정산상태가 있습니다. 먼저 정산 완료 파일을 선택해 주세요.');
      return {reservation_id:String(r[cols['예약번호']]),venue:r[cols['예약공간']],use_date:day(r[cols['이용시작일']]),end_date:day(r[cols['이용종료일']]),paid_at:day(r[cols['결제일시']]),amount:money(r[cols['결제금액']]),refund_amount:money(r[cols['취소금액']])};
    });
  }
  input.addEventListener('change',async function(){rows=null;commit.hidden=true;preview.innerHTML='';if(!input.files[0])return;message('결제내역 확인 중…');try{
    rows=await parse(input.files[0]);var j=await api('preview'),labels={new:'가져오기 가능',unchanged:'이미 반영됨',blocked:'확인 필요'};
    preview.innerHTML='<table class="tbl"><thead><tr><th>예약번호</th><th>결제일</th><th>이용일</th><th>결제금액</th><th>취소금액</th><th>상태</th></tr></thead><tbody>'+j.rows.map(function(r){return '<tr><td>'+esc(r.reservation_id)+'</td><td>'+esc(r.paid_at)+'</td><td>'+esc(r.use_date)+'</td><td>'+esc(Number.isSafeInteger(r.amount)?r.amount.toLocaleString('ko-KR'):'오류')+'원</td><td>'+esc(Number.isSafeInteger(r.refund_amount)?r.refund_amount.toLocaleString('ko-KR'):'오류')+'원</td><td>'+esc(r.reason||labels[r.state])+'</td></tr>';}).join('')+'</tbody></table>';
    var ready=j.rows.filter(function(r){return r.state==='new';}).length,blocked=j.rows.some(function(r){return r.state==='blocked';});
    message('새로 반영할 '+ready+'건 · 순매출 '+j.total.toLocaleString('ko-KR')+'원'+(blocked?' · 확인이 필요한 행은 아래 사유를 확인해 주세요.':''));commit.hidden=blocked||!ready;
  }catch(e){rows=null;message(e.message);}});
  commit.addEventListener('click',async function(){commit.disabled=true;try{var j=await api('commit');message(j.message+' 매출 화면을 새로고침하면 합계와 채널 비중에 반영됩니다.');commit.hidden=true;rows=null;}catch(e){message(e.message);}finally{commit.disabled=false;}});
}());
