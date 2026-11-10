// Advisor: Karl the Fog, a 3D mascot that mirrors the voice agent.
// It reads the voice widget's DOM state (data-phase, --lvl, caption classes), so it needs
// no changes to src/voice. Tool activity comes in through think()/toolDone(), which main.ts wires.
import * as THREE from 'three'
import type { ToolName, ToolResult } from '../types'
import { createKarl, type AdvisorState, type Reaction } from './karl'
import './advisor.css'

export type { AdvisorState, Reaction }

export interface AdvisorController {
  /** force a state (demo / console); pass null to go back to following the voice call */
  setState(s: AdvisorState | null): void
  react(r: Reaction): void
  /** show the thinking pose for up to `ms` (cleared as soon as the agent speaks) */
  think(ms?: number): void
  /** react to a finished tool call */
  toolDone(name: ToolName, r: ToolResult): void
  state(): AdvisorState
}

const LABEL: Record<AdvisorState, string> = {
  sleeping: 'napping',
  waking: 'waking up…',
  listening: 'listening',
  thinking: 'thinking…',
  speaking: 'talking',
}

export function mountAdvisor(container: HTMLElement, opts: { voiceSelector?: string; awakeWhenIdle?: boolean } = {}): AdvisorController {
  const voiceSel = opts.voiceSelector ?? '#voice .qv'

  container.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'adv'
  const stage = document.createElement('div')
  stage.className = 'adv-stage'
  stage.title = 'Karl the Fog'
  const tag = document.createElement('div')
  tag.className = 'adv-tag'
  tag.innerHTML = '<b>Karl</b><span></span>'
  const tagState = tag.querySelector('span')!
  wrap.append(stage, tag)
  container.append(wrap)

  // ---- three ----
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  } catch (e) {
    console.warn('[advisor] WebGL unavailable', e)
    container.style.display = 'none'
    const noop = () => {}
    return { setState: noop, react: noop, think: noop, toolDone: noop, state: () => 'sleeping' }
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  stage.append(renderer.domElement)

  const scene = new THREE.Scene()
  const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 50)
  cam.position.set(0.9, 0.55, 5.2)
  cam.lookAt(0, 0.22, 0)
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2d4a, 1.7))
  const key = new THREE.DirectionalLight(0xffffff, 2.2)
  key.position.set(2, 3, 4)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0xff9a6a, 1.3)
  rim.position.set(-3, 1, -2)
  scene.add(rim)

  const karl = createKarl()
  scene.add(karl.group)

  const resize = () => {
    const w = stage.clientWidth
    const h = stage.clientHeight
    if (!w || !h) return
    renderer.setSize(w, h, false)
    cam.aspect = w / h
    cam.updateProjectionMatrix()
  }
  new ResizeObserver(resize).observe(stage)
  resize()

  // ---- derive state from the voice widget ----
  let forced: AdvisorState | null = null
  let thinkingUntil = 0
  let voiceRoot: HTMLElement | null = null
  let lastUserText = ''

  const watchVoice = (root: HTMLElement) => {
    const cap = root.querySelector<HTMLElement>('.qv-cap-user')
    if (!cap) return
    new MutationObserver(() => {
      const text = cap.textContent ?? ''
      if (cap.classList.contains('is-partial')) thinkingUntil = 0 // user still talking
      else if (text && text !== lastUserText && cap.classList.contains('is-visible')) {
        lastUserText = text
        thinkingUntil = performance.now() + 6000 // user finished a sentence → Karl ponders
      }
    }).observe(cap, { attributes: true, attributeFilter: ['class'], childList: true, characterData: true, subtree: true })
  }

  const readVoice = (): { phase: string; level: number } => {
    if (!voiceRoot || !voiceRoot.isConnected) {
      voiceRoot = document.querySelector<HTMLElement>(voiceSel)
      if (voiceRoot) watchVoice(voiceRoot)
    }
    if (!voiceRoot) return { phase: 'disabled', level: 0 }
    return {
      phase: voiceRoot.dataset.phase ?? 'idle',
      level: parseFloat(voiceRoot.style.getPropertyValue('--lvl')) || 0,
    }
  }

  const awakeIdle = opts.awakeWhenIdle ?? new URLSearchParams(location.search).has('debug')
  let current: AdvisorState = 'sleeping'

  const derive = (phase: string, now: number): AdvisorState => {
    if (forced) return forced
    if (phase === 'speaking') {
      thinkingUntil = 0
      return 'speaking'
    }
    if (thinkingUntil > now) return 'thinking'
    if (phase === 'connecting') return 'waking'
    if (phase === 'live') return 'listening'
    return awakeIdle ? 'listening' : 'sleeping'
  }

  // ---- loop ----
  const clock = new THREE.Clock()
  let elapsed = 0
  const frame = () => {
    const dt = clock.getDelta()
    elapsed += dt
    const { phase, level } = readVoice()
    const s = derive(phase, performance.now())
    if (s !== current) {
      current = s
      wrap.dataset.state = s
      tagState.textContent = LABEL[s]
    }
    karl.update(dt, elapsed, { state: s, level })
    renderer.render(scene, cam)
    requestAnimationFrame(frame)
  }
  wrap.dataset.state = current
  tagState.textContent = LABEL[current]
  requestAnimationFrame(frame)

  stage.addEventListener('click', () => karl.react('poke'))

  return {
    setState: (s) => (forced = s),
    react: (r) => karl.react(r),
    think: (ms = 8000) => (thinkingUntil = Math.max(thinkingUntil, performance.now() + ms)),
    toolDone(name, r) {
      if (!r.needsResponse) thinkingUntil = 0
      if (!r.ok) return karl.react('confused')
      if (name === 'add_stop' || name === 'play_tour' || name === 'reorder_stops') karl.react('happy')
      else if (name === 'clear_trip') karl.react('poof')
      else if (name === 'set_mood' || name === 'remove_stop') karl.react('poke')
    },
    state: () => current,
  }
}
