// Reverse lookup for the pointer feature: lat/lng (+ optional radius) → human label + notable nearby places.
// Uses Mapbox Geocoding v6 reverse (neighborhood/locality/place) + Search Box reverse/category (landmarks).
// Never throws: on any failure returns a coordinate-ish label so the client always has something.
import { distanceM, fetchJson, norm } from './util.js'

export interface ReverseRequest {
  lat: number
  lng: number
  radiusM?: number
}
export interface ReverseResponse {
  label: string
  nearby: string[]
  neighborhood?: string
  city?: string
}

const SEARCHBOX = 'https://api.mapbox.com/search/searchbox/v1'
const GEOCODE = 'https://api.mapbox.com/search/geocode/v6'
const LANDMARK_CATS = 'tourist_attraction,park,museum,viewpoint,historic_site,art_gallery,beach,monument,plaza'
const TIMEOUT_MS = 1200

// junk POIs that make bad "you're pointing at …" anchors
const JUNK = /toilet|restroom|bus stop|parking|garage|\bcourts?\b|athletic field|\bfield\b|playground|bench|entrance|exit|atm|charging|bike share|bikeshare|station \d|^\d|dog run|open space|tennis|basketball|picnic area|drinking|fountain$|trailhead$|\bcorner\b/i
const JUNK_CATS = new Set(['tours', 'tour_operator', 'travel_agency', 'bus_stop', 'transportation', 'parking', 'office', 'it', 'atm', 'toilet', 'basketball_court'])

interface Poi {
  name: string
  lat: number
  lng: number
  cats: string[]
  d: number
}

const cache = new Map<string, { at: number; value: ReverseResponse }>()
const CACHE_TTL = 30 * 60_000

const qs = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')

const coordLabel = (lat: number, lng: number) => `${lat.toFixed(4)}, ${lng.toFixed(4)}`

function toPois(j: any, at: { lat: number; lng: number }): Poi[] {
  return ((j?.features ?? []) as any[])
    .map((f) => {
      const p = f?.properties ?? {}
      const lat = p.coordinates?.latitude ?? f?.geometry?.coordinates?.[1]
      const lng = p.coordinates?.longitude ?? f?.geometry?.coordinates?.[0]
      if (p.feature_type && p.feature_type !== 'poi') return null
      if (typeof lat !== 'number' || typeof lng !== 'number' || !p.name) return null
      const cats: string[] = p.poi_category_ids ?? []
      return { name: String(p.name), lat, lng, cats, d: distanceM(at, { lat, lng }) }
    })
    .filter((x): x is Poi => !!x)
}

const JUNK_NAME = /memorial bench|remembers|rest well|in memory|in loving|community garden|program\b|\btours?\b|tour company/i
const notable = (p: Poi) =>
  !JUNK.test(p.name) &&
  !JUNK_NAME.test(p.name) &&
  !p.name.includes(',') &&
  p.name.length <= 38 &&
  !p.cats.some((c) => JUNK_CATS.has(c)) &&
  /[a-z]/i.test(p.name)
/** distance multiplier: famous things win over a slightly closer bench or sculpture */
const tier = (p: Poi) =>
  p.cats.some((c) => /tourist_attraction|museum|historic|viewpoint|stadium|landmark|monument/.test(c)) && !p.cats.includes('fountain')
    ? 0.4
    : p.cats.some((c) => /park|beach|lake|mountain|garden|plaza/.test(c))
      ? 0.7
      : 1
const landmarkish = (p: Poi) =>
  !p.cats.includes('public_artwork') &&
  p.cats.some((c) => /tourist_attraction|historic|monument|museum|viewpoint|landmark|park|mountain|beach|plaza|lake|bridge|garden|stadium/.test(c))

async function areaNames(lat: number, lng: number, token: string) {
  const url = `${GEOCODE}/reverse?${qs({ longitude: lng, latitude: lat, types: 'neighborhood,locality,place', access_token: token })}`
  const j = await fetchJson(url, TIMEOUT_MS)
  const out: { neighborhood?: string; locality?: string; place?: string } = {}
  for (const f of (j?.features ?? []) as any[]) {
    const t = f?.properties?.feature_type as string | undefined
    const name = f?.properties?.name as string | undefined
    if (t && name && !(t in out)) (out as any)[t] = name
  }
  return out
}

async function reversePois(lat: number, lng: number, token: string) {
  const url = `${SEARCHBOX}/reverse?${qs({ longitude: lng, latitude: lat, limit: 10, access_token: token })}`
  return toPois(await fetchJson(url, TIMEOUT_MS), { lat, lng })
}

async function landmarkPois(lat: number, lng: number, radiusM: number, token: string) {
  const r = Math.min(Math.max(radiusM, 350), 2500)
  const dLat = r / 111_320
  const dLng = r / (111_320 * Math.cos((lat * Math.PI) / 180))
  const bbox = [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((n) => n.toFixed(5)).join(',')
  const url = `${SEARCHBOX}/category/${LANDMARK_CATS}?${qs({ proximity: `${lng},${lat}`, bbox, limit: 10, access_token: token })}`
  return toPois(await fetchJson(url, TIMEOUT_MS), { lat, lng })
}

const settle = <T>(p: Promise<T>, fallback: T, label: string): Promise<T> =>
  p.catch((e) => {
    console.warn(`[api] reverse ${label} failed: ${(e as Error)?.message ?? e}`)
    return fallback
  })

export async function reverse(req: ReverseRequest): Promise<ReverseResponse> {
  const lat = Number(req.lat)
  const lng = Number(req.lng)
  const radiusM = Number.isFinite(Number(req.radiusM)) ? Math.max(0, Number(req.radiusM)) : 0
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { label: 'this spot', nearby: [] }
  const token = process.env.VITE_MAPBOX_TOKEN
  if (!token) return { label: coordLabel(lat, lng), nearby: [] }

  const key = `${lat.toFixed(3)},${lng.toFixed(3)},${Math.round(radiusM / 250)}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value

  try {
    const [areas, near, marks] = await Promise.all([
      settle(areaNames(lat, lng, token), {} as Awaited<ReturnType<typeof areaNames>>, 'geocode'),
      settle(reversePois(lat, lng, token), [] as Poi[], 'searchbox reverse'),
      settle(landmarkPois(lat, lng, radiusM, token), [] as Poi[], 'category'),
    ])

    const neighborhood = areas.neighborhood ?? areas.locality
    const city = areas.place

    // merge, dedupe by normalized name, nearest first; landmarks get a distance bonus
    const seen = new Set<string>()
    const ranked = [...near, ...marks]
      .filter(notable)
      .sort((a, b) => a.d * tier(a) - b.d * tier(b))
      .filter((p) => {
        const k = norm(p.name)
        if (!k || seen.has(k) || (neighborhood && k === norm(neighborhood))) return false
        seen.add(k)
        return true
      })

    // anchor: a landmark close to the point (or inside the swept area)
    const anchorMax = Math.max(180, radiusM * 0.6)
    const anchor = ranked.find((p) => landmarkish(p) && tier(p) < 1 && p.d * tier(p) <= anchorMax * 0.7)

    // a "mountain"/hill feature from Search Box often names the area better than the neighborhood (e.g. Telegraph Hill)
    const hill = near.find((p) => p.cats.includes('mountain') && p.d < 250)
    const areaName = hill?.name ?? neighborhood ?? city

    let label: string
    if (anchor && anchor.name !== areaName) label = areaName ? `near ${anchor.name}, ${areaName}` : `near ${anchor.name}`
    else if (neighborhood && city && neighborhood !== city) label = `${hill?.name ?? neighborhood}, ${city}`
    else label = areaName ?? coordLabel(lat, lng)

    const nearby = ranked
      .filter((p) => p !== anchor && p.name !== hill?.name && landmarkish(p))
      .filter((p) => p.d <= Math.max(600, radiusM * 1.2))
      .sort((a, b) => a.d * tier(a) - b.d * tier(b))
      .slice(0, anchor ? 2 : 3)
      .map((p) => p.name)
    if (anchor) nearby.unshift(anchor.name)

    const value: ReverseResponse = { label, nearby, neighborhood, city }
    // only cache answers that actually resolved something
    if (neighborhood || city || nearby.length) {
      if (cache.size > 2000) cache.clear()
      cache.set(key, { at: Date.now(), value })
    }
    return value
  } catch (e) {
    console.warn(`[api] reverse failed: ${(e as Error)?.message ?? e}`)
    return { label: coordLabel(lat, lng), nearby: [] }
  }
}
