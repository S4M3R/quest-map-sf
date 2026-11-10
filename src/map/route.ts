// Glowing quest route + active-stop ground ring.
// Segments are cached by coordinate pair; walking (or, for legs > 5km, driving) geometry comes from the Mapbox
// Directions API (1.5s timeout) with a straight-line fallback. The segment ending
// at a newly added stop "draws in" by progressively growing its coordinates.
import type { Map as MbMap, GeoJSONSource, ExpressionSpecification } from 'mapbox-gl'
import { dayColor } from '../types'
import type { Stop } from '../types'

type Coord = [number, number]

const ROUTE_SRC = 'quest-route'
const ACTIVE_SRC = 'quest-active'
const GOLD = '#ffb547'
const DIM_OPACITY = 0.28
const DRAW_MS = 1400
const DIRECTIONS_TIMEOUT_MS = 1500
const DRIVE_OVER_KM = 5 // Bay Area hops (SF → Sausalito / Napa) use the driving profile

interface Segment {
  key: string
  from: Stop
  to: Stop
  day: number
}

const segKey = (a: Stop, b: Stop) => `${a.lng.toFixed(5)},${a.lat.toFixed(5)};${b.lng.toFixed(5)},${b.lat.toFixed(5)}`

export interface Route {
  /** (re)add sources + layers; safe to call on every style.load */
  install(): void
  /** one polyline per day (only consecutive stops of the same day are joined); activeDay drawn full strength */
  update(stops: Stop[], activeDay: number, animateToId?: string | null): void
  setActive(stop: Stop | null): void
}

export function createRoute(map: MbMap, token: string): Route {
  const geom = new Map<string, Coord[]>() // resolved (directions or fallback) geometry
  const inflight = new Map<string, Promise<void>>()
  let segments: Segment[] = []
  let anim: { key: string; progress: number } | null = null
  let rafId = 0
  let activeStop: Stop | null = null
  let activeDay = 1

  // ---------- geometry ----------
  const fetchSegment = (seg: Segment): Promise<void> => {
    if (geom.has(seg.key)) return Promise.resolve()
    const existing = inflight.get(seg.key)
    if (existing) return existing
    const straight: Coord[] = [
      [seg.from.lng, seg.from.lat],
      [seg.to.lng, seg.to.lat],
    ]
    const ctrl = new AbortController()
    const k = Math.cos(((seg.from.lat + seg.to.lat) / 2) * (Math.PI / 180))
    const km = Math.hypot((seg.to.lng - seg.from.lng) * k, seg.to.lat - seg.from.lat) * 111.32
    const profile = km > DRIVE_OVER_KM ? 'driving' : 'walking'
    // long driving legs take longer to resolve; the straight-line fallback covers a timeout
    const timer = window.setTimeout(() => ctrl.abort(), profile === 'driving' ? DIRECTIONS_TIMEOUT_MS * 2 : DIRECTIONS_TIMEOUT_MS)
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/${profile}/${seg.key}` +
      `?geometries=geojson&overview=full&access_token=${encodeURIComponent(token)}`
    const p = fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`directions ${r.status}`))))
      .then((j: { routes?: Array<{ geometry?: { coordinates?: Coord[] } }> }) => {
        const coords = j.routes?.[0]?.geometry?.coordinates
        if (!coords || coords.length < 2) throw new Error('no route')
        // stitch exact stop coordinates on both ends so the line meets the pins
        geom.set(seg.key, [straight[0], ...coords, straight[1]])
      })
      .catch(() => {
        geom.set(seg.key, straight)
      })
      .finally(() => {
        window.clearTimeout(timer)
        inflight.delete(seg.key)
      })
    inflight.set(seg.key, p)
    return p
  }

  const partial = (coords: Coord[], t: number): Coord[] => {
    if (t >= 1) return coords
    if (t <= 0 || coords.length < 2) return []
    // cumulative planar length (lng scaled by cos(lat))
    const k = Math.cos((coords[0][1] * Math.PI) / 180)
    const d: number[] = [0]
    for (let i = 1; i < coords.length; i++) {
      const dx = (coords[i][0] - coords[i - 1][0]) * k
      const dy = coords[i][1] - coords[i - 1][1]
      d.push(d[i - 1] + Math.hypot(dx, dy))
    }
    const target = d[d.length - 1] * t
    const out: Coord[] = [coords[0]]
    for (let i = 1; i < coords.length; i++) {
      if (d[i] <= target) {
        out.push(coords[i])
        continue
      }
      const seg = d[i] - d[i - 1] || 1
      const f = (target - d[i - 1]) / seg
      out.push([
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f,
      ])
      break
    }
    return out.length >= 2 ? out : []
  }

  // ---------- rendering ----------
  const render = () => {
    const src = map.getSource(ROUTE_SRC) as GeoJSONSource | undefined
    if (!src) return
    type Props = { color: string; active: boolean }
    const features: Array<{ type: 'Feature'; properties: Props; geometry: { type: 'LineString'; coordinates: Coord[] } }> = []
    for (const s of segments) {
      const full = geom.get(s.key) ?? [
        [s.from.lng, s.from.lat],
        [s.to.lng, s.to.lat],
      ]
      const coords = anim && anim.key === s.key ? partial(full, anim.progress) : full
      if (coords.length < 2) continue
      features.push({
        type: 'Feature',
        properties: { color: dayColor(s.day), active: s.day === activeDay },
        geometry: { type: 'LineString', coordinates: coords },
      })
    }
    // active day last so it draws on top of the dimmed ones
    features.sort((a, b) => Number(a.properties.active) - Number(b.properties.active))
    src.setData({ type: 'FeatureCollection', features })
  }

  const renderActive = () => {
    const src = map.getSource(ACTIVE_SRC) as GeoJSONSource | undefined
    if (!src) return
    src.setData({
      type: 'FeatureCollection',
      features: activeStop
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [activeStop.lng, activeStop.lat] } }]
        : [],
    })
  }

  const finishAnim = () => {
    if (rafId) cancelAnimationFrame(rafId)
    rafId = 0
    anim = null
  }

  const animate = (key: string) => {
    finishAnim()
    anim = { key, progress: 0 }
    render()
    void fetchSegment(segments.find((s) => s.key === key)!).then(() => {
      if (!anim || anim.key !== key) return
      const start = performance.now()
      const step = (now: number) => {
        if (!anim || anim.key !== key) return
        const t = Math.min(1, (now - start) / DRAW_MS)
        anim.progress = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 // easeInOutCubic
        render()
        if (t < 1) rafId = requestAnimationFrame(step)
        else {
          anim = null
          rafId = 0
          render()
        }
      }
      rafId = requestAnimationFrame(step)
    })
  }

  // ---------- public ----------
  const install = () => {
    const width: ExpressionSpecification = ['interpolate', ['exponential', 1.5], ['zoom'], 11, 1.5, 14, 3.5, 17, 9]
    const glowWidth: ExpressionSpecification = ['interpolate', ['exponential', 1.5], ['zoom'], 11, 8, 14, 16, 17, 40]
    const empty = { type: 'FeatureCollection' as const, features: [] }
    const color: ExpressionSpecification = ['coalesce', ['get', 'color'], GOLD]

    if (!map.getSource(ROUTE_SRC)) map.addSource(ROUTE_SRC, { type: 'geojson', data: empty })
    if (!map.getSource(ACTIVE_SRC)) map.addSource(ACTIVE_SRC, { type: 'geojson', data: empty })

    // Slot 'middle': above roads, below 3D buildings + labels. Occluded parts still
    // show through buildings via line-occlusion-opacity.
    if (!map.getLayer('quest-active-glow'))
      map.addLayer({
        id: 'quest-active-glow',
        type: 'circle',
        source: ACTIVE_SRC,
        slot: 'middle',
        paint: {
          'circle-color': GOLD,
          'circle-opacity': 0.28,
          'circle-blur': 0.9,
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 12, 10, 16, 60, 18, 220],
          'circle-pitch-alignment': 'map',
          'circle-emissive-strength': 1,
        },
      })
    if (!map.getLayer('quest-active-ring'))
      map.addLayer({
        id: 'quest-active-ring',
        type: 'circle',
        source: ACTIVE_SRC,
        slot: 'middle',
        paint: {
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': GOLD,
          'circle-stroke-width': 2.5,
          'circle-stroke-opacity': 0.95,
          'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 12, 6, 16, 34, 18, 130],
          'circle-pitch-alignment': 'map',
          'circle-emissive-strength': 1,
        },
      })
    // Two layer sets split by the `active` feature property (occlusion opacity requires a
    // constant line-opacity, so dimming is done per layer, not data-driven). Dim first = below.
    const isActive: ExpressionSpecification = ['==', ['get', 'active'], true]
    const notActive: ExpressionSpecification = ['!=', ['get', 'active'], true]
    const line = (id: string, filter: ExpressionSpecification, paint: Record<string, unknown>) => {
      if (map.getLayer(id)) return
      map.addLayer({
        id,
        type: 'line',
        source: ROUTE_SRC,
        slot: 'middle',
        filter,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-emissive-strength': 1, ...paint },
      } as Parameters<MbMap['addLayer']>[0])
    }
    line('quest-route-dim', notActive, {
      'line-color': color,
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 1.5, 14, 3, 17, 6],
      'line-opacity': DIM_OPACITY + 0.27,
      'line-dasharray': [2, 1.5],
      'line-occlusion-opacity': 0.15,
    })
    line('quest-route-glow', isActive, {
      'line-color': color,
      'line-width': glowWidth,
      'line-blur': ['interpolate', ['linear'], ['zoom'], 11, 6, 17, 22],
      'line-opacity': 0.5,
      'line-occlusion-opacity': 0.25,
    })
    line('quest-route-core', isActive, {
      'line-color': color,
      'line-width': width,
      'line-opacity': 1,
      'line-border-width': 1,
      'line-border-color': 'rgba(20, 10, 60, 0.6)',
      'line-occlusion-opacity': 0.45,
    })
    line('quest-route-spark', isActive, {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 0.5, 17, 2.2],
      'line-opacity': 0.8,
      'line-dasharray': [0.4, 2.2],
      'line-occlusion-opacity': 0.3,
    })
    render()
    renderActive()
  }

  const update = (stops: Stop[], day: number, animateToId?: string | null) => {
    activeDay = day
    const next: Segment[] = []
    const byDay = new Map<number, Stop[]>()
    for (const s of stops) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s])
    for (const [d, list] of byDay)
      for (let i = 1; i < list.length; i++) next.push({ key: segKey(list[i - 1], list[i]), from: list[i - 1], to: list[i], day: d })
    segments = next
    if (anim && !segments.some((s) => s.key === anim!.key)) finishAnim()

    const animSeg = animateToId ? segments.find((s) => s.to.id === animateToId) : undefined
    // kick off fetches for any unresolved segment; redraw when they land
    for (const s of segments) {
      if (geom.has(s.key) || s === animSeg) continue
      void fetchSegment(s).then(() => {
        if (segments.some((x) => x.key === s.key)) render()
      })
    }
    if (animSeg) animate(animSeg.key)
    else render()
  }

  const setActive = (stop: Stop | null) => {
    activeStop = stop
    const c = stop ? dayColor(stop.day) : GOLD
    try {
      if (map.getLayer('quest-active-glow')) map.setPaintProperty('quest-active-glow', 'circle-color', c)
      if (map.getLayer('quest-active-ring')) map.setPaintProperty('quest-active-ring', 'circle-stroke-color', c)
    } catch {
      /* style not ready */
    }
    renderActive()
  }

  return { install, update, setActive }
}
