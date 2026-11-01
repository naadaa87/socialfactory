import { calendarReservationId } from './spacecloud-sales.js';

// SpaceCloud generates a new iCal UID on every request. Use booking facts,
// never the transport UID, to identify the same room occupancy across refreshes.
export function calendarEventIdentity(event) {
  const id = calendarReservationId(event.source_url);
  const title = String(event.title || '').normalize('NFC').trim();
  return `${id ? 'booking:' + id : 'manual:' + title}|${event.start}|${event.end}`;
}
