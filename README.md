<img src="assets/icon.svg" width="64" height="64" alt="">

# Quest Map SF

**Plan a Bay Area trip by talking to the fog.** Karl the Fog, a voice agent, plans multi-day "side quests" with you while a 3D map of San Francisco and the Bay reacts live. Places fly into view, pins drop, routes draw, and instant photos of each stop develop on screen.

**Live:** https://quest-map-sf.vercel.app (add `?debug=1` for the demo panel)

Built at the **Side Quest Hotline Vapi Hackathon** (Build Club × Vapi, SF, Nov 9 2026).

## What it does
- **Talk to plan.** Say *"2 days, food and views"* and Karl adds stops one at a time. The camera flies to each place, the building lights up, and a glowing route connects the stops.
- **Instant photos.** Every stop gets a photo that develops on screen (Wikipedia, then Exa, then a Mapbox satellite view as fallback).
- **Multiple days.** Each day has its own color, route and tabs. Ask for a flyover of one day or the whole trip.
- **Pick 1 of 3.** Karl shows three options as cards and A/B/C pins on the map; choose by voice or by clicking.
- **Point and talk.** Hover, tap or sweep the map and say *"what's good around here?"* Karl gets the place you're pointing at.
- **Whole Bay Area.** SF is home base, and day trips to Marin, Oakland, Napa, Palo Alto and other places work too.
- **Voice onboarding.** Karl introduces himself, tours the map and asks a few questions (answer by voice or by tapping).
- **Live info from Exa.** Searches for places and for what's happening tonight.

## Stack
- **Vapi** Web SDK: browser voice call, with **Deepgram** nova-3 for speech-to-text. All tools run in the browser.
- **Exa**: live web search, event lookups and photos.
- **Mapbox GL v3**: Standard style with lighting presets, 3D buildings, Search Box and Geocoding, Directions, and Static Images.
- **Three.js**: Karl the Fog, the 3D mascot.
- Vite and TypeScript (vanilla). The API is Hono, running locally on Node and on Vercel as a Function.

## Run locally
```bash
cp .env.example .env   # add VITE_MAPBOX_TOKEN, VITE_VAPI_PUBLIC_KEY, EXA_API_KEY
npm install
npm run dev            # web on :5173 + API on :8787
```
`?debug=1` shows a test panel with scripted demos. `?onboarding=1` replays the intro. `?skipintro` skips it.

## Deploy
`npm run deploy` runs typecheck, bundles the API into `api/index.js`, then runs `vercel deploy --prod`.

Architecture notes are in [CLAUDE.md](CLAUDE.md).
