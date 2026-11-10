// Browser wrappers for the local API server (Vite proxies /api → :8787).
import type {
  GeocodeRequest,
  GeocodeResponse,
  HappeningsRequest,
  HappeningsResponse,
  SearchPlacesRequest,
  SearchPlacesResponse,
} from '../types'

const DEFAULT_TIMEOUT_MS = 6000

async function post<Req, Res>(path: string, body: Req, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Res> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`${path} timed out after ${Math.round(timeoutMs / 1000)}s`)
    throw new Error(`${path} failed: API server unreachable (is \`npm run dev:api\` running?)`)
  } finally {
    clearTimeout(timer)
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON body (e.g. proxy error page) */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? res.statusText ?? 'request failed'
    throw new Error(`${path} failed (${res.status}): ${msg}`)
  }
  return data as Res
}

export function searchPlaces(query: string, area?: string): Promise<SearchPlacesResponse> {
  return post<SearchPlacesRequest, SearchPlacesResponse>('search-places', { query, area })
}

/** Exa summaries are slower (~3–5s), so this one gets a longer timeout. */
export function findHappenings(query: string, when?: string): Promise<HappeningsResponse> {
  return post<HappeningsRequest, HappeningsResponse>('happenings', { query, when }, 9000)
}

export function geocode(query: string): Promise<GeocodeResponse> {
  return post<GeocodeRequest, GeocodeResponse>('geocode', { query })
}
