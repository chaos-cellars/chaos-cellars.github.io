// Turns partner addresses into map coordinates at build time.
//
// Tries the US Census geocoder first (free, no key, good for street addresses),
// then OpenStreetMap's Nominatim. Results are kept in .cache/geocode.json, which
// CI restores between runs, so each address is only looked up once. A failed
// lookup never fails the build — that partner simply has no pin.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface LatLng { lat: number; lng: number }

const CACHE_FILE = '.cache/geocode.json';
let cache: Record<string, LatLng | null> | null = null;

function loadCache() {
  if (cache) return cache;
  try {
    cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
  } catch {
    cache = {};
  }
  return cache!;
}

function saveCache() {
  try {
    mkdirSync('.cache', { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

/** "43.66, -77.05" → { lat, lng } */
export function parseLatLng(s: string): LatLng | null {
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

export async function geocode(address: string, fetchImpl: typeof fetch = fetch): Promise<LatLng | null> {
  const key = address.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  const c = loadCache();
  if (c[key]) return c[key];

  const result = (await census(address, fetchImpl)) ?? (await nominatim(address, fetchImpl));
  // Only remember hits, so a temporary outage is retried next build.
  if (result) {
    c[key] = result;
    saveCache();
  } else {
    console.warn(`[geocode] no match for "${address}" — add a Map Pin (lat, lng) in the sheet to place it.`);
  }
  return result;
}

async function census(address: string, f: typeof fetch): Promise<LatLng | null> {
  try {
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(address)}`;
    const res = await f(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const c = data?.result?.addressMatches?.[0]?.coordinates;
    return c && Number.isFinite(c.x) && Number.isFinite(c.y) ? { lat: c.y, lng: c.x } : null;
  } catch {
    return null;
  }
}

async function nominatim(address: string, f: typeof fetch): Promise<LatLng | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`;
    const res = await f(url, {
      headers: { 'User-Agent': 'chaos-cellars.com site build (chaos-cellars@outlook.com)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const [hit] = await res.json();
    const lat = Number(hit?.lat);
    const lng = Number(hit?.lon);
    // Nominatim allows one request per second.
    await new Promise((r) => setTimeout(r, 1100));
    return Number.isFinite(lat) && Number.isFinite(lng) && hit ? { lat, lng } : null;
  } catch {
    return null;
  }
}
