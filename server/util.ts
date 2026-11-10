// Small shared helpers for the API server.

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** fetch JSON with a hard timeout; throws on non-2xx */
export async function fetchJson<T = any>(url: string, timeoutMs: number, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    if (!res.ok) throw new Error(`upstream ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** resolve to `fallback` if `p` takes longer than `ms` or rejects */
export function within<T>(p: Promise<T>, ms: number, fallback: T, label?: string): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (label) console.warn(`[api] ${label} timed out after ${ms}ms`)
      resolve(fallback)
    }, ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        if (label) console.warn(`[api] ${label} failed: ${(e as Error)?.message ?? e}`)
        resolve(fallback)
      },
    )
  })
}

export const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'co', 'cafe', 'caffe', 'coffee', 'sf', 'san', 'francisco', 'bar', 'restaurant', 'company', 'inc', 'at', 'in', 'on'])

/** distinctive tokens of a place name ("Réveille Coffee Co." → ["reveille"]) */
export const coreTokens = (s: string) => norm(s).split(' ').filter((t) => t.length > 2 && !STOP.has(t))

/** true when two place names plausibly refer to the same place */
export function sameName(a: string, b: string): boolean {
  const na = norm(a)
  const nb = norm(b)
  if (!na || !nb) return false
  if (na === nb || na.includes(nb) || nb.includes(na)) return true
  const ta = coreTokens(a)
  const tb = new Set(coreTokens(b))
  if (!ta.length || !tb.size) return false
  const hits = ta.filter((t) => tb.has(t)).length
  return hits / Math.min(ta.length, tb.size) >= 0.6
}

/** does free text mention this place name? */
export function mentions(text: string, name: string): boolean {
  const nt = ` ${norm(text)} `
  const nn = norm(name)
  if (nn && nt.includes(` ${nn} `)) return true
  const toks = coreTokens(name)
  return toks.length > 0 && toks.every((t) => nt.includes(` ${t} `))
}

/** trim to a single tidy line */
export function oneLine(s: string | undefined, max = 160): string | undefined {
  if (!s) return undefined
  let t = s.replace(/\s+/g, ' ').replace(/^[\s.…-]+/, '').trim()
  if (!t) return undefined
  if (t.length > max) {
    const cut = t.slice(0, max)
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '))
    t = lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : cut.replace(/\s+\S*$/, '') + '…'
  }
  return t
}

/** great-circle distance in meters */
export function distanceM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371e3
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
