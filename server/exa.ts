// Exa helpers: live web context for places + current SF happenings.
import Exa from 'exa-js'
import { HttpError, oneLine } from './util.js'

let client: Exa | null = null

export const hasExa = () => !!process.env.EXA_API_KEY

export function exa(): Exa {
  const key = process.env.EXA_API_KEY
  if (!key) throw new HttpError(503, 'EXA_API_KEY missing')
  client ??= new Exa(key)
  return client
}

export interface ExaHit {
  title: string
  url: string
  publishedDate?: string
  highlights: string[]
  summary?: string
}

const toHit = (r: any): ExaHit => ({
  title: (r.title ?? '').trim(),
  url: r.url,
  publishedDate: r.publishedDate ?? undefined,
  highlights: Array.isArray(r.highlights) ? r.highlights : [],
  summary: typeof r.summary === 'string' ? r.summary : undefined,
})

/** Fast keyword/neural search with highlights (~0.4–0.8s). */
export async function exaHighlights(
  query: string,
  opts: { numResults?: number; timeoutMs?: number; startPublishedDate?: string; signal?: AbortSignal } = {},
): Promise<ExaHit[]> {
  const res = await exa().search(query, {
    type: 'fast',
    numResults: opts.numResults ?? 8,
    startPublishedDate: opts.startPublishedDate,
    userLocation: 'US',
    contents: { highlights: { maxCharacters: 500 } },
    timeout: opts.timeoutMs ?? 2000,
    signal: opts.signal,
  })
  return res.results.map(toHit)
}

const EVENT_SCHEMA = {
  type: 'object',
  properties: {
    isEvent: { type: 'boolean', description: 'true if the page is about a specific upcoming event/show/happening (false for generic listings/articles or events that already ended before today)' },
    title: { type: 'string', description: 'Short event name, e.g. "Buzzcocks at The Chapel"' },
    date: { type: 'string', description: 'When it happens, human readable, e.g. "Tue Nov 10, 8 PM"' },
    venue: { type: 'string', description: 'Venue name only, e.g. "The Fillmore"' },
    hook: { type: 'string', description: 'One short enticing sentence (max 18 words) about why to go. Do not say "tonight" unless the event date is today.' },
  },
  required: ['title'],
}

export interface EventSummary {
  isEvent?: boolean
  title?: string
  date?: string
  venue?: string
  hook?: string
}

/** Search with a structured per-result summary (slower: ~3–5s). */
export async function exaEventSummaries(
  query: string,
  focus: string,
  opts: { numResults?: number; timeoutMs?: number; startPublishedDate?: string; signal?: AbortSignal } = {},
): Promise<(ExaHit & { event?: EventSummary })[]> {
  const res = await exa().search(query, {
    type: 'fast',
    numResults: opts.numResults ?? 8,
    startPublishedDate: opts.startPublishedDate,
    userLocation: 'US',
    contents: {
      summary: {
        query: `Today is ${new Date().toDateString()}. Extract the main San Francisco Bay Area event on this page relevant to "${focus}". If it lists many events, pick the single most relevant upcoming one.`,
        schema: EVENT_SCHEMA,
      },
    },
    timeout: opts.timeoutMs ?? 5000,
    signal: opts.signal,
  })
  return res.results.map((r: any) => {
    const hit = toHit(r)
    let event: EventSummary | undefined
    try {
      event = hit.summary ? (JSON.parse(hit.summary) as EventSummary) : undefined
    } catch {
      event = { hook: oneLine(hit.summary, 140) }
    }
    return { ...hit, event }
  })
}
