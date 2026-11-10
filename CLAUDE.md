# Quest Map SF — Vapi Hackathon project

> Read this whole file before touching code. Several threads/agents work in this repo **at the same time, in the same checkout (branch `main`, no worktrees)**. Check "Ownership & coordination" before editing.

## 1. The event (drives every decision)
- **Side Quest Hotline Vapi Hackathon** by Build Club at Vapi HQ (150 Spear St, SF), **Mon Nov 9 2026, 5–9pm PST**.
- Build window 5:45–**7:15pm submission**, then live finalist demos + judging (criteria not published) → optimize for a **live, visual, reliable demo**.
- Theme: voice AI agents. Sponsors: **Vapi** (host), **Deepgram** (Switch 2 prize), **Exa** ($2k credits prize), Manus, TypeSafe/Jev, AdaL. We use Vapi + Deepgram (transcriber inside Vapi) + Exa.

## 2. The product
Browser app: stylized **3D map of the Bay Area** (starts on downtown SF) + **live voice agent "Karl the Fog"** (Vapi Web SDK). You talk to plan a multi-day trip ("side quests"); the map reacts live.

Features (status as of ~6:50pm):
| Feature | Status | Where |
|---|---|---|
| Mapbox 3D map, glowing numbered pins, animated route, light presets, building highlight, flyover tour | ✅ | `src/map/` |
| Voice: Vapi call, mic orb, captions, client-side tools | ✅ (no full live call verified yet!) | `src/voice/`, `src/tools/dispatcher.ts` |
| Karl the Fog 3D mascot (Three.js) reacting to voice/tool state | ✅ (built in another thread) | `src/advisor/` |
| Quest Log itinerary panel (day chips, photo thumbnails, profile line) | ✅ | `src/ui/itinerary.ts` |
| Instant-film photos per stop (Wikipedia → Exa → Mapbox satellite fallback), develop animation, scrapbook stack, "DAY N" stamp | ✅ | `src/ui/polaroid.ts`, `server/photo.ts` |
| Multi-day trips (per-day colors, routes, tour per day / all) | ✅ | everywhere |
| Bay Area scope (server search) | ✅ | `server/mapbox.ts`, `server/places.ts` |
| Bay Area in map/dispatcher/prompt (long legs fly zoomed-out, driving directions >5km) | ✅ | map, dispatcher, assistant |
| **Pick 1 of 3 options** (A/B/C ghost pins + cards, choose by voice, click, or keys 1/2/3) | ✅ wired | `show_options`/`choose_option`, `src/ui/options.ts`, `src/map/ghosts.ts` |
| **Pointing**: mouse/tap on map + "this area" → Karl knows where (hover ring+label, sweep=area, click=pin 20s, Alt-drag lasso) | ✅ wired | `src/pointer/`, `server/reverse.ts`, `get_pointer` |
| **Onboarding**: Karl intro, map showcase, questions → profile → start call | ✅ wired (copy/camera stops in `src/onboarding/script.ts`) | `src/onboarding/` |
| Debug panel `?debug=1` with Demo scripts (demo fallback if voice/Wi-Fi fails) | ✅ | `src/ui/debug.ts` |

Demo priority (cut from the bottom): 1) voice → add_stop → camera flies + pin + photo; 2) multi-day + flyover + night mode; 3) pick-1-of-3; 4) pointing; 5) onboarding (skippable on stage).

Ideas backlog (not started): QR share link of the trip (state in URL), "fog rolls in" on night mode, Exa "reading sources…" ticker, sponsor badges, outbound call/SMS "your quest for tomorrow".

## 3. Stack
- **Vite 8 + TypeScript 7 (vanilla, no framework)**, single page, `src/`.
- **mapbox-gl v3**, Standard style (`lightPreset` dawn/day/dusk/night via `setConfigProperty('basemap', …)`).
- **@vapi-ai/web v3** — transient assistant defined in code (`vapi.start(buildAssistant(state))`). ⚠ It's CJS: import must unwrap `.default` (see top of `src/voice/index.ts`) or you get "Vapi is not a constructor".
- Model `openai gpt-4.1-mini` (fast tool calls), transcriber **Deepgram nova-3**, voice Vapi `Elliot` (all in `src/voice/assistant.ts`).
- **three** for Karl.
- **Local API**: Hono on Node (`server/`, :8787) via `tsx watch` (auto-reloads server files). Vite proxies `/api/*`. Holds secrets. No public URL needed.
- **Exa** (`exa-js`) for live web info + photos; **Mapbox** Search Box / Geocoding v6 / Directions / Static Images.

## 4. Key architecture
### All Vapi tools are CLIENT-SIDE
Tools are declared `async: true` with no server URL → Vapi sends them to the browser as `message` events of type `tool-calls`. `src/voice/index.ts` runs them via `dispatcher.runTool(name, args)` and sends results back with
`vapi.send({ type: 'add-message', message: { role: 'system', content: 'Tool result for …' }, triggerResponseEnabled })` — trigger only when the model must react (search results, failures, user choices). There is no true tool-result channel from the browser.

### Single entry point for actions
`runTool(name, args)` (`src/tools/dispatcher.ts`) is used by voice, the debug panel, the options cards, etc. `main.ts` wraps it so Karl reacts (think → toolDone). Never call map/store from voice code directly.

### State
`TripStore` (`src/state/store.ts`), contracts in `src/types.ts` (**source of truth**):
- `stops: Stop[]` (each has `day`, optional `photoUrl`), `days: DayInfo[]`, `activeDay`, `profile: TripProfile | null` (onboarding answers), `lightPreset`, `activeStopId`, `touring`, `options: OptionSet | null` (pick-1-of-3), `pointer: PointerContext | null`.
- **The dispatcher owns trip mutations.** Allowed exceptions: itinerary day chips → `setActiveDay`; map → `setActive`/`setTouring`; polaroids → `updateStop(photoUrl)`; onboarding → `setProfile`; pointer → `setPointer`; dispatcher/options → `setOptions`/`updateOption`.
- Map auto-flies to newly added stops (dispatcher does NOT call focusStop after add_stop).

### Tools (names = contract between prompt, dispatcher and types)
`search_places {query, area?}` · `find_happenings {query, when?}` · `add_stop {name, query?, lat?, lng?, time?, note?, category?, url?, day?}` · `remove_stop {name}` · `reorder_stops {order[], day?}` · `focus_stop {name}` · `set_mood {lightPreset}` · `play_tour {day? | 'all'}` · `clear_trip {}` · `set_day {day, title?}` · `show_options {title, day?, options[3]}` · `choose_option {choice}` · `get_pointer {}`

### Window CustomEvents (cross-module bridge, avoids import tangles)
- `quest:focus-stop` {id} — polaroid click → map.focusStop (wired in main.ts)
- `quest:transcript` {role, text, final}, `quest:user-speaking` {speaking} — emitted by voice
- `quest:voice-context` {content, triggerResponse?} — anyone → voice injects a system message into the live call
- `quest:user-choice` {message} — options card click → voice
- `quest:hover-option` {label} — options card hover → map ghost pin highlight

### Server routes (`server/index.ts`)
`GET /api/health` · `POST /api/geocode {query}` · `POST /api/search-places {query, area?}` · `POST /api/happenings {query, when?}` (slow: 3–4s) · `POST /api/photo {name, lat, lng, url?}` · `POST /api/reverse {lat, lng, radiusM?}` (pointer labels).
Geo scope: bbox `-123.25,36.90 → -121.40,38.90` (Bay Area), proximity biased to SF; region nicknames (Marin, East Bay, South Bay, Peninsula, Napa, Sonoma…) in `server/places.ts` `REGION_CENTERS`.

## 5. Layout
```
index.html               mount points: #map #itinerary #voice #advisor #polaroids #options #onboarding #debug #toast
src/main.ts              wiring (lead)
src/types.ts             shared contracts (lead)
src/state/store.ts       TripStore (lead)
src/map/                 index.ts, markers.ts, route.ts, ghosts.ts (option pins), map.css
src/voice/               index.ts (Vapi client + orb + captions + event bridge), assistant.ts (Karl prompt + tool schemas)
src/tools/dispatcher.ts  runTool
src/advisor/             Karl the Fog (Three.js) — owned by the "Create a 3D Advisor Model" thread
src/onboarding/          first-run intro with Karl (mountOnboarding)
src/pointer/             mouse/tap pointing → PointerContext
src/ui/                  itinerary, polaroid, options (in progress), debug, toast
src/services/            api.ts (search/geocode/happenings), photo.ts
server/                  index.ts (routes), mapbox.ts, exa.ts, places.ts, happenings.ts, photo.ts, reverse.ts, util.ts
```

## 6. Running it
- Env in `.env` (gitignored; template `.env.example`): `VITE_MAPBOX_TOKEN` (pk.…), `VITE_VAPI_PUBLIC_KEY` (**public** key), `VAPI_PRIVATE_KEY` (server only — never prefix with VITE_), `EXA_API_KEY`. Never print values.
- Currently running (background, started by the lead thread):
  - **http://localhost:5174** — `npm run dev:static` (STATIC=1): **no auto-reload**, the human's view; refresh manually.
  - http://localhost:5173 — `vite` with HMR, for agents' browser testing.
  - API :8787 — `npm run dev:api` (tsx watch).
  - These run as background tasks of the lead thread with a 2h limit (restarted ~7:05pm). If one is down, check `lsof -i :5173 -i :5174 -i :8787` and restart just that one.
  - Don't start/stop running ones from other threads.
- `?debug=1` → test panel + "Demo script" buttons (demo fallback). `?onboarding=1` forces intro, `?skipintro` skips it.
- `npm run typecheck` (client + server) and `npx vite build` must pass before handing off. No test framework.
- Console handles: `window.store`, `map`, `dispatcher`, `advisor`.

## 6b. Deploy (Vercel)
- Live: **https://quest-map-sf.vercel.app** — project `quest-map-sf`, team **s4m3rs-projects** (linked in `.vercel/`).
- Redeploy: `npm run deploy` (= typecheck → `build:api` → `vercel deploy --prod --yes`).
- How the API runs there: `server/app.ts` (all Hono routes) is bundled by esbuild from `server/vercel.ts` into **`api/index.js`** (generated — rebuild with `npm run build:api` before every deploy, never hand-edit). `vercel.json` rewrites `/api/(.*)` → `/api`; Hono still sees the original `/api/...` path. Locally `server/index.ts` serves the same `app` on :8787.
- Vercel env (production + preview): `VITE_MAPBOX_TOKEN` (config/public), `VITE_VAPI_PUBLIC_KEY` (config/public), `EXA_API_KEY` (secret). VITE_* are baked in at build time → change them with `vercel env add … --force` then redeploy. `.vercelignore` keeps `.env*` out of uploads.

## 7. Ownership & coordination (multi-thread rules)
- **Lead thread** owns `src/types.ts`, `src/state/store.ts`, `src/main.ts`, `index.html`, `CLAUDE.md`, `vite.config.ts`, `package.json`. Other threads: propose contract changes, or make them minimal and additive (never rename/remove fields) and mention it.
- Karl (`src/advisor/**`) belongs to the "Create a 3D Advisor Model" thread.
- Before editing a file another agent may be working on: `git status` / check mtime, re-read it, make small targeted `Edit`s (no full rewrites of shared files).
- Nothing is committed yet (everything untracked on `main`). Commit only when the user asks.
- Hackathon speed: simple, working, demo-able > clever. Degrade gracefully: missing key → visible message, not a blank screen; geocode miss → agent says so.
- Keep latency low: short spoken replies (≤2 sentences), camera animations ~2–3s.

## 8. Known risks / to verify
- **No end-to-end live voice call verified yet** — first thing to test: assistant config accepted (model/voice ids), tool-calls arrive, add-message results make Karl respond without talking over himself.
- Wikipedia rate-limits bursts → photos fall back to Exa/Mapbox (fine at demo pace).
- `/api/happenings` is slow (3–4s); prompt tells Karl to say a filler line.
- On stage: Chrome, allow mic on localhost, use headphones/mic (avoid echo), have `?debug=1` Demo script ready.
