// Tool dispatcher (voice agent). Single entry point for every tool — used by the Vapi
// handler AND the debug panel. The only module that mutates the TripStore.
import type { LightPreset, MapController, OptionCandidate, OptionLabel, StopCategory, ToolArgs, ToolName, ToolResult } from '../types'
import type { TripStore } from '../state/store'
import { findHappenings, geocode, searchPlaces } from '../services/api'
import { fetchPhoto, mapboxSnapshotUrl } from '../services/photo'

export interface Dispatcher {
  runTool<N extends ToolName>(name: N, args: ToolArgs[N]): Promise<ToolResult>
}

export const TOOL_NAMES: readonly ToolName[] = [
  'search_places',
  'find_happenings',
  'add_stop',
  'remove_stop',
  'reorder_stops',
  'focus_stop',
  'set_mood',
  'play_tour',
  'clear_trip',
  'set_day',
  'show_options',
  'choose_option',
  'get_pointer',
  'update_profile',
]

const LIGHT_PRESETS: readonly LightPreset[] = ['dawn', 'day', 'dusk', 'night']
const CATEGORIES: readonly StopCategory[] = ['food', 'coffee', 'view', 'culture', 'outdoors', 'nightlife', 'event', 'shopping', 'other']

// Whole Bay Area (matches the server's geocode/search bbox): Napa/Sonoma → Santa Cruz, Bodega → Livermore.
const BAY_BBOX = { minLat: 36.9, maxLat: 38.9, minLng: -123.25, maxLng: -121.4 }
const inBay = (lat: number, lng: number) =>
  lat >= BAY_BBOX.minLat && lat <= BAY_BBOX.maxLat && lng >= BAY_BBOX.minLng && lng <= BAY_BBOX.maxLng

// ---------- defensive arg parsing ----------
const str = (v: unknown, max = 200): string | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s ? s.slice(0, max) : undefined
}
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}
const strList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => str(x)).filter((x): x is string => !!x)
  if (typeof v === 'string') {
    // tolerate a JSON-encoded array or a comma-separated list
    try {
      const parsed = JSON.parse(v)
      if (Array.isArray(parsed)) return strList(parsed)
    } catch {
      /* not JSON */
    }
    return v.split(/,|\bthen\b/i).map((s) => s.trim()).filter(Boolean)
  }
  return []
}
const asCategory = (v: unknown): StopCategory | undefined => {
  const s = str(v)?.toLowerCase()
  return s && (CATEGORIES as readonly string[]).includes(s) ? (s as StopCategory) : undefined
}
const asPreset = (v: unknown): LightPreset | undefined => {
  const s = str(v)?.toLowerCase()
  if (!s) return undefined
  if ((LIGHT_PRESETS as readonly string[]).includes(s)) return s as LightPreset
  if (/night|evening|dark|late/.test(s)) return 'night'
  if (/sunset|golden|dusk/.test(s)) return 'dusk'
  if (/sunrise|dawn|early/.test(s)) return 'dawn'
  if (/day|noon|morning|afternoon|bright/.test(s)) return 'day'
  return undefined
}
const asDay = (v: unknown): number | undefined => {
  const n = num(typeof v === 'string' ? v.replace(/[^0-9.]/g, '') : v)
  return n !== undefined && n >= 1 ? Math.min(Math.floor(n), 14) : undefined
}
const ORDINALS: Record<string, number> = { first: 0, one: 0, '1st': 0, second: 1, two: 1, middle: 1, '2nd': 1, third: 2, three: 2, '3rd': 2 }
/** 'A' / 'b' / 'option C' / '2' / 'second' / 'the last one' / fuzzy name → candidate */
export function resolveChoice<T extends { label: string; name: string; note?: string; category?: string }>(opts: T[], choice: string): T | undefined {
  const c = choice.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!c || !opts.length) return undefined
  const letter = /^(?:option |choice |the )?([abc])(?: one)?$/.exec(c)?.[1]
  if (letter) return opts.find((o) => o.label.toLowerCase() === letter)
  const n = /^(?:option |number |the )?([1-3])$/.exec(c)?.[1]
  if (n) return opts[Number(n) - 1]
  if (/\blast\b/.test(c)) return opts[opts.length - 1]
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
  const byName = opts.find((o) => norm(o.name) === c) ?? opts.find((o) => norm(o.name).includes(c) || c.includes(norm(o.name)))
  if (byName) return byName
  for (const w of c.split(' ')) if (w in ORDINALS) return opts[ORDINALS[w]]
  // partial word overlap with the name ("the taqueria"), then the note/category ("the dim sum place")
  const overlap = (text: string | undefined) => {
    const t = norm(text ?? '')
    return c.split(' ').filter((w) => w.length > 2 && !['the', 'one', 'place', 'option', 'that', 'with'].includes(w) && t.includes(w)).length
  }
  const named = opts.find((o) => norm(o.name).split(' ').some((w) => w.length > 3 && c.includes(w)))
  if (named) return named
  const scored = opts.map((o) => ({ o, n: overlap(`${o.note ?? ''} ${o.category ?? ''}`) })).sort((a, b) => b.n - a.n)
  return scored[0] && scored[0].n > 0 && (scored.length < 2 || scored[1].n < scored[0].n) ? scored[0].o : undefined
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160)
const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s)

export function createDispatcher(deps: { store: TripStore; map: MapController }): Dispatcher {
  const { store, map } = deps

  const dayLabel = (d: number) => {
    const t = store.get().days.find((x) => x.day === d)?.title
    return t ? `Day ${d} (${t})` : `Day ${d}`
  }
  const daySummary = (d: number) => {
    const names = store.stopsForDay(d).map((s) => s.name)
    return names.length ? `${dayLabel(d)}: ${names.map((n, i) => `${i + 1}. ${n}`).join(', ')}` : `${dayLabel(d)}: empty`
  }
  /** compact per-day overview so the model keeps track of the whole trip */
  const tripSummary = () => {
    const st = store.get()
    if (!st.stops.length) return `Trip is empty. Planning ${dayLabel(st.activeDay)}.`
    return `Trip now — ${st.days.map((d) => daySummary(d.day)).join(' | ')}. Active: Day ${st.activeDay}.`
  }
  const dayCounts = () => store.get().days.map((d) => ({ day: d.day, title: d.title, stops: store.stopsForDay(d.day).length }))
  /** find by name, optionally restricted to one day */
  const findInDay = (name: string, day?: number) => {
    if (day === undefined) return store.findByName(name)
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
    const n = norm(name)
    if (!n) return undefined
    const pool = store.stopsForDay(day)
    return pool.find((s) => norm(s.name) === n) ?? pool.find((s) => norm(s.name).includes(n) || n.includes(norm(s.name)))
  }

  /** lat/lng from args (swap-tolerant) or geocode fallback; must land inside the Bay Area */
  const resolveLocation = async (
    a: Record<string, unknown>,
    name: string,
  ): Promise<{ lat: number; lng: number; address?: string } | { error: string }> => {
    let lat = num(a.lat)
    let lng = num(a.lng)
    // model sometimes swaps lat/lng
    if (lat !== undefined && lng !== undefined && !inBay(lat, lng) && inBay(lng, lat)) [lat, lng] = [lng, lat]
    if (lat !== undefined && lng !== undefined && inBay(lat, lng)) return { lat, lng }
    // server biases to SF and clamps to the Bay Area — don't force a city suffix
    const query = str(a.query) ?? name
    try {
      const { result } = await geocode(query)
      if (!result || !inBay(result.lat, result.lng)) return { error: `Couldn't find "${name}" in the Bay Area. Tell the user and suggest a different spot.` }
      return { lat: result.lat, lng: result.lng, address: result.address }
    } catch (e) {
      return { error: `Geocoding "${name}" failed (${errMsg(e)}). Retry with exact lat/lng or pick another place.` }
    }
  }

  const handlers: { [N in ToolName]: (args: Record<string, unknown>) => Promise<ToolResult> } = {
    async search_places(a) {
      const query = str(a.query)
      if (!query) return { ok: false, message: 'search_places needs a query.', needsResponse: true }
      try {
        const { places } = await searchPlaces(query, str(a.area))
        const top = (places ?? []).slice(0, 5).map((p) => ({
          name: p.name,
          lat: +p.lat.toFixed(5),
          lng: +p.lng.toFixed(5),
          address: clip(p.address, 80),
          about: clip(p.description, 140),
          category: p.category,
          url: p.url,
        }))
        if (!top.length) return { ok: true, message: `No places found for "${query}". Suggest something you know instead.`, data: [], needsResponse: true }
        return { ok: true, message: `Found ${top.length} places for "${query}". Pick the best and add them with add_stop (pass lat/lng).`, data: top, needsResponse: true }
      } catch (e) {
        return { ok: false, message: `Place search failed (${errMsg(e)}). Use your own knowledge of SF instead.`, needsResponse: true }
      }
    },

    async find_happenings(a) {
      const query = str(a.query)
      if (!query) return { ok: false, message: 'find_happenings needs a query.', needsResponse: true }
      try {
        const { happenings } = await findHappenings(query, str(a.when))
        const top = (happenings ?? []).slice(0, 5).map((h) => ({
          title: clip(h.title, 90),
          when: clip(h.when, 60),
          venue: clip(h.venue, 80),
          summary: clip(h.summary, 160),
          lat: h.location ? +h.location.lat.toFixed(5) : undefined,
          lng: h.location ? +h.location.lng.toFixed(5) : undefined,
          url: h.url,
        }))
        if (!top.length) return { ok: true, message: `Nothing live found for "${query}". Suggest a reliable classic instead.`, data: [], needsResponse: true }
        return { ok: true, message: `Found ${top.length} happenings for "${query}". Mention the best one or two and add the chosen one with add_stop.`, data: top, needsResponse: true }
      } catch (e) {
        return { ok: false, message: `Event search failed (${errMsg(e)}). Suggest something you know instead.`, needsResponse: true }
      }
    },

    async add_stop(a) {
      const name = str(a.name, 80) ?? str(a.query, 80)
      if (!name) return { ok: false, message: 'add_stop needs a name.', needsResponse: true }

      const day = asDay(a.day) ?? store.get().activeDay
      // duplicates are per-day: the same spot on two different days is allowed
      const existing = findInDay(name, day)
      if (existing) return { ok: true, message: `${existing.name} is already in ${dayLabel(day)}. ${tripSummary()}`, data: { day, days: dayCounts() } }

      const loc = await resolveLocation(a, name)
      if ('error' in loc) return { ok: false, message: loc.error, needsResponse: true }
      const { lat, lng, address } = loc

      // the map auto-flies to newly added stops (map agent contract) — no focusStop here
      const stop = store.addStop({
        name,
        lat,
        lng,
        address,
        time: str(a.time, 24),
        note: str(a.note, 120),
        category: asCategory(a.category),
        url: str(a.url, 300),
        day,
      })
      const idx = store.indexInDay(stop.id)
      return {
        ok: true,
        message: `Added ${stop.name} as stop ${idx} of ${dayLabel(stop.day)}.`,
        data: { day: stop.day, stopInDay: idx, lat: +lat.toFixed(5), lng: +lng.toFixed(5), days: dayCounts() },
      }
    },

    async remove_stop(a) {
      const name = str(a.name)
      const stop = name ? store.findByName(name) : undefined
      if (!stop) return { ok: false, message: `No stop matching "${name ?? ''}". ${tripSummary()}`, needsResponse: true }
      store.removeStop(stop.id)
      return { ok: true, message: `Removed ${stop.name} from ${dayLabel(stop.day)}. ${tripSummary()}`, data: { day: stop.day, days: dayCounts() } }
    },

    async reorder_stops(a) {
      const names = strList(a.order)
      if (!names.length) return { ok: false, message: `reorder_stops needs an order list. ${tripSummary()}`, needsResponse: true }
      let day = asDay(a.day)
      if (day === undefined) {
        // no day given: use the day of the first matched name (usually the active day)
        const firstHit = names.map((n) => store.findByName(n)).find(Boolean)
        day = firstHit?.day ?? store.get().activeDay
      }
      const ids: string[] = []
      const missing: string[] = []
      for (const n of names) {
        const s = findInDay(n, day)
        if (s && !ids.includes(s.id)) ids.push(s.id)
        else if (!s) missing.push(n)
      }
      if (!ids.length) return { ok: false, message: `None of those names matched. ${tripSummary()}`, needsResponse: true }
      store.reorder(ids, day)
      return {
        ok: true,
        message: `${missing.length ? `Couldn't match in ${dayLabel(day)}: ${missing.join(', ')}. ` : `Reordered ${dayLabel(day)}. `}${tripSummary()}`,
        data: { day, days: dayCounts() },
        needsResponse: missing.length > 0,
      }
    },

    async focus_stop(a) {
      const name = str(a.name)
      const stop = name ? store.findByName(name) : undefined
      if (!stop) return { ok: false, message: `No stop matching "${name ?? ''}". ${tripSummary()}`, needsResponse: true }
      void map.focusStop(stop.id).catch((e) => console.warn('[dispatcher] focusStop', e))
      return { ok: true, message: `Camera on ${stop.name} (${dayLabel(stop.day)}, stop ${store.indexInDay(stop.id)}).`, data: { day: stop.day } }
    },

    async set_mood(a) {
      const preset = asPreset(a.lightPreset ?? a.mood ?? a.preset)
      if (!preset) return { ok: false, message: 'set_mood needs lightPreset: dawn, day, dusk or night.', needsResponse: true }
      store.setLightPreset(preset)
      return { ok: true, message: `Map lighting set to ${preset}.` }
    },

    async play_tour(a) {
      const st = store.get()
      if (st.stops.length === 0) return { ok: false, message: 'No stops yet — add some before the flyover.', needsResponse: true }
      const rawDay = str(a.day)?.toLowerCase()
      const all = rawDay === 'all' || rawDay === 'every' || rawDay === 'whole' || a.all === true
      let day: number | 'all' = all ? 'all' : asDay(a.day) ?? st.activeDay
      // requested day is empty → fall back to the whole trip rather than failing on stage
      if (day !== 'all' && store.stopsForDay(day).length === 0) day = 'all'
      // fire and forget: the flyover takes a while, the agent should narrate over it
      void map.playTour(day).catch((e) => console.warn('[dispatcher] playTour', e))
      if (day === 'all') {
        const withStops = st.days.filter((d) => store.stopsForDay(d.day).length > 0).length
        return { ok: true, message: `Flyover started across all ${withStops} day${withStops === 1 ? '' : 's'} (${st.stops.length} stops), day by day.`, data: { day: 'all', days: dayCounts() } }
      }
      return { ok: true, message: `Flyover of ${dayLabel(day)} started across ${store.stopsForDay(day).length} stops.`, data: { day, days: dayCounts() } }
    },

    async show_options(a) {
      const title = str(a.title, 60) ?? 'Pick one'
      const day = asDay(a.day) ?? store.get().activeDay
      const raw = Array.isArray(a.options) ? (a.options as unknown[]).filter((o): o is Record<string, unknown> => !!o && typeof o === 'object').slice(0, 6) : []
      if (!raw.length) return { ok: false, message: 'show_options needs 3 options with names.', needsResponse: true }
      // geocode in parallel; keep the first 3 that land in the Bay Area
      const resolved = await Promise.all(
        raw.map(async (o) => {
          const name = str(o.name, 80) ?? str(o.query, 80)
          if (!name) return null
          const loc = await resolveLocation(o, name)
          return 'error' in loc ? null : { name, o, ...loc }
        }),
      )
      const labels: readonly OptionLabel[] = ['A', 'B', 'C']
      const options: OptionCandidate[] = resolved
        .filter((r): r is NonNullable<typeof r> => !!r)
        .slice(0, 3)
        .map((r, i) => ({
          label: labels[i],
          name: r.name,
          lat: r.lat,
          lng: r.lng,
          address: r.address,
          note: str(r.o.note, 120),
          time: str(r.o.time, 24),
          category: asCategory(r.o.category),
          url: str(r.o.url, 300),
        }))
      if (!options.length) return { ok: false, message: "Couldn't locate any of those options in the Bay Area. Suggest others.", needsResponse: true }
      if (day !== store.get().activeDay) store.setActiveDay(day)
      store.setOptions({ title, day, options })
      // photos load in the background → cards develop as they arrive
      for (const o of options) {
        void fetchPhoto({ name: o.name, lat: o.lat, lng: o.lng, url: o.url }).then((r) => {
          const set = store.get().options
          if (!set || !set.options.some((x) => x.label === o.label && x.name === o.name)) return
          const url = r.photoUrl ?? mapboxSnapshotUrl(o.lat, o.lng)
          if (url) store.updateOption(o.label, { photoUrl: url })
        })
      }
      const lines = options.map((o) => `${o.label}: ${o.name}${o.note ? ` — ${o.note}` : ''}`).join('\n')
      return {
        ok: true,
        message: `Showing "${title}" for ${dayLabel(day)}:\n${lines}\nWait for the user's choice (they may tap a card or say it); then call choose_option.`,
        data: { day, options: options.map((o) => ({ label: o.label, name: o.name })) },
        needsResponse: false,
      }
    },

    async choose_option(a) {
      const set = store.get().options
      if (!set) return { ok: false, message: 'No options are showing right now. Use add_stop directly.', needsResponse: true }
      const pick = resolveChoice(set.options, str(a.choice ?? a.label ?? a.name) ?? '')
      if (!pick) {
        return { ok: false, message: `"${str(a.choice) ?? ''}" doesn't match ${set.options.map((o) => `${o.label}: ${o.name}`).join(', ')}. Ask which one.`, needsResponse: true }
      }
      store.setOptions(null)
      const res = await handlers.add_stop({ name: pick.name, lat: pick.lat, lng: pick.lng, time: pick.time, note: pick.note, category: pick.category, url: pick.url, day: set.day })
      if (!res.ok) return res
      // carry the already-loaded photo over to the real stop
      const stop = findInDay(pick.name, set.day)
      if (stop && pick.photoUrl && !stop.photoUrl) store.updateStop(stop.id, { photoUrl: pick.photoUrl })
      return { ...res, message: `User chose ${pick.label}: ${pick.name} — added to ${dayLabel(set.day)}. ${res.message}`, data: { ...(res.data as object), chosen: pick.label }, needsResponse: true }
    },

    async get_pointer() {
      const p = store.get().pointer
      if (!p || Date.now() - p.updatedAt > 20000) {
        return { ok: false, message: "User isn't pointing at anything — ask them to point or name the place.", needsResponse: true }
      }
      const extra = [p.kind, p.radiusM ? `radius ~${Math.round(p.radiusM)}m` : ''].filter(Boolean).join(', ')
      return {
        ok: true,
        message: `User is pointing at ${p.label} (${extra})${p.nearby?.length ? `, nearby: ${p.nearby.slice(0, 4).join(', ')}` : ''}. Use it as the area for search_places/show_options.`,
        data: { label: p.label, kind: p.kind, lat: +p.lat.toFixed(5), lng: +p.lng.toFixed(5), radiusM: p.radiusM, nearby: p.nearby?.slice(0, 5) },
        needsResponse: true,
      }
    },

    async update_profile(a) {
      const PACES = ['chill', 'balanced', 'packed'] as const
      const COMPANY = ['solo', 'partner', 'friends', 'family'] as const
      const BUDGET = ['cheap', 'mid', 'splurge'] as const
      const oneOf = <T extends string>(v: unknown, list: readonly T[]) => (typeof v === 'string' && (list as readonly string[]).includes(v.toLowerCase()) ? (v.toLowerCase() as T) : undefined)
      const rawInterests = Array.isArray(a.interests) ? a.interests : typeof a.interests === 'string' ? String(a.interests).split(/[,\s]+/) : []
      const interests = rawInterests.map((x) => String(x).toLowerCase()).filter((x): x is StopCategory => (CATEGORIES as readonly string[]).includes(x))
      const daysNum = Math.round(Number(a.days))
      const patch = {
        travelerName: str(a.travelerName, 30),
        days: Number.isFinite(daysNum) && daysNum >= 1 ? Math.min(daysNum, 7) : undefined,
        pace: oneOf(a.pace, PACES),
        interests: interests.length ? [...new Set([...(store.get().profile?.interests ?? []), ...interests])] : undefined,
        company: oneOf(a.company, COMPANY),
        budget: oneOf(a.budget, BUDGET),
        notes: str(a.notes, 120),
      }
      const p = store.patchProfile(patch)
      window.dispatchEvent(new CustomEvent('quest:profile-updated', { detail: { patch, profile: p } }))
      const saved = Object.entries(patch).filter(([, v]) => v !== undefined).map(([k]) => k)
      return { ok: true, message: saved.length ? `Saved ${saved.join(', ')}. Profile: ${JSON.stringify(p)}` : 'Nothing recognizable to save — ask again briefly.', data: p, needsResponse: !saved.length }
    },

    async set_day(a) {
      const day = asDay(a.day)
      if (day === undefined) return { ok: false, message: `set_day needs a day number (1, 2, 3…). ${tripSummary()}`, needsResponse: true }
      const title = str(a.title, 40)
      store.setActiveDay(day, title)
      if (store.stopsForDay(day).length) void map.overview(day).catch((e) => console.warn('[dispatcher] overview', e))
      const n = store.stopsForDay(day).length
      return {
        ok: true,
        message: `Now planning ${dayLabel(day)} — ${n ? `${n} stop${n === 1 ? '' : 's'} so far` : 'empty, add its first stop'}. ${tripSummary()}`,
        data: { day, title: store.get().days.find((d) => d.day === day)?.title, days: dayCounts() },
      }
    },

    async clear_trip() {
      try {
        map.stopTour()
      } catch (e) {
        console.warn('[dispatcher] stopTour', e)
      }
      store.setOptions(null)
      store.clear()
      return { ok: true, message: 'Trip cleared.' }
    },
  }

  return {
    async runTool(name, args) {
      const h = handlers[name as ToolName]
      if (!h) return { ok: false, message: `Unknown tool "${String(name)}".`, needsResponse: true }
      const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
      try {
        const res = await h(a)
        console.debug('[tool]', name, a, '→', res)
        return res
      } catch (e) {
        console.error('[tool]', name, e)
        return { ok: false, message: `${name} failed: ${errMsg(e)}`, needsResponse: true }
      }
    },
  }
}
