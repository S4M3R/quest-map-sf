// POST /api/search-places — Mapbox POIs (coords) + Exa web hooks (why it's good).
import type { LngLat, PlaceCandidate, SearchPlacesResponse } from '../src/types.js'
import { exaHighlights, hasExa, type ExaHit } from './exa.js'
import { categoryForQuery, searchboxCategory, searchboxForward, type MbPlace } from './mapbox.js'
import { coreTokens, distanceM, mentions, norm, oneLine, sameName, within } from './util.js'

const MAX_RESULTS = 6
const BUDGET_MS = 2400

/** pull the sentence of a hit that talks about `name` */
function hookFor(name: string, hit: ExaHit): string | undefined {
  const text = hit.highlights.join(' … ')
  const sentences = text
    .split(/(?<=[.!?])\s+|\s…\s|\.\.\./)
    .map((s) => s.replace(/^[\s\-–—…,.;:)]+/, '').trim())
    .map((s) => s.replace(/^#+\s*/, ''))
    .filter(
      (s) =>
        s.split(' ').length >= 7 &&
        s.length <= 260 &&
        !/\(rated|cookie|subscribe|sign up|@|\b\d{3}[\s.-]?\d{3}[\s.-]?\d{4}\b|\b(mon|tue|wed)\s\d/i.test(s) &&
        (s.match(/\d/g)?.length ?? 0) < 12,
    )
  const toks = coreTokens(name)
  const s = sentences.find((x) => mentions(x, name)) ?? (toks.length ? sentences.find((x) => toks.every((t) => norm(x).includes(t))) : undefined)
  return oneLine(s, 150)
}

/** "Réveille Coffee Co. | Brian's Coffee Spot" → "Réveille Coffee Co." ; skips listicles */
function placeNameFromTitle(title: string): string | undefined {
  const first = title
    .split(/\s[|–—-]\s|:\s/)[0]
    ?.replace(/,?\s*(san francisco|sf)\b.*$/i, '')
    .trim()
  if (!first || first.length > 48) return undefined
  if (/\b(best|top|guide|things to do|where to|places|spots|shops|bars|restaurants|cafes|review|\d{2,})\b/i.test(first)) return undefined
  if (/^\d/.test(first)) return undefined
  return first
}

/** Bay Area region nicknames → a representative center (Search Box mis-resolves these). */
const REGION_CENTERS: Record<string, LngLat> = {
  marin: { lng: -122.5311, lat: 37.9735 }, // San Rafael
  sonoma: { lng: -122.4580, lat: 38.2919 },
  napa: { lng: -122.2869, lat: 38.2975 },
  'napa valley': { lng: -122.4100, lat: 38.4300 },
  'east bay': { lng: -122.2711, lat: 37.8044 }, // Oakland
  'south bay': { lng: -121.8863, lat: 37.3382 }, // San Jose
  peninsula: { lng: -122.3255, lat: 37.5630 }, // San Mateo
  'silicon valley': { lng: -122.0575, lat: 37.3861 }, // Mountain View
  'santa cruz': { lng: -122.0308, lat: 36.9741 },
  'half moon bay': { lng: -122.4286, lat: 37.4636 },
}

export async function searchPlaces(query: string, area?: string): Promise<SearchPlacesResponse> {
  const t0 = Date.now()
  const left = () => Math.max(150, BUDGET_MS - (Date.now() - t0))
  const exaQuery = `${query}${area ? ` in ${area}` : ''}, San Francisco Bay Area`

  // 1) Exa (in parallel with everything Mapbox) — optional, never blocks past the budget.
  const exaP: Promise<ExaHit[]> = hasExa()
    ? within(exaHighlights(exaQuery, { numResults: 8, timeoutMs: 1800 }), 1800, [], 'exa places')
    : Promise.resolve([])

  // 2) Area center → Mapbox POIs near it. Region nicknames resolve to a concrete center first.
  const center: LngLat | undefined = area
    ? REGION_CENTERS[area.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+county$/, '')] ??
      ((await within(searchboxForward(`${area}, California`, { limit: 1, types: 'neighborhood,locality,place,district,poi', timeoutMs: 900 }), 900, [], 'area geocode'))[0] ?? undefined)
    : undefined

  const cat = categoryForQuery(query)
  let mb: MbPlace[] = []
  if (cat) mb = await within(searchboxCategory(cat, { center, limit: 10, timeoutMs: 1000 }), 1000, [], 'mapbox category')
  if (!mb.length) {
    const q = area ? `${query} ${area}` : query
    mb = await within(searchboxForward(q, { center, limit: 8, types: 'poi', timeoutMs: 1000 }), 1000, [], 'mapbox forward')
  }

  // 3) Exa results → attach hooks; Exa-only places (single-venue pages) get geocoded.
  const hits = await within(exaP, left(), [], 'exa places (budget)')
  const merged: (PlaceCandidate & { rank: number })[] = mb.map((p, i) => ({ ...strip(p), rank: 100 + i }))

  const blobs = hits.map((h) => `${h.title} ${h.highlights.join(' ')}`)
  for (const p of merged) {
    hits.forEach((hit, hi) => {
      if (!mentions(blobs[hi], p.name)) return
      if (p.rank >= 100) p.rank = hi // best-ranked Exa hit that mentions it
      p.description ??= hookFor(p.name, hit)
      p.url ??= hit.url
    })
  }

  const extraNames = hits
    .map((h, hi) => ({ h, hi, name: placeNameFromTitle(h.title) }))
    .filter((x): x is { h: ExaHit; hi: number; name: string } => !!x.name && !merged.some((p) => sameName(p.name, x.name!)))
    .filter((x, i, arr) => arr.findIndex((y) => norm(y.name) === norm(x.name)) === i)
    .slice(0, 4)
  if (extraNames.length && left() > 300) {
    const budget = Math.min(1000, left())
    const found = await Promise.all(
      extraNames.map(({ h, hi, name }) =>
        within(
          (async () => {
            const [hit] = await searchboxForward(area && !norm(name).includes(norm(area)) ? `${name} ${area}` : name, { center, limit: 1, types: 'poi', timeoutMs: budget })
            if (!hit || !sameName(hit.name, name)) return null
            if (center && distanceM(center, hit) > 2000) return null // same-name place elsewhere in the city
            return { ...strip(hit), description: hookFor(hit.name, h) ?? hookFor(name, h), url: hit.url ?? h.url, rank: hi - 0.5 }
          })(),
          budget,
          null,
          `exa place geocode "${name}"`,
        ),
      ),
    )
    for (const f of found) if (f && !merged.some((p) => sameName(p.name, f.name))) merged.push(f)
  }

  // dedupe (chains: keep the first/closest), rank Exa-backed first
  const out: PlaceCandidate[] = []
  for (const p of merged.sort((a, b) => a.rank - b.rank)) {
    if (out.some((o) => norm(o.name) === norm(p.name))) continue
    const { rank: _rank, ...rest } = p
    out.push(rest)
    if (out.length >= MAX_RESULTS) break
  }
  return { places: out }
}

function strip(p: MbPlace): PlaceCandidate {
  const { categoryIds: _ids, ...rest } = p
  return rest
}
