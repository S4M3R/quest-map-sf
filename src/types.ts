// Shared contracts. Owned by the lead — subagents: propose changes in your report, don't edit silently.

export type LightPreset = 'dawn' | 'day' | 'dusk' | 'night'

export type StopCategory = 'food' | 'coffee' | 'view' | 'culture' | 'outdoors' | 'nightlife' | 'event' | 'shopping' | 'other'

export interface LngLat {
  lng: number
  lat: number
}

export interface Stop extends LngLat {
  id: string
  /** 1-based trip day this stop belongs to */
  day: number
  name: string
  address?: string
  time?: string // free text, e.g. "2:00 PM"
  note?: string // one-line hook shown in the itinerary
  category?: StopCategory
  url?: string
  /** instant-photo image for the stop (filled async by the polaroid module after add) */
  photoUrl?: string
  photoSource?: 'wikipedia' | 'exa' | 'mapbox'
}

export interface DayInfo {
  /** 1-based */
  day: number
  /** short theme, e.g. "Golden Gate & Presidio" */
  title?: string
}

/** route/pin accent per day (index = day-1, wraps) */
export const DAY_COLORS = ['#ffb547', '#3ee6ff', '#ff5ca8', '#8cff6b', '#b18cff', '#ff7a45'] as const
export const dayColor = (day: number): string => DAY_COLORS[(Math.max(1, day) - 1) % DAY_COLORS.length]

/** answers collected by Karl's onboarding; injected into the voice assistant's prompt */
export interface TripProfile {
  travelerName?: string
  days: number
  pace: 'chill' | 'balanced' | 'packed'
  interests: StopCategory[]
  company?: 'solo' | 'partner' | 'friends' | 'family'
  budget?: 'cheap' | 'mid' | 'splurge'
  /** free-text extra, e.g. "first time in SF", "no hills please" */
  notes?: string
}

export type OptionLabel = 'A' | 'B' | 'C'

export interface OptionCandidate extends PlaceCandidate {
  label: OptionLabel
  /** shown on the card, e.g. "best pastries, long line" */
  note?: string
  time?: string
  photoUrl?: string
}

export interface OptionSet {
  /** e.g. "Pick your breakfast" */
  title: string
  /** day the chosen option will be added to */
  day: number
  options: OptionCandidate[]
}

/** what the user is pointing at, resolved to a human place name (written by src/pointer) */
export interface PointerContext extends LngLat {
  /** e.g. "Hayes Valley, near Patricia's Green" */
  label: string
  /** set when the user swept/drew an area rather than a single point */
  radiusM?: number
  /** nearby POI names, best first (optional) */
  nearby?: string[]
  /** 'hover' = cursor resting, 'pin' = clicked/tapped, 'area' = swept/drawn */
  kind: 'hover' | 'pin' | 'area'
  updatedAt: number
}

export interface TripState {
  /** null until onboarding completes (or is skipped) */
  profile: TripProfile | null
  /** all stops across all days; order within a day = route order */
  stops: Stop[]
  /** always at least [{day:1}] */
  days: DayInfo[]
  /** the day currently being planned/viewed; new stops go here by default */
  activeDay: number
  lightPreset: LightPreset
  /** id of the stop the camera is currently focused on */
  activeStopId: string | null
  /** 3 candidate places Karl is offering; user picks by voice (choose_option) or click */
  options: OptionSet | null
  /** where the user is pointing on the map (mouse hover / tap / drawn area); null when not pointing */
  pointer: PointerContext | null
  /** true while play_tour is animating */
  touring: boolean
}

export interface PlaceCandidate extends LngLat {
  name: string
  address?: string
  description?: string
  url?: string
  category?: StopCategory
}

export interface Happening {
  title: string
  url: string
  summary?: string
  when?: string
  venue?: string
  location?: LngLat
}

// ---------- server API (POST bodies / JSON responses) ----------
export interface SearchPlacesRequest { query: string; area?: string }
export interface SearchPlacesResponse { places: PlaceCandidate[] }

export interface HappeningsRequest { query: string; when?: string }
export interface HappeningsResponse { happenings: Happening[] }

export interface PhotoRequest { name: string; lat: number; lng: number; url?: string }
export interface PhotoResponse { photoUrl: string | null; source: 'wikipedia' | 'exa' | 'mapbox' | null }

export interface GeocodeRequest { query: string }
export interface GeocodeResponse { result: (LngLat & { name: string; address?: string }) | null }

// ---------- tools ----------
export type ToolName =
  | 'search_places'
  | 'find_happenings'
  | 'add_stop'
  | 'remove_stop'
  | 'reorder_stops'
  | 'focus_stop'
  | 'set_mood'
  | 'play_tour'
  | 'clear_trip'
  | 'set_day'
  | 'show_options'
  | 'choose_option'
  | 'get_pointer'
  | 'update_profile'

export interface ToolArgs {
  search_places: { query: string; area?: string }
  find_happenings: { query: string; when?: string }
  /** day defaults to state.activeDay; a day beyond the current count creates it */
  add_stop: { name: string; query?: string; lat?: number; lng?: number; time?: string; note?: string; category?: StopCategory; url?: string; day?: number }
  remove_stop: { name: string }
  /** reorders stops within one day (defaults to activeDay) */
  reorder_stops: { order: string[]; day?: number }
  focus_stop: { name: string }
  set_mood: { lightPreset: LightPreset }
  /** day omitted = active day; 'all' = every day in sequence */
  play_tour: { day?: number | 'all' }
  clear_trip: Record<string, never>
  /** switch planning/view to a day, creating it if needed, optionally naming it */
  set_day: { day: number; title?: string }
  /** present exactly 3 candidates (A/B/C) on the map + cards; nothing is added until chosen */
  show_options: {
    title: string
    day?: number
    options: { name: string; lat?: number; lng?: number; query?: string; note?: string; category?: StopCategory; time?: string; url?: string }[]
  }
  /** pick one of the shown options by label ('A'|'B'|'C'), 1-3, or name → adds it as a stop and clears the options */
  choose_option: { choice: string }
  /** where is the user pointing right now ("here", "this area", "over there") */
  get_pointer: Record<string, never>
  /** onboarding by voice: save whatever profile answers the user just gave (partial; merged) */
  update_profile: Partial<TripProfile>
}

export interface ToolResult {
  ok: boolean
  /** short human/LLM-readable summary, e.g. "Added Tartine Bakery at 600 Guerrero St" */
  message: string
  data?: unknown
  /** if true, the voice layer should feed `message`/`data` back to the LLM and let it respond */
  needsResponse?: boolean
}

// ---------- map ----------
export interface CameraTarget extends LngLat {
  zoom?: number
  pitch?: number
  bearing?: number
  durationMs?: number
}

export interface MapController {
  /** resolves when the style + 3D layers are loaded */
  ready: Promise<void>
  flyTo(target: CameraTarget): Promise<void>
  focusStop(id: string): Promise<void>
  setLightPreset(preset: LightPreset): void
  /** day omitted = state.activeDay; 'all' = every day in order */
  playTour(day?: number | 'all'): Promise<void>
  stopTour(): void
  /** fit stops in view: a given day, 'all', or (omitted) the active day */
  overview(day?: number | 'all'): Promise<void>
  /** screen px (relative to the map container) → lng/lat; null if the map isn't ready */
  unproject(x: number, y: number): LngLat | null
  /** lng/lat → screen px relative to the map container; null if not ready */
  project(p: LngLat): { x: number; y: number } | null
}
