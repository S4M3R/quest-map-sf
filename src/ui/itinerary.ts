// "Quest Log" itinerary panel. Subscribes to the store; keyed DOM diff so items animate in/out.
import './itinerary.css'
import type { TripStore } from '../state/store'
import { dayColor } from '../types'
import type { LightPreset, Stop, StopCategory, TripProfile, TripState } from '../types'

const CATEGORY_EMOJI: Record<StopCategory, string> = {
  food: '🍜',
  coffee: '☕',
  view: '🌉',
  culture: '🎭',
  outdoors: '🌲',
  nightlife: '🍸',
  event: '🎟️',
  shopping: '🛍️',
  other: '📍',
}

const MOOD: Record<LightPreset, { icon: string; label: string }> = {
  dawn: { icon: '🌅', label: 'Dawn' },
  day: { icon: '☀️', label: 'Day' },
  dusk: { icon: '🌇', label: 'Dusk' },
  night: { icon: '🌙', label: 'Night' },
}

const LINK_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5"/></svg>'

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const safeUrl = (u?: string) => {
  if (!u) return undefined
  try {
    const url = new URL(u)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

const profileSummary = (p: TripProfile | null): string => {
  if (!p) return ''
  const parts = [`${p.days} day${p.days === 1 ? '' : 's'}`, p.pace]
  if (p.company) parts.push(p.company)
  if (p.interests?.length) parts.push(p.interests.slice(0, 3).join(', '))
  return parts.filter(Boolean).join(' · ')
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

export function mountItinerary(container: HTMLElement, store: TripStore, opts: { onSelect: (stopId: string) => void }): void {
  container.replaceChildren()
  const panel = el('section', 'panel ql')
  panel.setAttribute('aria-label', 'Quest log')

  // ---- header ----
  const header = el('header', 'ql-head')
  const titles = el('div', 'ql-titles')
  const eyebrow = el('div', 'ql-eyebrow', 'Side Quest · SF')
  const title = el('h2', 'ql-title', 'Quest Log')
  titles.append(eyebrow, title)
  const meta = el('div', 'ql-meta')
  const count = el('span', 'ql-count')
  const mood = el('span', 'ql-mood')
  meta.append(count, mood)
  header.append(titles, meta)

  // ---- profile line + day tabs ----
  const profileLine = el('div', 'ql-profile')
  const tabs = el('div', 'ql-days')
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', 'Trip days')
  const addDay = el('button', 'ql-day ql-day-add', '+')
  addDay.type = 'button'
  addDay.title = 'Add a day'
  addDay.setAttribute('aria-label', 'Add a day')
  addDay.addEventListener('click', () => store.setActiveDay(store.get().days.length + 1))
  tabs.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-day]')
    if (b) store.setActiveDay(Number(b.dataset.day))
  })
  const dayHead = el('div', 'ql-dayhead')

  // ---- touring banner ----
  const banner = el('div', 'ql-banner')
  banner.setAttribute('role', 'status')
  banner.innerHTML = '<span class="ql-banner-dot"></span><span>🎬 Flyover in progress…</span>'

  // ---- list + empty state ----
  const list = el('ol', 'ql-list')
  const empty = el('div', 'ql-empty')
  empty.innerHTML = `
    <div class="ql-empty-glyph">🗺️</div>
    <p class="ql-empty-title">Your quest is unwritten</p>
    <p class="ql-empty-hint">Tap the orb and say<br><em>“Plan me a chill Saturday in the Mission”</em></p>`
  const emptyTitle = empty.querySelector<HTMLElement>('.ql-empty-title')!
  const emptyHint = empty.querySelector<HTMLElement>('.ql-empty-hint')!

  panel.append(header, profileLine, tabs, dayHead, banner, list, empty)
  container.append(panel)

  // ---- keyed rows ----
  const rows = new Map<string, HTMLLIElement>()
  const rendered = new Map<string, string>() // id → content signature
  let first = true

  list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (target.closest('a')) return // external link: let it open, don't refocus
    const li = target.closest<HTMLLIElement>('li[data-id]')
    if (li && !li.classList.contains('is-leaving')) opts.onSelect(li.dataset.id!)
  })
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-id]')
    if (!li || (e.target as HTMLElement).closest('a')) return
    e.preventDefault()
    opts.onSelect(li.dataset.id!)
  })

  function fillThumb(thumb: HTMLElement, s: Stop) {
    const url = safeUrl(s.photoUrl)
    if (!url) {
      thumb.classList.add('is-loading')
      return
    }
    const img = new Image()
    img.alt = ''
    img.decoding = 'async'
    img.referrerPolicy = 'no-referrer'
    img.addEventListener('load', () => thumb.classList.remove('is-loading', 'is-failed'))
    img.addEventListener('error', () => {
      thumb.classList.remove('is-loading')
      thumb.classList.add('is-failed')
    })
    thumb.classList.add('is-loading')
    img.src = url
    thumb.replaceChildren(img)
  }

  function fillRow(li: HTMLLIElement, s: Stop) {
    li.replaceChildren()
    const lead = el('div', 'ql-lead')
    const badge = el('span', 'ql-badge')
    const thumb = el('div', 'ql-thumb')
    thumb.setAttribute('aria-hidden', 'true')
    fillThumb(thumb, s)
    lead.append(badge, thumb)
    const body = el('div', 'ql-body')
    const top = el('div', 'ql-top')
    top.append(el('span', 'ql-emoji', CATEGORY_EMOJI[s.category ?? 'other'] ?? '📍'))
    if (s.time) top.append(el('span', 'ql-time', s.time))
    const name = el('div', 'ql-name', s.name)
    body.append(top, name)
    if (s.note) body.append(el('p', 'ql-note', s.note))
    else if (s.address) body.append(el('p', 'ql-note ql-addr', s.address))
    li.append(lead, body)
    const href = safeUrl(s.url)
    if (href) {
      const a = el('a', 'ql-link')
      a.href = href
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.title = 'Open link'
      a.setAttribute('aria-label', `Open ${s.name} website`)
      a.innerHTML = LINK_SVG
      li.append(a)
    }
  }

  let tabsSig = ''
  function renderTabs(state: TripState) {
    const counts = state.days.map((d) => state.stops.filter((s) => s.day === d.day).length)
    const sig = JSON.stringify([state.days, counts, state.activeDay])
    if (sig === tabsSig) return
    tabsSig = sig
    const chips = state.days.map((d, i) => {
      const b = el('button', 'ql-day')
      b.type = 'button'
      b.dataset.day = String(d.day)
      b.setAttribute('role', 'tab')
      const active = d.day === state.activeDay
      b.setAttribute('aria-selected', String(active))
      b.classList.toggle('is-active', active)
      b.style.setProperty('--day', dayColor(d.day))
      b.title = d.title ? `Day ${d.day} · ${d.title}` : `Day ${d.day}`
      b.append(el('span', 'ql-day-dot'), el('span', 'ql-day-label', `Day ${d.day}`))
      if (d.title) b.append(el('span', 'ql-day-title', d.title))
      b.append(el('span', 'ql-day-count', String(counts[i])))
      return b
    })
    tabs.replaceChildren(...chips, addDay)
    const activeChip = chips.find((c) => c.classList.contains('is-active'))
    if (activeChip) requestAnimationFrame(() => activeChip.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }))
  }

  function render(state: TripState, prev?: TripState) {
    const allStops = state.stops
    const stops = allStops.filter((s) => s.day === state.activeDay)
    const multi = state.days.length > 1
    count.textContent =
      allStops.length === 1 ? '1 stop' : `${allStops.length} stops${multi ? ` · ${state.days.length} days` : ''}`
    const summary = profileSummary(state.profile)
    profileLine.textContent = summary
    profileLine.hidden = !summary
    if (state.profile?.travelerName) title.textContent = `${state.profile.travelerName}'s Quest Log`
    renderTabs(state)
    const info = state.days.find((d) => d.day === state.activeDay)
    dayHead.style.setProperty('--day', dayColor(state.activeDay))
    dayHead.textContent = info?.title ? `Day ${state.activeDay} · ${info.title}` : `Day ${state.activeDay}`
    panel.style.setProperty('--day', dayColor(state.activeDay))
    const dayChanged = prev && prev.activeDay !== state.activeDay
    const m = MOOD[state.lightPreset] ?? MOOD.dusk
    mood.textContent = `${m.icon} ${m.label}`
    mood.title = `Mood: ${m.label}`
    panel.classList.toggle('is-touring', state.touring)
    panel.classList.toggle('is-empty', stops.length === 0)
    panel.classList.toggle('is-trip-empty', allStops.length === 0)
    if (allStops.length && !stops.length) {
      emptyTitle.textContent = `Day ${state.activeDay} is wide open`
      emptyHint.innerHTML = 'Ask Karl to fill it, e.g.<br><em>“Let’s do the Mission tomorrow”</em>'
    } else if (!allStops.length && emptyTitle.textContent !== 'Your quest is unwritten') {
      emptyTitle.textContent = 'Your quest is unwritten'
      emptyHint.innerHTML = 'Tap the orb and say<br><em>“Plan me a chill Saturday in the Mission”</em>'
    }

    const ids = new Set(stops.map((s) => s.id))

    // removed → animate out
    for (const [id, li] of rows) {
      if (ids.has(id)) continue
      rows.delete(id)
      rendered.delete(id)
      if (reducedMotion() || dayChanged) {
        li.remove()
        continue
      }
      li.style.height = `${li.offsetHeight}px`
      li.classList.add('is-leaving')
      requestAnimationFrame(() => (li.style.height = '0px'))
      const done = () => li.remove()
      li.addEventListener('transitionend', (e) => e.propertyName === 'height' && done())
      setTimeout(done, 450)
    }

    // added / updated / reordered (appendChild moves existing nodes; leaving rows stay put at the end)
    let anchor: ChildNode | null = list.firstChild
    stops.forEach((s, i) => {
      let li = rows.get(s.id)
      if (!li) {
        li = el('li', 'ql-item')
        li.dataset.id = s.id
        li.tabIndex = 0
        li.setAttribute('role', 'button')
        rows.set(s.id, li)
        if (!first && !dayChanged) li.classList.add('is-entering')
        li.addEventListener('animationend', () => li!.classList.remove('is-entering', 'is-pulse'))
      }
      const sig = JSON.stringify([s.name, s.time, s.note, s.address, s.category, s.url, s.photoUrl])
      if (rendered.get(s.id) !== sig) {
        fillRow(li, s)
        rendered.set(s.id, sig)
      }
      ;(li.querySelector('.ql-badge') as HTMLElement).textContent = String(i + 1) // = indexInDay
      li.style.setProperty('--i', String(i))
      const active = state.activeStopId === s.id
      li.classList.toggle('is-active', active)
      li.setAttribute('aria-current', active ? 'step' : 'false')
      if (li !== anchor) list.insertBefore(li, anchor)
      anchor = li.nextSibling
    })

    // bring the active stop into view when it changes
    if (state.activeStopId && state.activeStopId !== prev?.activeStopId) {
      const li = rows.get(state.activeStopId)
      if (li) {
        if (!first && !li.classList.contains('is-entering')) {
          li.classList.remove('is-pulse')
          void li.offsetWidth
          li.classList.add('is-pulse')
        }
        requestAnimationFrame(() => li.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }))
      }
    }
    first = false
  }

  render(store.get())
  store.subscribe((state, prev) => render(state, prev))
}
