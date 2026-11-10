// Vercel Function entry (bundled to api/index.js by `npm run build:api`).
// vercel.json rewrites /api/* here; Hono routes on the original /api/... path.
import { app } from './app.js'

const handler = (req: Request) => app.fetch(req)
export const GET = handler
export const POST = handler
export const OPTIONS = handler
