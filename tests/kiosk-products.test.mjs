import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { deviceTokenHash, issuePassForPayment } from "../functions/_lib/kiosk.js";
import { termsForPayment } from "../functions/_lib/kiosk-catalog.js";
import { onRequestGet as adminList, onRequestPost as adminCreate, onRequestPatch as adminEdit } from "../functions/api/admin/kiosk-products.js";
import { onRequestGet as frontList } from "../functions/api/kiosk/products.js";
import { onRequestPost as intent } from "../functions/api/kiosk/intents.js";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const DB = {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...values) { args = values; return stmt; },
        async first() { return sqlite.prepare(sql).get(...args) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async run() { return { meta: sqlite.prepare(sql).run(...args) }; }
      };
      return stmt;
    },
    async batch(stmts) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const stmt of stmts) out.push(await stmt.run());
        sqlite.exec("COMMIT"); return out;
      } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    }
  };
  return { sqlite, env: { DB, ADMIN_KEY: "test-admin", KIOSK_TEST: "1" } };
}
const adminReq = (method, body) => new Request("https://example.test/api/admin/kiosk-products", {
  method, headers: { authorization: "Bearer test-admin", "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined
});
const deviceReq = (method, token, path, body) => new Request("https://example.test/api/kiosk/" + path, {
  method, headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: body ? JSON.stringify(body) : undefined
});

test("admin product registration reaches kiosk list and intent; later edits do not alter the pending payment", async () => {
  const { sqlite, env } = fixture();
  const token = "sfk_test-token-one-long-enough";
  sqlite.prepare("INSERT INTO kiosk_devices (id,name,status,token_hash) VALUES (1,'Test front','active',?)").run(await deviceTokenHash(token));
  assert.equal((await adminList({ request: new Request("https://example.test/api/admin/kiosk-products"), env })).status, 401);
  const defaults = await (await adminList({ request: adminReq("GET"), env })).json();
  assert.equal(defaults.products.length, 7);
  assert.equal(defaults.products.find((p) => p.id === "seat-3m-friend").price, 193050);
  const entry = {
    name: "사물함 15일", short: "사물함을 15일 이용", price: 30000, listPrice: null,
    durationUnit: "days", durationValue: 15, group: "locker", category: "regular",
    image: "pass-15d.webp", sortOrder: 100, active: true
  };
  const created = await (await adminCreate({ request: adminReq("POST", entry), env })).json();
  assert.equal(created.ok, true);
  let list = await (await frontList({ request: deviceReq("GET", token, "products"), env })).json();
  assert(list.products.some((p) => p.id === created.id && p.price === 30000));
  const prepared = await (await intent({ request: deviceReq("POST", token, "intents", {
    productId: created.id, phone: "01012345678", agreePrivacy: true
  }), env })).json();
  assert.equal(prepared.amount, 30000);
  const edited = await (await adminEdit({ request: adminReq("PATCH", {
    ...entry, id: created.id, price: 50000, durationValue: 30, active: false
  }), env })).json();
  assert.equal(edited.ok, true);
  list = await (await frontList({ request: deviceReq("GET", token, "products"), env })).json();
  assert(!list.products.some((p) => p.id === created.id));
  const pay = sqlite.prepare("SELECT * FROM pass_payments WHERE payment_key = ?").get(prepared.paymentKey);
  assert.equal(pay.amount, 30000);
  const terms = await termsForPayment(env, pay);
  assert.equal(terms.duration.days, 15);
  const { pass } = await issuePassForPayment(env, pay, { startAt: "2026-10-27 12:00:00", purchaseNotice: false });
  assert.equal(pass.ends_at, "2026-11-11 12:00:00");
  const blocked = await intent({ request: deviceReq("POST", token, "intents", {
    productId: created.id, phone: "01012345678", agreePrivacy: true
  }), env });
  assert.equal(blocked.status, 400);
});

test("invalid prices and unsupported image names cannot enter the kiosk catalog", async () => {
  const { env } = fixture();
  const base = { name: "테스트 이용권", short: "", price: 4000, listPrice: null, durationUnit: "hours",
    durationValue: 2, group: "seat", category: "day", image: "pass-2h.webp", sortOrder: 10, active: true };
  for (const bad of [{ price: 0 }, { image: "../other.png" }, { durationValue: 0 }, { category: "unknown" }]) {
    const r = await adminCreate({ request: adminReq("POST", { ...base, ...bad }), env });
    assert.equal(r.status, 400);
  }
});

test("editing a seeded product freezes terms for payments created before catalog management", async () => {
  const { sqlite, env } = fixture();
  sqlite.prepare("INSERT INTO customers (id,phone) VALUES (1,'01012345678')").run();
  sqlite.prepare(
    "INSERT INTO pass_payments (payment_key,customer_id,product_id,product_name,amount) VALUES ('SFKLEGACY12345678',1,'seat-1m','1개월 이용권',99000)"
  ).run();
  const old = (await (await adminList({ request: adminReq("GET"), env })).json()).products.find((p) => p.id === "seat-1m");
  const changed = await adminEdit({ request: adminReq("PATCH", {
    id: old.id, name: old.name, short: old.short, price: 120000, listPrice: null,
    durationUnit: "months", durationValue: 2, group: old.group, category: old.category,
    image: old.image, sortOrder: old.sortOrder, active: true
  }), env });
  assert.equal(changed.status, 200);
  const pay = sqlite.prepare("SELECT * FROM pass_payments WHERE payment_key = 'SFKLEGACY12345678'").get();
  assert.equal((await termsForPayment(env, pay)).duration.months, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM kiosk_payment_terms").get().n, 1);
});
