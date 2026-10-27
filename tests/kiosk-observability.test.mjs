import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { deviceTokenHash, staffTokenOk, deviceFromRequest } from "../functions/_lib/kiosk.js";
import { onRequestPost as staff } from "../functions/api/kiosk/staff.js";
import { onRequestPost as log } from "../functions/api/kiosk/logs.js";
import { onRequestGet as readLogs } from "../functions/api/admin/kiosk-logs.js";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const queries = [];
  const DB = {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...values) { args = values; return stmt; },
        async first() { queries.push(sql); return sqlite.prepare(sql).get(...args) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { queries.push(sql); return { meta: sqlite.prepare(sql).run(...args) }; }
      };
      return stmt;
    },
    async batch(stmts) {
      for (const stmt of stmts) await stmt.run();
    }
  };
  return { sqlite, queries, env: { DB, ADMIN_KEY: "test-admin", KIOSK_STAFF_PIN: "12345678" } };
}
const req = (url, token, body) => new Request(url, {
  method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: JSON.stringify(body)
});

test("five failed staff PINs lock only new PIN entries for that device", async () => {
  const { sqlite, env } = fixture();
  const a = "sfk_test-token-one-long-enough", b = "sfk_test-token-two-long-enough";
  sqlite.prepare("INSERT INTO kiosk_devices (id,name,status,token_hash) VALUES (1,'A','active',?)").run(await deviceTokenHash(a));
  sqlite.prepare("INSERT INTO kiosk_devices (id,name,status,token_hash) VALUES (2,'B','active',?)").run(await deviceTokenHash(b));
  const granted = await (await staff({ request: req("https://example.test/api/kiosk/staff", a, { pin: "12345678" }), env })).json();
  assert.equal(granted.ok, true);
  for (let i = 0; i < 5; i++)
    assert.equal((await staff({ request: req("https://example.test/api/kiosk/staff", a, { pin: "00000000" }), env })).status, 403);
  const locked = await staff({ request: req("https://example.test/api/kiosk/staff", a, { pin: "12345678" }), env });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error, "too-many");
  assert.equal(await staffTokenOk(env, 1, granted.staffToken), true);
  assert.equal((await staff({ request: req("https://example.test/api/kiosk/staff", b, { pin: "12345678" }), env })).status, 200);
});

test("device error logs are idempotent, private, and readable only by admin", async () => {
  const { sqlite, env } = fixture();
  const token = "sfk_test-token-one-long-enough";
  sqlite.prepare("INSERT INTO kiosk_devices (id,name,status,token_hash) VALUES (1,'A','active',?)").run(await deviceTokenHash(token));
  const key = "SFK261027123456ABCDEFGH";
  sqlite.prepare("INSERT INTO customers (id,phone) VALUES (1,'01012345678')").run();
  sqlite.prepare("INSERT INTO pass_payments (payment_key,device_id,customer_id,product_id,product_name,amount) VALUES (?,1,1,'seat-2h','2시간',4000)").run(key);
  const event = { eventId: "Kabc123456789012", paymentKey: key, kind: "PAYMENT_RECOVERY_FAILED", code: "NETWORK", httpStatus: 0 };
  const body = { events: [event] };
  assert.equal((await log({ request: req("https://example.test/api/kiosk/logs", token, body), env })).status, 200);
  assert.equal((await log({ request: req("https://example.test/api/kiosk/logs", token, body), env })).status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_error_logs").get().n, 1);
  assert.equal((await log({ request: req("https://example.test/api/kiosk/logs", token, { events: [{ ...event, eventId: "Kabc123456789013", phone: "01012345678" }] }), env })).status, 200);
  const row = sqlite.prepare("SELECT * FROM kiosk_error_logs LIMIT 1").get();
  assert.equal(row.payment_key, key);
  assert(!JSON.stringify(row).includes("01012345678"));
  const unauth = await readLogs({ request: new Request("https://example.test/api/admin/kiosk-logs"), env });
  assert.equal(unauth.status, 401);
  const auth = await readLogs({ request: new Request("https://example.test/api/admin/kiosk-logs", { headers: { authorization: "Bearer test-admin" } }), env });
  assert.equal(auth.status, 200);
  assert.equal((await auth.json()).results.length, 2);
});

test("last-seen writes are throttled but device revocation is checked every request", async () => {
  const { sqlite, env, queries } = fixture();
  const token = "sfk_fixture-device-token-for-latency";
  sqlite.prepare("INSERT INTO kiosk_devices (id,name,status,token_hash) VALUES (1,'Fixture','active',?)").run(await deviceTokenHash(token));
  const request = new Request("https://example.test/api/kiosk/lookup", { headers: { authorization: "Bearer " + token } });
  assert(await deviceFromRequest(request, env)); assert(await deviceFromRequest(request, env));
  assert.equal(queries.filter(q => q.startsWith("UPDATE kiosk_devices SET last_seen_at")).length, 1);
  sqlite.prepare("UPDATE kiosk_devices SET status='revoked' WHERE id=1").run();
  assert.equal(await deviceFromRequest(request, env), null);
  assert.equal(queries.filter(q => q.startsWith("SELECT id, name, status FROM kiosk_devices")).length, 3);
});
