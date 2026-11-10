// "Pick one" chooser: 3 instant-photo cards (A/B/C) bottom-centre, above the voice orb.
// Driven by state.options (set by the show_options tool). Choosing — click, ghost-pin click,
// or keys 1/2/3/A/B/C — runs choose_option through the dispatcher and tells the voice model.
import './options.css'
import { dayColor } from '../types'
import type { OptionCandidate, OptionSet, StopCategory } from '../types'
import type { TripStore } from '../state/store'
import type { Dispatcher } from '../tools/dispatcher'

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
const LEAVE_MS = 650

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const setKey = (s: OptionSet) => `${s.title}|${s.day}|${s.options.map((o) => o.name).join('|')}`

export function mountOptions(container: HTMLElement, store: TripStore, dispatcher: Dispatcher): void {
  container.classList.add('qo-root')
  container.replaceChildren()

  let shownKey = ''
  let panel: HTMLElement | null = null
  const cards = new Map<string, { el: HTMLElement; img: HTMLImageElement; url?: string }>()
  let busy = false

  const notify = (message: string) => window.dispatchEvent(new CustomEvent('quest:user-choice', { detail: { message } }))
  const hover = (label: string | null) => window.dispatchEvent(new CustomEvent('quest:hover-option', { detail: { label } }))

  const choose = async (label: string) => {
    const set = store.get().options
    if (busy || !set) return
    const opt = set.options.find((o) => o.label === label)
    if (!opt) return
    busy = true
    cards.get(label)?.el.classList.add('is-chosen')
    try {
      const r = await dispatcher.runTool('choose_option', { choice: label })
      if (r.ok) notify(`The user tapped option ${label}: ${opt.name}. It is already added to Day ${set.day} — react briefly and continue. Do NOT call choose_option.`)
      else cards.get(label)?.el.classList.remove('is-chosen')
    } finally {
      busy = false
    }
  }

  const dismiss = () => {
    if (!store.get().options) return
    store.setOptions(null)
    notify('User wants different options — none of those. Offer 3 new ones with show_options (or ask what they want instead).')
  }

  const setPhoto = (o: OptionCandidate) => {
    const c = cards.get(o.label)
    if (!c || !o.photoUrl || c.url === o.photoUrl) return
    c.url = o.photoUrl
    c.img.src = o.photoUrl
  }

  const build = (set: OptionSet) => {
    cards.clear()
    const p = el('section', 'qo')
    p.style.setProperty('--day', dayColor(set.day))
    p.setAttribute('aria-label', set.title)
    const head = el('div', 'qo-head')
    head.append(el('span', 'qo-eyebrow', `Day ${set.day} · your call`), el('h3', 'qo-title', set.title))
    const row = el('div', 'qo-row')
    set.options.forEach((o, i) => {
      const card = el('button', 'qo-card')
      card.type = 'button'
      card.style.setProperty('--i', String(i))
      card.style.setProperty('--rot', `${[-3, 1, 3.5][i] ?? 0}deg`)
      card.setAttribute('aria-label', `Option ${o.label}: ${o.name}${o.note ? `, ${o.note}` : ''}. Press ${o.label} or ${i + 1}.`)
      const photo = el('div', 'qo-photo')
      const img = el('img') as HTMLImageElement
      img.alt = ''
      img.decoding = 'async'
      img.referrerPolicy = 'no-referrer'
      img.addEventListener('load', () => card.classList.add('is-developed'))
      img.addEventListener('error', () => card.classList.add('is-developed', 'is-blank'))
      photo.append(img, el('div', 'qo-wash'), el('span', 'qo-letter', o.label))
      const cap = el('div', 'qo-cap')
      cap.append(el('span', 'qo-name', o.name))
      if (o.note) cap.append(el('span', 'qo-note', o.note))
      const meta = [EMOJI[o.category ?? 'other'], o.time].filter(Boolean).join(' ')
      if (meta) cap.append(el('span', 'qo-meta', meta))
      card.append(photo, cap)
      card.addEventListener('click', () => void choose(o.label))
      card.addEventListener('pointerenter', () => hover(o.label))
      card.addEventListener('pointerleave', () => hover(null))
      card.addEventListener('focus', () => hover(o.label))
      card.addEventListener('blur', () => hover(null))
      row.append(card)
      cards.set(o.label, { el: card, img })
      setPhoto(o)
    })
    const none = el('button', 'qo-none', 'None of these')
    none.type = 'button'
    none.addEventListener('click', dismiss)
    p.append(head, row, none)
    return p
  }

  const render = () => {
    const set = store.get().options
    const key = set ? setKey(set) : ''
    if (key === shownKey) {
      set?.options.forEach(setPhoto)
      return
    }
    shownKey = key
    hover(null)
    if (panel) {
      const old = panel
      old.classList.add('is-leaving')
      old.style.pointerEvents = 'none'
      window.setTimeout(() => old.remove(), LEAVE_MS)
      panel = null
    }
    if (set) {
      panel = build(set)
      container.append(panel)
    }
  }

  window.addEventListener('quest:pick-option', (e) => {
    const label = (e as CustomEvent<{ label?: string }>).detail?.label
    if (label) void choose(label)
  })

  window.addEventListener('keydown', (ev) => {
    const set = store.get().options
    if (!set || ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return
    const t = ev.target as HTMLElement | null
    if (t && (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || t.isContentEditable)) return
    const k = ev.key.toUpperCase()
    const label = ({ '1': 'A', '2': 'B', '3': 'C', A: 'A', B: 'B', C: 'C' } as Record<string, string>)[k]
    if (k === 'ESCAPE') {
      ev.preventDefault()
      dismiss()
      return
    }
    if (!label || !set.options.some((o) => o.label === label)) return
    ev.preventDefault()
    void choose(label)
  })

  render()
  store.subscribe((s, prev) => {
    if (s.options !== prev.options) render()
  })
}
