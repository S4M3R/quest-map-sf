// POST /api/happenings — what's on in SF right now (Exa), with best-effort venue geocoding.
import type { Happening, HappeningsResponse } from '../src/types.js'
import { exa, exaEventSummaries, exaHighlights, type ExaHit, type EventSummary } from './exa.js'
import { geocode, hasMapbox } from './mapbox.js'
import { oneLine, sameName, within } from './util.js'

const MAX_RESULTS = 5
const SUMMARY_WAIT_MS = 4200

function cleanTitle(t: string): string {
  return t.split(/\s[|–—]\s/)[0].trim()
}

export async function findHappenings(query: string, when?: string): Promise<HappeningsResponse> {
  exa() // throws 503 if key missing
  const since = new Date(Date.now() - 14 * 864e5).toISOString()
  const q = `${query} ${when ?? 'this week'} in the San Francisco Bay Area`

  // Fire both: rich structured summaries (slow) and plain highlights (fast fallback).
  const fastP = within(exaHighlights(q, { numResults: 8, startPublishedDate: since, timeoutMs: 2500 }), 2500, [] as ExaHit[], 'exa happenings fast')
  const richP = within(
    exaEventSummaries(q, `${query}${when ? ` ${when}` : ''}`, { numResults: 8, startPublishedDate: since, timeoutMs: SUMMARY_WAIT_MS }),
    SUMMARY_WAIT_MS,
    null,
    'exa happenings summary',
  )

  const rich = await richP
  let items: Happening[]
  if (rich && rich.length) {
    const scored = rich.map((r, i) => ({ r, score: i + (r.event?.isEvent === false ? 10 : 0) + (r.event?.venue ? 0 : 3) }))
    items = scored
      .sort((a, b) => a.score - b.score)
      .map(({ r }) => fromRich(r, r.event))
  } else {
    const fast = await fastP
    items = fast.map((h) => ({
      title: cleanTitle(h.title) || h.url,
      url: h.url,
      summary: oneLine(h.highlights[0], 180),
      when: h.publishedDate?.slice(0, 10),
    }))
  }
  items = dedupe(items).slice(0, MAX_RESULTS)

  // Best-effort: venue → coordinates (parallel, short timeout).
  if (hasMapbox()) {
    await within(
      Promise.all(
        items.map(async (it) => {
          if (!it.venue) return
          const venue = it.venue.split(/\s[|(–—-]\s?/)[0].trim()
          const g = await geocode(venue, 900).catch(() => null)
          if (g && sameName(g.name, venue)) it.location = { lng: g.lng, lat: g.lat }
        }),
      ),
      1100,
      undefined,
      'venue geocode',
    )
  }
  return { happenings: items }
}

function fromRich(h: ExaHit, ev?: EventSummary): Happening {
  const title = oneLine(ev?.title, 80) ?? cleanTitle(h.title)
  return {
    title: title || h.url,
    url: h.url,
    summary: oneLine(ev?.hook, 180) ?? oneLine(h.highlights[0], 180),
    when: oneLine(ev?.date, 60),
    venue: oneLine(ev?.venue, 60),
  }
}

function dedupe(items: Happening[]): Happening[] {
  const seen = new Set<string>()
  return items.filter((it) => {
    const k = `${it.title.toLowerCase()}|${(it.venue ?? '').toLowerCase()}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
