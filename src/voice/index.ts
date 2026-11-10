// Voice layer (voice agent): Vapi web call + mic orb + live captions.
// Tool calls arrive as client `message` events (type 'tool-calls'), run through the
// dispatcher, and results are fed back to the model with `add-message`.
import VapiModule from '@vapi-ai/web'
// @vapi-ai/web is CJS (`exports.default = Vapi`); under Vite's interop the default import
// can be the module object instead of the class — unwrap it.
const Vapi = ((VapiModule as unknown as { default?: typeof VapiModule }).default ?? VapiModule) as typeof VapiModule
import type { Dispatcher } from '../tools/dispatcher'
import type { TripStore } from '../state/store'
import type { ToolArgs, ToolName, ToolResult, TripProfile } from '../types'
import { toast } from '../ui/toast'
import { buildAssistant, profileBlock } from './assistant'
import './voice.css'

export interface VoiceController {
  /** onboarding: same assistant (all tools), but it waits silently while the app speaks scripted lines via say() */
  start(opts?: { onboarding?: boolean }): Promise<void>
  stop(): void
  /** connecting or live */
  isActive(): boolean
  /** call connected right now */
  isLive(): boolean
  /** speak a scripted line in Karl's Vapi voice; resolves when it finished playing. Rejects if no live call. */
  say(text: string): Promise<void>
  /** true once the call is live (immediately if already), false on timeout / call end */
  whenLive(timeoutMs: number): Promise<boolean>
  /** tell the model onboarding is over (with the profile) and let it start planning */
  endOnboarding(profile: TripProfile | null): void
  /** assistant playback volume 0..1 (remembered across calls) */
  setOutputVolume(v: number): void
}

type Phase = 'idle' | 'connecting' | 'live' | 'speaking' | 'disabled'

interface ParsedCall {
  id: string
  name: string
  args: Record<string, unknown>
}

const ORDERED_TOOLS = new Set(['add_stop', 'remove_stop', 'reorder_stops', 'clear_trip', 'set_day', 'show_options', 'choose_option'])

const TOOL_LABEL: Partial<Record<ToolName, (a: Record<string, unknown>) => string>> = {
  search_places: (a) => `Scouting ${a.query ?? 'places'}`,
  find_happenings: (a) => `Checking what's on${a.when ? ` ${a.when}` : ''}`,
  add_stop: (a) => `Checkpoint: ${a.name ?? 'new stop'}`,
  remove_stop: (a) => `Dropping ${a.name ?? 'stop'}`,
  reorder_stops: () => 'Reshuffling the route',
  focus_stop: (a) => `Flying to ${a.name ?? 'stop'}`,
  set_mood: (a) => `Lighting: ${a.lightPreset ?? ''}`,
  play_tour: () => 'Drone flyover',
  clear_trip: () => 'New quest',
  set_day: (a) => `Day ${a.day ?? ''}${a.title ? ` · ${a.title}` : ''}`,
  show_options: (a) => String(a.title ?? 'Three options'),
  choose_option: (a) => `Picked ${a.choice ?? ''}`,
  get_pointer: () => 'Looking where you point',
  update_profile: () => 'Noted',
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const v = JSON.parse(raw)
      return v && typeof v === 'object' ? v : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** Accepts every shape Vapi has used: toolCallList, toolWithToolCallList[].toolCall, toolCalls. */
function extractToolCalls(msg: any): ParsedCall[] {
  const raw: any[] =
    (Array.isArray(msg?.toolCallList) && msg.toolCallList.length && msg.toolCallList) ||
    (Array.isArray(msg?.toolWithToolCallList) && msg.toolWithToolCallList.map((t: any) => t?.toolCall).filter(Boolean)) ||
    (Array.isArray(msg?.toolCalls) && msg.toolCalls) ||
    []
  return raw
    .map((c: any, i: number) => ({
      id: String(c?.id ?? c?.toolCallId ?? `${Date.now()}-${i}`),
      name: String(c?.function?.name ?? c?.name ?? ''),
      args: parseArgs(c?.function?.arguments ?? c?.arguments ?? c?.parameters),
    }))
    .filter((c) => c.name)
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

const MIC_SVG = `<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path fill="currentColor" d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 1 0-7 0v6A3.5 3.5 0 0 0 12 15Zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.59a6 6 0 0 0 5-5.91Z"/></svg>`
const STOP_SVG = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="3" fill="currentColor"/></svg>`

export function createVoice(container: HTMLElement, deps: { dispatcher: Dispatcher; store: TripStore }): VoiceController {
  const { dispatcher, store } = deps
  const key = import.meta.env.VITE_VAPI_PUBLIC_KEY as string | undefined

  // ---------- DOM ----------
  container.innerHTML = ''
  const root = el('div', 'qv')
  const captions = el('div', 'qv-captions')
  captions.setAttribute('aria-live', 'polite')
  const capUser = el('div', 'qv-cap qv-cap-user')
  const capBot = el('div', 'qv-cap qv-cap-bot')
  const toolChip = el('div', 'qv-chip')
  captions.append(toolChip, capUser, capBot)

  const orbWrap = el('div', 'qv-orb-wrap')
  const halo = el('div', 'qv-halo')
  const ring = el('div', 'qv-ring')
  const orb = el('button', 'qv-orb') as HTMLButtonElement
  orb.type = 'button'
  const icon = el('span', 'qv-icon')
  icon.innerHTML = MIC_SVG
  orb.append(icon)
  orbWrap.append(halo, ring, orb)
  const label = el('div', 'qv-label')
  root.append(captions, orbWrap, label)
  container.append(root)

  // ---------- state ----------
  let phase: Phase = 'idle'
  let vapi: VapiModule | null = null
  let callActive = false
  const seen = new Set<string>()
  let toolQueue: Promise<void> = Promise.resolve()

  const LABELS: Record<Phase, string> = {
    idle: 'Tap to start your quest · Space',
    connecting: 'Summoning Karl…',
    live: 'Listening…',
    speaking: 'Karl the Fog',
    disabled: 'Voice off — set VITE_VAPI_PUBLIC_KEY',
  }
  const setPhase = (p: Phase) => {
    phase = p
    root.dataset.phase = p
    label.textContent = LABELS[p]
    const active = p === 'live' || p === 'speaking' || p === 'connecting'
    icon.innerHTML = active ? STOP_SVG : MIC_SVG
    orb.setAttribute('aria-label', active ? 'End voice call' : 'Start voice call')
    orb.setAttribute('aria-pressed', String(active))
    if (!active) setLevel(0)
  }

  // volume → glow. Smoothed via rAF to avoid jitter.
  let target = 0
  let level = 0
  let raf = 0
  const setLevel = (v: number) => {
    target = Math.max(0, Math.min(1, v || 0))
    if (!raf) raf = requestAnimationFrame(tick)
  }
  const tick = () => {
    level += (target - level) * (target > level ? 0.45 : 0.12)
    root.style.setProperty('--lvl', level.toFixed(3))
    if (Math.abs(target - level) > 0.004) raf = requestAnimationFrame(tick)
    else {
      level = target
      root.style.setProperty('--lvl', level.toFixed(3))
      raf = 0
    }
  }

  // captions with fade-out
  const fadeTimers = new WeakMap<HTMLElement, number>()
  const show = (node: HTMLElement, text: string, partial: boolean, ms = 4500) => {
    node.textContent = text
    node.classList.toggle('is-partial', partial)
    node.classList.add('is-visible')
    window.clearTimeout(fadeTimers.get(node))
    fadeTimers.set(node, window.setTimeout(() => node.classList.remove('is-visible'), ms))
  }
  const clearCaptions = () => [capUser, capBot, toolChip].forEach((n) => n.classList.remove('is-visible'))

  // assistant transcript accumulates within a turn: finals are appended, partial shown after them
  let botFinal = ''
  const resetBotTurn = () => (botFinal = '')

  // ---------- tool calls ----------
  const sendResults = (lines: string[], trigger: boolean) => {
    if (!vapi || !callActive || !lines.length) return
    try {
      vapi.send({ type: 'add-message', message: { role: 'system', content: lines.join('\n') }, triggerResponseEnabled: trigger })
    } catch (e) {
      console.warn('[voice] add-message failed', e)
    }
  }

  const formatResult = (call: ParsedCall, r: ToolResult) => {
    const payload: Record<string, unknown> = { ok: r.ok, message: r.message }
    if (r.data !== undefined && r.needsResponse) payload.data = r.data
    return `Tool result for ${call.name}: ${JSON.stringify(payload)}`
  }

  const handleToolCalls = (calls: ParsedCall[]) => {
    const fresh = calls.filter((c) => !seen.has(c.id))
    fresh.forEach((c) => seen.add(c.id))
    if (!fresh.length) return

    // Map mutations run sequentially (order matters for the route); lookups run in parallel.
    const ordered = fresh.filter((c) => ORDERED_TOOLS.has(c.name))
    const parallel = fresh.filter((c) => !ORDERED_TOOLS.has(c.name))

    const run = async (c: ParsedCall): Promise<[ParsedCall, ToolResult]> => {
      const lbl = TOOL_LABEL[c.name as ToolName]?.(c.args)
      if (lbl) show(toolChip, lbl, false, 3000)
      const r = await dispatcher.runTool(c.name as ToolName, c.args as ToolArgs[ToolName])
      if (!r.ok) console.warn('[voice] tool failed', c.name, r.message)
      return [c, r]
    }

    const job = async () => {
      const results: [ParsedCall, ToolResult][] = []
      const par = Promise.all(parallel.map(run))
      for (const c of ordered) results.push(await run(c))
      results.push(...(await par))
      const trigger = results.some(([, r]) => r.needsResponse)
      sendResults(results.map(([c, r]) => formatResult(c, r)), trigger)
    }
    toolQueue = toolQueue.then(job, job).catch((e) => console.error('[voice] tool job', e))
  }

  // ---------- assistant speech tracking (for say() completion) ----------
  let botSpeaking = false
  const speechWaiters = new Set<(ev: 'start' | 'end' | 'callend') => void>()
  const botSpeech = (on: boolean) => {
    if (on === botSpeaking) return
    botSpeaking = on
    speechWaiters.forEach((f) => f(on ? 'start' : 'end'))
  }
  const liveWaiters = new Set<(live: boolean) => void>()

  // ---------- window event bridge (pointer / options UI ↔ voice model) ----------
  let userSpeaking = false
  function emitUserSpeaking(speaking: boolean) {
    if (speaking === userSpeaking) return
    userSpeaking = speaking
    window.dispatchEvent(new CustomEvent('quest:user-speaking', { detail: { speaking } }))
  }
  const injectSystem = (content: string, trigger: boolean) => {
    if (!vapi || !callActive || !content) return
    try {
      vapi.send({ type: 'add-message', message: { role: 'system', content }, triggerResponseEnabled: trigger })
    } catch (e) {
      console.warn('[voice] add-message failed', e)
    }
  }
  // generic: { content, triggerResponse? }
  window.addEventListener('quest:voice-context', (e) => {
    const d = (e as CustomEvent<{ content?: string; triggerResponse?: boolean }>).detail
    if (d?.content) injectSystem(String(d.content), !!d.triggerResponse)
  })
  // options chooser: user tapped a card / "none of these" → the model reacts
  window.addEventListener('quest:user-choice', (e) => {
    const d = (e as CustomEvent<{ message?: string }>).detail
    if (d?.message) injectSystem(String(d.message), true)
  })

  // ---------- Vapi ----------
  const handleMessage = (msg: any) => {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'tool-calls':
        handleToolCalls(extractToolCalls(msg))
        break
      case 'transcript':
      case "transcript[transcriptType='final']": {
        const text = String(msg.transcript ?? '').trim()
        if (!text) break
        const partial = msg.transcriptType === 'partial'
        const role = msg.role === 'user' ? 'user' : 'assistant'
        window.dispatchEvent(new CustomEvent('quest:transcript', { detail: { role, text, final: !partial } }))
        // user transcript is a proxy for "user is speaking" (partial → talking, final → done)
        if (role === 'user') emitUserSpeaking(partial)
        if (msg.role === 'user') {
          show(capUser, text, partial)
        } else {
          if (!partial) botFinal = (botFinal ? botFinal + ' ' : '') + text
          show(capBot, partial ? (botFinal ? botFinal + ' ' : '') + text : botFinal, partial, 6000)
        }
        break
      }
      case 'speech-update':
        if (msg.role === 'user') emitUserSpeaking(msg.status === 'started')
        if (msg.role === 'assistant') {
          botSpeech(msg.status === 'started')
          if (msg.status === 'started') {
            resetBotTurn()
            if (callActive) setPhase('speaking')
          } else if (callActive) setPhase('live')
        }
        break
      case 'user-interrupted':
        resetBotTurn()
        if (callActive) setPhase('live')
        break
      case 'status-update':
        if (msg.status === 'ended') console.info('[voice] call ended:', msg.endedReason)
        break
    }
  }

  const onEnd = () => {
    callActive = false
    botSpeaking = false
    speechWaiters.forEach((f) => f('callend'))
    liveWaiters.forEach((f) => f(false))
    emitUserSpeaking(false)
    seen.clear()
    resetBotTurn()
    setPhase(key ? 'idle' : 'disabled')
    window.setTimeout(clearCaptions, 1500)
  }

  const describeError = (e: any): string => {
    const type = String(e?.type ?? '')
    const inner = e?.error ?? e
    const name = String(inner?.name ?? '')
    const msg = String(inner?.message ?? inner?.error?.message ?? inner?.errorMsg ?? (typeof inner === 'string' ? inner : '') ?? '')
    if (/NotAllowed|Permission/i.test(type + name + msg)) return 'Microphone blocked — allow mic access in the address bar and try again.'
    if (/NotFound|NotReadable/i.test(type + name + msg)) return 'No working microphone found.'
    if (/401|403|unauthori|invalid key|public key/i.test(msg)) return 'Vapi rejected the key — check VITE_VAPI_PUBLIC_KEY.'
    if (/400/.test(msg)) return `Vapi rejected the assistant config: ${msg.slice(0, 140)}`
    return `Voice error: ${(msg || type || 'unknown').slice(0, 140)}`
  }

  if (key) {
    try {
      vapi = new Vapi(key)
      vapi.on('call-start', () => {
        callActive = true
        setPhase('live')
        liveWaiters.forEach((f) => f(true))
      })
      vapi.on('call-end', onEnd)
      vapi.on('speech-start', () => {
        botSpeech(true)
        if (callActive) setPhase('speaking')
      })
      vapi.on('speech-end', () => {
        botSpeech(false)
        if (callActive) setPhase('live')
      })
      vapi.on('volume-level', (v) => setLevel(v))
      vapi.on('message', handleMessage)
      vapi.on('error', (e) => {
        console.error('[voice] error', e)
        // audio processing / observer errors are non-fatal; don't spam the user
        if (/audio-observer|audio-processor|local-audio-level/.test(String(e?.type ?? ''))) return
        toast(describeError(e), 'error', 7000)
        if (!callActive) onEnd()
      })
    } catch (e) {
      console.error('[voice] init failed', e)
      vapi = null
      toast('Voice failed to initialise — use ?debug=1', 'error', 8000)
    }
  }

  if (!vapi) {
    orb.disabled = true
    orb.title = key ? 'Voice failed to initialise' : 'Missing VITE_VAPI_PUBLIC_KEY in .env'
    setPhase('disabled')
  } else {
    setPhase('idle')
  }

  const start = async (opts?: { onboarding?: boolean }) => {
    if (!vapi || phase !== 'idle') return
    setPhase('connecting')
    clearCaptions()
    seen.clear()
    try {
      const call = await vapi.start(buildAssistant(store.get(), new Date(), { onboarding: !!opts?.onboarding }))
      // start() resolves null on failure (and emits 'error'); also null if already started
      if (!call && !callActive) onEnd()
    } catch (e) {
      console.error('[voice] start failed', e)
      toast(describeError(e), 'error', 7000)
      onEnd()
    }
  }

  const stop = () => {
    if (!vapi) return
    try {
      void vapi.stop()
    } catch (e) {
      console.warn('[voice] stop', e)
    }
    onEnd()
  }

  orb.addEventListener('click', () => {
    if (phase === 'idle') void start()
    else if (phase !== 'disabled') stop()
  })

  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' || ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return
    const t = ev.target as HTMLElement | null
    if (t && (t.closest('input, textarea, select, button, [contenteditable=""], [contenteditable="true"]') || t.isContentEditable)) return
    ev.preventDefault()
    orb.click()
  })

  /** wait for the next assistant speech event (or timeout) */
  const nextSpeech = (ms: number) =>
    new Promise<'start' | 'end' | 'callend' | 'timeout'>((resolve) => {
      const f = (ev: 'start' | 'end' | 'callend') => fin(ev)
      const t = window.setTimeout(() => fin('timeout'), ms)
      const fin = (ev: 'start' | 'end' | 'callend' | 'timeout') => {
        clearTimeout(t)
        speechWaiters.delete(f)
        resolve(ev)
      }
      speechWaiters.add(f)
    })

  const say = async (text: string): Promise<void> => {
    const line = text.replace(/\*/g, '').trim()
    if (!vapi || !callActive) throw new Error('no live call')
    if (!line) return
    // let a model reaction finish instead of talking over it
    if (botSpeaking) await nextSpeech(5000)
    if (!vapi || !callActive) throw new Error('no live call')
    vapi.say(line, false, false, false)
    const words = line.split(/\s+/).length
    const deadline = performance.now() + Math.max(2500, words * 420) + 2500
    // wait for our line to start (TTS latency), then for it to end
    let started = botSpeaking
    while (performance.now() < deadline) {
      const ev = await nextSpeech(started ? deadline - performance.now() : Math.min(4500, deadline - performance.now()))
      if (ev === 'callend') return
      if (ev === 'start') started = true
      else if (ev === 'end' && started) break
      else if (ev === 'timeout' && !started) break // audio never started: don't hang the intro
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  const whenLive = (timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      if (callActive) return resolve(true)
      if (phase !== 'connecting') return resolve(false)
      const f = (live: boolean) => fin(live)
      const t = window.setTimeout(() => fin(false), timeoutMs)
      const fin = (live: boolean) => {
        clearTimeout(t)
        liveWaiters.delete(f)
        resolve(live)
      }
      liveWaiters.add(f)
    })

  const endOnboarding = (profile: TripProfile | null) => {
    try {
      vapi?.setVolume(1)
    } catch {
      /* noop */
    }
    injectSystem(
      `ONBOARDING COMPLETE. Onboarding mode is over: tools are allowed again and normal rules apply.\n${profileBlock(profile)}\n` +
        (profile
          ? `Now greet the user${profile.travelerName ? ` (${profile.travelerName})` : ''} by name in one short sentence and start planning Day 1 (call set_day 1 first).`
          : 'Now greet the user in one short sentence and ask how many days they have and what they love.'),
      true,
    )
  }

  const setOutputVolume = (v: number) => {
    try {
      vapi?.setVolume(v)
    } catch (e) {
      console.warn('[voice] setVolume', e)
    }
  }

  return {
    start,
    stop,
    isActive: () => callActive || phase === 'connecting',
    isLive: () => callActive,
    say,
    whenLive,
    endOnboarding,
    setOutputVolume,
  }
}
