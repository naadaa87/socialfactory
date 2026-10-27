import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readKioskUi, saveKioskUi } from '../functions/_lib/kiosk-ui.js';
import { onRequestGet, onRequestPut } from '../functions/api/admin/kiosk-ui.js';
import { onRequestGet as getProducts } from '../functions/api/kiosk/products.js';
import { deviceTokenHash } from '../functions/_lib/kiosk.js';
import { KIOSK_PRODUCTS } from '../functions/_lib/kiosk-products.js';

const uiCode = readFileSync(new URL('../toss-front-plugin/ui.js', import.meta.url), 'utf8');
const appCode = readFileSync(new URL('../toss-front-plugin/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  const DB = { prepare(sql) {
    let args = [];
    return { bind(...values) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
    };
  }, async batch(stmts) {
    sqlite.exec('BEGIN');
    try { const result = []; for (const stmt of stmts) result.push(await stmt.run()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const env = { DB, ADMIN_KEY: 'test-only-admin-key' };
  const request = (method = 'GET', body, authenticated = true) => new Request('https://socialfactory.co.kr/api/admin/kiosk-ui', {
    method, headers: authenticated ? { authorization: 'Bearer ' + env.ADMIN_KEY, 'content-type': 'application/json' } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { env, sqlite, request };
}

test('기존 DB에 설정 표가 없어도 기본 목록형으로 조회하고 자동 준비', async t => {
  const f = fixture(t);
  f.sqlite.exec('DROP TABLE kiosk_ui_settings');
  const result = await readKioskUi(f.env);
  assert.deepEqual(result, { categoryLayout: 'list', productLayout: 'list', updatedAt: null });
  assert(f.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'kiosk_ui_settings'").get());
});

test('화면 설정 조회·변경 API는 익명 사용자의 접근을 거절', async t => {
  const f = fixture(t);
  assert.equal((await onRequestGet({ env: f.env, request: f.request('GET', undefined, false) })).status, 401);
  assert.equal((await onRequestPut({ env: f.env, request: f.request('PUT', { layout: { categoryLayout: 'grid', productLayout: 'grid' } }, false) })).status, 401);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM kiosk_ui_settings').get().n, 0);
});

test('관리자에서 선택한 두 화면 구성을 저장하고 다시 열면 그대로 조회', async t => {
  const f = fixture(t);
  const layout = { categoryLayout: 'grid', productLayout: 'list' };
  const response = await onRequestPut({ env: f.env, request: f.request('PUT', { layout }) });
  assert.equal(response.status, 200);
  const result = await (await onRequestGet({ env: f.env, request: f.request() })).json();
  assert.equal(result.layout.categoryLayout, 'grid'); assert.equal(result.layout.productLayout, 'list');
  assert(result.layout.updatedAt); assert.equal(result.products.length, KIOSK_PRODUCTS.length);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM pass_payments').get().n, 0);
});

test('열 개수·알 수 없는 레이아웃·불완전한 설정은 저장하지 않고 기존 선택 보존', async t => {
  const f = fixture(t);
  await saveKioskUi(f.env, { categoryLayout: 'grid', productLayout: 'list' });
  for (const layout of [null, [], { categoryLayout: 'tabs', productLayout: 'list' }, { categoryLayout: 'grid' }, { categoryLayout: 'list', productLayout: 'list', columns: 3 }]) {
    const response = await onRequestPut({ env: f.env, request: f.request('PUT', { layout }) });
    assert.equal(response.status, 400);
  }
  assert.equal((await readKioskUi(f.env)).categoryLayout, 'grid');
});

test('연결된 단말기만 상품과 저장된 레이아웃을 읽을 수 있음', async t => {
  const f = fixture(t), token = 'test-only-long-device-token';
  await saveKioskUi(f.env, { categoryLayout: 'list', productLayout: 'grid' });
  f.sqlite.prepare("INSERT INTO kiosk_devices (name, status, token_hash) VALUES ('시험', 'active', ?)").run(await deviceTokenHash(token));
  const request = authorization => new Request('https://socialfactory.co.kr/api/kiosk/products', { headers: authorization ? { authorization } : {} });
  assert.equal((await getProducts({ env: f.env, request: request() })).status, 401);
  const result = await (await getProducts({ env: f.env, request: request('Bearer ' + token) })).json();
  assert.equal(result.layout.productLayout, 'grid');
  assert.equal(result.products[0].price, KIOSK_PRODUCTS[0].price);
});

test('어드민·단말기 공통 화면 모델은 그리드의 공개 필드만 사용하고 최종 가격 표시', () => {
  const context = vm.createContext({}); vm.runInContext(uiCode, context);
  const UI = context.SF_KIOSK_UI;
  let selected;
  const grid = UI.productPage(KIOSK_PRODUCTS, 'friend', 'grid', product => { selected = product; });
  assert.equal(grid.method, 'renderSelectGridPage');
  for (const item of grid.params.options) assert.deepEqual(Object.keys(item).sort(), ['id', 'onClick', 'title']);
  assert(grid.params.options[0].title.includes('64,350원'));
  grid.params.options[1].onClick(); assert.equal(selected.id, 'seat-3m-friend');
  const list = UI.productPage(KIOSK_PRODUCTS, 'friend', 'list', () => {});
  assert.equal(list.params.options[0].subtitle, '64,350원');
  assert.equal(list.params.options[0].description, '35% 할인 · 1인 가격');
});

function pluginHarness(initial, gridSupported = true) {
  const rendered = [], requests = [], storage = new Map([['sf_kiosk_token', 'mock-token']]);
  let remoteLayout = initial;
  const template = {};
  for (const method of ['renderIdlePage', 'renderSelectPage', 'renderInputPage', 'renderAgreementPage', 'renderOrderPage', 'renderResultPage', 'renderOnboardingPage', ...(gridSupported ? ['renderSelectGridPage'] : [])]) {
    template[method] = params => rendered.push({ method, params });
  }
  template.openToast = () => {};
  const window = { SF_PLUGIN: { apiBase: 'https://mock.test' }, TossFrontSDK: { template, storage: {
    async get({ key }) { return { value: storage.get(key) || null }; }, async set() {}, async remove() {}
  } } };
  const context = vm.createContext({ window, location: { hostname: 'mock.test', href: 'https://mock.test/plugin/index.html' }, URL, AbortController, setTimeout, clearTimeout, console,
    fetch: async (url, options) => {
      requests.push({ url, options });
      assert.equal(new URL(url).pathname, '/api/kiosk/products');
      return new Response(JSON.stringify({ ok: true, products: KIOSK_PRODUCTS, layout: remoteLayout }));
    }
  });
  vm.runInContext(uiCode, context); vm.runInContext(appCode, context);
  return { requests, setRemote(value) { remoteLayout = value; }, get current() { return rendered.at(-1); } };
}

test('설정은 구매 시작 시 새로 읽고 뒤로가기 등 구매 도중에는 레이아웃을 바꾸지 않음', async () => {
  const h = pluginHarness({ categoryLayout: 'grid', productLayout: 'list' }); await tick();
  h.current.params.primaryButton.onClick(); await tick();
  assert.equal(h.current.method, 'renderSelectGridPage');
  h.setRemote({ categoryLayout: 'list', productLayout: 'grid' });
  h.current.params.options[0].onClick(); assert.equal(h.current.method, 'renderSelectPage');
  h.current.params.onBack(); assert.equal(h.current.method, 'renderSelectGridPage');
  assert.equal(h.requests.length, 1);
  h.current.params.onBack(); h.current.params.primaryButton.onClick(); await tick();
  assert.equal(h.current.method, 'renderSelectPage');
  h.current.params.options[0].onClick(); assert.equal(h.current.method, 'renderSelectGridPage');
  assert.equal(h.requests.length, 2);
  h.current.params.options[0].onClick(); assert.equal(h.current.method, 'renderInputPage');
  assert(h.current.params.top.subtitle.includes('4,000원'));
});

test('구형 SDK에 그리드 API가 없으면 목록형으로 계속 구매 가능', async () => {
  const h = pluginHarness({ categoryLayout: 'grid', productLayout: 'grid' }, false); await tick();
  h.current.params.primaryButton.onClick(); await tick();
  assert.equal(h.current.method, 'renderSelectPage');
  h.current.params.options[0].onClick(); assert.equal(h.current.method, 'renderSelectPage');
  h.current.params.options[0].onClick(); assert.equal(h.current.method, 'renderInputPage');
});

test('운영에서 편집한 카테고리·사용자 상품·업로드 이미지와 판매 중지 상태를 미리보기에 반영', async t => {
  const f = fixture(t);
  await onRequestGet({ env: f.env, request: f.request() });
  f.sqlite.prepare("INSERT INTO kiosk_categories (id,name,description,image,sort_order) VALUES ('locker','보관함','개인 보관함','pass-1m.webp',40)").run();
  f.sqlite.prepare("INSERT INTO kiosk_products (id,name,price,duration_unit,duration_value,pass_group,image,short,category,active,sort_order) VALUES ('custom-locker','개인 사물함',12500,'months',1,'locker','pass-1m.webp','한 달 보관','locker',1,10)").run();
  f.sqlite.prepare("INSERT INTO kiosk_product_images (product_id,data_base64,version) VALUES ('custom-locker','AA==',3)").run();
  f.sqlite.prepare("INSERT INTO kiosk_category_images (category_id,data_base64,version) VALUES ('locker','AA==',4)").run();
  f.sqlite.prepare("UPDATE kiosk_products SET active=0 WHERE id='seat-2h'").run();
  const result = await (await onRequestGet({ env: f.env, request: f.request() })).json();
  assert(!result.products.some(p => p.id === 'seat-2h'));
  assert(result.categories.some(c => c.id === 'locker' && c.name === '보관함'));
  assert(result.products.find(p => p.id === 'custom-locker').imageUrl.endsWith('/custom-locker?v=3'));
  const context = vm.createContext({}); vm.runInContext(uiCode, context);
  const UI = context.SF_KIOSK_UI;
  const categoryPage = UI.categoryPage('list', () => {}, () => '', result.categories, result.products);
  assert(categoryPage.params.options.some(o => o.title === '보관함' && o.iconUrl.endsWith('/locker?v=4')));
  const page = UI.productPage(result.products, 'locker', 'list', () => {}, () => '', result.categories);
  assert.equal(page.params.title, '보관함');
  assert.equal(page.params.options[0].title, '개인 사물함');
  assert.equal(page.params.options[0].subtitle, '12,500원');
});
