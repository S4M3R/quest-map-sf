import './style.css'
import { createStore } from './state/store'
import { createMap } from './map'
import { createDispatcher } from './tools/dispatcher'
import { createVoice } from './voice'
import { mountItinerary } from './ui/itinerary'
import { mountPolaroids } from './ui/polaroid'
import { mountOptions } from './ui/options'
import { mountDebug } from './ui/debug'
import { toast } from './ui/toast'
import { mountAdvisor } from './advisor'
import { mountOnboarding } from './onboarding'
import { mountPointer } from './pointer'

const $ = (id: string) => document.getElementById(id)!

const store = createStore()
const map = createMap($('map'), store)
const dispatcher = createDispatcher({ store, map })

// Karl the Fog (3D advisor) — reacts to every tool call, from voice or the debug panel.
const advisor = mountAdvisor($('advisor'))
const runTool = dispatcher.runTool.bind(dispatcher)
dispatcher.runTool = (async (name, args) => {
  advisor.think()
  try {
    const r = await runTool(name, args)
    advisor.toolDone(name, r)
    return r
  } catch (e) {
    advisor.react('confused')
    throw e
  }
}) as typeof dispatcher.runTool

mountItinerary($('itinerary'), store, { onSelect: (id) => void map.focusStop(id) })
mountPolaroids($('polaroids'), store)
mountOptions($('options'), store, dispatcher) // dispatcher is the advisor-wrapped one
window.addEventListener('quest:focus-stop', (e) => void map.focusStop((e as CustomEvent<{ id: string }>).detail.id))
const voice = createVoice($('voice'), { dispatcher, store })
// Pointing: hover/tap/sweep on the map + "here / this area" → location context for Karl.
mountPointer($('map'), { store, map })

// First-run intro: Karl explains the app, tours the map, asks profile questions, then can start the call.
const onboarding = mountOnboarding($('onboarding'), { store, map, advisor, voice })

if (new URLSearchParams(location.search).has('debug')) mountDebug($('debug'), dispatcher)

if (!import.meta.env.VITE_MAPBOX_TOKEN) toast('Missing VITE_MAPBOX_TOKEN in .env', 'error', 10000)
if (!import.meta.env.VITE_VAPI_PUBLIC_KEY) toast('Missing VITE_VAPI_PUBLIC_KEY in .env — voice disabled, use ?debug=1', 'error', 10000)

// handy in the console during the demo
Object.assign(window, { store, map, dispatcher, advisor, voice, onboarding })
