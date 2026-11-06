import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarGridDates} from '../calendar.mjs';
import {QueueClient} from '../queue.mjs';

test('live host calendar padded day labels include adjacent months without shifting dates',()=>{
  const labels=Array.from({length:35},(_,i)=>String(new Date(Date.UTC(2026,10,29+i)).getUTCDate()).padStart(2,'0'));
  const dates=calendarGridDates('2026.12',labels);
  assert.equal(dates[0],'2026-11-29');assert.equal(dates[2],'2026-12-01');assert.equal(dates[16],'2026-12-15');assert.equal(dates[34],'2027-01-02');
});

test('default queue transport preserves the global fetch receiver used by Workers',async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async function(){assert.equal(this,globalThis);return Response.json({ok:true,job:null});};
  try {assert.equal(await new QueueClient({origin:'https://example.test',token:'x'.repeat(32)}).claim(),null);}
  finally {globalThis.fetch=previous;}
});
