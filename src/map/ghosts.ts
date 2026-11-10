// "Ghost" candidate pins for show_options: lettered A/B/C, translucent white with a pulsing ring in
// the day color. Clearly not real (numbered) stops. Fade out when the options are cleared/chosen.
import mapboxgl from 'mapbox-gl'
import type { Map as MbMap, Marker } from 'mapbox-gl'
import { dayColor } from '../types'
import type { OptionSet } from '../types'

interface Ghost {
  marker: Marker
  el: HTMLElement
  key: string
}

export interface Ghosts {
  sync(set: OptionSet | null): void
  hover(label: string | null): void
}

export function createGhosts(map: MbMap, onClick: (label: string) => void): Ghosts {
  const live = new Map<string, Ghost>() // key = label|name

  const remove = (key: string, g: Ghost) => {
    live.delete(key)
    g.el.classList.add('is-leaving')
    window.setTimeout(() => g.marker.remove(), 420)
  }

  const sync = (set: OptionSet | null) => {
    const want = new Map((set?.options ?? []).map((o) => [`${o.label}|${o.name}`, o]))
    for (const [k, g] of live) if (!want.has(k)) remove(k, g)
    if (!set) return
    const color = dayColor(set.day)
    for (const [k, o] of want) {
      let g = live.get(k)
      if (!g) {
        const el = document.createElement('div')
        el.className = 'qm-ghost'
        el.dataset.label = o.label
        el.innerHTML = `
          <div class="qm-ghost__pin">
            <div class="qm-ghost__ring"></div>
            <div class="qm-ghost__stem"></div>
            <div class="qm-ghost__badge"><span></span></div>
            <div class="qm-ghost__label"></div>
          </div>`
        el.querySelector('.qm-ghost__badge span')!.textContent = o.label
        el.querySelector('.qm-ghost__label')!.textContent = o.name
        el.addEventListener('click', (e) => {
          e.stopPropagation()
          onClick(o.label)
        })
        const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom', occludedOpacity: 0.9 }).setLngLat([o.lng, o.lat]).addTo(map)
        g = { marker, el, key: k }
        live.set(k, g)
      }
      g.el.style.setProperty('--pin', color)
    }
  }

  const hover = (label: string | null) => {
    for (const g of live.values()) g.el.classList.toggle('is-hot', !!label && g.el.dataset.label === label)
  }

  return { sync, hover }
}
