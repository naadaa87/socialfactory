import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as sales } from '../functions/api/admin/sales.js';
import { fixture } from './helpers/parking-fixture.mjs';
import { ensureAutomation } from '../functions/_lib/parking-automation.js';

test('sales cards count parking sales per payment and margins per vehicle by payment date', async (t) => {
  const { db, env, req, now } = await fixture(t);
  now(Date.parse('2026-01-15T02:00:00Z'));
  await ensureAutomation(env);

  function record(id, tickets, { paidAt = '2026-01-05 12:00:00', status = 'paid', refund = 0, testMode = 0, matched = true } = {}) {
    const prices = { daily: 30000, '24h': 40000, '1h': 4000, '2h': 8000, '3h': 12000 };
    const amount = tickets.reduce((sum, ticket) => sum + prices[ticket], 0);
    db.prepare(`
      INSERT INTO orders(oid, product_id, product_name, qty, amount, buyer_name, buyer_phone, status, paid_at, tid, test_mode)
      VALUES (?, 'parking-multi', '주차권', ?, ?, '테스트', '01000000000', ?, ?, ?, ?)
    `).run(id, tickets.length, amount, status, paidAt, matched ? id : 'different-transaction', testMode);
    db.prepare('INSERT INTO payapp_payments(oid, mul_no, nonce, request_id, request_hash, refunded_amount) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, id, id, id, id, refund);
    const insert = db.prepare(`
      INSERT INTO parking_orders(oid, payment_oid, vehicle_price, ticket, plate, visit_date, terms)
      VALUES (?, ?, ?, ?, '123가4567', '2026-02-01', '{}')
    `);
    tickets.forEach((ticket, i) => insert.run(id + '-' + i, id, prices[ticket], ticket));
  }

  record('mixed', ['daily', '24h', '24h', '2h']);
  record('previous-month', ['daily'], { paidAt: '2025-12-31 23:59:59' });
  record('earlier', ['24h'], { paidAt: '2024-06-17 09:00:00' });
  record('hours', ['1h', '2h', '3h']);
  record('free-already-used', ['3h']);
  record('registration-in-progress', ['2h']);
  const setStatus = db.prepare('UPDATE parking_orders SET status = ? WHERE oid = ?');
  setStatus.run('applied', 'free-already-used-0');
  setStatus.run('processing', 'registration-in-progress-0');
  const claim = db.prepare(`
    INSERT INTO parking_automation_claims(oid, free_hours, paid_hours, cost, created_at)
    VALUES (?, 0, ?, ?, '2026-02-01 10:00:00')
  `);
  claim.run('free-already-used-0', 3, 9000);
  claim.run('registration-in-progress-0', 2, 6000);
  record('full-refund', ['24h'], { status: 'refunded', refund: 40000 });
  record('partial-refund', ['daily', '2h'], { refund: 8000 });
  record('test', ['daily'], { testMode: 1 });
  record('pending', ['24h'], { paidAt: null, status: 'pending' });
  record('unmatched', ['daily'], { matched: false });

  async function summary(query) {
    const response = await sales({
      env,
      request: req('/api/admin/sales?' + query, undefined, { authorization: 'Bearer ' + env.ADMIN_KEY })
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  const margin = { allTime: 108000, annual: 78000, thisMonth: 78000, lastMonth: 10000 };
  const salesAmounts = { allTime: 262000, annual: 192000, thisMonth: 192000, lastMonth: 30000 };
  for (const query of ['year=2026', 'year=2026&basis=use', 'year=2026&provider=payapp&orders=0']) {
    const report = await summary(query);
    assert.deepEqual(report.parkingMargin, margin);
    assert.deepEqual(report.parkingSales, salesAmounts);
  }
  const priorYear = await summary('year=2025');
  assert.deepEqual(priorYear.parkingMargin, { ...margin, annual: 10000 });
  assert.deepEqual(priorYear.parkingSales, { ...salesAmounts, annual: 30000 });
  const withoutOrders = await summary('year=2026&orders=0');
  assert.equal(withoutOrders.parkingMargin, null);
  assert.equal(withoutOrders.parkingSales, null);
});
