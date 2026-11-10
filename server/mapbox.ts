// Mapbox Search Box + Geocoding v6 helpers (results limited to the Bay Area, ranked toward SF).
import type { GeocodeResponse, LngLat, PlaceCandidate, StopCategory } from '../src/types.js'
import { coreTokens, fetchJson, HttpError, sameName } from './util.js'

const pick = (h: MbPlace) => ({ name: h.name, lng: h.lng, lat: h.lat, address: h.address })

const SF_CENTER = '-122.4194,37.7749'
// Greater Bay Area: Sonoma/Napa → Santa Cruz/San Jose, coast → Livermore. Proximity still biases to SF.
const SF_BBOX = '-123.25,36.90,-121.40,38.90'
const SEARCHBOX = 'https://api.mapbox.com/search/searchbox/v1'

export const hasMapbox = () => !!process.env.VITE_MAPBOX_TOKEN

function token(): string {
  const t = process.env.VITE_MAPBOX_TOKEN
  if (!t) throw new HttpError(503, 'VITE_MAPBOX_TOKEN missing')
  return t
}

const qs = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')

const prox = (center?: LngLat) => (center ? `${center.lng},${center.lat}` : SF_CENTER)

export interface MbPlace extends PlaceCandidate {
  categoryIds: string[]
}

function featureToPlace(f: any): MbPlace | null {
  const p = f?.properties ?? {}
  const coords = f?.geometry?.coordinates
  const lng = p.coordinates?.longitude ?? coords?.[0]
  const lat = p.coordinates?.latitude ?? coords?.[1]
  if (typeof lng !== 'number' || typeof lat !== 'number' || !p.name) return null
  const ids: string[] = p.poi_category_ids ?? []
  const address = (p.address as string | undefined) ?? (p.full_address as string | undefined)?.split(',')[0] ?? p.place_formatted
  return {
    name: p.name,
    lng,
    lat,
    address,
    category: ids.length ? categoryFromIds(ids) : undefined,
    url: p.metadata?.website,
    categoryIds: ids,
  }
}

/** Search Box forward search (returns POIs, addresses, neighborhoods…) */
export async function searchboxForward(q: string, opts: { limit?: number; types?: string; center?: LngLat; timeoutMs?: number } = {}): Promise<MbPlace[]> {
  const url = `${SEARCHBOX}/forward?${qs({
    q,
    proximity: prox(opts.center),
    bbox: SF_BBOX,
    limit: opts.limit ?? 1,
    types: opts.types,
    access_token: token(),
  })}`
  const j = await fetchJson(url, opts.timeoutMs ?? 1500)
  return ((j?.features ?? []) as any[]).map(featureToPlace).filter((x): x is MbPlace => !!x)
}

/** Search Box category search around a center */
export async function searchboxCategory(categoryId: string, opts: { limit?: number; center?: LngLat; timeoutMs?: number } = {}): Promise<MbPlace[]> {
  const url = `${SEARCHBOX}/category/${encodeURIComponent(categoryId)}?${qs({
    proximity: prox(opts.center),
    bbox: SF_BBOX,
    limit: opts.limit ?? 6,
    access_token: token(),
  })}`
  const j = await fetchJson(url, opts.timeoutMs ?? 1500)
  return ((j?.features ?? []) as any[]).map(featureToPlace).filter((x): x is MbPlace => !!x)
}

/** Geocoding v6 forward (addresses/places; fallback) */
async function geocodeV6(q: string, timeoutMs = 1500): Promise<MbPlace[]> {
  const url = `https://api.mapbox.com/search/geocode/v6/forward?${qs({
    q,
    proximity: SF_CENTER,
    bbox: SF_BBOX,
    limit: 1,
    access_token: token(),
  })}`
  const j = await fetchJson(url, timeoutMs)
  return ((j?.features ?? []) as any[])
    .map((f) => {
      const p = f?.properties ?? {}
      const [lng, lat] = f?.geometry?.coordinates ?? []
      if (typeof lng !== 'number' || typeof lat !== 'number') return null
      return { name: p.name ?? q, lng, lat, address: p.full_address ?? p.place_formatted, categoryIds: [] } as MbPlace
    })
    .filter((x): x is MbPlace => !!x)
}

/** name → coordinates. Never throws for "not found" — returns null. */
export async function geocode(query: string, timeoutMs = 1800): Promise<GeocodeResponse['result']> {
  // bbox already pins results to the Bay Area; a trailing ", San Francisco" confuses Search Box POI matching
  const q = query.trim().replace(/,?\s*(san francisco|sf)(,?\s*(ca|california))?\s*$/i, '').trim() || query.trim()
  if (!q) return null
  // 1) Search Box (POIs). Prefer a result whose name actually matches the query.
  let fallback: MbPlace | undefined
  try {
    const hits = await searchboxForward(q, { limit: 5, timeoutMs })
    const match = hits.find((h) => sameName(h.name, q))
    if (match) return pick(match)
    fallback = hits[0]
  } catch (e) {
    if (e instanceof HttpError) throw e
    console.warn(`[api] searchbox geocode failed: ${(e as Error).message}`)
  }
  // 2) Geocoding v6 (addresses, streets, neighborhoods) — used when Search Box has no name match.
  try {
    const [hit] = await geocodeV6(q, timeoutMs)
    const qt = coreTokens(q)
    if (hit && (!fallback || sameName(hit.name, q) || coreTokens(hit.name).some((t) => qt.includes(t)))) return pick(hit)
  } catch (e) {
    if (e instanceof HttpError) throw e
    console.warn(`[api] v6 geocode failed: ${(e as Error).message}`)
  }
  if (fallback) return pick(fallback)
  return null
}

// ---------- categories ----------

const ID_TO_CAT: [RegExp, StopCategory][] = [
  [/viewpoint|observatory|lighthouse|scenic/, 'view'],
  [/coffee|cafe|teahouse|bubble_tea|tea_/, 'coffee'],
  [/nightclub|night|cocktail|wine_bar|beer_bar|_bar$|^bar$|pub|brewery|lounge|speakeasy|music_venue|concert|karaoke|dive_bar|distillery/, 'nightlife'],
  [/museum|gallery|art|theatre|theater|cinema|historic|monument|library|landmark|tourist_attraction|exhibit|book_store|planetarium|aquarium|place_of_worship|church|temple/, 'culture'],
  [/park|garden|beach|trail|nature|forest|coastal|pier|marina|playground|zoo|outdoors|plaza|lake|dog_park/, 'outdoors'],
  [/shop|store|market|boutique|mall|shopping/, 'shopping'],
  [/restaurant|food|bakery|deli|dessert|ice_cream|pizza|taco|burger|diner|snack|donut|bagel|sandwich/, 'food'],
  [/event|fair|stadium/, 'event'],
]

export function categoryFromIds(ids: string[]): StopCategory {
  // Check ids in order — Mapbox lists the most specific first.
  for (const id of ids) for (const [re, cat] of ID_TO_CAT) if (re.test(id)) return cat
  return 'other'
}

/** user query keyword → Mapbox canonical category id (most specific first) */
const QUERY_TO_CATEGORY: [RegExp, string][] = [
  [/\bspeakeasy/, 'speakeasy'],
  [/\bcocktail/, 'cocktail_bar'],
  [/\bwine\b/, 'wine_bar'],
  [/\bdive bar/, 'dive_bar'],
  [/\bbrewer|\bbeer\b/, 'brewery'],
  [/\b(live music|concert|gig)/, 'music_venue'],
  [/\bclub|dancing/, 'nightclub'],
  [/\bbar(s)?\b|\bdrinks?\b|nightlife/, 'bar'],
  [/\bcoffee|espresso|latte|\bcafe|\bcaf[eé]s?\b/, 'coffee'],
  [/\btea\b|boba|bubble tea/, 'teahouse'],
  [/\bbakery|pastr|croissant|bread/, 'bakery'],
  [/ice cream|gelato/, 'ice_cream'],
  [/\bdessert|sweets/, 'dessert_shop'],
  [/\bbrunch/, 'brunch_restaurant'],
  [/\bbreakfast/, 'breakfast_restaurant'],
  [/\bpizza/, 'pizza_restaurant'],
  [/\btaco|burrito|mexican/, 'mexican_restaurant'],
  [/\bsushi/, 'sushi_restaurant'],
  [/\bramen/, 'ramen_restaurant'],
  [/\bdim sum|chinese/, 'chinese_restaurant'],
  [/\bitalian|pasta/, 'italian_restaurant'],
  [/\bseafood|oyster/, 'seafood_restaurant'],
  [/\bthai\b/, 'thai_restaurant'],
  [/\bburger/, 'burger_restaurant'],
  [/\bvegan|vegetarian|salad/, 'salad_bar'],
  [/\b(food|eat|dinner|lunch|restaurant|bite)/, 'restaurant'],
  [/\bmuseum/, 'museum'],
  [/\bgaller(y|ies)|\bart\b/, 'art_gallery'],
  [/\bbookstore|book shop|books\b/, 'book_store'],
  [/\b(view|vista|lookout|sunset|skyline|panoram)/, 'viewpoint'],
  [/\bbeach/, 'beach'],
  [/\bhike|trail/, 'trailhead'],
  [/\bpark|picnic|outdoor|nature|garden/, 'park'],
  [/\bvintage|thrift/, 'thrift_shop'],
  [/\bshop|shopping|boutique/, 'boutique'],
  [/\bmarket/, 'market'],
  [/\bmovie|cinema|film/, 'cinema'],
  [/\btheat(er|re)|show|comedy/, 'theatre'],
  [/\blandmark|sight|tourist|historic/, 'tourist_attraction'],
]

export function categoryForQuery(query: string): string | undefined {
  const q = query.toLowerCase()
  return QUERY_TO_CATEGORY.find(([re]) => re.test(q))?.[1]
}
