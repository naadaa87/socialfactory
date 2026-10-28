import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { issuePassForPayment, cancelPass, queueRefundNotice, toMs, fromMs, kTime, deviceTokenHash, makeStaffToken } from '../functions/_lib/kiosk.js';
import { runQueue, buildMessage } from '../functions/_lib/notify.js';
import { kstNow } from '../functions/_lib/admin.js';
import { onRequestPost as refundResult } from '../functions/api/kiosk/refund.js';
import { onRequestPatch as adminPatch } from '../functions/api/admin/passes.js';

function fixture(t, live = false) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  sqlite.prepare('INSERT INTO customers (phone, name) VALUES (?, ?)').run('01000000000', '테스트');
  const DB = { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() {
        const r = sqlite.prepare(sql).run(...args);
        return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      }
    };
  }, async batch(statements) {
    sqlite.exec('BEGIN');
    try { const result = []; for (const s of statements) result.push(await s.run()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const env = { DB, ADMIN_KEY: 'test-only-admin-key', SESSION_SECRET: 'test-only-session-secret',
    ALIMTALK_PROVIDER: 'aligo', ALIMTALK_ENABLED: live ? '1' : '0',
    ALIGO_API_KEY: 'test-only-api-key', ALIGO_USER_ID: 'test-user', ALIGO_SENDER_KEY: 'test-only-sender-key', ALIGO_SENDER: '0212345678',
    ALIMTALK_TPL_PURCHASE: 'PURCHASE', ALIMTALK_TPL_EXPIRE: 'EXPIRE', ALIMTALK_TPL_RENEWAL: 'RENEWAL', ALIMTALK_TPL_REFUND: 'REFUND' };
  const rows = (sql, ...args) => sqlite.prepare(sql).all(...args);
  const one = (sql, ...args) => sqlite.prepare(sql).get(...args);
  let payment = 0;
  function pay(extra = {}) {
    const key = 'TEST-' + (++payment);
    sqlite.prepare("INSERT INTO pass_payments (payment_key, customer_id, product_id, product_name, amount, status, pay_method) VALUES (?, 1, 'seat-2h', '2시간권', 4000, 'paid', 'CARD')").run(key);
    const row = one('SELECT * FROM pass_payments WHERE payment_key = ?', key);
    for (const [field, value] of Object.entries(extra)) sqlite.prepare(`UPDATE pass_payments SET ${field} = ? WHERE id = ?`).run(value, row.id);
    return one('SELECT * FROM pass_payments WHERE id = ?', row.id);
  }
  const noNetwork = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network call'); });
  return { env, sqlite, rows, one, pay, noNetwork };
}
function apiMock(t, response = { code: 0, info: { mid: '123', scnt: 1, fcnt: 0 } }) {
  const requests = [];
  const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options, form: new URLSearchParams(options.body) });
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify(response), { status: 200 });
  });
  return { requests, mock };
}

test('첫 구매는 구매 완료 1건, 동일 결제 결과 재전송은 중복 발급·알림 없음', async t => {
  const f = fixture(t), payment = f.pay();
  const first = await issuePassForPayment(f.env, payment);
  const second = await issuePassForPayment(f.env, payment);
  assert(first.created); assert(!second.created);
  assert.equal(first.pass.id, second.pass.id);
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE kind = 'purchase'").length, 1);
});

test('추가 구매는 구매 완료 대신 연장 1건, 기존 만료 알림은 취소하고 최종 시각 재계산', async t => {
  const f = fixture(t);
  const first = await issuePassForPayment(f.env, f.pay());
  const second = await issuePassForPayment(f.env, f.pay());
  assert.equal(second.pass.starts_at, first.pass.ends_at);
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE kind = 'purchase'").length, 1);
  const renewals = f.rows("SELECT * FROM notification_jobs WHERE kind = 'renewal'");
  assert.equal(renewals.length, 1);
  const message = buildMessage('renewal', JSON.parse(renewals[0].vars));
  assert(message.text.includes('기존 종료: ' + kTime(first.pass.ends_at)));
  assert(message.text.includes('최종 종료: ' + kTime(second.pass.ends_at)));
  assert.equal(f.one("SELECT status FROM notification_jobs WHERE kind = 'expire_soon' AND pass_id = ?", first.pass.id).status, 'cancelled');
  assert.equal(f.one("SELECT pass_id FROM notification_jobs WHERE kind = 'expire_soon' AND status = 'queued'").pass_id, second.pass.id);
});

test('별도 시작일로 발급하거나 결제가 완료되지 않은 건을 연장 완료로 오인하지 않음', async t => {
  const f = fixture(t);
  await issuePassForPayment(f.env, f.pay());
  await issuePassForPayment(f.env, f.pay(), { startAt: fromMs(toMs(kstNow()) + 864e5) });
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE kind = 'renewal'").length, 0);
  await assert.rejects(issuePassForPayment(f.env, f.pay({ status: 'pending' })), /payment-not-paid/);
});

test('알리고 인증정보가 있어도 검수 중에는 네트워크 호출 없이 문구만 기록', async t => {
  const f = fixture(t);
  await issuePassForPayment(f.env, f.pay());
  const result = await runQueue(f.env);
  assert.equal(result.logged, 1); assert.equal(result.sent, 0);
  assert.equal(f.noNetwork.mock.callCount(), 0);
  assert(f.one("SELECT rendered FROM notification_jobs WHERE kind = 'purchase'").rendered.includes('4,000원'));
});

test('4종 모두 알리고 폼 형식으로 요청하고 접수 ID 저장, 문자 대체발송은 꺼짐', async t => {
  const f = fixture(t, true), api = apiMock(t);
  await issuePassForPayment(f.env, f.pay());
  await runQueue(f.env);
  const second = await issuePassForPayment(f.env, f.pay());
  await runQueue(f.env);
  f.sqlite.prepare("UPDATE notification_jobs SET send_after = ? WHERE kind = 'expire_soon' AND status = 'queued'").run(kstNow());
  await runQueue(f.env);
  await cancelPass(f.env, second.pass, { refundAmount: 4000, refundConfirmed: true });
  await runQueue(f.env);
  assert.deepEqual(api.requests.map(r => r.form.get('tpl_code')), ['PURCHASE', 'RENEWAL', 'EXPIRE', 'REFUND']);
  for (const request of api.requests) {
    assert.equal(request.url, 'https://kakaoapi.aligo.in/akv10/alimtalk/send/');
    assert.equal(request.form.get('receiver_1'), '01000000000');
    assert.equal(request.form.get('failover'), 'N');
    assert(!request.form.get('message_1').includes('#{'));
    assert.equal(request.options.redirect, 'manual');
  }
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE status = 'sent' AND provider_msg_id = '123'").length, 4);
});

test('승인 본문의 별칭 변수·줄바꿈·버튼·강조 타이틀을 그대로 치환', async t => {
  const f = fixture(t, true), api = apiMock(t);
  f.env.ALIMTALK_TEXT_PURCHASE = '#{이용권}\n#{시작일시} ~ #{종료일시}\n#{결제금액}원';
  f.env.ALIMTALK_SUBJECT_PURCHASE = '등록 안내';
  f.env.ALIMTALK_EMTITLE_PURCHASE = '#{이용권}';
  f.env.ALIMTALK_BUTTONS_PURCHASE = JSON.stringify({ button: [{ name: '이용 안내', linkType: 'WL', linkMo: 'https://socialfactory.co.kr/guide', linkPc: 'https://socialfactory.co.kr/guide' }] });
  await issuePassForPayment(f.env, f.pay());
  await runQueue(f.env);
  const form = api.requests[0].form;
  assert.equal(form.get('subject_1'), '등록 안내'); assert.equal(form.get('emtitle_1'), '2시간권');
  assert.equal(JSON.parse(form.get('button_1')).button[0].name, '이용 안내');
  assert.equal(form.get('message_1').split('\n').length, 3);
  assert(form.get('message_1').includes('4,000원'));
});

test('알리고 HTTP 200이어도 오류 코드면 발송 완료로 기록하지 않고 재시도', async t => {
  const f = fixture(t, true), api = apiMock(t, { code: -99, message: 'test-only-api-key 01000000000' });
  await issuePassForPayment(f.env, f.pay());
  const result = await runQueue(f.env);
  assert.equal(result.retry, 1); assert.equal(result.sent, 0);
  assert.equal(api.requests.length, 1);
  const job = f.one("SELECT * FROM notification_jobs WHERE kind = 'purchase'");
  assert(!job.last_error.includes('test-only-api-key')); assert(!job.last_error.includes('01000000000'));
});

test('접수 여부 불명인 네트워크 오류는 자동 재발송하지 않음', async t => {
  const f = fixture(t, true), api = apiMock(t, new Error('connection lost'));
  await issuePassForPayment(f.env, f.pay());
  const result = await runQueue(f.env);
  assert.equal(result.failed, 1); assert.equal(result.retry, 0);
  await runQueue(f.env);
  assert.equal(api.requests.length, 1);
  assert.match(f.one("SELECT last_error FROM notification_jobs WHERE kind = 'purchase'").last_error, /전송내역 확인/);
});

test('성공 코드라도 접수 건수·메시지 ID가 불분명하면 보냄으로 기록하지 않음', async t => {
  const f = fixture(t, true);
  apiMock(t, { code: 0, info: { mid: '123', scnt: 0, fcnt: 1 } });
  await issuePassForPayment(f.env, f.pay());
  const result = await runQueue(f.env);
  assert.equal(result.failed, 1); assert.equal(result.sent, 0); assert.equal(result.retry, 0);
});

test('알리고 테스트 모드 응답은 실제 발송 접수가 아닌 기록만으로 표시', async t => {
  const f = fixture(t, true), api = apiMock(t, { code: 0 });
  f.env.ALIGO_TEST_MODE = 'Y';
  await issuePassForPayment(f.env, f.pay());
  const result = await runQueue(f.env);
  assert.equal(result.logged, 1); assert.equal(result.sent, 0);
  assert.equal(api.requests[0].form.get('testMode'), 'Y');
  assert.equal(api.requests[0].options.redirect, 'manual');
  assert.equal(f.one("SELECT provider FROM notification_jobs WHERE kind = 'purchase'").provider, 'aligo-test');
});

test('테스트 모드에서 알리고 오류 사유를 보이되 인증정보와 전화번호는 가림', async t => {
  const f = fixture(t, true);
  f.env.ALIGO_TEST_MODE = 'Y';
  apiMock(t, { code: -99, message: '발신 프로파일 키를 확인하세요 test-only-api-key 01012345678' });
  await issuePassForPayment(f.env, f.pay());
  const result = await runQueue(f.env);
  assert.equal(result.retry, 1);
  const reason = f.one("SELECT last_error FROM notification_jobs WHERE kind = 'purchase'").last_error;
  assert.match(reason, /발신 프로파일 키를 확인하세요/);
  assert(!reason.includes('test-only-api-key'));
  assert(!reason.includes('01012345678'));
});

test('알리고 리다이렉트는 따라가지 않고 자동 재발송하지 않음', async t => {
  const f = fixture(t, true);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'https://example.com/' } }); });
  await issuePassForPayment(f.env, f.pay());
  const result = await runQueue(f.env);
  assert.equal(result.failed, 1); assert.equal(result.retry, 0);
  assert.equal(calls, 1);
  assert.match(f.one("SELECT last_error FROM notification_jobs WHERE kind = 'purchase'").last_error, /리다이렉트 응답/);
});

test('승인 템플릿 코드는 코드 기본값으로 사용하고 승인 문구와 버튼을 렌더링', async t => {
  const f = fixture(t, true);
  delete f.env.ALIMTALK_TPL_PURCHASE;
  const api = apiMock(t);
  await issuePassForPayment(f.env, f.pay());
  assert.equal((await runQueue(f.env)).sent, 1);
  assert.equal(api.requests[0].form.get('tpl_code'), 'UM_9903');
  assert.equal(api.requests[0].form.get('message_1'), '[소셜팩토리 건대] 이용권 구매 완료\n\n이용권이 정상적으로 등록되었습니다.\n\n■ 구매 상품: 2시간권\n■ 결제 금액: 4,000원\n■ 이용 시작: ' + JSON.parse(f.one("SELECT vars FROM notification_jobs WHERE kind = 'purchase'").vars).시작 + '\n■ 이용 종료: ' + JSON.parse(f.one("SELECT vars FROM notification_jobs WHERE kind = 'purchase'").vars).만료 + '\n\n공간 이용 방법과 시설 안내는 아래 이용 안내를 통해 확인 부탁드립니다.');
  assert.deepEqual(JSON.parse(api.requests[0].form.get('button_1')), { button: [{ name: '이용 안내', linkType: 'WL', linkMo: 'https://socialfactory.co.kr/guide' }] });
  const expire = buildMessage('expire_soon', { 이용권: '2시간권', 만료: '10월 28일 12:00' });
  assert(expire.text.includes('· 이용 종료: 10월 28일 12:00'));
  assert.deepEqual(expire.buttons.button[0].name, '이용권 추가 구매');
});

test('누락된 본문·버튼 변수와 잘못된 버튼 JSON은 조용히 빈 값으로 발송하지 않음', () => {
  assert.throws(() => buildMessage('purchase', {}, { ALIMTALK_TEXT_PURCHASE: '#{없는변수}' }), /변수 누락/);
  assert.throws(() => buildMessage('purchase', {}, { ALIMTALK_TEXT_PURCHASE: '본문', ALIMTALK_BUTTONS_PURCHASE: 'not-json' }), /JSON/);
  assert.throws(() => buildMessage('purchase', {}, { ALIMTALK_TEXT_PURCHASE: '본문', ALIMTALK_BUTTONS_PURCHASE: '{"button":[{"name":"확인","linkType":"WL","linkMo":"#{없는변수}"}]}' }), /변수 누락/);
});

test('관리자 단순 환불 기록은 완료 알림 없음, 명시적인 완료 확인 시에만 생성', async t => {
  const f = fixture(t);
  const first = await issuePassForPayment(f.env, f.pay());
  await cancelPass(f.env, first.pass, { refundAmount: 3000 });
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE kind = 'refund'").length, 0);
  const second = await issuePassForPayment(f.env, f.pay());
  await cancelPass(f.env, second.pass, { refundAmount: 3000, refundConfirmed: true });
  await queueRefundNotice(f.env, second.pass);
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE kind = 'refund'").length, 1);
  assert.equal(JSON.parse(f.one("SELECT vars FROM notification_jobs WHERE kind = 'refund'").vars).환불금액, '3,000');
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE pass_id = ? AND status = 'queued' AND kind <> 'refund'", second.pass.id).length, 0);
});

test('환불 0원 또는 환불 상태가 아닌 결제에는 환불 완료 알림 없음', async t => {
  const f = fixture(t);
  const issued = await issuePassForPayment(f.env, f.pay());
  await queueRefundNotice(f.env, issued.pass);
  await cancelPass(f.env, issued.pass, { refundAmount: 0, refundConfirmed: true });
  await queueRefundNotice(f.env, issued.pass);
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE kind = 'refund'").length, 0);
});

test('프론트 취소 시작·실패에는 완료 알림 없음, SUCCESS 중복 결과에도 환불 알림 1건', async t => {
  const f = fixture(t);
  const token = 'test-device-token-with-long-length';
  f.sqlite.prepare("INSERT INTO kiosk_devices (id, name, status, token_hash) VALUES (1, '시험 단말', 'active', ?)").run(await deviceTokenHash(token));
  const pay = f.pay({ device_id: 1, approval_number: 'test-approval', approved_ts: 123 });
  await issuePassForPayment(f.env, pay);
  const staffToken = await makeStaffToken(f.env, 1);
  const call = body => refundResult({ env: f.env, request: new Request('https://socialfactory.co.kr/api/kiosk/refund', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ staffToken, paymentKey: pay.payment_key, ...body })
  }) });
  assert.equal((await call({ stage: 'start' })).status, 200);
  assert.equal((await call({ stage: 'result', type: 'FAILED' })).status, 200);
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE kind = 'refund'").length, 0);
  assert.equal((await call({ stage: 'result', type: 'SUCCESS', response: { card: { approvalNumber: 'cancel-approval' } } })).status, 200);
  assert.equal((await call({ stage: 'result', type: 'SUCCESS' })).status, 200);
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE kind = 'refund'").length, 1);
  assert.equal(f.one('SELECT status FROM pass_payments WHERE id = ?', pay.id).status, 'refunded');
});

test('관리자에서 나중에 환불 완료 확인을 하더라도 결제당 알림은 1건', async t => {
  const f = fixture(t), issued = await issuePassForPayment(f.env, f.pay());
  await cancelPass(f.env, issued.pass, { refundAmount: 3000 });
  const call = confirmed => adminPatch({ env: f.env, request: new Request('https://socialfactory.co.kr/api/admin/passes', {
    method: 'PATCH', headers: { authorization: 'Bearer ' + f.env.ADMIN_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'refund-notify', id: issued.pass.id, refundConfirmed: confirmed })
  }) });
  assert.equal((await call(false)).status, 400);
  assert.equal((await call(true)).status, 200);
  assert.equal((await call(true)).status, 200);
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE kind = 'refund'").length, 1);
});

test('만료 시각 변경 후 수동 재시도한 이전 만료 알림은 발송하지 않음', async t => {
  const f = fixture(t, true);
  const first = await issuePassForPayment(f.env, f.pay());
  const old = f.one("SELECT * FROM notification_jobs WHERE kind = 'expire_soon'");
  await issuePassForPayment(f.env, f.pay());
  f.sqlite.prepare("UPDATE notification_jobs SET status = 'logged' WHERE kind IN ('purchase', 'renewal')").run();
  f.sqlite.prepare("UPDATE notification_jobs SET status = 'queued', send_after = ? WHERE id = ?").run(kstNow(), old.id);
  const result = await runQueue(f.env);
  assert.equal(result.cancelled, 1);
  assert.equal(f.noNetwork.mock.callCount(), 0);
  assert.equal(f.one('SELECT status FROM passes WHERE id = ?', first.pass.id).status, 'active');
});

test('시험 결제와 취소된 이용권의 구매 알림은 수동 재시도해도 발송하지 않음', async t => {
  const f = fixture(t, true);
  await issuePassForPayment(f.env, f.pay({ test_mode: 1 }));
  assert.equal((await runQueue(f.env)).cancelled, 1);
  const second = await issuePassForPayment(f.env, f.pay());
  await cancelPass(f.env, second.pass);
  f.sqlite.prepare("UPDATE notification_jobs SET status = 'queued', send_after = ? WHERE kind = 'renewal'").run(kstNow());
  assert.equal((await runQueue(f.env)).cancelled, 1);
  assert.equal(f.noNetwork.mock.callCount(), 0);
});

test('동시 발송기 실행에도 동일 알림은 한 번만 요청', async t => {
  const f = fixture(t, true), api = apiMock(t);
  await issuePassForPayment(f.env, f.pay());
  await Promise.all([runQueue(f.env), runQueue(f.env)]);
  assert.equal(api.requests.length, 1);
});

test('알리고 요청 중 서버가 중단된 sending 건은 자동 재발송하지 않음', async t => {
  const f = fixture(t, true);
  await issuePassForPayment(f.env, f.pay());
  f.sqlite.prepare("UPDATE notification_jobs SET status = 'sending', provider = 'aligo', updated_at = '2000-01-01 00:00:00' WHERE kind = 'purchase'").run();
  await runQueue(f.env);
  assert.equal(f.one("SELECT status FROM notification_jobs WHERE kind = 'purchase'").status, 'failed');
  assert.equal(f.noNetwork.mock.callCount(), 0);
});

test('알리고 접수 후 DB 기록만 실패해도 자동 중복 발송하지 않음', async t => {
  const f = fixture(t, true), api = apiMock(t);
  await issuePassForPayment(f.env, f.pay());
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes("SET status = 'sent'")) statement.run = async () => { throw new Error('transient DB write error'); };
    return statement;
  };
  assert.equal((await runQueue(f.env)).failed, 1);
  await runQueue(f.env);
  assert.equal(api.requests.length, 1);
  assert.match(f.one("SELECT last_error FROM notification_jobs WHERE kind = 'purchase'").last_error, /접수 후 기록 실패/);
});

test('관리자 환불 API도 명시적 완료 확인 없이는 알림을 생성하지 않음', async t => {
  const f = fixture(t), first = await issuePassForPayment(f.env, f.pay());
  const call = (id, confirmed) => adminPatch({ env: f.env, request: new Request('https://socialfactory.co.kr/api/admin/passes', {
    method: 'PATCH', headers: { authorization: 'Bearer ' + f.env.ADMIN_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'cancel', id, refundAmount: 3000, refundConfirmed: confirmed })
  }) });
  assert.equal((await call(first.pass.id, false)).status, 200);
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE kind = 'refund'").length, 0);
  const second = await issuePassForPayment(f.env, f.pay());
  assert.equal((await call(second.pass.id, true)).status, 200);
  assert.equal(f.rows("SELECT * FROM notification_jobs WHERE kind = 'refund'").length, 1);
});
