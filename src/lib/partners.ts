// Loads the list of places that carry our wine at build time.
//
// Source of truth is a Google Sheet, published to the web as CSV (see
// src/data/sources.json). One row per place; add a row to add a partner,
// delete the row to remove one. Columns (header names, any order):
//
//   Name | Type | Town | Address | Notes | Website | Instagram | Phone
//
// Type: anything mentioning bar / restaurant / brewery / glass is shown under
// "By the glass"; everything else is a bottle shop. Instagram can be a URL or
// an @handle. A logo is picked up automatically from
// public/Distribution/<Name>.(png|jpg|jpeg|webp) when one exists.
// If no sheet is configured, src/data/partners.json is used.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sources from '../data/sources.json';
import fallback from '../data/partners.json';
import { mapsUrl } from './events';

export type PartnerKind = 'shop' | 'pour';

export interface Partner {
  name: string;
  kind: PartnerKind;
  town: string;
  address: string;
  notes: string;
  website: string;
  instagram: string;
  phone: string;
  logo: string | null;
  mapsUrl: string;
}

let cache: Promise<Partner[]> | null = null;

export function getPartners(): Promise<Partner[]> {
  cache ??= load();
  return cache;
}

async function load(): Promise<Partner[]> {
  const url = process.env.PARTNERS_CSV_URL || sources.partnersSheetCsvUrl.trim();
  const list = url ? fromCsv(await fetchCsv(url)) : fromJson();
  return list.sort((a, b) => a.town.localeCompare(b.town) || a.name.localeCompare(b.name));
}

async function fetchCsv(url: string, tries = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('got an HTML page, not CSV — is the sheet published as CSV?');
      return text;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  // Failing the build keeps the last good version of the site live.
  throw new Error(`Could not fetch partners sheet (${url}): ${lastErr}`);
}

export function fromCsv(text: string): Partner[] {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim()));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (row: string[], ...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return (row[i] ?? '').trim();
    }
    return '';
  };
  return rows
    .slice(1)
    .map((r) => {
      const name = col(r, 'name');
      const address = col(r, 'address');
      return {
        name,
        kind: kindOf(col(r, 'type', 'kind')),
        town: col(r, 'town', 'city', 'neighborhood') || townFromAddress(address),
        address,
        notes: col(r, 'notes', 'note'),
        website: normalizeUrl(col(r, 'website', 'web', 'url')),
        instagram: normalizeInstagram(col(r, 'instagram', 'ig')),
        phone: col(r, 'phone'),
        logo: findLogo(name),
        mapsUrl: mapsUrl([name, address].filter(Boolean).join(', ')),
      };
    })
    .filter((p) => p.name);
}

function kindOf(type: string): PartnerKind {
  return /bar|restaurant|brew|glass|premise|tap|pour|cafe|café|bistro|tavern|pub/i.test(type) ? 'pour' : 'shop';
}

function townFromAddress(address: string): string {
  // "132 Water St., Penn Yan, NY 14527" → "Penn Yan, NY"
  const parts = address.split(',').map((s) => s.trim());
  if (parts.length >= 3) return `${parts[parts.length - 2]}, ${parts[parts.length - 1].replace(/\s*\d{5}(-\d{4})?$/, '')}`;
  return '';
}

function normalizeUrl(u: string): string {
  if (!u || u === '#') return '';
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

function normalizeInstagram(v: string): string {
  if (!v) return '';
  if (/instagram\.com/i.test(v)) return normalizeUrl(v);
  return `https://www.instagram.com/${v.replace(/^@/, '').replace(/\/$/, '')}/`;
}

const DIST_DIR = fileURLToPath(new URL('../../public/Distribution/', import.meta.url));

function findLogo(name: string): string | null {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'svg']) {
    if (existsSync(`${DIST_DIR}${name}.${ext}`)) return encodeURI(`/Distribution/${name}.${ext}`);
  }
  return null;
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function fromJson(): Partner[] {
  const map = (p: (typeof fallback.wine_stores)[number] & { notes?: string }, kind: PartnerKind): Partner => ({
    name: p.name,
    kind,
    town: p.neighborhood,
    address: p.address,
    notes: p.notes ?? '',
    website: normalizeUrl(p.website),
    instagram: normalizeInstagram(p.instagram),
    phone: p.phone,
    logo: p.logo ? encodeURI(p.logo) : findLogo(p.name),
    mapsUrl: mapsUrl(`${p.name}, ${p.address}`),
  });
  return [
    ...fallback.wine_stores.map((p) => map(p, 'shop')),
    ...fallback.on_premise.map((p) => map(p, 'pour')),
  ];
}
