// Pure presentation logic, shared with time-boundary tests. All times are epoch ms.
export const ROOM_IDS = ['r1', 'r2', 'r3', 'r4', 'r5'];
export function roomSchedule(rows, room, now) {
  const bookings = rows.filter(r => r.room === room).sort((a, b) => a.start - b.start);
  return { current: bookings.filter(r => r.start <= now && now < r.end),
    next: bookings.find(r => r.start > now) || null };
}
export function kstDay(now) { return new Date(now + 9 * 3600000).toISOString().slice(0, 10); }
export function formatTime(ts, date) {
  if (ts === Date.parse(date + 'T00:00:00+09:00') + 86400000) return '24:00';
  return new Date(ts + 9 * 3600000).toISOString().slice(11, 16);
}
export function isOutdated(data, now, receivedAt) {
  return !data || data.date !== kstDay(now) || now - receivedAt > 180000 || now - data.generated_at > 180000;
}
