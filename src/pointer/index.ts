// Pointer → Karl: "what's good around here?" while pointing at the map.
// Tracks the cursor/finger over the map, resolves what it points at (hover rest, tap pin, swept/drawn area)
// to a place name via /api/reverse, writes it to store.pointer (read by the get_pointer tool), and when the
// user says a deictic word ("here", "this area", "over there") injects it into the live call via
// 'quest:voice-context'. Visual: a soft "Karl is watching" spotlight ring + place-name chip.
import './pointer.css'
import type { LngLat, MapController, PointerContext } from '../types'
import type { TripStore } from '../state/store'

interface Deps {
  store: TripStore
  map: MapController
}
interface TrailPt extends LngLat {
  t: number
}
interface Resolved {
  label: string
  nearby: string[]
}
type Ctx = Omit<PointerContext, 'label' | 'nearby' | 'updatedAt'>

const MOVE_THROTTLE_MS = 60
const REST_MS = 400
const TRAIL_MS = 15_000 // long enough to cover one utterance
const RECENT_MS = 4_000
const AREA_MIN_SPAN_M = 250
const EXPLICIT_TTL_MS = 20_000
const FRESH_MS = 10_000
const IDLE_CLEAR_MS = 20_000
const DRAG_PX = 6
const CLICK_MAX_MS = 450
const PRE_ROLL_MS = 1_200 // pointing usually starts slightly before the words

const STRONG = /\b(here|this (area|place|spot|neighbou?rhood|one|part|block|street)|that (area|place|spot|one|part)|over there|around here|right there|these( ones)?|those)\b/i
const WEAK = /\b(this|that)\b/i

// ---------- geo helpers ----------
function distM(a: LngLat, b: LngLat): number {
  const R = 6371e3
  const r = (d: number) => (d * Math.PI) / 180
  const dLat = r(b.lat - a.lat)
  const dLng = r(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
function centroid(pts: LngLat[]): LngLat {
  const n = pts.length || 1
  return { lng: pts.reduce((s, p) => s + p.lng, 0) / n, lat: pts.reduce((s, p) => s + p.lat, 0) / n }
}
/** circle around pts: center = centroid, radius = 90th-percentile distance (ignores stray flicks) */
function coverCircle(pts: LngLat[]): { center: LngLat; radiusM: number } {
  const center = centroid(pts)
  const ds = pts.map((p) => distM(center, p)).sort((a, b) => a - b)
  const r = ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.9))] ?? 0
  return { center, radiusM: Math.min(5000, Math.max(120, r)) }
}
function span(pts: LngLat[]): number {
  if (pts.length < 2) return 0
  let lo = { lng: Infinity, lat: Infinity }
  let hi = { lng: -Infinity, lat: -Infinity }
  for (const p of pts) {
    lo = { lng: Math.min(lo.lng, p.lng), lat: Math.min(lo.lat, p.lat) }
    hi = { lng: Math.max(hi.lng, p.lng), lat: Math.max(hi.lat, p.lat) }
  }
  return distM(lo, hi)
}
const offsetEast = (p: LngLat, m: number): LngLat => ({ lat: p.lat, lng: p.lng + m / (111_320 * Math.cos((p.lat * Math.PI) / 180)) })

// ---------- reverse lookup (client cache + in-flight dedupe) ----------
const revCache = new Map<string, Promise<Resolved>>()
function reverseLookup(p: LngLat, radiusM?: number): Promise<Resolved> {
  const key = `${p.lat.toFixed(3)},${p.lng.toFixed(3)},${Math.round((radiusM ?? 0) / 250)}`
  const hit = revCache.get(key)
  if (hit) return hit
  const fallback: Resolved = { label: `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`, nearby: [] }
  const job = (async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2000)
    try {
      const res = await fetch('/api/reverse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lat: p.lat, lng: p.lng, radiusM }),
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`reverse ${res.status}`)
      const j = (await res.json()) as Partial<Resolved>
      return { label: typeof j.label === 'string' && j.label ? j.label : fallback.label, nearby: Array.isArray(j.nearby) ? j.nearby.map(String) : [] }
    } catch {
      revCache.delete(key) // don't cache failures
      return fallback
    } finally {
      clearTimeout(timer)
    }
  })()
  revCache.set(key, job)
  if (revCache.size > 500) revCache.delete(revCache.keys().next().value!)
  return job
}

// ---------- DOM ----------
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: Element): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  parent?.appendChild(e)
  return e
}
const SVGNS = 'http://www.w3.org/2000/svg'

export function mountPointer(mapContainer: HTMLElement, deps: Deps): { destroy(): void } {
  const { store, map } = deps
  const hasProject = typeof map.project === 'function' && typeof map.unproject === 'function'
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  const coarse = window.matchMedia?.('(hover: none)').matches ?? false

  // overlay
  const layer = el('div', 'qp-layer', mapContainer)
  layer.setAttribute('aria-hidden', 'true')
  if (reduceMotion) layer.classList.add('qp-reduced')
  const svg = document.createElementNS(SVGNS, 'svg')
  svg.setAttribute('class', 'qp-svg')
  layer.appendChild(svg)
  const areaCircle = document.createElementNS(SVGNS, 'circle')
  areaCircle.setAttribute('class', 'qp-area')
  svg.appendChild(areaCircle)
  const lasso = document.createElementNS(SVGNS, 'polyline')
  lasso.setAttribute('class', 'qp-lasso')
  svg.appendChild(lasso)
  const ring = el('div', 'qp-ring', layer)
  el('div', 'qp-ring-core', ring)
  const chip = el('div', 'qp-chip', layer)
  const pinEl = el('div', 'qp-pin', layer)
  el('div', 'qp-pin-head', pinEl)
  const pinChip = el('div', 'qp-chip qp-chip--pin', pinEl)

  // ---------- state ----------
  const trail: TrailPt[] = []
  let cursor: { x: number; y: number } | null = null // container px
  let overMap = false
  let lastSampleAt = 0
  let lastActivityAt = 0
  let restTimer = 0
  let idleTimer = 0
  let hoverSeq = 0

  let down: { x: number; y: number; t: number; id: number; draw: boolean; onCanvas: boolean } | null = null
  let dragging = false
  let drawPts: { x: number; y: number; ll: LngLat }[] = []

  /** explicit intent (tap pin / alt-drawn area) beats hover for EXPLICIT_TTL_MS */
  let explicit: { ctx: PointerContext; until: number } | null = null
  /** area shown while speaking (geo; projected each frame) */
  let speakArea: { center: LngLat; radiusM: number } | null = null
  let pinTimer = 0

  let speaking = false
  let utterStart = 0
  let utterSent: { lat: number; lng: number; radiusM?: number; kind: string } | null = null
  let flashTimer = 0
  let chipText = ''

  const rectOf = () => mapContainer.getBoundingClientRect()
  const localXY = (e: { clientX: number; clientY: number }) => {
    const r = rectOf()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const toLL = (x: number, y: number): LngLat | null => (hasProject ? map.unproject(x, y) : null)
  const toPx = (p: LngLat) => (hasProject ? map.project(p) : null)

  const pruneTrail = (now: number) => {
    while (trail.length && now - trail[0].t > TRAIL_MS) trail.shift()
  }
  const trailSince = (t: number) => trail.filter((p) => p.t >= t)

  // ---------- visuals ----------
  const setChip = (text: string) => {
    if (text === chipText) return
    chipText = text
    chip.textContent = text
    chip.classList.toggle('is-on', !!text)
  }
  const flashShared = () => {
    layer.classList.add('is-shared')
    const prev = chipText
    chip.textContent = '📍 shared with Karl'
    chip.classList.add('is-on', 'is-flash')
    pinChip.classList.add('is-flash')
    clearTimeout(flashTimer)
    flashTimer = window.setTimeout(() => {
      layer.classList.remove('is-shared')
      chip.classList.remove('is-flash')
      pinChip.classList.remove('is-flash')
      chipText = ''
      setChip(prev)
    }, 1800)
  }
  const setSpeaking = (s: boolean) => {
    if (s === speaking) return
    speaking = s
    layer.classList.toggle('is-speaking', s)
    if (s) {
      utterStart = Date.now() - PRE_ROLL_MS
      utterSent = null
    } else {
      // keep the area visible a moment after speaking, then fade
      window.setTimeout(() => {
        if (!speaking) speakArea = null
      }, 2500)
    }
  }

  let raf = 0
  const frame = () => {
    raf = requestAnimationFrame(frame)
    // cursor ring
    const showRing = !coarse && overMap && !!cursor && !dragging
    ring.classList.toggle('is-on', showRing)
    if (cursor) {
      const tf = `translate3d(${cursor.x}px, ${cursor.y}px, 0)`
      ring.style.transform = tf
      chip.style.transform = `translate3d(${cursor.x + 22}px, ${cursor.y + 18}px, 0)`
    }
    chip.classList.toggle('is-hidden', !showRing && !chip.classList.contains('is-flash'))
    // area circle (drawn area / speaking sweep)
    const area = explicit && explicit.ctx.kind === 'area' && Date.now() < explicit.until ? { center: explicit.ctx, radiusM: explicit.ctx.radiusM ?? 0 } : speakArea
    const c = area ? toPx(area.center) : null
    const e = area && c ? toPx(offsetEast(area.center, area.radiusM)) : null
    if (area && c && e) {
      const rpx = Math.max(12, Math.hypot(e.x - c.x, e.y - c.y))
      areaCircle.setAttribute('cx', String(c.x))
      areaCircle.setAttribute('cy', String(c.y))
      areaCircle.setAttribute('r', String(rpx))
      areaCircle.classList.add('is-on')
    } else areaCircle.classList.remove('is-on')
    // pin
    const pinLive = explicit && explicit.ctx.kind === 'pin' && Date.now() < explicit.until
    if (pinLive) {
      const p = toPx(explicit!.ctx)
      if (p) pinEl.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`
      pinEl.classList.toggle('is-on', !!p)
    } else pinEl.classList.remove('is-on')
  }
  raf = requestAnimationFrame(frame)

  // ---------- context ----------
  const commit = async (ctx: Ctx, opts: { isCurrent?: () => boolean } = {}): Promise<PointerContext | null> => {
    const r = await reverseLookup(ctx, ctx.radiusM)
    if (opts.isCurrent && !opts.isCurrent()) return null
    const full: PointerContext = { ...ctx, label: r.label, nearby: r.nearby, updatedAt: Date.now() }
    store.setPointer(full)
    return full
  }

  const explicitLive = () => (explicit && Date.now() < explicit.until ? explicit.ctx : null)

  /** what the user points at during the current utterance (trail since it began) */
  const utteranceCtx = (): Ctx | null => {
    const pts = trailSince(utterStart)
    const recent = pts.length ? pts : trailSince(Date.now() - RECENT_MS)
    if (!recent.length) return null
    if (span(recent) > AREA_MIN_SPAN_M) {
      const { center, radiusM } = coverCircle(recent)
      return { ...center, radiusM, kind: 'area' }
    }
    const last = recent[recent.length - 1]
    return { lng: last.lng, lat: last.lat, kind: 'hover' }
  }

  const onRest = () => {
    if (!cursor || dragging || !overMap) return
    const ll = toLL(cursor.x, cursor.y)
    if (!ll) return
    const seq = ++hoverSeq
    void reverseLookup(ll).then((r) => {
      if (seq === hoverSeq) setChip(r.label)
    })
    if (explicitLive()) return // a tapped pin / drawn area stays the context until it expires
    if (speaking) {
      const u = utteranceCtx()
      if (u) {
        if (u.kind === 'area') speakArea = { center: u, radiusM: u.radiusM ?? 0 }
        void commit(u)
        return
      }
    }
    void commit({ ...ll, kind: 'hover' }, { isCurrent: () => seq === hoverSeq })
  }

  const scheduleIdleClear = () => {
    clearTimeout(idleTimer)
    idleTimer = window.setTimeout(() => {
      if (!explicitLive() && store.get().pointer?.kind === 'hover' && Date.now() - lastActivityAt >= IDLE_CLEAR_MS) store.setPointer(null)
    }, IDLE_CLEAR_MS + 50)
  }

  // ---------- deictic → voice ----------
  const describe = (p: PointerContext) => {
    const across = p.kind === 'area' && p.radiusM ? Math.round((p.radiusM * 2) / 50) * 50 : 0
    const where = /^near /i.test(p.label) ? p.label : `at ${p.label}`
    const what = p.kind === 'pin' ? `dropped a pin ${where}` : across ? `is pointing at an area (~${across}m across) ${/^near /i.test(p.label) ? p.label : `around ${p.label}`}` : `is pointing ${where}`
    const nearby = p.nearby?.length ? ` Nearby: ${p.nearby.slice(0, 3).join(', ')}.` : ''
    return `User ${what} — lat ${p.lat.toFixed(4)}, lng ${p.lng.toFixed(4)}.${nearby} Interpret "here/this area/over there" as this location.`
  }
  const movedMeaningfully = (a: NonNullable<typeof utterSent>, b: Ctx) =>
    a.kind !== b.kind || distM(a, b) > Math.max(150, (a.radiusM ?? 0) * 0.5) || Math.abs((a.radiusM ?? 0) - (b.radiusM ?? 0)) > Math.max(150, (a.radiusM ?? 0) * 0.5)

  let sending = false
  const shareFor = async (final: boolean) => {
    if (sending) return
    const now = Date.now()
    const ex = explicitLive()
    let ctx: Ctx | null = ex
    if (!ctx) {
      const activeRecently = now - lastActivityAt < RECENT_MS && trail.length > 0
      if (activeRecently) ctx = utteranceCtx()
      if (!ctx) {
        const p = store.get().pointer
        if (p && now - p.updatedAt < FRESH_MS) ctx = p
      }
    }
    if (!ctx) return
    if (utterSent && !(final && movedMeaningfully(utterSent, ctx))) return
    sending = true
    try {
      if (ctx.kind === 'area' && !ex) speakArea = { center: ctx, radiusM: ctx.radiusM ?? 0 }
      const full = ex && ex.label !== '…' ? ex : await commit(ctx)
      if (!full) return
      utterSent = { lat: full.lat, lng: full.lng, radiusM: full.radiusM, kind: full.kind }
      window.dispatchEvent(new CustomEvent('quest:voice-context', { detail: { content: describe(full), triggerResponse: false } }))
      flashShared()
    } finally {
      sending = false
    }
  }

  const onTranscript = (e: Event) => {
    const d = (e as CustomEvent<{ role?: string; text?: string; final?: boolean }>).detail
    if (!d || d.role !== 'user' || !d.text) return
    const final = !!d.final
    if (!final) setSpeaking(true)
    const strong = STRONG.test(d.text)
    const weak = !strong && WEAK.test(d.text) && Date.now() - lastActivityAt < 3000 && overMap
    if (strong || weak) void shareFor(final)
    if (final) {
      // next utterance starts fresh
      window.setTimeout(() => {
        utterSent = null
        utterStart = Date.now()
      }, 0)
    }
  }
  const onSpeaking = (e: Event) => setSpeaking(!!(e as CustomEvent<{ speaking?: boolean }>).detail?.speaking)

  // ---------- explicit: pin + drawn area ----------
  const setExplicit = (ctx: Ctx) => {
    clearTimeout(pinTimer)
    const provisional: PointerContext = { ...ctx, label: '…', updatedAt: Date.now() }
    explicit = { ctx: provisional, until: Date.now() + EXPLICIT_TTL_MS }
    pinChip.textContent = '…'
    void commit(ctx).then((full) => {
      if (!full || !explicit || explicit.ctx !== provisional) return
      explicit.ctx = full
      pinChip.textContent = full.label
      if (full.kind === 'area') setChip(full.label)
      // a pin/area made mid-sentence ("…here") gets shared right away
      if (speaking) void shareFor(true)
    })
    pinTimer = window.setTimeout(() => {
      explicit = null
      const p = store.get().pointer
      if (p && p.kind !== 'hover' && p.updatedAt === provisional.updatedAt) store.setPointer(null)
    }, EXPLICIT_TTL_MS)
  }

  // ---------- input ----------
  const isCanvas = (t: EventTarget | null) => t instanceof Element && t.classList.contains('mapboxgl-canvas')

  const onPointerMove = (e: PointerEvent) => {
    const xy = localXY(e)
    const now = performance.now()
    if (down && e.pointerId === down.id) {
      if (!dragging && Math.hypot(xy.x - down.x, xy.y - down.y) > DRAG_PX) dragging = true
      if (down.draw) {
        e.stopPropagation()
        const ll = toLL(xy.x, xy.y)
        if (ll && (!drawPts.length || Math.hypot(xy.x - drawPts[drawPts.length - 1].x, xy.y - drawPts[drawPts.length - 1].y) > 4)) {
          drawPts.push({ ...xy, ll })
          lasso.setAttribute('points', drawPts.map((p) => `${p.x},${p.y}`).join(' '))
          lasso.classList.add('is-on')
        }
        cursor = xy
        return
      }
    }
    if (e.pointerType === 'touch') return // no hover on touch; taps make pins
    cursor = xy
    overMap = isCanvas(e.target) || (e.target instanceof Element && !!e.target.closest('.mapboxgl-canvas-container'))
    lastActivityAt = Date.now()
    if (dragging) return // panning: the point under the cursor is not "pointing"
    if (now - lastSampleAt >= MOVE_THROTTLE_MS) {
      lastSampleAt = now
      const ll = toLL(xy.x, xy.y)
      if (ll) {
        const t = Date.now()
        trail.push({ ...ll, t })
        pruneTrail(t)
        if (speaking) {
          const u = utteranceCtx()
          speakArea = u && u.kind === 'area' ? { center: u, radiusM: u.radiusM ?? 0 } : null
        }
      }
    }
    clearTimeout(restTimer)
    restTimer = window.setTimeout(onRest, REST_MS)
    scheduleIdleClear()
  }

  const onPointerDown = (e: PointerEvent) => {
    const xy = localXY(e)
    const draw = e.altKey && e.pointerType !== 'touch' && e.button === 0
    down = { ...xy, t: performance.now(), id: e.pointerId, draw, onCanvas: isCanvas(e.target) }
    dragging = false
    if (draw) {
      // keep Mapbox from panning: swallow the event before it reaches the canvas container
      e.stopPropagation()
      e.preventDefault()
      drawPts = []
      layer.classList.add('is-drawing')
      try {
        mapContainer.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
  }

  const onPointerUp = (e: PointerEvent) => {
    if (!down || e.pointerId !== down.id) return
    const d = down
    down = null
    const xy = localXY(e)
    if (d.draw) {
      e.stopPropagation()
      layer.classList.remove('is-drawing')
      lasso.classList.remove('is-on')
      try {
        mapContainer.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      const pts = drawPts.map((p) => p.ll)
      drawPts = []
      dragging = false
      if (pts.length >= 3) {
        const { center, radiusM } = coverCircle(pts)
        setExplicit({ ...center, radiusM, kind: 'area' })
      } else {
        const ll = toLL(xy.x, xy.y)
        if (ll) setExplicit({ ...ll, kind: 'pin' })
      }
      return
    }
    const wasDrag = dragging || Math.hypot(xy.x - d.x, xy.y - d.y) > DRAG_PX
    dragging = false
    if (!wasDrag && d.onCanvas && performance.now() - d.t < CLICK_MAX_MS && e.button === 0) {
      const ll = toLL(xy.x, xy.y)
      if (ll) setExplicit({ ...ll, kind: 'pin' })
    }
  }
  const onPointerCancel = () => {
    down = null
    dragging = false
    drawPts = []
    lasso.classList.remove('is-on')
    layer.classList.remove('is-drawing')
  }
  // Mapbox listens to mouse/touch on the canvas container; swallow them during alt-draw (capture phase)
  const swallowIfDrawing = (e: MouseEvent | TouchEvent) => {
    if ((e as MouseEvent).altKey && e.type === 'mousedown') e.stopPropagation()
    else if (down?.draw) e.stopPropagation()
  }
  const onLeave = () => {
    overMap = false
    clearTimeout(restTimer)
  }
  const onWheel = () => {
    // zooming changes what's under a resting cursor
    clearTimeout(restTimer)
    restTimer = window.setTimeout(onRest, REST_MS + 200)
  }
  const onKey = (e: KeyboardEvent) => layer.classList.toggle('is-alt', e.altKey)

  const opts = { capture: true } as const
  mapContainer.addEventListener('pointermove', onPointerMove, opts)
  mapContainer.addEventListener('pointerdown', onPointerDown, opts)
  mapContainer.addEventListener('pointerup', onPointerUp, opts)
  mapContainer.addEventListener('pointercancel', onPointerCancel, opts)
  mapContainer.addEventListener('mousedown', swallowIfDrawing, opts)
  mapContainer.addEventListener('mousemove', swallowIfDrawing, opts)
  mapContainer.addEventListener('pointerleave', onLeave)
  mapContainer.addEventListener('wheel', onWheel, { passive: true })
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)
  window.addEventListener('quest:transcript', onTranscript)
  window.addEventListener('quest:user-speaking', onSpeaking)

  const api = {
    destroy() {
      cancelAnimationFrame(raf)
      clearTimeout(restTimer)
      clearTimeout(idleTimer)
      clearTimeout(pinTimer)
      clearTimeout(flashTimer)
      mapContainer.removeEventListener('pointermove', onPointerMove, opts)
      mapContainer.removeEventListener('pointerdown', onPointerDown, opts)
      mapContainer.removeEventListener('pointerup', onPointerUp, opts)
      mapContainer.removeEventListener('pointercancel', onPointerCancel, opts)
      mapContainer.removeEventListener('mousedown', swallowIfDrawing, opts)
      mapContainer.removeEventListener('mousemove', swallowIfDrawing, opts)
      mapContainer.removeEventListener('pointerleave', onLeave)
      mapContainer.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('quest:transcript', onTranscript)
      window.removeEventListener('quest:user-speaking', onSpeaking)
      layer.remove()
      if ((window as unknown as { pointer?: unknown }).pointer === debug) delete (window as unknown as { pointer?: unknown }).pointer
    },
  }
  // console debugging only
  const debug = {
    trail,
    get context() {
      return store.get().pointer
    },
    get explicit() {
      return explicit?.ctx ?? null
    },
    share: () => shareFor(true),
    destroy: api.destroy,
  }
  ;(window as unknown as { pointer?: unknown }).pointer = debug
  return api
}
