// Hono app with all /api routes. Shared by the local Node server (server/index.ts) and the Vercel Function (api/index.ts).
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { GeocodeRequest, HappeningsRequest, PhotoRequest, SearchPlacesRequest } from '../src/types.js'
import { getPhoto } from './photo.js'
import { hasExa } from './exa.js'
import { geocode, hasMapbox } from './mapbox.js'
import { searchPlaces } from './places.js'
import { findHappenings } from './happenings.js'
import { reverse, type ReverseRequest } from './reverse.js'
import { HttpError } from './util.js'

export const app = new Hono()

app.use('/api/*', cors())

// one log line per request, with latency
app.use('/api/*', async (c, next) => {
  const t0 = Date.now()
  await next()
  console.log(`[api] ${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - t0}ms`)
})

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500
  if (status >= 500 && status !== 503) console.error('[api] error:', err)
  return c.json({ error: err.message || 'internal error' }, status as 500)
})
app.notFound((c) => c.json({ error: `no route ${c.req.method} ${c.req.path}` }, 404))

async function body<T>(c: { req: { json: () => Promise<unknown> } }): Promise<Partial<T>> {
  try {
    return ((await c.req.json()) ?? {}) as Partial<T>
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${field}" is required`)
  return v.trim()
}

const optString = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

const requireMapbox = () => {
  if (!hasMapbox()) throw new HttpError(503, 'VITE_MAPBOX_TOKEN missing')
}

app.get('/api/health', (c) => c.json({ ok: true, exa: hasExa(), mapbox: hasMapbox() }))

app.post('/api/geocode', async (c) => {
  const b = await body<GeocodeRequest>(c)
  const query = requireString(b.query, 'query')
  requireMapbox()
  return c.json({ result: await geocode(query) })
})

app.post('/api/search-places', async (c) => {
  const b = await body<SearchPlacesRequest>(c)
  const query = requireString(b.query, 'query')
  requireMapbox()
  return c.json(await searchPlaces(query, optString(b.area)))
})

app.post('/api/happenings', async (c) => {
  const b = await body<HappeningsRequest>(c)
  const query = requireString(b.query, 'query')
  return c.json(await findHappenings(query, optString(b.when)))
})

app.post('/api/photo', async (c) => {
  const b = await body<PhotoRequest>(c)
  const name = requireString(b.name, 'name')
  const lat = Number(b.lat)
  const lng = Number(b.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, '"lat" and "lng" are required numbers')
  return c.json(await getPhoto({ name, lat, lng, url: optString(b.url) }))
})

app.post('/api/reverse', async (c) => {
  const b = await body<ReverseRequest>(c)
  const lat = Number(b.lat)
  const lng = Number(b.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new HttpError(400, '"lat" and "lng" are required numbers')
  const radiusM = Number(b.radiusM)
  return c.json(await reverse({ lat, lng, radiusM: Number.isFinite(radiusM) ? radiusM : undefined }))
})
