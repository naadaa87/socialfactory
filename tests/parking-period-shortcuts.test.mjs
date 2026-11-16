import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFileSync}from'node:fs';
const context={window:{}};vm.runInNewContext(readFileSync(new URL('../js/parking-periods.js',import.meta.url),'utf8'),context);const period=(k,now)=>JSON.parse(JSON.stringify(context.window.SF_PARKING_PERIODS(k,Date.parse(now))));
test('빠른 기간 조회는 한국 시간과 월요일 시작·월말·윤년을 적용',()=>{
 assert.deepEqual(period('today','2026-11-15T15:01:00Z'),{start:'2026-11-16',end:'2026-11-16'});
 assert.deepEqual(period('yesterday','2026-01-01T00:00:00Z'),{start:'2025-12-31',end:'2025-12-31'});
 assert.deepEqual(period('week','2026-11-22T00:00:00Z'),{start:'2026-11-16',end:'2026-11-22'});
 assert.deepEqual(period('month','2028-02-15T00:00:00Z'),{start:'2028-02-01',end:'2028-02-29'});
});
