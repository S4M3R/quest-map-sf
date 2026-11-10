// Local API server (Hono on Node, :8787). Vite proxies /api/* here. Holds the Exa key.
// Routes live in ./app.ts (also deployed as a Vercel Function via api/index.ts).
import { serve } from '@hono/node-server'
import { app } from './app.js'
import { hasExa } from './exa.js'
import { hasMapbox } from './mapbox.js'

const PORT = Number(process.env.API_PORT ?? 8787)

process.on('unhandledRejection', (e) => console.error('[api] unhandledRejection:', e))
process.on('uncaughtException', (e) => console.error('[api] uncaughtException:', e))

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[api] listening on :${PORT}  (exa: ${hasExa() ? 'yes' : 'MISSING'}, mapbox: ${hasMapbox() ? 'yes' : 'MISSING'})`)
})
