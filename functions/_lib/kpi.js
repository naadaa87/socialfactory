/**
 * 관리자 KPI 계산 도구 — 예약률 · 이용인원처럼 SQL만으로 세기 어려운 부분을 여기서 계산합니다.
 * - 예약률: 1~5번룸 각각 '24시간 × 기간 일수'를 분모로, 확정 예약이 차지한 시간을 분자로 씁니다.
 *   자정을 넘는 예약은 날짜별로 나누고, 같은 방에서 겹치는 시간은 한 번만 셉니다.
 * - 이용인원: 기록된 인원을 쓰고, 기록이 없으면 그 방 최대 인원의 절반(반올림)으로 셉니다.
 */
import '../../js/booking-rates.js';
import { addDaysIso, isIsoDate } from './admin.js';

export const RATES = globalThis.SF_BOOKING_RATES;
export const ROOMS = ['r1', 'r2', 'r3', 'r4', 'r5'];
export const ROOM_NAMES = { r1: '1번룸', r2: '2번룸', r3: '3번룸', r4: '4번룸', r5: '5번룸' };
export const MAX_SPAN_DAYS = 731;

export const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 864e5) + 1;
export const weekdayOf = date => (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;   // 월=0 … 일=6
export const monthEnd = ym => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);

/** 기간 확인 — 기본은 이번 달 1일 ~ 말일 */
export function parsePeriod(params, today) {
  let from = params.get('from') || '', to = params.get('to') || '';
  if (!from && !to) { from = today.slice(0, 7) + '-01'; to = monthEnd(today.slice(0, 7)); }
  if (!isIsoDate(from) || !isIsoDate(to)) return { error: '기간을 날짜(YYYY-MM-DD)로 골라 주세요.' };
  if (from > to) return { error: '시작일이 종료일보다 늦습니다.' };
  const days = daysBetween(from, to);
  if (days > MAX_SPAN_DAYS) return { error: '기간은 2년 이내로 골라 주세요.' };
  const basis = params.get('basis') === 'paid' ? 'paid' : 'use';
  const bucket = days <= 62 ? 'day' : 'month';
  const prevTo = addDaysIso(from, -1), prevFrom = addDaysIso(from, -days);
  return { from, to, days, basis, bucket, prev: { from: prevFrom, to: prevTo } };
}

/** 기간 안의 묶음(날짜 또는 월) 목록 */
export function bucketKeys(from, to, bucket) {
  const out = [];
  if (bucket === 'day') { for (let d = from; d <= to; d = addDaysIso(d, 1)) out.push(d); return out; }
  for (let ym = from.slice(0, 7); ym <= to.slice(0, 7); ) {
    out.push(ym);
    const [y, m] = ym.split('-').map(Number);
    ym = m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
  }
  return out;
}
export const bucketOf = (date, bucket) => bucket === 'day' ? date.slice(0, 10) : date.slice(0, 7);

/** 각 묶음에 실제로 들어 있는 날 수 (기간 경계에 걸린 달은 일부만) */
export function bucketDays(from, to, bucket) {
  const out = {};
  for (let d = from; d <= to; d = addDaysIso(d, 1)) { const k = bucketOf(d, bucket); out[k] = (out[k] || 0) + 1; }
  return out;
}

/** 예약 하나를 날짜별 조각으로 나눕니다. {date, start_min, end_min(최대 2880)} → [{date, s, e}] */
export function segments(row) {
  const out = [], start = Number(row.start_min), end = Number(row.end_min);
  if (!isIsoDate(row.date) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return out;
  for (let m = Math.max(0, start); m < end;) {
    const day = Math.floor(m / 1440), stop = Math.min(end, (day + 1) * 1440);
    out.push({ date: addDaysIso(row.date, day), s: m - day * 1440, e: stop - day * 1440 });
    m = stop;
  }
  return out;
}

/** 겹치는 구간을 합칩니다. */
export function union(list) {
  const sorted = list.slice().sort((a, b) => a.s - b.s), out = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e) last.e = Math.max(last.e, x.e);
    else out.push({ s: x.s, e: x.e });
  }
  return out;
}

/** 예약률 — rows: 확정 예약(관리자 기록 + 외부 일정 합친 것) */
export function occupancy(rows, from, to, bucket) {
  const keys = bucketKeys(from, to, bucket), daysIn = bucketDays(from, to, bucket), days = daysBetween(from, to);
  const perDay = {};   // room|date → [{s,e}]
  for (const r of rows) {
    if (!ROOMS.includes(r.space)) continue;
    for (const seg of segments(r)) {
      if (seg.date < from || seg.date > to) continue;
      (perDay[r.space + '|' + seg.date] ||= []).push(seg);
    }
  }
  const byRoom = {}, series = {}, heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  ROOMS.forEach(k => { byRoom[k] = { minutes: 0, available: days * 1440, rate: 0 }; });
  keys.forEach(k => { series[k] = { minutes: 0, available: (daysIn[k] || 0) * 1440 * ROOMS.length, byRoom: Object.fromEntries(ROOMS.map(r => [r, 0])) }; });
  for (const [key, list] of Object.entries(perDay)) {
    const [room, date] = key.split('|'), w = weekdayOf(date), b = bucketOf(date, bucket);
    for (const { s, e } of union(list)) {
      const mins = e - s;
      byRoom[room].minutes += mins;
      if (series[b]) { series[b].minutes += mins; series[b].byRoom[room] += mins; }
      for (let h = Math.floor(s / 60); h < Math.ceil(e / 60) && h < 24; h++) heat[w][h] += Math.min(e, (h + 1) * 60) - Math.max(s, h * 60);
    }
  }
  // 요일별 날 수 (히트맵 분모)
  const wdCount = Array(7).fill(0);
  for (let d = from; d <= to; d = addDaysIso(d, 1)) wdCount[weekdayOf(d)]++;
  const heatRate = heat.map((row, w) => row.map(m => wdCount[w] ? m / (wdCount[w] * 60 * ROOMS.length) * 100 : 0));
  let minutes = 0;
  ROOMS.forEach(k => { minutes += byRoom[k].minutes; byRoom[k].rate = byRoom[k].minutes / byRoom[k].available * 100; });
  Object.values(series).forEach(x => { x.rate = x.available ? x.minutes / x.available * 100 : 0; x.roomRate = Object.fromEntries(ROOMS.map(r => [r, x.available ? x.byRoom[r] / (x.available / ROOMS.length) * 100 : 0])); });
  const available = days * 1440 * ROOMS.length;
  return { minutes, available, rate: available ? minutes / available * 100 : 0, byRoom, series, heat: heatRate };
}

/** 인원 — 기록이 없으면 최대 인원의 절반 */
export function peopleOf(row) {
  const n = Number(row.people), max = Number(RATES.rooms[row.space]?.max) || 0;
  if (Number.isInteger(n) && n > 0) return { n, estimated: false };
  return { n: Math.round(max / 2), estimated: true };
}

/** 외부 일정은 날짜별로 나뉘어 있으므로 원래 예약 하나로 다시 묶습니다. */
export function bookingKey(row) {
  if (row.external && row.source_start != null) return row.space + '|' + row.source_start + '|' + row.source_end;
  return row.code || row.space + '|' + row.date + '|' + row.start_min;
}
