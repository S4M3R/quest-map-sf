/**
 * Quest Map scene (map agent) — mapbox-gl v3, Standard style.
 *
 * CONTRACT for the dispatcher / voice layer:
 *  - add_stop: the map AUTO-FLIES to every newly added stop (detected by a new id
 *    in store.subscribe) unless `state.touring` is true. The dispatcher does NOT
 *    need to call focusStop after store.addStop. If it does anyway, focusStop is
 *    idempotent: a call for the id that is already being flown to returns the same
 *    in-flight promise (no double animation).
 *  - When several stops are added in one tick, only the last one is flown to.
 *  - focusStop / flyTo / overview called from outside cancel a running tour.
 *  - playTour sets store.touring true→false itself; stopTour (or the user grabbing /
 *    scrolling the map) cancels it and the playTour promise resolves.
 *  - Light preset follows store.lightPreset automatically; setLightPreset is also
 *    safe to call directly (idempotent).
 *  - Clearing all stops eases back to the default downtown view.
 *  - Multi-day: pins/routes are colored by dayColor(stop.day) and numbered within their day;
 *    days other than state.activeDay are dimmed. When activeDay changes on its own
 *    (set_day / itinerary tab, i.e. not via addStop or focusing a stop, and not during a tour)
 *    the camera runs overview(activeDay) if that day has stops.
 *  - playTour(day?) defaults to activeDay; 'all' tours day by day, switching activeDay as it goes.
 *  - overview(day?) defaults to activeDay; 'all' fits everything.
 *  - show_options: while state.options is set, lettered "ghost" pins A/B/C are shown and the camera
 *    fits them (+ the day's last stop). Window event 'quest:hover-option' {label} highlights one;
 *    clicking a ghost dispatches 'quest:pick-option' {label} (handled by the options UI).
 */
import mapboxgl from 'mapbox-gl'
import type { EasingOptions, Map as MbMap, PaddingOptions, GeoJSONFeature, TargetFeature } from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import './map.css'
import type { CameraTarget, LightPreset, MapController, Stop } from '../types'
import type { TripStore } from '../state/store'
import { createMarkers } from './markers'
import { createRoute } from './route'
import { createGhosts } from './ghosts'

const DEFAULT_VIEW = {
  center: [-122.4035, 37.7885] as [number, number], // Union Sq → FiDi, looking north-ish
  zoom: 14.8,
  pitch: 60,
  bearing: -20,
}
const STOP_ZOOM = 16.5
const NO_PAD = { top: 0, right: 0, bottom: 0, left: 0 }
const FLY_MS = 2500
const BUILDINGS = { featuresetId: 'buildings', importId: 'basemap' }

const noopController = (): MapController => ({
  ready: Promise.resolve(),
  flyTo: async () => {},
  focusStop: async () => {},
  setLightPreset: () => {},
  playTour: async () => {},
  stopTour: () => {},
  overview: async () => {},
  unproject: () => null,
  project: () => null,
})

function renderMissingToken(container: HTMLElement) {
  container.innerHTML = `
    <div class="qm-missing">
      <div class="qm-missing__card">
        <div class="qm-missing__glyph">◆</div>
        <h2>The quest map is sleeping</h2>
        <p>Add a Mapbox public token as <code>VITE_MAPBOX_TOKEN=pk.…</code> in <code>.env</code> and restart <code>npm run dev</code> to wake up San Francisco.</p>
      </div>
    </div>`
}

export function createMap(container: HTMLElement, store: TripStore): MapController {
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined
  if (!token) {
    renderMissingToken(container)
    return noopController()
  }

  let map: MbMap
  try {
    mapboxgl.accessToken = token
    map = new mapboxgl.Map({
      container,
      accessToken: token,
      style: 'mapbox://styles/mapbox/standard',
      config: {
        basemap: {
          lightPreset: store.get().lightPreset ?? 'dusk',
          showPointOfInterestLabels: false, // our quest pins are the POIs
          showTransitLabels: false,
          colorBuildingSelect: '#ffb547',
          colorBuildingHighlight: '#ffcf85',
        },
      },
      ...DEFAULT_VIEW,
      antialias: true,
      attributionControl: false,
      logoPosition: 'bottom-right',
      maxPitch: 75,
    })
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right')
  } catch (e) {
    console.error('[map] failed to init', e)
    renderMissingToken(container)
    container.querySelector('h2')!.textContent = 'The map could not start (WebGL?)'
    return noopController()
  }

  map.on('error', (e) => console.warn('[map]', e.error ?? e))

  // ---------------------------------------------------------------- state
  let styleReady = false
  let currentPreset: LightPreset | null = null
  let tour: { cancelled: boolean } | null = null
  let focusing: { id: string; p: Promise<void> } | null = null
  let overviewing: { day: number | 'all'; p: Promise<void> } | null = null
  let highlighted: GeoJSONFeature | TargetFeature | null = null
  let hlGen = 0

  const markers = createMarkers(map, (id) => void focusStop(id))
  const route = createRoute(map, token)
  const ghosts = createGhosts(map, (label) => window.dispatchEvent(new CustomEvent('quest:pick-option', { detail: { label } })))
  window.addEventListener('quest:hover-option', (e) => ghosts.hover((e as CustomEvent<{ label: string | null }>).detail?.label ?? null))

  const stopById = (id: string | null) => (id ? store.get().stops.find((s) => s.id === id) ?? null : null)

  // ---------------------------------------------------------------- camera core
  /** Run a camera animation and resolve on its moveend (or a safety timeout). */
  const animate = (kind: 'flyTo' | 'easeTo', opts: EasingOptions): Promise<void> =>
    new Promise<void>((resolve) => {
      // flush any running animation first so its (synchronous) moveend can't resolve us
      map.stop()
      let done = false
      const finish = () => {
        if (done) return
        done = true
        window.clearTimeout(timer)
        map.off('moveend', finish)
        resolve()
      }
      const timer = window.setTimeout(finish, (opts.duration ?? FLY_MS) + 1500)
      map.on('moveend', finish)
      try {
        // padding is sticky in mapbox: every move resets it unless it explicitly frames with padding
        map[kind]({ essential: true, padding: NO_PAD, ...opts })
      } catch (e) {
        console.warn('[map] camera', e)
        finish()
      }
    })

  const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

  /** km between the current camera centre and a point */
  const kmFromCamera = (lng: number, lat: number) => {
    const c = map.getCenter()
    const k = Math.cos(((c.lat + lat) / 2) * (Math.PI / 180))
    return Math.hypot((lng - c.lng) * k, lat - c.lat) * 111.32
  }
  /** Bay Area hops (SF → Napa ~70km) read as a journey: zoom out to ~10 mid-flight, take longer */
  const journey = (lng: number, lat: number, baseMs: number): Partial<EasingOptions> => {
    const km = kmFromCamera(lng, lat)
    if (km < 8) return { duration: baseMs }
    return { duration: Math.round(Math.min(baseMs + 1000 + km * 30, 6000)), minZoom: km > 25 ? 9.5 : 10.5, curve: 1.6 } as Partial<EasingOptions>
  }

  const bearingFor = (i: number) => ((i * 47) % 90) - 45 // varied but bounded, cinematic

  const overviewPadding = (): PaddingOptions => {
    const w = container.clientWidth || window.innerWidth
    const h = container.clientHeight || window.innerHeight
    const narrow = w < 640
    let top = narrow ? 70 : 100
    // wide screens: keep clear of the polaroid stack (+ debug panel) on the right
    let right = narrow ? 30 : w >= 1100 ? (document.querySelector('#debug > *') ? 600 : 260) : 90
    let left = narrow ? 30 : 400
    let bottom = narrow ? Math.round(h * 0.4 + 130) : 160
    // never let padding swallow the viewport (mapbox refuses to fit then)
    if (left + right > w - 120) left = right = Math.max(10, (w - 120) / 4)
    if (top + bottom > h - 120) {
      top = 40
      bottom = Math.max(10, Math.min(bottom, h - 200))
    }
    return { top, right, bottom, left }
  }

  const stopsFor = (day: number | 'all') => (day === 'all' ? store.get().stops : store.stopsForDay(day))

  /** frame a set of points (the 3 options + context) */
  const fitPoints = (pts: Array<{ lng: number; lat: number }>, ms = 2200): Promise<void> => {
    if (!pts.length) return Promise.resolve()
    if (pts.length === 1) return animate('flyTo', { center: [pts[0].lng, pts[0].lat], zoom: 15.4, pitch: 55, bearing: -15, duration: ms })
    const bounds = new mapboxgl.LngLatBounds()
    pts.forEach((p) => bounds.extend([p.lng, p.lat]))
    let cam: EasingOptions | null | undefined = null
    let padding: PaddingOptions = NO_PAD
    try {
      // the chooser cards sit bottom-centre: frame the pins in the space above them
      const pad = overviewPadding()
      const h = container.clientHeight || window.innerHeight
      const chooser = document.querySelector('#options .qo:not(.is-leaving)')?.getBoundingClientRect()
      const below = chooser && chooser.height ? h - chooser.top + 24 : Math.min(380, h * 0.45)
      const bottom = Math.min(Math.max(pad.bottom ?? 0, below), Math.max(10, h - (pad.top ?? 0) - 140))
      padding = { ...pad, bottom }
      cam = map.cameraForBounds(bounds, { padding, pitch: 45, bearing: -15, maxZoom: 15.5 })
    } catch {
      cam = null
    }
    if (!cam || cam.center == null) return animate('flyTo', { center: bounds.getCenter(), zoom: 13, pitch: 45, bearing: -15, duration: ms })
    return animate('flyTo', { ...cam, padding, pitch: 45, bearing: -15, zoom: Math.min(cam.zoom ?? 14, 15.5), duration: ms })
  }

  const doOverview = async (day: number | 'all' = 'all'): Promise<void> => {
    let stops = stopsFor(day)
    if (!stops.length) stops = store.get().stops // empty day → frame the whole trip instead
    if (!stops.length) return animate('flyTo', { ...DEFAULT_VIEW, duration: 2000 })
    if (stops.length === 1) {
      const s = stops[0]
      return animate('flyTo', { center: [s.lng, s.lat], zoom: 15.4, pitch: 55, bearing: -15, duration: 2000 })
    }
    const bounds = new mapboxgl.LngLatBounds()
    stops.forEach((s) => bounds.extend([s.lng, s.lat]))
    const bearing = -15
    const ovPad = overviewPadding()
    let cam: EasingOptions | null | undefined = null
    try {
      cam = map.cameraForBounds(bounds, { padding: ovPad, pitch: 50, bearing, maxZoom: 16 })
    } catch {
      cam = null
    }
    if (!cam || cam.center == null) {
      return animate('flyTo', { center: bounds.getCenter(), zoom: 13, pitch: 50, bearing, duration: 2200 })
    }
    return animate('flyTo', { ...cam, padding: ovPad, pitch: 50, bearing, zoom: Math.min(cam.zoom ?? 14, 16), duration: 2200 })
  }

  // ---------------------------------------------------------------- building highlight
  const clearBuilding = () => {
    if (!highlighted) return
    try {
      map.setFeatureState(highlighted, { select: false })
    } catch {
      /* ignore */
    }
    highlighted = null
  }

  const highlightBuilding = (stop: Stop) => {
    clearBuilding()
    try {
      const p = map.project([stop.lng, stop.lat])
      let feats: Array<GeoJSONFeature | TargetFeature> = map.queryRenderedFeatures(p, { target: BUILDINGS })
      if (!feats.length) {
        feats = map.queryRenderedFeatures(
          [
            [p.x - 16, p.y - 16],
            [p.x + 16, p.y + 16],
          ],
          { target: BUILDINGS },
        )
      }
      const f = feats.find((x) => (x as { id?: unknown }).id != null)
      if (f) {
        map.setFeatureState(f, { select: true })
        highlighted = f
      }
    } catch (e) {
      // featureset missing / API mismatch: the gold ground ring is the fallback
      console.debug('[map] building highlight skipped', e)
    }
  }

  /** highlight the active stop's building once the camera has settled there */
  const scheduleHighlight = () => {
    const gen = ++hlGen
    const run = () => {
      if (gen !== hlGen || !styleReady) return
      const s = stopById(store.get().activeStopId)
      if (s) highlightBuilding(s)
      else clearBuilding()
    }
    // defer a beat: setActive usually happens right before a flight starts
    window.setTimeout(() => {
      if (gen !== hlGen) return
      if (!map.isMoving()) return run()
      map.once('moveend', () => {
        if (gen !== hlGen) return
        // give tiles a moment to render at the destination
        let fired = false
        const go = () => {
          if (fired) return
          fired = true
          run()
        }
        map.once('idle', go)
        window.setTimeout(go, 1200)
      })
    }, 80)
  }

  // ---------------------------------------------------------------- public API
  const setLightPreset = (preset: LightPreset) => {
    if (preset === currentPreset) return
    if (!styleReady) return // applied on style.load from store / config
    try {
      map.setConfigProperty('basemap', 'lightPreset', preset)
      currentPreset = preset
    } catch (e) {
      console.warn('[map] lightPreset', e)
    }
  }

  const stopTour = () => {
    if (!tour) return
    tour.cancelled = true
    tour = null
    map.stop()
    if (store.get().touring) store.setTouring(false)
  }

  const flyStop = (stop: Stop, index: number) =>
    animate('flyTo', {
      center: [stop.lng, stop.lat],
      zoom: STOP_ZOOM,
      pitch: 60,
      bearing: bearingFor(index),
      duration: FLY_MS,
      curve: 1.5,
      ...journey(stop.lng, stop.lat, FLY_MS),
    })

  const focusStop = (id: string): Promise<void> => {
    if (focusing && focusing.id === id) return focusing.p
    const stop = stopById(id)
    if (!stop) return Promise.resolve()
    stopTour()
    overviewing = null
    if (store.get().activeStopId !== id) store.setActive(id)
    const p = flyStop(stop, store.indexInDay(id) - 1).finally(() => {
      if (focusing && focusing.p === p) focusing = null
    })
    focusing = { id, p }
    return p
  }

  const flyTo = (t: CameraTarget): Promise<void> => {
    stopTour()
    focusing = null
    overviewing = null
    return animate('flyTo', {
      center: [t.lng, t.lat],
      zoom: t.zoom ?? STOP_ZOOM,
      pitch: t.pitch ?? 60,
      bearing: t.bearing ?? map.getBearing(),
      ...journey(t.lng, t.lat, t.durationMs ?? FLY_MS),
    })
  }

  /** overview(day) while the same overview is already flying returns that promise (no restart jitter) */
  const overview = (day?: number | 'all'): Promise<void> => {
    const d = day ?? store.get().activeDay
    if (overviewing && overviewing.day === d) return overviewing.p
    stopTour()
    focusing = null
    const p = doOverview(d).finally(() => {
      if (overviewing && overviewing.p === p) overviewing = null
    })
    overviewing = { day: d, p }
    return p
  }

  const playTour = async (day?: number | 'all'): Promise<void> => {
    stopTour()
    focusing = null
    overviewing = null
    if (!store.get().stops.length) return
    const want = day ?? store.get().activeDay
    // days to fly, in order; an empty requested day falls back to the whole trip
    let days = want === 'all' ? [...new Set(store.get().stops.map((s) => s.day))].sort((a, b) => a - b) : [want]
    if (want !== 'all' && !store.stopsForDay(want).length) days = [...new Set(store.get().stops.map((s) => s.day))].sort((a, b) => a - b)
    const multi = days.length > 1
    const tok = { cancelled: false }
    tour = tok
    store.setTouring(true)
    try {
      if (multi) {
        await doOverview('all')
        if (tok.cancelled) return
        await sleep(500)
      }
      for (const d of days) {
        if (tok.cancelled) return
        if (store.get().activeDay !== d) store.setActiveDay(d)
        await doOverview(d)
        if (tok.cancelled) return
        await sleep(400)
        const ids = store.stopsForDay(d).map((s) => s.id)
        for (let i = 0; i < ids.length; i++) {
          if (tok.cancelled) return
          const s = stopById(ids[i])
          if (!s) continue // removed mid-tour
          if (store.get().activeStopId !== s.id) store.setActive(s.id)
          const b = bearingFor(i)
          await animate('flyTo', { center: [s.lng, s.lat], zoom: 16.8, pitch: 62, bearing: b, duration: 1900, curve: 1.3, ...journey(s.lng, s.lat, 1900) })
          if (tok.cancelled) return
          // slow orbit around the stop
          await animate('easeTo', { bearing: b + 40, zoom: 17, duration: 1600, easing: (t) => t })
        }
      }
      if (tok.cancelled) return
      await doOverview(multi ? 'all' : days[0])
    } finally {
      if (tour === tok) {
        tour = null
        if (store.get().touring) store.setTouring(false)
      }
    }
  }

  // cancel the tour as soon as the user grabs / scrolls the map
  const canvas = map.getCanvas()
  const userInterrupt = () => {
    if (tour) stopTour()
  }
  canvas.addEventListener('pointerdown', userInterrupt, { passive: true })
  canvas.addEventListener('wheel', userInterrupt, { passive: true })

  // ---------------------------------------------------------------- style lifecycle
  let resolveReady!: () => void
  const ready = new Promise<void>((r) => (resolveReady = r))
  // never block callers forever on a bad token / offline style
  window.setTimeout(() => resolveReady(), 15000)

  map.on('style.load', () => {
    styleReady = true
    currentPreset = null
    setLightPreset(store.get().lightPreset)
    try {
      route.install()
      route.update(store.get().stops, store.get().activeDay)
      route.setActive(stopById(store.get().activeStopId))
    } catch (e) {
      console.error('[map] route layers', e)
    }
    scheduleHighlight()
  })
  map.on('load', () => resolveReady())

  // ---------------------------------------------------------------- store → scene
  const syncActive = () => {
    const s = store.get()
    markers.setActive(s.activeStopId)
    if (styleReady) route.setActive(stopById(s.activeStopId))
  }

  markers.sync(store.get().stops, store.get().activeStopId, store.get().activeDay)

  ghosts.sync(store.get().options)

  store.subscribe((s, prev) => {
    if (s.lightPreset !== prev.lightPreset) setLightPreset(s.lightPreset)

    if (s.options !== prev.options) {
      ghosts.sync(s.options)
      // a new option set (not just a photo patch) → frame the candidates + where the day currently ends
      const fresh = s.options && (!prev.options || prev.options.title !== s.options.title || prev.options.options.map((o) => o.name).join() !== s.options.options.map((o) => o.name).join())
      if (fresh && !s.touring) {
        const set = s.options!
        queueMicrotask(() => {
          if (store.get().options !== set && store.get().options?.title !== set.title) return
          stopTour()
          focusing = null
          overviewing = null
          const last = store.stopsForDay(set.day).slice(-1)
          void fitPoints([...set.options, ...last])
        })
      }
    }

    const dayChanged = s.activeDay !== prev.activeDay
    let newest: Stop | undefined
    if (s.stops !== prev.stops || dayChanged) {
      const prevIds = new Set(prev.stops.map((x) => x.id))
      const added = s.stops !== prev.stops ? s.stops.filter((x) => !prevIds.has(x.id)) : []
      newest = added[added.length - 1]
      markers.sync(s.stops, s.activeStopId, s.activeDay)
      if (styleReady) route.update(s.stops, s.activeDay, newest?.id ?? null)
    }

    // switched day on its own (set_day / tab click) → frame that day if it has stops
    if (dayChanged && !newest && !s.touring && !s.activeStopId && store.stopsForDay(s.activeDay).length) {
      queueMicrotask(() => {
        const st = store.get()
        if (!st.touring && st.activeDay === s.activeDay) void overview(st.activeDay)
      })
    }

    if (s.stops !== prev.stops) {
      if (newest && !s.touring) {
        // defer: never mutate the store from inside its own emit
        queueMicrotask(() => {
          if (!store.get().touring && store.get().stops.some((x) => x.id === newest.id)) void focusStop(newest.id)
        })
      }
      if (!s.stops.length && prev.stops.length) {
        stopTour()
        focusing = null
        clearBuilding()
        void animate('flyTo', { ...DEFAULT_VIEW, duration: 2000 })
      }
    }

    if (s.activeStopId !== prev.activeStopId || s.stops !== prev.stops) {
      syncActive()
      if (s.activeStopId !== prev.activeStopId) scheduleHighlight()
    }
  })

  const unproject = (x: number, y: number) => {
    if (!styleReady) return null
    try {
      const ll = map.unproject([x, y])
      return { lng: ll.lng, lat: ll.lat }
    } catch {
      return null
    }
  }
  const project = (p: { lng: number; lat: number }) => {
    if (!styleReady) return null
    try {
      const pt = map.project([p.lng, p.lat])
      return { x: pt.x, y: pt.y }
    } catch {
      return null
    }
  }

  return { ready, flyTo, focusStop, setLightPreset, playTour, stopTour, overview, unproject, project }
}
