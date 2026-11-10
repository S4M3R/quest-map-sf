// Instant-photo lookup for a stop: Wikipedia → Exa → Mapbox static satellite (always works).
// Exported as a plain function; the lead mounts it as `POST /api/photo` in server/index.ts.
import type { PhotoRequest, PhotoResponse } from '../src/types.js'
import { exa, hasExa } from './exa.js'
import { coreTokens, norm, sameName } from './util.js'

const UA = 'QuestMapSF/0.1 (hackathon demo)'
const TOTAL_BUDGET_MS = 3000
const WIKI = 'https://en.wikipedia.org/w/api.php'

type Hit = { url: string; source: 'wikipedia' | 'exa' }

// ---------- helpers ----------

function distM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Wikimedia rate-limits anonymous API clients (429 + retry-after); back off instead of hammering. */
let wikiCooldownUntil = 0

async function getJson(url: string, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { signal, headers: { 'User-Agent': UA, 'Api-User-Agent': UA, Accept: 'application/json' } })
  if (res.status === 429) {
    const s = Number(res.headers.get('retry-after')) || 10
    wikiCooldownUntil = Date.now() + Math.min(60, s) * 1000
  }
  if (!res.ok) throw new Error(`upstream ${res.status}`)
  return res.json()
}

/** "Coit Tower (San Francisco)" → "Coit Tower"; "Ferry Building, San Francisco" → "Ferry Building" */
const cleanTitle = (t: string) =>
  t
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/,\s*san francisco.*$/i, '')
    .trim()

/** drop generic words like "coffee", "soma", "sf" from the requested name before matching */
const LOCALE = /\b(soma|mission|downtown|sf|san francisco|the castro|north beach|hayes valley)\b/gi
const baseName = (name: string) => name.replace(LOCALE, ' ').replace(/\s+/g, ' ').trim() || name

const BAD_IMG = /(\.svg($|\?)|logo|icon|favicon|sprite|placeholder|avatar|badge|banner-ad|default[-_]?image|blank\.|pixel|spacer|\/flags?\/|map[-_]of|locator|_map\.|location_map)/i

function plausibleImage(u: unknown): u is string {
  if (typeof u !== 'string' || !/^https?:\/\//.test(u)) return false
  if (BAD_IMG.test(u)) return false
  // tiny thumbnails encoded in the URL (e.g. w=32, 64x64)
  const m = u.match(/[?&](?:w|width|size)=(\d+)/i) ?? u.match(/[-_/](\d{2,3})x\d{2,3}[._-]/)
  if (m && Number(m[1]) < 200) return false
  return true
}

// ---------- 1. Wikipedia / Wikimedia ----------

interface WikiPage {
  title: string
  index?: number
  thumbnail?: { source: string; width: number; height: number }
  pageimage?: string
  coordinates?: { lat: number; lon: number }[]
}

function pickWiki(pages: WikiPage[], req: PhotoRequest, maxDistM: number): string | null {
  const want = baseName(req.name)
  const scored = pages
    .filter((p) => p.thumbnail?.source && !/\.svg$/i.test(p.pageimage ?? '') && !BAD_IMG.test(p.pageimage ?? ''))
    .map((p) => {
      const title = cleanTitle(p.title)
      const c = p.coordinates?.[0]
      const d = c ? distM(req.lat, req.lng, c.lat, c.lon) : Infinity
      const nameOk = sameName(title, want) || sameName(title, req.name)
      // a page must match the name; if it has coords they must be near the stop
      const ok = nameOk && (c ? d <= maxDistM : coreTokens(want).length >= 2 || norm(title) === norm(want))
      const exact = norm(title) === norm(want) ? 0 : 1
      return { p, ok, d, exact }
    })
    .filter((x) => x.ok)
    .sort((a, b) => a.exact - b.exact || a.d - b.d || (a.p.index ?? 99) - (b.p.index ?? 99))
  return scored[0]?.p.thumbnail?.source ?? null
}

const WIKI_COMMON = 'action=query&format=json&formatversion=2&redirects=1&prop=pageimages%7Ccoordinates&piprop=thumbnail%7Cname&pithumbsize=800&colimit=max'

async function wikiSearch(req: PhotoRequest, signal: AbortSignal): Promise<string | null> {
  const q = encodeURIComponent(`${baseName(req.name)} San Francisco`)
  const j = await getJson(`${WIKI}?${WIKI_COMMON}&generator=search&gsrsearch=${q}&gsrlimit=6`, signal)
  return pickWiki(j?.query?.pages ?? [], req, 1500)
}

async function wikiGeo(req: PhotoRequest, signal: AbortSignal): Promise<string | null> {
  const coord = `${req.lat}%7C${req.lng}`
  const j = await getJson(`${WIKI}?${WIKI_COMMON}&generator=geosearch&ggscoord=${coord}&ggsradius=300&ggslimit=20`, signal)
  return pickWiki(j?.query?.pages ?? [], req, 300)
}

async function fromWikipedia(req: PhotoRequest, signal: AbortSignal): Promise<Hit | null> {
  if (Date.now() < wikiCooldownUntil) return null
  // title search first (best name match, ~300ms); geosearch only if that misses — keeps us
  // to ~1 request per stop so we stay under Wikimedia's anonymous rate limit
  const url = (await wikiSearch(req, signal).catch(() => null)) ?? (Date.now() < wikiCooldownUntil ? null : await wikiGeo(req, signal).catch(() => null))
  return url ? { url, source: 'wikipedia' } : null
}

// ---------- 2. Exa (page images) ----------

async function fromExa(req: PhotoRequest, signal: AbortSignal): Promise<Hit | null> {
  if (!hasExa()) return null
  const want = baseName(req.name)
  const res = await exa().search(`${req.name} San Francisco`, {
    type: 'fast',
    numResults: 6,
    userLocation: 'US',
    contents: { extras: { imageLinks: 4 } },
    timeout: 2600,
    signal,
  } as any)
  const results: any[] = res?.results ?? []
  // the stop's own website first (if given), then results whose title mentions the place
  const own = req.url ? results.filter((r) => sameHost(r.url, req.url!)) : []
  const named = results.filter((r) => typeof r.title === 'string' && (sameName(cleanTitle(r.title.split(/[|\-–—:]/)[0]), want) || norm(r.title).includes(norm(want))))
  // only trust pages that are clearly about this place (never a random result's og:image)
  for (const r of [...own, ...named]) {
    if (plausibleImage(r.image)) return { url: r.image, source: 'exa' }
    const extra = (r.extras?.imageLinks ?? []).find(plausibleImage)
    if (extra) return { url: extra, source: 'exa' }
  }
  return null
}

function sameHost(a: string, b: string): boolean {
  try {
    const h = (u: string) => new URL(u).hostname.replace(/^www\./, '')
    return h(a) === h(b)
  } catch {
    return false
  }
}

// ---------- 3. Mapbox static satellite (always works) ----------

export function mapboxStaticUrl(lat: number, lng: number): string | null {
  const token = process.env.VITE_MAPBOX_TOKEN
  if (!token) return null
  const bearing = Math.round((Math.abs(lat * 1000 + lng * 1000) % 60) - 30) // stable pseudo-random angle
  return (
    `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/` +
    `${lng.toFixed(5)},${lat.toFixed(5)},17.5,${bearing},55/600x600@2x` +
    `?access_token=${encodeURIComponent(token)}&logo=false&attribution=false`
  )
}

// ---------- entry ----------

function race<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), Math.max(0, ms))
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(null)),
    )
  })
}

const cache = new Map<string, PhotoResponse>()
const cacheKey = (r: PhotoRequest) => `${norm(r.name)}@${r.lat?.toFixed?.(3)},${r.lng?.toFixed?.(3)}`

export async function getPhoto(req: PhotoRequest): Promise<PhotoResponse> {
  try {
    const hit = cache.get(cacheKey(req))
    if (hit) return hit
  } catch {
    /* bad input — handled below */
  }
  const res = await lookup(req)
  // cache real photos only; a mapbox fallback may be a transient miss (rate limit / timeout)
  if (res.source === 'wikipedia' || res.source === 'exa') {
    try {
      cache.set(cacheKey(req), res)
    } catch {
      /* ignore */
    }
  }
  return res
}

async function lookup(req: PhotoRequest): Promise<PhotoResponse> {
  const fallback = (): PhotoResponse => {
    const url = Number.isFinite(req?.lat) && Number.isFinite(req?.lng) ? mapboxStaticUrl(req.lat, req.lng) : null
    return { photoUrl: url, source: url ? 'mapbox' : null }
  }
  try {
    if (!req || typeof req.name !== 'string' || !req.name.trim()) return fallback()
    const t0 = Date.now()
    const ctrl = new AbortController()
    const killer = setTimeout(() => ctrl.abort(), TOTAL_BUDGET_MS)
    try {
      const wiki = fromWikipedia(req, ctrl.signal).catch(() => null)
      const ex = fromExa(req, ctrl.signal).catch(() => null)
      const w = await race(wiki, TOTAL_BUDGET_MS - (Date.now() - t0))
      if (w) return { photoUrl: w.url, source: w.source }
      const e = await race(ex, TOTAL_BUDGET_MS - (Date.now() - t0))
      if (e) return { photoUrl: e.url, source: e.source }
    } finally {
      clearTimeout(killer)
      ctrl.abort()
    }
  } catch {
    /* fall through */
  }
  return fallback()
}
