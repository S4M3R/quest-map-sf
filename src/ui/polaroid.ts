// Instant-film photos: when a stop is added, a little print ejects onto the screen, develops,
// then settles into a scrapbook stack on the right. Click a print → 'quest:focus-stop'.
import './polaroid.css'
import { dayColor } from '../types'
import type { StopCategory, Stop, TripState } from '../types'
import type { TripStore } from '../state/store'
import { fetchPhoto, mapboxSnapshotUrl } from '../services/photo'

const HERO_HOLD_MS = 2800 // how long a fresh print stays big after it starts developing
const HERO_MAX_MS = 6500 // never hold the hero longer than this, even if the image is slow
const EJECT_MS = 950
const MAX_VISIBLE = 4
const MAX_PEEK = 2 // other days' prints peeking out behind the active day's stack

const EMOJI: Record<StopCategory, string> = {
  food: '🍜',
  coffee: '☕',
  view: '🌉',
  culture: '🎨',
  outdoors: '🌿',
  nightlife: '🌙',
  event: '🎟️',
  shopping: '🛍️',
  other: '📍',
}

interface Card {
  id: string
  el: HTMLElement
  img: HTMLImageElement
  stamp: HTMLElement
  day: number
  rot: number
  born: number
  heroUntil: number
  triedFallback: boolean
}

export function mountPolaroids(container: HTMLElement, store: TripStore): void {
  container.classList.add('pz-root')
  container.setAttribute('aria-label', 'Trip photos')

  const cards = new Map<string, Card>() // insertion order = add order
  let heroId: string | null = null
  let pickedId: string | null = null // last card the user clicked
  let heroTimer = 0

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const sound = createSound()

  // ---------- layout ----------
  const layout = () => {
    const { activeStopId, activeDay } = store.get()
    const now = Date.now()
    if (heroId && (cards.get(heroId)?.heroUntil ?? 0) <= now) heroId = null

    const live = [...cards.values()].filter((c) => c.id !== heroId && !c.el.classList.contains('is-leaving')).reverse() // newest first
    // only the active day's prints sit in the stack; other days are tucked behind it
    const stacked = live.filter((c) => c.day === activeDay)
    const others = live.filter((c) => c.day !== activeDay)
    // the active (tour/focus) or clicked card floats to the top of the stack
    const frontId = pickedId && cards.has(pickedId) ? pickedId : activeStopId
    const fi = stacked.findIndex((c) => c.id === frontId)
    if (fi > 0) stacked.unshift(...stacked.splice(fi, 1))

    stacked.forEach((c, i) => {
      const slot = Math.min(i, MAX_VISIBLE - 1)
      const hidden = i >= MAX_VISIBLE
      setVars(c.el, {
        '--tx': `calc(var(--stack-x) - ${slot * 16 - (hidden ? 10 : 0)}px)`,
        '--ty': `calc(var(--stack-y) + ${slot * 30 + (hidden ? 14 : 0)}px)`,
        '--rot': `${c.rot}deg`,
        '--sc': hidden ? 'calc(var(--stack-sc) * 0.9)' : 'var(--stack-sc)',
      })
      c.el.style.zIndex = String(100 - i)
      c.el.classList.toggle('is-tucked', hidden)
      c.el.classList.remove('is-hero')
      c.el.classList.toggle('is-active', c.id === activeStopId)
      c.el.classList.toggle('is-picked', c.id === pickedId && c.id !== activeStopId)
      c.el.classList.remove('is-other')
    })

    // other days: a couple peek out behind (smaller, faded, shifted), the rest hidden
    others.forEach((c, i) => {
      const peek = i < MAX_PEEK
      setVars(c.el, {
        '--tx': `calc(var(--stack-x) + ${18 + i * 10}px)`,
        '--ty': `calc(var(--stack-y) - ${22 + i * 12}px)`,
        '--rot': `${c.rot * 1.4}deg`,
        '--sc': 'calc(var(--stack-sc) * 0.82)',
      })
      c.el.style.zIndex = String(20 - i)
      c.el.classList.add('is-other')
      c.el.classList.toggle('is-tucked', !peek)
      c.el.classList.remove('is-hero', 'is-active', 'is-picked')
    })

    if (heroId) {
      const h = cards.get(heroId)!
      setVars(h.el, { '--tx': 'var(--hero-tx)', '--ty': 'var(--hero-ty)', '--rot': `${h.rot * 0.4}deg`, '--sc': '1' })
      h.el.style.zIndex = '200'
      h.el.classList.add('is-hero')
      h.el.classList.remove('is-tucked')
      h.el.classList.toggle('is-active', h.id === activeStopId)
      clearTimeout(heroTimer)
      heroTimer = window.setTimeout(layout, Math.max(50, h.heroUntil - now))
    }
  }

  // ---------- create ----------
  const addCard = (stop: Stop) => {
    const el = document.createElement('div')
    el.className = 'pz is-new'
    el.tabIndex = 0
    el.setAttribute('role', 'button')
    el.setAttribute('aria-label', `Photo of ${stop.name} — show on map`)
    const rot = (Math.random() * 2 - 1) * 7
    el.innerHTML = `
      <div class="pz-slot" aria-hidden="true"></div>
      <div class="pz-card">
        <div class="pz-photo">
          <img alt="" decoding="async" referrerpolicy="no-referrer" />
          <div class="pz-wash"></div>
          <div class="pz-grain"></div>
          <span class="pz-stamp"></span>
        </div>
        <div class="pz-cap">
          <span class="pz-name"></span>
          <span class="pz-meta"></span>
        </div>
      </div>`
    el.querySelector<HTMLElement>('.pz-name')!.textContent = stop.name
    el.querySelector<HTMLElement>('.pz-meta')!.textContent = [EMOJI[stop.category ?? 'other'] ?? '📍', stop.time].filter(Boolean).join(' ')
    const img = el.querySelector('img')!
    const stamp = el.querySelector<HTMLElement>('.pz-stamp')!

    const now = Date.now()
    const card: Card = { id: stop.id, el, img, stamp, day: 0, rot, born: now, heroUntil: now + HERO_MAX_MS, triedFallback: false }
    setDay(card, stop.day)
    cards.set(stop.id, card)
    container.appendChild(el)

    // the previous hero gets bumped into the stack immediately
    heroId = stop.id
    setVars(el, { '--tx': 'var(--hero-tx)', '--ty': 'var(--hero-ty)', '--rot': `${rot * 0.4}deg`, '--sc': '1' })
    layout()
    sound.eject()

    const ejectDone = new Promise<void>((r) => setTimeout(r, reduced ? 0 : EJECT_MS))
    setTimeout(() => el.classList.remove('is-new'), reduced ? 0 : EJECT_MS + 50)

    let developed = false
    const develop = () => {
      if (developed || !cards.has(stop.id)) return
      developed = true
      void ejectDone.then(() => {
        el.classList.add('is-developed')
        // hold the big print while it develops, then settle
        card.heroUntil = Math.min(card.born + HERO_MAX_MS, Date.now() + HERO_HOLD_MS)
        if (heroId === stop.id) layout()
      })
    }
    img.addEventListener('load', develop)
    img.addEventListener('error', () => {
      const fb = mapboxSnapshotUrl(stop.lat, stop.lng)
      if (!card.triedFallback && fb && img.src !== fb) {
        card.triedFallback = true
        img.src = fb
        store.updateStop(stop.id, { photoUrl: fb, photoSource: 'mapbox' })
      } else {
        el.classList.add('is-blank') // develops into a soft dusk gradient instead
        develop()
      }
    })

    const setSrc = (url: string | null) => {
      if (!cards.has(stop.id)) return
      if (url) img.src = url
      else img.dispatchEvent(new Event('error'))
    }

    if (stop.photoUrl) setSrc(stop.photoUrl)
    else
      void fetchPhoto({ name: stop.name, lat: stop.lat, lng: stop.lng, url: stop.url }).then((r) => {
        const url = r.photoUrl ?? mapboxSnapshotUrl(stop.lat, stop.lng)
        const source = r.photoUrl ? r.source ?? undefined : url ? 'mapbox' : undefined
        if (url) store.updateStop(stop.id, { photoUrl: url, photoSource: source })
        setSrc(url)
      })

    const pick = () => {
      pickedId = stop.id
      if (heroId && heroId !== stop.id) heroId = null
      el.classList.remove('is-poked')
      void el.offsetWidth
      el.classList.add('is-poked')
      layout()
      window.dispatchEvent(new CustomEvent('quest:focus-stop', { detail: { id: stop.id } }))
    }
    el.addEventListener('click', pick)
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        pick()
      }
    })
  }

  /** the "date stamp" in the photo corner: Day N in that day's color */
  function setDay(c: Card, day: number) {
    if (c.day === day) return
    c.day = day
    c.el.style.setProperty('--day', dayColor(day))
    c.stamp.textContent = `DAY ${day}`
    c.el.setAttribute('aria-label', `${c.el.querySelector('.pz-name')?.textContent ?? 'Photo'} — Day ${day}, show on map`)
  }

  // ---------- remove ----------
  const removeCard = (id: string, mode: 'flutter' | 'sweep', delay = 0) => {
    const c = cards.get(id)
    if (!c) return
    cards.delete(id)
    if (heroId === id) heroId = null
    if (pickedId === id) pickedId = null
    const el = c.el
    el.style.setProperty('--leave-delay', `${delay}ms`)
    el.classList.add('is-leaving', mode === 'sweep' ? 'is-swept' : 'is-flutter')
    el.style.pointerEvents = 'none'
    setTimeout(() => el.remove(), reduced ? 0 : 1100 + delay)
  }

  // ---------- sync with store ----------
  const sync = (state: TripState, prev: TripState) => {
    const ids = new Set(state.stops.map((s) => s.id))
    const gone = [...cards.keys()].filter((id) => !ids.has(id))
    if (gone.length && state.stops.length === 0 && prev.stops.length > 0) {
      // clear_trip: sweep everything off, newest first
      gone.reverse().forEach((id, i) => removeCard(id, 'sweep', i * 70))
    } else {
      gone.forEach((id) => removeCard(id, 'flutter'))
    }
    for (const s of state.stops) {
      const c = cards.get(s.id)
      if (c) setDay(c, s.day)
      else addCard(s)
    }
    // whichever happened last wins the front of the stack: a click, or the camera focusing a stop
    if (state.activeStopId !== prev.activeStopId) pickedId = null
    const dayChanged = state.activeDay !== prev.activeDay
    if (dayChanged && heroId && cards.get(heroId)?.day !== state.activeDay) heroId = null
    if (gone.length || dayChanged || state.stops !== prev.stops || state.activeStopId !== prev.activeStopId || state.touring !== prev.touring) {
      container.classList.toggle('is-touring', state.touring)
      layout()
    }
  }

  store.subscribe(sync)
  // stops that already exist at mount time just land in the stack (no ceremony)
  for (const s of store.get().stops) {
    addCard(s)
    heroId = null
  }
  layout()
}

function setVars(el: HTMLElement, vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
}

// ---------- tiny synthesized camera sounds (quiet, lazy, never throws) ----------
function createSound() {
  let ctx: AudioContext | null = null
  const unlock = () => {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!ctx && AC) ctx = new AC()
      void ctx?.resume()
    } catch {
      ctx = null
    }
  }
  // AudioContext may only start after a user gesture
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, unlock, { once: true, passive: true })

  const noise = (c: AudioContext, seconds: number) => {
    const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * seconds)), c.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    const src = c.createBufferSource()
    src.buffer = buf
    return src
  }

  return {
    eject() {
      try {
        const c = ctx
        if (!c || c.state !== 'running') return
        const t = c.currentTime
        const out = c.createGain()
        out.gain.value = 0.22
        out.connect(c.destination)

        // shutter: two short filtered clicks
        for (const [at, f] of [[0, 2400], [0.07, 1600]] as const) {
          const n = noise(c, 0.05)
          const bp = c.createBiquadFilter()
          bp.type = 'bandpass'
          bp.frequency.value = f
          bp.Q.value = 1.4
          const g = c.createGain()
          g.gain.setValueAtTime(0.0001, t + at)
          g.gain.exponentialRampToValueAtTime(0.9, t + at + 0.004)
          g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.045)
          n.connect(bp).connect(g).connect(out)
          n.start(t + at)
          n.stop(t + at + 0.06)
        }

        // whirr: buzzy little motor pushing the print out
        const m = c.createOscillator()
        m.type = 'sawtooth'
        m.frequency.setValueAtTime(95, t + 0.12)
        m.frequency.linearRampToValueAtTime(130, t + 0.5)
        m.frequency.linearRampToValueAtTime(80, t + 0.85)
        const lp = c.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 900
        const trem = c.createOscillator()
        trem.frequency.value = 38
        const tremGain = c.createGain()
        tremGain.gain.value = 0.05
        const mg = c.createGain()
        mg.gain.setValueAtTime(0.0001, t + 0.12)
        mg.gain.exponentialRampToValueAtTime(0.12, t + 0.2)
        mg.gain.setValueAtTime(0.12, t + 0.75)
        mg.gain.exponentialRampToValueAtTime(0.0001, t + 0.9)
        trem.connect(tremGain).connect(mg.gain)
        m.connect(lp).connect(mg).connect(out)
        m.start(t + 0.12)
        trem.start(t + 0.12)
        m.stop(t + 0.95)
        trem.stop(t + 0.95)
      } catch {
        /* sound is decoration only */
      }
    },
  }
}
