// Browser wrapper for POST /api/photo (instant-photo image for a stop). Never throws.
import type { PhotoRequest, PhotoResponse } from '../types'

const EMPTY: PhotoResponse = { photoUrl: null, source: null }

export async function fetchPhoto(req: PhotoRequest, timeoutMs = 5000): Promise<PhotoResponse> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch('/api/photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    })
    if (!res.ok) return EMPTY
    const j = (await res.json()) as Partial<PhotoResponse>
    return typeof j?.photoUrl === 'string' && j.photoUrl
      ? { photoUrl: j.photoUrl, source: j.source ?? null }
      : EMPTY
  } catch {
    return EMPTY
  } finally {
    clearTimeout(timer)
  }
}

/** client-side Mapbox satellite snapshot of a spot — the always-works fallback */
export function mapboxSnapshotUrl(lat: number, lng: number): string | null {
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined
  if (!token || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const bearing = Math.round((Math.abs(lat * 1000 + lng * 1000) % 60) - 30)
  return (
    `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/` +
    `${lng.toFixed(5)},${lat.toFixed(5)},17.5,${bearing},55/600x600@2x` +
    `?access_token=${encodeURIComponent(token)}&logo=false&attribution=false`
  )
}
