// One-tap "Add to Calendar" file for each upcoming event.
import type { APIRoute, GetStaticPaths } from 'astro';
import { getUpcomingEvents, type SiteEvent } from '../../lib/events';

export const getStaticPaths: GetStaticPaths = async () => {
  const events = await getUpcomingEvents();
  return events.map((event) => ({ params: { id: event.id }, props: { event } }));
};

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const day = (iso: string) => {
  // All-day events are stored as midnight New York time; take the New York calendar date.
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
  return d.replace(/-/g, '');
};

// Fold long lines at 75 octets per RFC 5545.
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) { out.push(cur); cur = ' '; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}

export const GET: APIRoute = ({ props, site }) => {
  const e = props.event as SiteEvent;
  const url = new URL('/events', site).toString();
  const desc = [...e.description, e.ticketUrl ? `Tickets: ${e.ticketUrl}` : '', url].filter(Boolean).join('\n\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Chaos Cellars//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.id}@chaos-cellars.com`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    ...(e.allDay
      ? [`DTSTART;VALUE=DATE:${day(e.start)}`, `DTEND;VALUE=DATE:${day(e.end)}`]
      : [`DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`]),
    `SUMMARY:${esc(`${e.title} — Chaos Cellars`)}`,
    ...([e.venue, e.address].some(Boolean) ? [`LOCATION:${esc([e.venue, e.address].filter(Boolean).join(', '))}`] : []),
    `DESCRIPTION:${esc(desc)}`,
    `URL:${url}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return new Response(lines.map(fold).join('\r\n') + '\r\n', {
    headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
  });
};
