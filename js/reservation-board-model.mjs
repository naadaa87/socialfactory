// Pure presentation logic, shared with time-boundary tests. All times are epoch ms.
export const ROOM_IDS = ['r1', 'r2', 'r3', 'r4', 'r5'];
export const ROOM_GUIDES = {
  r1: { direction:'왼쪽 복도', location:'지도 아래쪽 가운데', arrow:'←' },
  r2: { direction:'왼쪽 복도', location:'지도 왼쪽 아래', arrow:'←' },
  r3: { direction:'왼쪽 복도', location:'지도 왼쪽 가운데', arrow:'←' },
  r4: { direction:'왼쪽 복도', location:'지도 왼쪽 맨 위', arrow:'←' },
  r5: { direction:'오른쪽', location:'지도 오른쪽 · 휴게 공간 옆', arrow:'→' }
};

// Independent of reservation render/refresh and the demo's fixed clock.
export function createRoomTour(start, duration=8000) {
  let anchor=start, offset=0, pausedAt=null;
  const sample=at=>{
    const elapsed=Math.max(0,(pausedAt ?? at)-anchor), step=Math.floor(elapsed/duration);
    return {room:ROOM_IDS[(offset+step)%ROOM_IDS.length],progress:(elapsed%duration)/duration,paused:pausedAt!==null};
  };
  return {sample,
    select(id,at){if(!ROOM_IDS.includes(id))return;offset=ROOM_IDS.indexOf(id);anchor=at;if(pausedAt!==null)pausedAt=at;},
    pause(at){if(pausedAt===null)pausedAt=at;},
    resume(at){if(pausedAt!==null){anchor+=at-pausedAt;pausedAt=null;}}
  };
}
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
