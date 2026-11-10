// Karl's onboarding script: lines, camera stops, question options and quips.
// Text supports *emphasis* (rendered as <em>, stripped for speech).
import type { CameraTarget, StopCategory, TripProfile } from '../types'

export const DEFAULT_VIEW: CameraTarget = { lat: 37.7885, lng: -122.4035, zoom: 14.8, pitch: 60, bearing: -20, durationMs: 2400 }

export const INVITE = 'Psst. You look like you need a plan. Want the one-minute tour?'
export const HELLO = "Oh hey. I'm Karl. Yes — *the* fog. I've rolled through every corner of this city — and the whole Bay, honestly."

export const TOUR: { line: string; cam: CameraTarget }[] = [
  {
    line: 'This is my town. I swallow that bridge most afternoons — *dramatically*.',
    cam: { lat: 37.8199, lng: -122.4783, zoom: 14.9, pitch: 64, bearing: 38, durationMs: 2600 },
  },
  {
    line: 'You talk, I plan. Every stop drops a pin on the map…',
    cam: { lat: 37.7955, lng: -122.3937, zoom: 15.8, pitch: 62, bearing: -32, durationMs: 2600 },
  },
  {
    line: '…and an instant photo, so your trip looks like a scrapbook.',
    cam: { lat: 37.7596, lng: -122.4269, zoom: 15.2, pitch: 58, bearing: 12, durationMs: 2600 },
  },
]

export const SPOTS: { sel: string[]; line: string; label: string }[] = [
  { sel: ['#itinerary'], line: 'Your plan lands here, day by day.', label: 'Itinerary' },
  { sel: ['#voice .qv-orb-wrap', '#voice'], line: "This orb is the hotline. Tap it and just talk to me.", label: 'Talk to Karl' },
  { sel: ['#polaroids'], line: 'And the snapshots pile up here.', label: 'Instant photos' },
]

export const Q_NAME = 'Quick questions, then I vanish. What should I call you?'
export const Q_DAYS = 'How many days are we haunting the city?'
export const Q_PACE = "What's your pace?"
export const Q_INTERESTS = 'What are you into? Pick as many as you like.'
export const Q_COMPANY = "Who's coming?"
export const Q_BUDGET = 'Budget vibe?'
export const Q_RANGE = 'Staying in the city, or up for day trips around the Bay?'
export const FINISH = 'Tap me — or the orb — and just talk. I’ll draw the map as we go.'

export interface Opt<T> {
  value: T
  label: string
  emoji?: string
}

export const DAYS: Opt<number>[] = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
  { value: 5, label: '5+' },
]

export const PACE: Opt<TripProfile['pace']>[] = [
  { value: 'chill', label: 'Chill', emoji: '🛋️' },
  { value: 'balanced', label: 'Balanced', emoji: '⚖️' },
  { value: 'packed', label: 'Packed', emoji: '⚡' },
]

export const INTERESTS: Opt<StopCategory>[] = [
  { value: 'food', label: 'Food', emoji: '🍜' },
  { value: 'coffee', label: 'Coffee', emoji: '☕' },
  { value: 'view', label: 'Views', emoji: '🌉' },
  { value: 'culture', label: 'Culture', emoji: '🎨' },
  { value: 'outdoors', label: 'Outdoors', emoji: '🌲' },
  { value: 'nightlife', label: 'Nightlife', emoji: '🌙' },
  { value: 'event', label: 'Events', emoji: '🎟️' },
  { value: 'shopping', label: 'Shopping', emoji: '🛍️' },
]

export const COMPANY: Opt<NonNullable<TripProfile['company']>>[] = [
  { value: 'solo', label: 'Just me', emoji: '🧍' },
  { value: 'partner', label: 'Partner', emoji: '💞' },
  { value: 'friends', label: 'Friends', emoji: '👯' },
  { value: 'family', label: 'Family', emoji: '👨‍👩‍👧' },
]

export const BUDGET: Opt<NonNullable<TripProfile['budget']>>[] = [
  { value: 'cheap', label: 'Cheap', emoji: '🪙' },
  { value: 'mid', label: 'Mid', emoji: '💳' },
  { value: 'splurge', label: 'Splurge', emoji: '💎' },
]

export const RANGE: Opt<'city' | 'bay'>[] = [
  { value: 'city', label: 'City only', emoji: '🏙️' },
  { value: 'bay', label: 'Open to day trips', emoji: '🚗' },
]

export const RANGE_NOTE = { city: 'staying in San Francisco', bay: 'open to Bay Area day trips' } as const

export const quip = {
  range: (r: 'city' | 'bay') => (r === 'bay' ? 'Sausalito, Muir Woods, Berkeley… I get around.' : 'City mouse. Plenty of hills to keep you busy.'),
  name: (n?: string) => (n ? `${n}. Classy. I'll whisper it mysteriously.` : 'A traveler of mystery. I respect that.'),
  days: (d: number) =>
    d === 1 ? 'One day? Bold. We make it count.' : d >= 5 ? 'Five-plus! You might start rolling in with me.' : `${d} days — the sweet spot.`,
  pace: (p: TripProfile['pace']) =>
    p === 'chill' ? 'Chill. My natural state.' : p === 'packed' ? 'Packed! Hope you brought calves for these hills.' : 'Balanced. Very zen.',
  interests: (i: StopCategory[]) =>
    !i.length ? "Open to anything? Dangerous. I love it." : i.includes('view') ? 'Views, huh? I make no promises. I *am* the fog.' : i.includes('food') ? 'Good taste. Literally.' : 'Noted. Excellent choices.',
  company: (c: NonNullable<TripProfile['company']>) =>
    c === 'solo' ? 'Solo — just you and me then.' : c === 'partner' ? 'Romantic. I’ll do moody lighting.' : c === 'friends' ? 'A crew! I’ll keep the group chat fed.' : 'Family mode. Fewer bars, more sea lions.',
  budget: (b: NonNullable<TripProfile['budget']>) =>
    b === 'cheap' ? 'Free views are my specialty.' : b === 'splurge' ? 'Ooh. Tasting menus it is.' : 'Sensible. Like a good jacket here.',
}

export function summarize(p: TripProfile): string {
  const days = p.days >= 5 ? '5+ days' : `${p.days} day${p.days === 1 ? '' : 's'}`
  const ints = p.interests.map((c) => INTERESTS.find((o) => o.value === c)?.label.toLowerCase() ?? c)
  const who: Record<string, string> = { solo: 'solo', partner: 'with a partner', friends: 'with friends', family: 'with family' }
  let s = [days, p.pace, ints.length ? ints.slice(0, 3).join(', ') + (ints.length > 3 ? ` +${ints.length - 3}` : '') : 'anything goes'].join(' · ')
  if (p.company) s += ` — ${who[p.company]}`
  if (p.budget) s += ` · ${p.budget}`
  if (p.notes?.includes('day trips')) s += ' · Bay day trips'
  return s
}
