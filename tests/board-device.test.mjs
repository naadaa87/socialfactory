import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createBoardDevice, pairBoardDevice, readBoardDevice, boardCookie, BOARD_DAYS } from '../functions/_lib/board-device.js';
import { onRequestGet as getDevices, onRequestPost as manageDevices } from '../functions/api/admin/board-devices.js';
import { onRequestPost as pair } from '../functions/api/board/pair.js';
import { onRequestGet as schedule } from '../functions/api/board/schedule.js';
import { onRequestGet as adminSession } from '../functions/api/admin/session.js';
const origin='https://socialfactory.co.kr';
function environment(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
  return {sqlite,ADMIN_KEY:'board-auth-test-only',DB:{prepare(sql){let args=[];const query={bind(...values){args=values;return query;},
    async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},
    async run(){return {meta:sqlite.prepare(sql).run(...args)};}};return query;}}};
}
const adminHeaders={authorization:'Bearer board-auth-test-only',origin,'content-type':'application/json'};
const cookie=token=>'sf_board='+token;
const request=(path,body,headers={})=>new Request(origin+path,{method:body?'POST':'GET',headers:{...headers},...(body?{body:JSON.stringify(body)}:{})});
test('one-time enrollment creates a scoped HttpOnly cookie and stores only hashes',async()=>{
  const env=environment(),created=await createBoardDevice(env,'입구 모니터');
  const result=await pair({request:request('/api/board/pair',{code:created.code},{origin,'content-type':'application/json'}),env});
  assert.equal(result.status,200);
  const setCookie=result.headers.get('set-cookie');assert.match(setCookie,/Path=\/api\/board\/;/);assert.match(setCookie,/HttpOnly; SameSite=Strict; Secure/);
  assert.match(setCookie,new RegExp('Max-Age='+BOARD_DAYS*86400));
  const token=setCookie.match(/^sf_board=([^;]+)/)[1];
  const raw=JSON.stringify(env.sqlite.prepare('SELECT * FROM board_devices').all());assert(!raw.includes(token));assert(!raw.includes(created.code));
  assert.equal((await readBoardDevice(request('/api/board/schedule',null,{cookie:cookie(token)}),env)).name,'입구 모니터');
  const again=await pairBoardDevice(env,created.code);assert.equal(again,null);
});
test('concurrent enrollment consumes the same link once, and expired links never work',async()=>{
  const env=environment(),created=await createBoardDevice(env,'로비',1000);
  const results=await Promise.all([pairBoardDevice(env,created.code,2000),pairBoardDevice(env,created.code,2000)]);
  assert.equal(results.filter(Boolean).length,1);
  const expired=await createBoardDevice(env,'만료',1000);assert.equal(await pairBoardDevice(env,expired.code,601001),null);
});
test('monitor credentials cannot authenticate to admin or issue new monitor credentials',async()=>{
  const env=environment(),created=await createBoardDevice(env,'입구'),paired=await pairBoardDevice(env,created.code);
  for(const handler of [adminSession,getDevices]){
    const response=await handler({request:request('/api/admin/session',null,{cookie:cookie(paired.token),authorization:'Bearer '+paired.token}),env});assert.equal(response.status,401);
  }
  const denied=await manageDevices({request:request('/api/admin/board-devices',{action:'create',name:'침입'},{cookie:cookie(paired.token),origin}),env});assert.equal(denied.status,401);
  const anonymous=await schedule({request:request('/api/board/schedule'),env});assert.equal(anonymous.status,401);
});
test('schedule output exposes no contact details, payment, notes, reservation identifiers or device secrets',async()=>{
  const env=environment(),created=await createBoardDevice(env,'입구'),paired=await pairBoardDevice(env,created.code);
  const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  env.sqlite.prepare(`INSERT INTO reservations(code,status,space,date,start_min,end_min,customer_name,phone,memo,amount,pay_method)
    VALUES('PRIVATE-123','confirmed','r1',?,600,720,'김민수','010-1234-5678','내부 메모',99000,'bank_blank')`).run(today);
  const response=await schedule({request:request('/api/board/schedule',null,{cookie:cookie(paired.token)}),env});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const data=await response.json();assert.equal(data.reservations[0].name,'김○수');assert.equal(data.reservations.length,1);
  const raw=JSON.stringify(data);for(const secret of ['010-1234','내부 메모','PRIVATE-123','김민수','"amount":','token_hash',paired.token,created.code])assert(!raw.includes(secret));
});
test('revocation, credential expiry and admin key rotation invalidate only monitor access',async()=>{
  const env=environment(),created=await createBoardDevice(env,'입구'),paired=await pairBoardDevice(env,created.code);
  const req=request('/api/board/schedule',null,{cookie:cookie(paired.token)});
  assert.equal(await readBoardDevice(req,env,paired.until),null);
  env.ADMIN_KEY='rotated';assert.equal(await readBoardDevice(req,env),null);env.ADMIN_KEY='board-auth-test-only';
  const revoked=await manageDevices({request:request('/api/admin/board-devices',{action:'revoke',id:created.id},adminHeaders),env});assert.equal(revoked.status,200);
  assert.equal((await schedule({request:req,env})).status,401);
  assert.equal((await adminSession({request:request('/api/admin/session',null,adminHeaders),env})).status,200);
});
test('pairing and management reject cross-origin requests and device listings never return hashes or codes',async()=>{
  const env=environment(),created=await createBoardDevice(env,'입구');
  for(const foreign of ['https://evil.invalid','http://socialfactory.co.kr',null]){
    const response=await pair({request:request('/api/board/pair',{code:created.code},foreign?{origin:foreign}:{}),env});assert.equal(response.status,403);
  }
  const denied=await manageDevices({request:request('/api/admin/board-devices',{action:'revoke',id:created.id},{...adminHeaders,origin:'https://evil.invalid'}),env});assert.equal(denied.status,403);
  const response=await getDevices({request:request('/api/admin/board-devices',null,adminHeaders),env});
  const raw=await response.text();assert(!raw.includes(created.code));assert(!raw.includes('pair_hash'));assert(!raw.includes('token_hash'));
  assert.equal(boardCookie(new Request('http://127.0.0.1/api/board/pair'),'example').includes('Secure'),false);
});
