import type { DayInfo, LightPreset, OptionSet, PointerContext, Stop, TripProfile, TripState } from '../types'

type Listener = (state: TripState, prev: TripState) => void

export type NewStop = Omit<Stop, 'id' | 'day'> & { day?: number }

export interface TripStore {
  get(): TripState
  subscribe(fn: Listener): () => void
  /** day defaults to activeDay; a day beyond the current count is created (and intermediate days) */
  addStop(stop: NewStop): Stop
  removeStop(id: string): void
  /** patch fields of an existing stop (e.g. photoUrl once loaded) */
  updateStop(id: string, patch: Partial<Omit<Stop, 'id'>>): void
  /** reorder stops of ONE day (defaults to activeDay); ids not listed keep relative order after */
  reorder(ids: string[], day?: number): void
  /** switch active day, creating it (and any gap days) if needed; optionally set its title */
  setActiveDay(day: number, title?: string): void
  setDayTitle(day: number, title: string): void
  /** save onboarding answers; pre-creates profile.days days */
  setProfile(p: TripProfile): void
  /** merge partial answers (voice onboarding); creates a default profile if none */
  patchProfile(p: Partial<TripProfile>): TripProfile
  setLightPreset(p: LightPreset): void
  setActive(id: string | null): void
  setTouring(t: boolean): void
  /** show/replace the 3-option chooser; null clears it */
  setOptions(o: OptionSet | null): void
  setPointer(p: PointerContext | null): void
  /** patch one option (e.g. photoUrl once loaded) */
  updateOption(label: string, patch: Partial<OptionSet['options'][number]>): void
  clear(): void
  /** stops of a day in route order (defaults to activeDay) */
  stopsForDay(day?: number): Stop[]
  /** 1-based position of a stop within its day (matches pin numbers) */
  indexInDay(id: string): number
  /** fuzzy lookup by name (case-insensitive, substring both ways); prefers the active day */
  findByName(name: string): Stop | undefined
}

const initial: TripState = {
  profile: null,
  stops: [],
  days: [{ day: 1 }],
  activeDay: 1,
  lightPreset: 'dusk',
  activeStopId: null,
  touring: false,
  options: null,
  pointer: null,
}

export function createStore(): TripStore {
  let state: TripState = initial
  const listeners = new Set<Listener>()

  const set = (patch: Partial<TripState>) => {
    const prev = state
    state = { ...state, ...patch }
    listeners.forEach((l) => l(state, prev))
  }

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
  const clampDay = (d: unknown) => {
    const n = Math.floor(Number(d))
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 14) : state.activeDay
  }
  /** days list extended up to `day` */
  const ensureDays = (day: number): DayInfo[] => {
    if (day <= state.days.length) return state.days
    const days = [...state.days]
    for (let d = days.length + 1; d <= day; d++) days.push({ day: d })
    return days
  }

  const store: TripStore = {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    addStop(stop) {
      const day = stop.day == null ? state.activeDay : clampDay(stop.day)
      const s: Stop = { ...stop, day, id: crypto.randomUUID() }
      set({ stops: [...state.stops, s], days: ensureDays(day), activeDay: day, activeStopId: s.id })
      return s
    },
    removeStop(id) {
      set({
        stops: state.stops.filter((s) => s.id !== id),
        activeStopId: state.activeStopId === id ? null : state.activeStopId,
      })
    },
    updateStop(id, patch) {
      if (!state.stops.some((s) => s.id === id)) return
      const days = patch.day != null ? ensureDays(clampDay(patch.day)) : state.days
      set({ stops: state.stops.map((s) => (s.id === id ? { ...s, ...patch } : s)), days })
    },
    reorder(ids, day = state.activeDay) {
      const inDay = state.stops.filter((s) => s.day === day)
      const byId = new Map(inDay.map((s) => [s.id, s]))
      const ordered = ids.map((id) => byId.get(id)).filter((s): s is Stop => !!s)
      const rest = inDay.filter((s) => !ids.includes(s.id))
      const newDay = [...ordered, ...rest]
      // keep other days' stops where they are; replace this day's stops in sequence
      let i = 0
      set({ stops: state.stops.map((s) => (s.day === day ? newDay[i++] : s)) })
    },
    setActiveDay(day, title) {
      const d = clampDay(day)
      let days = ensureDays(d)
      if (title) days = days.map((x) => (x.day === d ? { ...x, title } : x))
      set({ days, activeDay: d, activeStopId: null })
    },
    setDayTitle(day, title) {
      set({ days: ensureDays(clampDay(day)).map((x) => (x.day === day ? { ...x, title } : x)) })
    },
    setProfile(profile) {
      set({ profile, days: ensureDays(clampDay(profile.days)) })
    },
    patchProfile(patch) {
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<TripProfile>
      const profile: TripProfile = { days: 1, pace: 'balanced', interests: [], ...(state.profile ?? {}), ...clean }
      set({ profile, days: ensureDays(clampDay(profile.days)) })
      return profile
    },
    setLightPreset: (lightPreset) => set({ lightPreset }),
    setActive(activeStopId) {
      const s = activeStopId ? state.stops.find((x) => x.id === activeStopId) : undefined
      set({ activeStopId, ...(s && s.day !== state.activeDay ? { activeDay: s.day } : {}) })
    },
    setTouring: (touring) => set({ touring }),
    setOptions: (options) => set({ options }),
    setPointer: (pointer) => set({ pointer }),
    updateOption(label, patch) {
      if (!state.options) return
      set({ options: { ...state.options, options: state.options.options.map((o) => (o.label === label ? { ...o, ...patch } : o)) } })
    },
    clear: () => set({ stops: [], days: Array.from({ length: Math.max(1, state.profile?.days ?? 1) }, (_, i) => ({ day: i + 1 })), activeDay: 1, activeStopId: null, touring: false, options: null }),
    stopsForDay: (day = state.activeDay) => state.stops.filter((s) => s.day === day),
    indexInDay(id) {
      const s = state.stops.find((x) => x.id === id)
      if (!s) return 0
      return state.stops.filter((x) => x.day === s.day).findIndex((x) => x.id === id) + 1
    },
    findByName(name) {
      const n = norm(name)
      if (!n) return undefined
      const pref = [...state.stops].sort((a, b) => Number(b.day === state.activeDay) - Number(a.day === state.activeDay))
      return (
        pref.find((s) => norm(s.name) === n) ??
        pref.find((s) => norm(s.name).includes(n) || n.includes(norm(s.name)))
      )
    },
  }
  return store
}
