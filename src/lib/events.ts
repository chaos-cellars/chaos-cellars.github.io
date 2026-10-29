// Loads upcoming events at build time.
//
// Source of truth is the public "Chaos Cellars Events" Google Calendar (see
// src/data/sources.json). The site rebuilds hourly, so anything added, edited
// or deleted in the calendar shows up within the hour, and past events drop
// off on their own. If no calendar is configured, src/data/events.json is used.
//
// How a calendar entry maps onto the page:
//   Title        → event name ("SOLD OUT" anywhere in it shows a Sold Out badge)
//   Location     → venue + address ("Venue Name, 123 Main St, Town, NY")
//   Description  → the blurb; links in it become buttons:
//                    ticket sites       → "Get Tickets"
//                    instagram.com      → "View on Instagram"
//                    an image / Drive file link → the event flyer
//                    anything else      → "More Info"
import ICAL from 'ical.js';
import sources from '../data/sources.json';
import fallbackEvents from '../data/events.json';

export const SITE_TZ = 'America/New_York';

export interface SiteEvent {
  id: string;
  title: string;
  start: string; // ISO
  end: string; // ISO
  allDay: boolean;
  venue: string;
  address: string;
  mapsUrl: string;
  description: string[]; // paragraphs
  ticketUrl: string | null;
  instagramUrl: string | null;
  moreUrl: string | null;
  flyer: string | null;
  soldOut: boolean;
}

export function calendarIcsUrl(): string | null {
  if (process.env.EVENTS_ICS_URL) return process.env.EVENTS_ICS_URL; // local testing
  const id = sources.eventsCalendarId.trim();
  if (!id) return null;
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
}

export function calendarSubscribeUrl(): string | null {
  const id = sources.eventsCalendarId.trim();
  if (!id) return null;
  return `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(id)}`;
}

let cache: Promise<SiteEvent[]> | null = null;

/** Upcoming (not yet ended) events, soonest first. Cached per build. */
export function getUpcomingEvents(now = new Date()): Promise<SiteEvent[]> {
  cache ??= load(now);
  return cache;
}

async function load(now: Date): Promise<SiteEvent[]> {
  const url = calendarIcsUrl();
  const all = url ? parseIcs(await fetchWithRetry(url), now) : fromJson();
  const upcoming = all
    .filter((e) => new Date(e.end) > now)
    .sort((a, b) => a.start.localeCompare(b.start));
  // Two same-named events on one day would share an id (and an .ics URL).
  const seen = new Map<string, number>();
  for (const e of upcoming) {
    const n = (seen.get(e.id) ?? 0) + 1;
    seen.set(e.id, n);
    if (n > 1) e.id = `${e.id}-${n}`;
  }
  return upcoming;
}

async function fetchWithRetry(url: string, tries = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  // Failing the build keeps the last good version of the site live.
  throw new Error(`Could not fetch events calendar (${url}): ${lastErr}`);
}

// ── ICS → SiteEvent ─────────────────────────────────────────────────────────

const HORIZON_DAYS = 400;
const MAX_OCCURRENCES = 60;

export function parseIcs(text: string, now = new Date()): SiteEvent[] {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    ICAL.TimezoneService.register(new ICAL.Timezone(tz));
  }

  const vevents = root.getAllSubcomponents('vevent');
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const comp of vevents) {
    const ev = new ICAL.Event(comp);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) {
    const master = masters.get(ex.uid);
    if (master) master.relateException(ex);
    else masters.set(`${ex.uid}#${ex.recurrenceId}`, ex);
  }

  const horizon = new Date(now.getTime() + HORIZON_DAYS * 864e5);
  const out: SiteEvent[] = [];

  for (const master of masters.values()) {
    if (!master.isRecurring()) {
      if (!isCancelled(master)) out.push(toSiteEvent(master, master.startDate, master.endDate, master.uid));
      continue;
    }
    const it = master.iterator();
    let count = 0;
    for (let next = it.next(); next && count < MAX_OCCURRENCES; next = it.next()) {
      const occ = master.getOccurrenceDetails(next);
      const start = toJsDate(occ.startDate);
      if (start > horizon) break;
      if (toJsDate(occ.endDate) <= now) continue;
      if (isCancelled(occ.item)) continue;
      out.push(toSiteEvent(occ.item, occ.startDate, occ.endDate, `${master.uid}-${start.getTime()}`));
      count++;
    }
  }
  return out;
}

function isCancelled(ev: ICAL.Event): boolean {
  return String(ev.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

function toSiteEvent(ev: ICAL.Event, startT: ICAL.Time, endT: ICAL.Time | null, uid: string): SiteEvent {
  const allDay = startT.isDate;
  const start = toJsDate(startT);
  let end = endT ? toJsDate(endT) : null;
  if (!end || end <= start) {
    end = new Date(start.getTime() + (allDay ? 864e5 : 3 * 36e5));
  }

  const rawTitle = (ev.summary ?? '').trim() || 'Chaos Cellars Tasting';
  const soldOut = /sold\s*out/i.test(rawTitle);
  const title = soldOut
    ? rawTitle.replace(/\s*[([]\s*sold\s*out\s*[)\]]\s*|[\s\-–—:|]*sold\s*out[\s\-–—:|]*/i, ' ').trim() || rawTitle
    : rawTitle;

  const { venue, address } = splitLocation(ev.location ?? '');
  const desc = parseDescription(ev.description ?? '');

  return {
    id: slugify(`${start.toISOString().slice(0, 10)}-${title}`) || slugify(uid),
    title,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
    venue,
    address,
    mapsUrl: mapsUrl([venue, address].filter(Boolean).join(', ')),
    ...desc,
    soldOut,
  };
}

/** Floating times and all-day dates are interpreted in the winery's time zone. */
function toJsDate(t: ICAL.Time): Date {
  const tzid = t.zone?.tzid;
  if (t.isDate || !tzid || tzid === 'floating') {
    return zonedToUtc(t.year, t.month, t.day, t.isDate ? 0 : t.hour, t.isDate ? 0 : t.minute);
  }
  return t.toJSDate();
}

function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz = SITE_TZ): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = tzOffsetMs(new Date(guess), tz);
  const first = guess - offset;
  // Re-check across DST boundaries.
  return new Date(guess - tzOffsetMs(new Date(first), tz));
}

function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// ── Location ────────────────────────────────────────────────────────────────

export function splitLocation(raw: string): { venue: string; address: string } {
  const parts = raw
    .replace(/\\,/g, ',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  while (parts.length && /^(USA|United States( of America)?|US)$/i.test(parts[parts.length - 1])) parts.pop();
  if (!parts.length) return { venue: '', address: '' };
  const firstStreet = parts.findIndex((p) => /^\d/.test(p));
  if (firstStreet > 0) {
    return { venue: parts.slice(0, firstStreet).join(', '), address: parts.slice(firstStreet).join(', ') };
  }
  if (firstStreet === 0) return { venue: '', address: parts.join(', ') };
  // No street number. "Buffalo, NY" is just a town; "Visitors Center, Watkins Glen, NY" is venue + town.
  if (parts.length <= 2 && /^[A-Z]{2}(\s+\d{5})?$/.test(parts[parts.length - 1])) {
    return { venue: '', address: parts.join(', ') };
  }
  return { venue: parts[0], address: parts.slice(1).join(', ') };
}

export function mapsUrl(query: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

// ── Description ─────────────────────────────────────────────────────────────

const TICKET_RE = /eventbrite|ticket|tix|tock\.com|exploretock|universe\.com|square\.link|squareup|withfriends|humanitix|showclix|simpletix/i;
const IMAGE_RE = /\.(jpe?g|png|webp|gif)(\?.*)?$/i;

export function parseDescription(raw: string) {
  const hrefs: string[] = [];
  let text = raw
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      hrefs.push(decodeEntities(href));
      return label;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);

  const urls = [...hrefs];
  text = text.replace(/https?:\/\/[^\s<>"')\]]+/g, (u) => {
    urls.push(u);
    return '';
  });

  let ticketUrl: string | null = null;
  let instagramUrl: string | null = null;
  let moreUrl: string | null = null;
  let flyer: string | null = null;

  for (const u0 of urls) {
    const u = unwrapGoogleRedirect(u0.replace(/[.,;]+$/, ''));
    const drive = driveImageUrl(u);
    if (!flyer && (drive || IMAGE_RE.test(u))) flyer = drive ?? u;
    else if (/instagram\.com/i.test(u)) instagramUrl ??= u;
    else if (TICKET_RE.test(u)) ticketUrl ??= u;
    else moreUrl ??= u;
  }

  const description = text
    .split(/\n\s*\n|\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    // Drop lines left as bare labels after their link was pulled out ("Tickets:", "Flyer -").
    .filter((l) => l && !/^[\w\s]{0,20}[:\-–—]\s*$/.test(l));

  return { description, ticketUrl, instagramUrl, moreUrl, flyer };
}

function unwrapGoogleRedirect(u: string): string {
  try {
    const url = new URL(u);
    if (/(^|\.)google\.com$/.test(url.hostname) && url.pathname === '/url') {
      return url.searchParams.get('q') ?? u;
    }
  } catch {}
  return u;
}

/** A shared Google Drive image link → a URL that renders as an <img>. */
function driveImageUrl(u: string): string | null {
  const m = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/);
  return m ? `https://lh3.googleusercontent.com/d/${m[1]}` : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

// ── Fallback: hand-edited events.json ──────────────────────────────────────

function fromJson(): SiteEvent[] {
  return fallbackEvents.map((e) => {
    const [y, m, d] = e.date.split('-').map(Number);
    const times = parseTimeRange(e.time);
    const start = times ? zonedToUtc(y, m, d, times[0][0], times[0][1]) : zonedToUtc(y, m, d, 0, 0);
    const end = times ? zonedToUtc(y, m, d, times[1][0], times[1][1]) : zonedToUtc(y, m, d + 1, 0, 0);
    return {
      id: slugify(`${e.date}-${e.title}`),
      title: e.title,
      start: start.toISOString(),
      end: end.toISOString(),
      allDay: !times,
      venue: e.location,
      address: e.address,
      mapsUrl: mapsUrl(`${e.location}, ${e.address}`),
      description: [e.description],
      ticketUrl: e.ticket_url,
      instagramUrl: e.instagram_url,
      moreUrl: null,
      flyer: e.flyer ? encodeURI(e.flyer) : null,
      soldOut: e.sold_out,
    };
  });
}

function parseTimeRange(s: string): [[number, number], [number, number]] | null {
  const m = s.match(/(\d{1,2})(?::(\d\d))?\s*(AM|PM)\s*[–-]\s*(\d{1,2})(?::(\d\d))?\s*(AM|PM)/i);
  if (!m) return null;
  const to24 = (h: string, min: string | undefined, ap: string): [number, number] => [
    (Number(h) % 12) + (ap.toUpperCase() === 'PM' ? 12 : 0),
    Number(min ?? 0),
  ];
  return [to24(m[1], m[2], m[3]), to24(m[4], m[5], m[6])];
}

// ── Display helpers ─────────────────────────────────────────────────────────

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: SITE_TZ, ...opts });

export function dateParts(e: SiteEvent) {
  const d = new Date(e.start);
  return {
    weekday: fmt({ weekday: 'long' }).format(d),
    shortMonth: fmt({ month: 'short' }).format(d).toUpperCase(),
    monthYear: fmt({ month: 'long', year: 'numeric' }).format(d),
    day: Number(fmt({ day: 'numeric' }).format(d)),
    year: Number(fmt({ year: 'numeric' }).format(d)),
  };
}

export function timeLabel(e: SiteEvent): string {
  if (e.allDay) {
    const days = Math.round((new Date(e.end).getTime() - new Date(e.start).getTime()) / 864e5);
    if (days <= 1) return 'All day';
    const last = new Date(new Date(e.end).getTime() - 864e5);
    return `Through ${fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(last)}`;
  }
  const t = fmt({ hour: 'numeric', minute: '2-digit' });
  const clean = (s: string) => s.replace(':00', '');
  const sameDay = fmt({ dateStyle: 'short' }).format(new Date(e.start)) === fmt({ dateStyle: 'short' }).format(new Date(e.end));
  const endStr = sameDay
    ? t.format(new Date(e.end))
    : `${fmt({ weekday: 'short' }).format(new Date(e.end))} ${t.format(new Date(e.end))}`;
  return `${clean(t.format(new Date(e.start)))} – ${clean(endStr)}`;
}
