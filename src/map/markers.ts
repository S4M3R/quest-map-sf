// Quest pin markers — DOM markers diffed by stop id (no full re-render).
import mapboxgl from 'mapbox-gl'
import type { Map as MbMap, Marker } from 'mapbox-gl'
import { dayColor } from '../types'
import type { Stop } from '../types'

interface Entry {
  marker: Marker
  el: HTMLElement
  num: HTMLElement
  name: HTMLElement
  sub: HTMLElement
  day: number
  key: string // last rendered lng/lat, to avoid needless setLngLat
}

const CATEGORY_LABEL: Record<string, string> = {
  food: 'Food',
  coffee: 'Coffee',
  view: 'Viewpoint',
  culture: 'Culture',
  outdoors: 'Outdoors',
  nightlife: 'Nightlife',
  event: 'Event',
  shopping: 'Shopping',
  other: 'Side quest',
}

export interface Markers {
  /** pins colored by day, numbered within their day; other days than activeDay are dimmed */
  sync(stops: Stop[], activeId: string | null, activeDay: number): void
  setActive(activeId: string | null): void
  clear(): void
}

export function createMarkers(map: MbMap, onClick: (id: string) => void): Markers {
  const entries = new Map<string, Entry>()

  const build = (stop: Stop): Entry => {
    const el = document.createElement('div')
    el.className = 'qm-marker'
    el.innerHTML = `
      <div class="qm-pin"><div class="qm-pin__inner">
        <div class="qm-pin__shock"></div>
        <div class="qm-pin__base"></div>
        <div class="qm-pin__beam"></div>
        <div class="qm-pin__pulse"></div>
        <div class="qm-pin__badge"><span class="qm-pin__num"></span></div>
        <div class="qm-pin__label"><span class="qm-pin__name"></span><small></small></div>
      </div></div>`
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick(stop.id)
    })
    const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom', occludedOpacity: 0.85 })
      .setLngLat([stop.lng, stop.lat])
      .addTo(map)
    return {
      marker,
      el,
      num: el.querySelector('.qm-pin__num')!,
      name: el.querySelector('.qm-pin__name')!,
      sub: el.querySelector('.qm-pin__label small')!,
      day: 0,
      key: `${stop.lng},${stop.lat}`,
    }
  }

  const sync = (stops: Stop[], activeId: string | null, activeDay: number) => {
    const perDay = new Map<number, number>()
    const live = new Set(stops.map((s) => s.id))
    // remove gone
    for (const [id, e] of entries) {
      if (live.has(id)) continue
      entries.delete(id)
      e.el.classList.add('is-leaving')
      window.setTimeout(() => e.marker.remove(), 280)
    }
    // add / update
    stops.forEach((s) => {
      const i = perDay.get(s.day) ?? 0
      perDay.set(s.day, i + 1)
      let e = entries.get(s.id)
      if (!e) {
        e = build(s)
        entries.set(s.id, e)
      }
      const key = `${s.lng},${s.lat}`
      if (e.key !== key) {
        e.marker.setLngLat([s.lng, s.lat])
        e.key = key
      }
      if (e.day !== s.day) {
        e.day = s.day
        e.el.style.setProperty('--pin', dayColor(s.day))
        e.el.dataset.day = String(s.day)
      }
      e.el.classList.toggle('is-dim', s.day !== activeDay)
      const n = String(i + 1)
      if (e.num.textContent !== n) e.num.textContent = n
      if (e.name.textContent !== s.name) e.name.textContent = s.name
      const sub = [`Day ${s.day}`, s.time, s.category ? CATEGORY_LABEL[s.category] : ''].filter(Boolean).join(' · ')
      if (e.sub.textContent !== sub) e.sub.textContent = sub
      e.sub.style.display = sub ? '' : 'none'
    })
    setActive(activeId)
  }

  const setActive = (activeId: string | null) => {
    for (const [id, e] of entries) e.el.classList.toggle('is-active', id === activeId)
  }

  const clear = () => {
    for (const e of entries.values()) e.marker.remove()
    entries.clear()
  }

  return { sync, setActive, clear }
}
