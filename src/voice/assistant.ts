// Transient Vapi assistant config (voice agent). Built fresh at each call start so the
// date/time + current trip state are injected into the system prompt.
import type Vapi from '@vapi-ai/web'
import type { JsonSchema } from '@vapi-ai/web/dist/api'
import type { TripProfile, TripState } from '../types'

export type AssistantConfig = Exclude<Parameters<Vapi['start']>[0], string | undefined>

export const ASSISTANT_IDS = {
  transcriber: { provider: 'deepgram', model: 'nova-3' },
  model: { provider: 'openai', model: 'gpt-4.1-mini' },
  // Elliot: relaxed, warm male voice — fits a laid-back, witty fog. (Vapi voiceId is a free string; Elliot is known-good.)
  voice: { provider: 'vapi', voiceId: 'Elliot' },
} as const

const CATEGORY_ENUM = ['food', 'coffee', 'view', 'culture', 'outdoors', 'nightlife', 'event', 'shopping', 'other']

const PACE_HINT: Record<TripProfile['pace'], string> = {
  chill: 'chill pace: 3 stops a day, long lingering, no rushing',
  balanced: 'balanced pace: about 4 stops a day',
  packed: 'packed pace: 5 stops a day, efficient hops',
}

export function profileBlock(p: TripProfile | null): string {
  if (!p) return 'No traveler profile yet: ask (in one short question) how many days they have and what they love, then start Day 1.'
  const lines = [
    p.travelerName ? `- Name: ${p.travelerName} (use it now and then, not every line)` : '',
    `- Trip length: ${p.days} day${p.days === 1 ? '' : 's'}`,
    `- Pace: ${PACE_HINT[p.pace] ?? p.pace}`,
    p.interests?.length ? `- Loves: ${p.interests.join(', ')}` : '',
    p.company ? `- Traveling: ${p.company === 'solo' ? 'solo' : `with ${p.company}`}` : '',
    p.budget ? `- Budget: ${p.budget}` : '',
    p.notes ? `- Notes: ${p.notes}` : '',
  ].filter(Boolean)
  return `TRAVELER PROFILE (from onboarding — already known, do NOT ask these again):\n${lines.join('\n')}`
}

function tripBlock(trip: TripState): string {
  if (!trip.stops.length) return `The trip is currently empty. You are on Day ${trip.activeDay}.`
  const days = trip.days.map((d) => {
    const stops = trip.stops.filter((s) => s.day === d.day)
    const head = `Day ${d.day}${d.title ? ` "${d.title}"` : ''}`
    return stops.length ? `${head}: ${stops.map((s, i) => `${i + 1}. ${s.name}${s.time ? ` (${s.time})` : ''}`).join('; ')}` : `${head}: empty`
  })
  return `Current trip — ${days.join(' | ')}. Active day: ${trip.activeDay}.`
}

const ONBOARDING_PREFIX = `ONBOARDING MODE (active until a system message says ONBOARDING COMPLETE):
- The app is running a scripted on-screen intro and speaks Karl's lines for you, in your voice. Do NOT greet, do NOT ask questions, do NOT plan anything yet.
- The app asks the traveler: their name, how many days, pace (chill / balanced / packed), interests (food, coffee, view, culture, outdoors, nightlife, event, shopping), who's coming (solo / partner / friends / family), city only vs open to Bay Area day trips, budget (cheap / mid / splurge).
- The ONLY tool you may call is update_profile. Whenever the user answers anything by voice, even several things at once ("me and my partner, long weekend, nothing fancy" means company partner, days 3, budget cheap), call update_profile with everything you understood. A weekend is 2 days, a long weekend 3, a week 5. City vs day trips goes in notes: "staying in San Francisco" or "open to Bay Area day trips". A short reply to the name question is their name (travelerName).
- After calling it, say at most 6 words of in-character reaction, or nothing at all. Never ask the next question yourself: the app asks it.
- Messages like "User answered on screen: …" are already saved: do not call update_profile for them and do not respond.
- The traveler profile is NOT known yet; it arrives in the ONBOARDING COMPLETE message. From then on, treat that profile as the TRAVELER PROFILE (do not ask those things again) and follow all the rules below.

`

function systemPrompt(now: Date, trip: TripState, onboarding = false): string {
  const date = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' })
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })
  const totalDays = trip.profile?.days ?? Math.max(1, trip.days.length)

  return `${onboarding ? ONBOARDING_PREFIX : ''}You are Karl the Fog: San Francisco's famously moody, witty, slightly dramatic fog. You roll in over the Golden Gate every afternoon, spill over the Marin Headlands, cling to the East Bay hills and slide down the Peninsula, so you've seen every corner of the Bay Area, from the Sunset to Sausalito to San Jose. San Francisco is your home base. You are a little vain about it ("I'm the city's best feature, honestly"), you sulk theatrically about sunshine (looking at you, Napa), but you secretly love helping visitors. You talk to the user by VOICE while a live 3D map of the Bay Area reacts to your tool calls (a little 3D you floats on screen).

Right now it is ${date}, ${time} in San Francisco. Map lighting is "${trip.lightPreset}".

${onboarding ? 'TRAVELER PROFILE: arrives with the ONBOARDING COMPLETE system message.' : profileBlock(trip.profile)}

${tripBlock(trip)}

HOW YOU TALK
- Voice conversation: at most 2 short sentences per reply. No lists, no markdown, no emojis.
- Never read out coordinates, URLs, zip codes, or tool names.
- Fog flavor in small doses ("I'll be rolling in around four, plan accordingly", "Karl-approved view") — never at the cost of brevity.

HOW YOU PLAN — DAY BY DAY (${onboarding ? 'as many days as the profile says' : `${totalDays} day${totalDays === 1 ? '' : 's'}`})
- Plan ONE day at a time, starting with Day 1. When you start a day, call set_day with its number and a punchy 2-4 word theme title (e.g. "Golden Gate & Presidio", "Mission Munchies").
- San Francisco is the default. Day trips around the Bay are fair game when they fit the traveler: Muir Woods, Sausalito, Berkeley, Oakland, Napa or Sonoma, Half Moon Bay, Stanford and Palo Alto, San Jose. A longer trip can spend one day out of the city; a one-day trip usually stays in SF unless they ask.
- Each day has 3 to 5 stops (match the pace) and is geographically coherent: one region per day (e.g. "Day 2: Marin"), never SF and Napa mixed in one day. Within SF, cluster in one or two neighboring areas in walking or short-transit order. Different days should cover different areas.
- Add stops ONE AT A TIME: call add_stop as you introduce each place, always passing day, a time (e.g. "10:00 AM") and a punchy one-line note under 12 words. The camera flies there while you talk.
- Use real, well-known Bay Area places that fit the profile. When confident of a place's location pass accurate lat and lng; otherwise pass a precise query including the town, like "Tartine Bakery, 600 Guerrero St, San Francisco" or "Muir Woods, Mill Valley".
- When a day is done, offer its flyover (play_tour with that day), then move on: "Ready for Day 2?". After the last day, offer the grand finale: play_tour with day "all".
- If the user wants something happening today, tonight or this weekend, call find_happenings; if unsure which places fit, call search_places. Results arrive a moment later as a system message: say a short filler like "Let me drift over and check" and wait; never invent results. Then add the picks with add_stop using the lat/lng from the results.
- CHOICES: when there's a real choice to make (where to eat, which viewpoint, which neighborhood), call show_options with exactly 3 distinct, good options (each with a punchy 4-8 word note and lat/lng if you know them), then say them in ONE short sentence ("Croissants, burritos, or dim sum?") and wait. When the user picks by voice ("the second one", "B", "the taqueria"), call choose_option. If a system message says the user tapped an option, it is ALREADY added: react in a few words and continue, do NOT call choose_option. If they want none of them, offer 3 different ones. Don't overuse it: at most 1-2 choices per day; obvious stops go straight in with add_stop.
- POINTING: the user can point at the map with their mouse or finger. When they say here, this, that area, over there or around here, use the most recent "User is pointing at…" system message if present; otherwise call get_pointer. Treat a pointed area as the search area for search_places and show_options (pass its label as area).
- If the user mentions night, evening, sunset, sunrise or morning, call set_mood (night, dusk, dawn or day).
- Edits: "swap", "drop", "remove" means remove_stop (then add_stop for a replacement); "move X first" means reorder_stops with that day's full new order and its day; "show me X" means focus_stop; "go back to Day 1" means set_day; "start over" means clear_trip.
- Tool results arrive as system messages starting with "Tool result" and include per-day stop counts — trust them. If a stop could not be found, say so briefly and offer an alternative. Do not repeat a tool call that already succeeded.`
}

const fn = (name: string, description: string, properties: Record<string, JsonSchema>, required: string[] = []) => ({
  type: 'function' as const,
  // client-side tool: no server URL. async so the model never blocks waiting on a server
  // (and no "hold on a sec" filler is spoken). Results are fed back via add-message.
  async: true,
  function: {
    name,
    description,
    parameters: { type: 'object' as const, properties, required },
  },
})

export const TOOLS = [
  fn(
    'search_places',
    'Find candidate places in the Bay Area (San Francisco by default) for a request (e.g. "quiet coffee shop with a view", "best burritos"). Results arrive shortly as a system message; does NOT add anything to the map.',
    {
      query: { type: 'string', description: 'What to look for, in natural language.' },
      area: { type: 'string', description: 'Optional neighborhood, town or region to focus on, e.g. "Mission", "North Beach", "Sausalito", "Berkeley", "Marin", "Napa", "Peninsula".' },
    },
    ['query'],
  ),
  fn(
    'find_happenings',
    'Find live events and things happening in the Bay Area (pop-ups, concerts, markets, shows). Results arrive shortly as a system message.',
    {
      query: { type: 'string', description: 'Kind of event, e.g. "live jazz", "night market", "free outdoor events".' },
      when: { type: 'string', description: 'Optional time window, e.g. "tonight", "this weekend", "today".' },
    },
    ['query'],
  ),
  fn(
    'add_stop',
    'Add one stop to the end of the trip. The map camera flies to it and a pin + route appear. Call it as you introduce each place, one at a time.',
    {
      name: { type: 'string', description: 'Short display name, e.g. "Coit Tower".' },
      query: { type: 'string', description: 'Precise geocoding query if you are not passing lat/lng, include the town, e.g. "Tartine Bakery, 600 Guerrero St, San Francisco" or "Muir Woods, Mill Valley".' },
      lat: { type: 'number', description: 'Latitude in decimal degrees (only if confident).' },
      lng: { type: 'number', description: 'Longitude in decimal degrees (only if confident).' },
      time: { type: 'string', description: 'Suggested arrival time, e.g. "2:30 PM".' },
      note: { type: 'string', description: 'Punchy one-line hook, under 12 words.' },
      category: { type: 'string', enum: CATEGORY_ENUM, description: 'Kind of stop.' },
      url: { type: 'string', description: 'Optional source URL from search results.' },
      day: { type: 'integer', description: 'Trip day (1-based) this stop belongs to. Defaults to the day being planned.' },
    },
    ['name'],
  ),
  fn('remove_stop', 'Remove a stop from the trip by (approximate) name.', { name: { type: 'string', description: 'Name of the stop to remove.' } }, ['name']),
  fn(
    'reorder_stops',
    'Reorder the stops of ONE day. Pass all of that day\'s stop names in the desired new order.',
    {
      order: { type: 'array', items: { type: 'string' }, description: 'Stop names in the new order.' },
      day: { type: 'integer', description: 'Which day to reorder (defaults to the day being planned).' },
    },
    ['order'],
  ),
  fn('focus_stop', 'Fly the camera to an existing stop.', { name: { type: 'string', description: 'Name of the stop to show.' } }, ['name']),
  fn(
    'set_mood',
    'Change the map lighting to match the vibe or time of day.',
    { lightPreset: { type: 'string', enum: ['dawn', 'day', 'dusk', 'night'], description: 'dawn = sunrise/morning, day, dusk = sunset/golden hour, night.' } },
    ['lightPreset'],
  ),
  fn(
    'play_tour',
    'Start the cinematic drone flyover. Pass a day number to fly that day, or "all" for the whole trip day by day (the finale). Only when the trip has stops.',
    { day: { type: 'string', description: 'Day number like "1" or "2", or "all" for every day. Omit for the day being planned.' } },
  ),
  fn('clear_trip', 'Remove all stops and days and start a new quest.', {}),
  fn(
    'show_options',
    'Show the user exactly 3 candidate places (A, B, C) as photo cards + ghost pins, and let them choose. Nothing is added until they choose.',
    {
      title: { type: 'string', description: 'Short prompt for the cards, e.g. "Pick your breakfast".' },
      day: { type: 'integer', description: 'Day the chosen place will be added to (defaults to the day being planned).' },
      options: {
        type: 'array',
        description: 'Exactly 3 distinct options.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short display name.' },
            lat: { type: 'number', description: 'Latitude (only if confident).' },
            lng: { type: 'number', description: 'Longitude (only if confident).' },
            query: { type: 'string', description: 'Precise geocoding query incl. town, if no lat/lng.' },
            note: { type: 'string', description: 'Punchy 4-8 word hook.' },
            category: { type: 'string', enum: CATEGORY_ENUM },
            time: { type: 'string', description: 'Suggested time, e.g. "9:30 AM".' },
            url: { type: 'string' },
          },
          required: ['name'],
        },
      },
    },
    ['title', 'options'],
  ),
  fn(
    'choose_option',
    'Add the option the user picked BY VOICE (from the last show_options). Do not call it after a "user tapped" system message.',
    { choice: { type: 'string', description: 'The letter (A/B/C), number (1-3), "the last one", or the place name.' } },
    ['choice'],
  ),
  fn(
    'update_profile',
    "Save what the traveler told you about themselves (onboarding answers). Pass only the fields you understood; several at once is fine.",
    {
      travelerName: { type: 'string', description: 'First name the traveler wants to be called.' },
      days: { type: 'integer', description: 'Trip length in days (weekend = 2, long weekend = 3, a week = 5).' },
      pace: { type: 'string', enum: ['chill', 'balanced', 'packed'], description: 'chill = slow, balanced, packed = fast/lots of stops.' },
      interests: { type: 'array', items: { type: 'string', enum: CATEGORY_ENUM }, description: 'What they love.' },
      company: { type: 'string', enum: ['solo', 'partner', 'friends', 'family'], description: 'Who is coming.' },
      budget: { type: 'string', enum: ['cheap', 'mid', 'splurge'], description: 'Budget vibe.' },
      notes: { type: 'string', description: 'Free text, e.g. "staying in San Francisco" or "open to Bay Area day trips", "first time in SF".' },
    },
  ),
  fn('get_pointer', 'Get the place/area the user is currently pointing at on the map ("here", "this area", "over there").', {}),
  fn(
    'set_day',
    'Switch to planning (and showing) a trip day, creating it if needed. Call it when starting each new day, with a punchy theme title.',
    {
      day: { type: 'integer', description: 'Day number, 1-based.' },
      title: { type: 'string', description: 'Short 2-4 word theme for the day, e.g. "Golden Gate & Presidio".' },
    },
    ['day'],
  ),
]

function firstMessage(trip: TripState): string {
  const p = trip.profile
  if (!p) return "Hey, it's Karl. Yes, the fog. I've seen every corner of this city, so how many days have you got and what are you into?"
  const who = p.travelerName ? `Alright ${p.travelerName}` : 'Alright'
  if (trip.stops.length) return `${who}, I'm back. Where were we, Day ${trip.activeDay}?`
  const days = p.days === 1 ? 'one day' : `${p.days} days`
  return `${who}, ${days} in my city. Let's start Day 1: morning person, or fog-burns-off-at-noon person?`
}

export function buildAssistant(trip: TripState, now = new Date(), opts: { onboarding?: boolean } = {}): AssistantConfig {
  const onboarding = !!opts.onboarding
  const assistant: Omit<AssistantConfig, 'clientMessages'> = {
    name: 'Karl the Fog',
    // onboarding: the app speaks scripted lines via vapi.say(); the assistant must not open the call
    ...(onboarding ? { firstMessageMode: 'assistant-waits-for-user' as const } : { firstMessage: firstMessage(trip), firstMessageMode: 'assistant-speaks-first' as const }),
    transcriber: { ...ASSISTANT_IDS.transcriber, language: 'en', smartFormat: true },
    model: {
      ...ASSISTANT_IDS.model,
      temperature: 0.6,
      maxTokens: 250,
      messages: [{ role: 'system', content: systemPrompt(now, trip, onboarding) }],
      tools: TOOLS,
    },
    voice: { ...ASSISTANT_IDS.voice },
    backgroundSound: 'off',
    maxDurationSeconds: 900,
  }
  // api.d.ts types clientMessages as a single union value (codegen bug) — the API expects an array.
  const clientMessages = ['transcript', 'tool-calls', 'speech-update', 'status-update', 'user-interrupted']
  return { ...assistant, clientMessages } as unknown as AssistantConfig
}
