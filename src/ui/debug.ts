// Debug panel (voice agent). Shown only with ?debug=1. Exercises every tool through the
// dispatcher — doubles as the on-stage fallback if voice/Wi-Fi fails ("Demo script").
import type { Dispatcher } from '../tools/dispatcher'
import type { LightPreset, ToolArgs, ToolName, ToolResult } from '../types'
import './debug.css'

const DEMO_STOPS: ToolArgs['add_stop'][] = [
  { name: 'Ferry Building', lat: 37.7955, lng: -122.3937, time: '10:00 AM', note: 'Oysters, sourdough and bay views to fuel up', category: 'food' },
  { name: 'Coit Tower', lat: 37.8024, lng: -122.4058, time: '11:30 AM', note: 'Climb Telegraph Hill for the 360° payoff', category: 'view' },
  { name: 'Tartine Bakery', lat: 37.7614, lng: -122.4241, time: '1:00 PM', note: 'The morning bun that started a cult', category: 'food' },
  { name: 'Dolores Park', lat: 37.7596, lng: -122.4269, time: '2:00 PM', note: 'Sun, skyline and the best people-watching', category: 'outdoors' },
  { name: 'Twin Peaks', lat: 37.7544, lng: -122.4477, time: '5:30 PM', note: 'Boss level: the whole city at golden hour', category: 'view' },
]

// 2-day stage script: Day 1 north waterfront, Day 2 Mission
const SCRIPT_DAYS: Array<{ day: number; title: string; stops: ToolArgs['add_stop'][] }> = [
  {
    day: 1,
    title: 'North Waterfront',
    stops: [
      { ...DEMO_STOPS[0], day: 1 },
      { ...DEMO_STOPS[1], time: '11:30 AM', day: 1 },
      { name: "Fisherman's Wharf", lat: 37.808, lng: -122.4177, time: '1:30 PM', note: 'Sea lions, chowder bowls and tourist chaos', category: 'food', day: 1 },
    ],
  },
  {
    day: 2,
    title: 'Mission Munchies',
    stops: [
      { ...DEMO_STOPS[2], time: '9:30 AM', day: 2 },
      { ...DEMO_STOPS[3], time: '11:00 AM', day: 2 },
      { name: 'Balmy Alley murals', lat: 37.7522, lng: -122.4124, time: '1:00 PM', note: 'A whole alley of murals, every wall a story', category: 'culture', day: 2 },
    ],
  },
]
// optional Bay Area day (not in the main script)
const MARIN_DAY = {
  day: 3,
  title: 'Marin Escape',
  stops: [
    { name: 'Golden Gate Bridge Vista Point', lat: 37.8324, lng: -122.4795, time: '9:30 AM', note: 'The postcard shot, from the Marin side', category: 'view', day: 3 },
    { name: 'Sausalito', lat: 37.8591, lng: -122.4853, time: '11:00 AM', note: 'Houseboats, bay breeze and lunch by the water', category: 'food', day: 3 },
    { name: 'Muir Woods', lat: 37.897, lng: -122.5811, time: '2:00 PM', note: 'Cathedral redwoods, my favorite place to hang', category: 'outdoors', day: 3 },
  ] as ToolArgs['add_stop'][],
}
const BREAKFAST: ToolArgs['show_options'] = {
  title: 'Pick your breakfast',
  options: [
    { name: 'Tartine Bakery', lat: 37.7614, lng: -122.4241, note: 'Legendary morning buns, worth the line', category: 'food', time: '9:00 AM' },
    { name: 'La Taqueria', lat: 37.7509, lng: -122.4181, note: 'Breakfast burrito, no rice, no regrets', category: 'food', time: '9:00 AM' },
    { name: 'Hong Kong Lounge II', lat: 37.7832, lng: -122.4625, note: 'Dim sum carts and har gow heaven', category: 'food', time: '10:00 AM' },
  ],
}
const PRESETS: LightPreset[] = ['dawn', 'day', 'dusk', 'night']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function mountDebug(container: HTMLElement, dispatcher: Dispatcher): void {
  container.innerHTML = ''
  const panel = document.createElement('div')
  panel.className = 'panel qd'

  const head = document.createElement('div')
  head.className = 'qd-head'
  head.innerHTML = '<strong>Debug · tools</strong>'
  const toggle = document.createElement('button')
  toggle.className = 'qd-min'
  toggle.textContent = '–'
  toggle.title = 'Collapse'
  toggle.onclick = () => {
    panel.classList.toggle('is-collapsed')
    toggle.textContent = panel.classList.contains('is-collapsed') ? '+' : '–'
  }
  head.append(toggle)

  const body = document.createElement('div')
  body.className = 'qd-body'
  const out = document.createElement('pre')
  out.className = 'qd-out'
  out.textContent = 'Results appear here.'

  const log = (name: string, args: unknown, r: ToolResult) => {
    out.textContent = `${name} ${JSON.stringify(args)}\n→ ${JSON.stringify(r, null, 2)}`
    out.classList.toggle('is-err', !r.ok)
  }
  const run = async <N extends ToolName>(name: N, args: ToolArgs[N]) => {
    const r = await dispatcher.runTool(name, args)
    log(name, args, r)
    return r
  }

  const section = (title: string) => {
    const s = document.createElement('div')
    s.className = 'qd-sec'
    const h = document.createElement('div')
    h.className = 'qd-title'
    h.textContent = title
    const row = document.createElement('div')
    row.className = 'qd-row'
    s.append(h, row)
    body.append(s)
    return row
  }
  const btn = (row: HTMLElement, text: string, onClick: () => unknown, cls = '') => {
    const b = document.createElement('button')
    b.className = `qd-btn ${cls}`.trim()
    b.textContent = text
    b.onclick = async () => {
      b.disabled = true
      try {
        await onClick()
      } finally {
        b.disabled = false
      }
    }
    row.append(b)
    return b
  }

  // ---- demo script ----
  const demoRow = section('Stage fallback')
  let scriptRunning = false
  const demoBtn = btn(
    demoRow,
    '▶ Demo script',
    async () => {
      if (scriptRunning) return
      scriptRunning = true
      demoBtn.classList.add('is-running')
      try {
        await run('clear_trip', {})
        await run('set_mood', { lightPreset: 'dusk' })
        await sleep(800)
        for (const d of SCRIPT_DAYS) {
          await run('set_day', { day: d.day, title: d.title })
          await sleep(d.day === 1 ? 400 : 1800)
          for (const s of d.stops) {
            await run('add_stop', s)
            await sleep(2500)
          }
        }
        await run('set_mood', { lightPreset: 'night' })
        await sleep(1500)
        await run('play_tour', { day: 'all' })
      } finally {
        scriptRunning = false
        demoBtn.classList.remove('is-running')
      }
    },
    'qd-primary',
  )
  btn(demoRow, 'Clear', () => run('clear_trip', {}), 'qd-danger')
  btn(demoRow, 'Play tour (day)', () => run('play_tour', {}))
  btn(demoRow, 'Play tour (all)', () => run('play_tour', { day: 'all' }))

  // ---- days ----
  const dayRow = section('set_day')
  const DAY_TITLES = ['Golden Gate & Presidio', 'Mission Munchies', 'Haight & Twin Peaks']
  DAY_TITLES.forEach((title, i) => btn(dayRow, `Day ${i + 1}`, () => run('set_day', { day: i + 1, title })))
  btn(dayRow, 'Tartine → Day 2', () => run('add_stop', { ...DEMO_STOPS[2], day: 2 }))
  btn(dayRow, 'Day 3 Marin (Bay Area)', async () => {
    await run('set_day', { day: MARIN_DAY.day, title: MARIN_DAY.title })
    await sleep(600)
    for (const s of MARIN_DAY.stops) {
      await run('add_stop', s)
      await sleep(3500)
    }
  })

  // ---- options ----
  const optRow = section('show_options / choose_option')
  btn(optRow, 'Show 3 options', () => run('show_options', BREAKFAST))
  btn(optRow, 'Choose B', () => run('choose_option', { choice: 'B' }))
  btn(optRow, 'Choose "the last one"', () => run('choose_option', { choice: 'the last one' }))
  btn(optRow, 'get_pointer', () => run('get_pointer', {}))

  // ---- add stops ----
  const addRow = section('add_stop')
  for (const s of DEMO_STOPS) btn(addRow, s.name, () => run('add_stop', s))
  btn(addRow, 'Alcatraz (geocode)', () => run('add_stop', { name: 'Alcatraz Island', query: 'Alcatraz Island', time: '3:00 PM', note: 'Escape-room energy', category: 'culture' }))
  btn(addRow, 'Bogus place', () => run('add_stop', { name: 'Atlantis Cafe xyz' }))

  // ---- edit ----
  const editRow = section('remove / focus / reorder')
  btn(editRow, 'Remove Coit', () => run('remove_stop', { name: 'coit' }))
  btn(editRow, 'Focus Ferry', () => run('focus_stop', { name: 'ferry building' }))
  btn(editRow, 'Focus Twin Peaks', () => run('focus_stop', { name: 'Twin Peaks' }))
  btn(editRow, 'Reorder (reverse)', () => run('reorder_stops', { order: ['Twin Peaks', 'Dolores Park', 'Tartine Bakery', 'Coit Tower', 'Ferry Building'] }))
  btn(editRow, 'Reorder Day 2', () => run('reorder_stops', { order: ['Balmy Alley murals', 'Dolores Park', 'Tartine Bakery'], day: 2 }))

  // ---- mood ----
  const moodRow = section('set_mood')
  for (const p of PRESETS) btn(moodRow, p, () => run('set_mood', { lightPreset: p }))

  // ---- search ----
  const searchSec = section('search')
  searchSec.classList.add('qd-col')
  const searchForm = (tool: 'search_places' | 'find_happenings', placeholder: string, extraPh: string) => {
    const f = document.createElement('form')
    f.className = 'qd-form'
    const q = document.createElement('input')
    q.placeholder = placeholder
    const x = document.createElement('input')
    x.placeholder = extraPh
    x.className = 'qd-small'
    const b = document.createElement('button')
    b.className = 'qd-btn'
    b.textContent = tool
    f.append(q, x, b)
    f.onsubmit = async (ev) => {
      ev.preventDefault()
      const query = q.value.trim() || placeholder
      b.disabled = true
      out.textContent = `${tool}… "${query}"`
      try {
        if (tool === 'search_places') await run('search_places', { query, area: x.value.trim() || undefined })
        else await run('find_happenings', { query, when: x.value.trim() || undefined })
      } finally {
        b.disabled = false
      }
    }
    searchSec.append(f)
  }
  searchForm('search_places', 'coffee with a view', 'area')
  searchForm('find_happenings', 'live music', 'when')

  body.append(out)
  panel.append(head, body)
  container.append(panel)
}
