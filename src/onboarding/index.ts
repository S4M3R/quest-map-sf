// First-run onboarding: Karl the Fog introduces himself, tours the map, asks a few
// questions (→ store.setProfile) and hands off to the live voice agent.
// Owns only #onboarding; moves Karl via body classes (see onboarding.css).
import type { AdvisorController } from '../advisor'
import type { TripStore } from '../state/store'
import type { CameraTarget, MapController, StopCategory, TripProfile } from '../types'
import type { VoiceController } from '../voice'
import * as S from './script'
import './onboarding.css'

export interface OnboardingDeps {
  store: TripStore
  map: MapController
  advisor: AdvisorController
  voice: VoiceController
}

export interface OnboardingController {
  open(): void
  isDone(): boolean
}

const DONE_KEY = 'questmap.onboarded.v1'
const MUTE_KEY = 'questmap.karlMuted'
const TOTAL_STEPS = 11 // hello, tour, spots, 7 questions, finish

const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* private mode etc. */
  }
}

class Aborted extends Error {}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

const reducedMotion = () => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// ---------- speech (optional, never throws) ----------
const synth: SpeechSynthesis | null = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
const PREFERRED_VOICES = ['Aaron', 'Nathan', 'Evan', 'Google US English', 'Microsoft Guy', 'Microsoft Aria', 'Samantha', 'Alex']
let cachedVoice: SpeechSynthesisVoice | null | undefined
const pickVoice = (): SpeechSynthesisVoice | null => {
  if (cachedVoice !== undefined) return cachedVoice
  try {
    const all = synth?.getVoices() ?? []
    if (!all.length) return null // voices load async; try again next line
    const us = all.filter((v) => v.lang?.toLowerCase().replace('_', '-') === 'en-us')
    cachedVoice =
      PREFERRED_VOICES.map((n) => us.find((v) => v.name.includes(n))).find(Boolean) ??
      us.find((v) => v.localService) ??
      us[0] ??
      all.find((v) => v.lang?.startsWith('en')) ??
      null
  } catch {
    cachedVoice = null
  }
  return cachedVoice
}

/** returns a promise that resolves when the utterance ends (or quickly if speech is unavailable) */
const speak = (text: string): Promise<void> =>
  new Promise((resolve) => {
    if (!synth) return resolve()
    try {
      synth.cancel()
      const u = new SpeechSynthesisUtterance(text.replace(/\*/g, ''))
      const v = pickVoice()
      if (v) u.voice = v
      u.lang = v?.lang ?? 'en-US'
      u.rate = 1.05
      u.pitch = 0.92
      const t = setTimeout(resolve, 900 + text.length * 85) // safety: some engines never fire onend
      u.onend = u.onerror = () => {
        clearTimeout(t)
        resolve()
      }
      synth.speak(u)
    } catch {
      resolve()
    }
  })
const hush = () => {
  try {
    synth?.cancel()
  } catch {
    /* noop */
  }
}

// ---------- main ----------
export function mountOnboarding(container: HTMLElement, deps: OnboardingDeps): OnboardingController {
  const { store, map, advisor, voice } = deps
  const params = new URLSearchParams(location.search)
  let done = lsGet(DONE_KEY) === '1'
  if (params.has('skipintro')) done = true
  let muted = lsGet(MUTE_KEY) === '1'
  let audioUnlocked = false
  /** true while Karl's lines play through the live Vapi call (same voice as the agent) */
  let vapiMode = false
  /** the onboarding started the call itself (so skip/explore can hang it up) */
  let ownCall = false
  /** profile answers collected so far (voice via update_profile, or taps) */
  type Key = 'travelerName' | 'days' | 'pace' | 'interests' | 'company' | 'budget' | 'range'
  let answers: Partial<Record<Key, unknown>> = {}
  /** open question waiting for an answer — resolved by tap or by a voice update_profile */
  let pending: { key: Key; apply: (v: unknown) => void } | null = null
  /** a question was answered by voice: the model already reacted, so skip our scripted quip */
  let byVoice = false
  const force = (st: Parameters<AdvisorController['setState']>[0]) => advisor.setState(vapiMode ? null : st)

  container.innerHTML = ''
  container.classList.add('ob-host')

  // replay button
  const replay = h('button', 'ob-replay')
  replay.type = 'button'
  replay.title = 'Replay intro'
  replay.setAttribute('aria-label', 'Replay intro')
  replay.innerHTML = '<span class="ob-replay-q">?</span><span class="ob-replay-txt">Replay intro</span>'
  replay.addEventListener('click', () => open())

  // overlay
  const root = h('div', 'ob-root')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', 'Intro with Karl the Fog')
  const veil = h('div', 'ob-veil')
  const spot = h('div', 'ob-spot')
  const spotLabel = h('div', 'ob-spot-label')
  spot.append(spotLabel)

  const top = h('div', 'ob-top')
  const progress = h('div', 'ob-progress')
  const progressBar = h('i')
  progress.append(progressBar)
  const muteBtn = h('button', 'ob-iconbtn') as HTMLButtonElement
  muteBtn.type = 'button'
  const skipBtn = h('button', 'ob-skip', 'Skip intro') as HTMLButtonElement
  skipBtn.type = 'button'
  top.append(progress, muteBtn, skipBtn)

  const bubble = h('div', 'ob-bubble')
  const name = h('div', 'ob-name', 'Karl')
  const text = h('div', 'ob-text')
  text.setAttribute('aria-live', 'polite')
  const ctrl = h('div', 'ob-ctrl')
  bubble.append(name, text, ctrl)

  root.append(veil, spot, top, bubble)
  container.append(replay, root)

  const syncMute = () => {
    muteBtn.textContent = muted ? '🔇' : '🔊'
    muteBtn.title = muted ? 'Unmute Karl' : 'Mute Karl'
    muteBtn.setAttribute('aria-label', muteBtn.title)
    muteBtn.hidden = !synth && !vapiMode
  }
  syncMute()
  muteBtn.addEventListener('click', () => {
    muted = !muted
    lsSet(MUTE_KEY, muted ? '1' : '0')
    if (muted) hush()
    if (vapiMode) voice.setOutputVolume(muted ? 0 : 1)
    syncMute()
  })

  // ---------- run state ----------
  let isOpen = false
  let ctl: AbortController | null = null
  let toured = false
  let skipTyping: (() => void) | null = null
  let speechDone: Promise<void> = Promise.resolve()
  let finishTimer = 0

  const signal = () => ctl!.signal
  const check = () => {
    if (!ctl || ctl.signal.aborted) throw new Aborted()
  }
  /** race a promise against the current run's abort */
  const guard = <T>(p: Promise<T>): Promise<T> => {
    const s = signal()
    return new Promise<T>((resolve, reject) => {
      if (s.aborted) return reject(new Aborted())
      const onAbort = () => reject(new Aborted())
      s.addEventListener('abort', onAbort, { once: true })
      p.then(
        (v) => (s.removeEventListener('abort', onAbort), resolve(v)),
        (e) => (s.removeEventListener('abort', onAbort), reject(e)),
      )
    })
  }
  const wait = (ms: number) => guard(new Promise<void>((r) => setTimeout(r, ms)))
  const setStep = (n: number) => (progressBar.style.width = `${Math.round((n / TOTAL_STEPS) * 100)}%`)

  const safeFly = (t: CameraTarget): Promise<void> => {
    toured = true
    const fly = Promise.resolve()
      .then(() => Promise.race([map.ready, new Promise((r) => setTimeout(r, 2500))]))
      .then(() => map.flyTo(reducedMotion() ? { ...t, durationMs: 0 } : t))
      .catch(() => {})
    return Promise.race([fly, new Promise<void>((r) => setTimeout(r, (t.durationMs ?? 2500) + 2000))])
  }

  /** typewriter a line into the bubble; Karl speaks while typing */
  const say = async (line: string): Promise<void> => {
    check()
    ctrl.replaceChildren()
    text.replaceChildren()
    bubble.classList.remove('is-pop')
    void bubble.offsetWidth
    bubble.classList.add('is-pop')
    force('speaking')
    speechDone = vapiMode
      ? voice.say(line).catch(() => {
          // call dropped mid-intro → fall back to browser speech for the rest
          vapiMode = false
          syncMute()
          return audioUnlocked && !muted ? speak(line) : undefined
        })
      : audioUnlocked && !muted
        ? speak(line)
        : Promise.resolve()

    // parse *emphasis*
    const segs = line.split(/(\*[^*]+\*)/g).filter(Boolean).map((s) => (s.startsWith('*') && s.endsWith('*') ? { t: s.slice(1, -1), em: true } : { t: s, em: false }))
    const nodes = segs.map((s) => {
      const n = s.em ? h('em') : h('span')
      text.append(n)
      return { n, t: s.t }
    })
    let instant = reducedMotion()
    skipTyping = () => (instant = true)
    const perChar = 24
    for (const { n, t } of nodes) {
      for (let i = 1; i <= t.length; i++) {
        if (instant) break
        n.textContent = t.slice(0, i)
        await wait(t[i - 1] === ',' || t[i - 1] === '.' || t[i - 1] === '—' ? perChar * 5 : perChar)
      }
      n.textContent = t
    }
    skipTyping = null
    check()
  }

  /** after a narration line: wait for tap/Enter/"Next" or auto-advance once speech ends */
  const next = async (autoMs = 1400): Promise<void> => {
    check()
    force('listening')
    const btn = h('button', 'ob-next', 'Next →') as HTMLButtonElement
    btn.type = 'button'
    ctrl.replaceChildren(btn)
    await guard(
      new Promise<void>((resolve) => {
        let t = 0
        const go = () => {
          clearTimeout(t)
          resolve()
        }
        btn.addEventListener('click', go, { once: true })
        bubble.addEventListener('click', (e) => e.target === btn || go(), { once: true })
        void speechDone.then(() => (t = window.setTimeout(go, autoMs)))
        btn.focus({ preventScroll: true })
      }),
    )
  }

  /** chips; resolves with the chosen value(s) */
  const choose = <T>(opts: S.Opt<T>[], multi = false, key?: Key): Promise<T[]> => {
    check()
    force('listening')
    byVoice = false
    const row = h('div', 'ob-chips')
    const picked = new Set<T>()
    let done: HTMLButtonElement | null = null
    const p = new Promise<T[]>((resolve) => {
      opts.forEach((o, i) => {
        const b = h('button', 'ob-chip') as HTMLButtonElement
        b.type = 'button'
        b.style.setProperty('--i', String(i))
        if (o.emoji) b.append(h('span', 'ob-chip-emoji', o.emoji))
        b.append(h('span', '', o.label))
        b.append(h('kbd', '', String(i + 1)))
        if (multi) b.setAttribute('aria-pressed', 'false')
        b.addEventListener('click', () => {
          if (!multi) {
            b.classList.add('is-on')
            pending = null
            tellModel(key, o.value)
            return resolve([o.value])
          }
          const on = !picked.has(o.value)
          on ? picked.add(o.value) : picked.delete(o.value)
          b.classList.toggle('is-on', on)
          b.setAttribute('aria-pressed', String(on))
          if (on) advisor.react('poke')
          if (done) done.textContent = picked.size ? `Done (${picked.size}) →` : 'Anything goes →'
        })
        row.append(b)
      })
      if (multi) {
        done = h('button', 'ob-next', 'Anything goes →') as HTMLButtonElement
        done.type = 'button'
        done.addEventListener('click', () => {
          pending = null
          const vals = opts.map((o) => o.value).filter((v) => picked.has(v))
          tellModel(key, vals)
          resolve(vals)
        })
      }
      // voice answer (update_profile) → light up the matching chip(s) and advance as if tapped
      if (key)
        pending = {
          key,
          apply: (v) => {
            pending = null
            byVoice = true
            const vals = (Array.isArray(v) ? v : [v]) as T[]
            row.querySelectorAll<HTMLButtonElement>('.ob-chip').forEach((b, i) => {
              const on = vals.includes(opts[i].value)
              b.classList.toggle('is-on', on)
              if (multi) b.setAttribute('aria-pressed', String(on))
            })
            setTimeout(() => resolve(multi ? opts.map((o) => o.value).filter((x) => vals.includes(x)) : vals.slice(0, 1)), 650)
          },
        }
    })
    ctrl.replaceChildren(row, ...(done ? [done] : []))
    row.querySelector('button')?.focus({ preventScroll: true })
    return guard(p)
  }

  const askName = (): Promise<string | undefined> => {
    check()
    force('listening')
    byVoice = false
    const form = h('form', 'ob-form')
    const input = h('input', 'ob-input') as HTMLInputElement
    input.type = 'text'
    input.placeholder = 'Your name (optional)'
    input.maxLength = 40
    input.autocomplete = 'given-name'
    input.enterKeyHint = 'next'
    const ok = h('button', 'ob-next', 'That’s me →') as HTMLButtonElement
    ok.type = 'submit'
    const skip = h('button', 'ob-ghost', 'Skip') as HTMLButtonElement
    skip.type = 'button'
    form.append(input, ok, skip)
    ctrl.replaceChildren(form)
    setTimeout(() => input.focus({ preventScroll: true }), 30)
    return guard(
      new Promise<string | undefined>((resolve) => {
        form.addEventListener('submit', (e) => {
          e.preventDefault()
          pending = null
          const v = input.value.trim() || undefined
          if (v) tellModel('travelerName', v)
          resolve(v)
        })
        skip.addEventListener('click', () => {
          pending = null
          resolve(undefined)
        })
        pending = {
          key: 'travelerName',
          apply: (v) => {
            pending = null
            byVoice = true
            input.value = String(v)
            setTimeout(() => resolve(String(v)), 650)
          },
        }
      }),
    )
  }

  const answered = async (line: string) => {
    advisor.react('happy')
    // answered by voice: the live model already reacted in a few words — don't talk over it
    if (byVoice) return void (await wait(400))
    await say(line)
    await wait(audioUnlocked && !muted ? 0 : 650)
    await guard(Promise.race([speechDone, new Promise<void>((r) => setTimeout(r, 4000))]))
  }

  // ---------- spotlight ----------
  const targetRect = (sels: string[]): DOMRect | null => {
    for (const sel of sels) {
      const el = document.querySelector<HTMLElement>(sel)
      if (!el) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      // union of visible content boxes; full-screen layers (e.g. #polaroids) are descended into,
      // so an empty layer yields nothing and the spotlight is skipped
      const vp = innerWidth * innerHeight
      const collect = (n: Element, depth: number): DOMRect[] => {
        const r = n.getBoundingClientRect()
        if (r.width <= 8 || r.height <= 8) return depth < 3 ? Array.from(n.children).flatMap((c) => collect(c, depth + 1)) : []
        if (r.width * r.height < vp * 0.45) return [r]
        return depth < 3 ? Array.from(n.children).flatMap((c) => collect(c, depth + 1)) : []
      }
      const kids = Array.from(el.children)
      const rects = kids.length ? kids.flatMap((k) => collect(k, 1)) : collect(el, 0)
      if (!rects.length) continue
      const l = Math.min(...rects.map((r) => r.left))
      const t = Math.min(...rects.map((r) => r.top))
      const r = Math.max(...rects.map((r) => r.right))
      const b = Math.max(...rects.map((r) => r.bottom))
      if (r < 0 || b < 0 || l > innerWidth || t > innerHeight) continue
      return new DOMRect(l, t, r - l, b - t)
    }
    return null
  }
  const showSpot = (r: DOMRect, label: string) => {
    const pad = 10
    const x = Math.max(4, r.left - pad)
    const y = Math.max(4, r.top - pad)
    spot.style.left = `${x}px`
    spot.style.top = `${y}px`
    spot.style.width = `${Math.min(innerWidth - 8, r.right + pad) - x}px`
    spot.style.height = `${Math.min(innerHeight - 8, r.bottom + pad) - y}px`
    spotLabel.textContent = label
    spotLabel.classList.toggle('is-below', y < 60)
    root.classList.add('has-spot')
  }
  const hideSpot = () => root.classList.remove('has-spot')

  // ---------- voice answers (update_profile from the live model) ----------
  const has = (k: Key) => {
    const v = answers[k]
    return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)
  }
  const asArr = <T>(v: unknown): T[] => (Array.isArray(v) ? v : [v]) as T[]
  const tellModel = (key: Key | undefined, value: unknown) => {
    if (!key || !vapiMode || !voice.isLive()) return
    const v = key === 'range' ? S.RANGE_NOTE[value as 'city' | 'bay'] : Array.isArray(value) ? value.join(', ') || 'anything' : String(value)
    window.dispatchEvent(new CustomEvent('quest:voice-context', { detail: { content: `User answered on screen: ${key === 'range' ? 'notes' : key}=${v}`, triggerResponse: false } }))
  }
  window.addEventListener('quest:profile-updated', (e) => {
    if (!isOpen) return
    const patch = ((e as CustomEvent).detail?.patch ?? {}) as Partial<TripProfile>
    if (patch.travelerName) answers.travelerName = patch.travelerName
    if (patch.days) answers.days = Math.max(1, Math.min(5, patch.days))
    if (patch.pace) answers.pace = patch.pace
    if (patch.interests?.length) answers.interests = patch.interests.filter((c) => S.INTERESTS.some((o) => o.value === c))
    if (patch.company) answers.company = patch.company
    if (patch.budget) answers.budget = patch.budget
    if (patch.notes) {
      if (/day.?trip|bay|outside|beyond/i.test(patch.notes)) answers.range = 'bay'
      else if (/city|san francisco|\bsf\b|stay/i.test(patch.notes)) answers.range = 'city'
    }
    if (pending && has(pending.key)) pending.apply(answers[pending.key])
  })

  // ---------- flow ----------
  const run = async () => {
    // 0. invite (also unlocks audio on tap)
    setStep(0)
    await say(S.INVITE)
    const go = await choose([
      { value: 'go', label: 'Meet Karl', emoji: '☁️' },
      { value: 'skip', label: 'Skip intro' },
    ])
    if (go[0] === 'skip') return close('skip')
    audioUnlocked = true
    pickVoice()

    // same voice as the live agent: run the intro inside a Vapi call (this tap = user gesture → mic + audio unlock)
    answers = {}
    if (!voice.isActive()) {
      ownCall = true
      void voice.start({ onboarding: true }).catch(() => {})
      ctrl.replaceChildren()
      text.textContent = 'Summoning Karl…'
      force('listening')
      vapiMode = await guard(voice.whenLive(8000))
      if (!vapiMode) {
        // too slow / failed → fall back to browser speech, don't leave a half-open call around
        if (voice.isActive()) voice.stop()
        ownCall = false
      } else voice.setOutputVolume(muted ? 0 : 1)
      syncMute()
    }

    // 1. hello
    setStep(1)
    advisor.react('happy')
    await say(S.HELLO)
    await next()

    // 2. map tour
    setStep(2)
    root.classList.add('is-touring')
    for (const stop of S.TOUR) {
      const fly = safeFly(stop.cam)
      await say(stop.line)
      await guard(Promise.all([fly, speechDone]))
      await wait(500)
    }
    root.classList.remove('is-touring')

    // 3. spotlights
    setStep(3)
    for (const s of S.SPOTS) {
      const r = targetRect(s.sel)
      if (!r) continue
      showSpot(r, s.label)
      await say(s.line)
      await next(1700)
    }
    hideSpot()

    // 4. questions — any already answered by voice (even several at once) are skipped
    const ask = async <T>(step: number, key: Key, line: string, opts: S.Opt<T>[], quip: (v: T[]) => string, multi = false): Promise<T[]> => {
      check()
      if (has(key)) return asArr<T>(answers[key])
      setStep(step)
      await say(line)
      if (has(key)) return asArr<T>(answers[key])
      const v = await choose(opts, multi, key)
      answers[key] = multi ? v : v[0]
      if (step < 10) await answered(quip(v))
      else if (!byVoice) advisor.react('happy')
      return v
    }

    setStep(4)
    let travelerName = answers.travelerName as string | undefined
    if (!has('travelerName')) {
      await say(S.Q_NAME)
      if (has('travelerName')) {
        travelerName = answers.travelerName as string
        byVoice = true
      } else travelerName = await askName()
      if (travelerName) answers.travelerName = travelerName
      await answered(S.quip.name(travelerName))
    }

    const [days] = await ask(5, 'days', S.Q_DAYS, S.DAYS, (v) => S.quip.days(v[0]))
    const [pace] = await ask(6, 'pace', S.Q_PACE, S.PACE, (v) => S.quip.pace(v[0]))
    const interests = (await ask<StopCategory>(7, 'interests', S.Q_INTERESTS, S.INTERESTS, (v) => S.quip.interests(v), true)) as StopCategory[]
    const [company] = await ask(8, 'company', S.Q_COMPANY, S.COMPANY, (v) => S.quip.company(v[0]))
    const [range] = await ask(9, 'range', S.Q_RANGE, S.RANGE, (v) => S.quip.range(v[0]))
    const [budget] = await ask(10, 'budget', S.Q_BUDGET, S.BUDGET, () => '')

    // 5. finish
    setStep(11)
    const profile: TripProfile = { days, pace, interests, company, budget, notes: S.RANGE_NOTE[range], ...(travelerName ? { travelerName } : {}) }
    store.setProfile(profile)
    void safeFly(S.DEFAULT_VIEW)
    toured = false
    await say(byVoice ? S.FINISH : `${S.quip.budget(budget)} ${S.FINISH}`)
    force('listening')
    const card = h('div', 'ob-summary')
    card.append(h('div', 'ob-summary-k', travelerName ? `${travelerName}'s quest` : 'Your quest'), h('div', 'ob-summary-v', S.summarize(profile)))
    const startBtn = h('button', 'ob-next ob-cta', '🎙️ Start talking') as HTMLButtonElement
    startBtn.type = 'button'
    const later = h('button', 'ob-ghost', 'I’ll explore first') as HTMLButtonElement
    later.type = 'button'
    const row = h('div', 'ob-actions')
    row.append(startBtn, later)
    ctrl.replaceChildren(card, row)
    startBtn.focus({ preventScroll: true })
    const stage = document.querySelector<HTMLElement>('#advisor .adv-stage')
    const choice = await guard(
      new Promise<'talk' | 'later'>((resolve) => {
        startBtn.addEventListener('click', () => resolve('talk'))
        later.addEventListener('click', () => resolve('later'))
        stage?.addEventListener('click', () => resolve('talk'), { once: true, signal: signal() })
      }),
    )
    const live = vapiMode && voice.isLive()
    if (live && choice === 'talk') ownCall = false // keep the call: Karl takes over and starts planning
    close('done')
    if (choice === 'talk') {
      if (live) voice.endOnboarding(profile)
      else
        try {
          await voice.start()
        } catch (e) {
          console.warn('[onboarding] voice.start failed', e)
        }
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (!isOpen) return
    // the intro is modal: keep app-level shortcuts (Space → voice orb, 1-3 → options) from firing.
    // Default actions (typing, button activation) still happen.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      return close('skip')
    }
    const typing = (e.target as HTMLElement | null)?.tagName === 'INPUT'
    if (skipTyping && (e.key === 'Enter' || e.key === ' ') && !typing) {
      e.preventDefault()
      skipTyping()
      return
    }
    if (!typing && /^[1-9]$/.test(e.key)) {
      const chip = ctrl.querySelectorAll<HTMLButtonElement>('.ob-chip')[Number(e.key) - 1]
      if (chip) {
        e.preventDefault()
        chip.click()
      }
    }
  }

  bubble.addEventListener('click', (e) => {
    if (skipTyping && !(e.target as HTMLElement).closest('button,input')) skipTyping()
  })
  skipBtn.addEventListener('click', () => close('skip'))

  function close(mode: 'done' | 'skip') {
    if (!isOpen) return
    isOpen = false
    ctl?.abort()
    ctl = null
    hush()
    // skip / explore-first → hang up the intro call (honest skip: no half-onboarded agent left listening)
    if (ownCall && voice.isActive()) voice.stop()
    ownCall = false
    vapiMode = false
    pending = null
    hideSpot()
    window.removeEventListener('keydown', onKey, true)
    done = true
    lsSet(DONE_KEY, '1')
    advisor.setState(null)
    if (mode === 'skip') advisor.react('poof')
    if (toured) void safeFly(S.DEFAULT_VIEW)
    toured = false
    root.classList.remove('is-open', 'is-touring')
    document.body.classList.remove('ob-on')
    container.classList.remove('is-open')
    clearTimeout(finishTimer)
    finishTimer = window.setTimeout(() => document.body.classList.remove('ob-anim'), 1100)
  }

  function open() {
    if (isOpen) return
    isOpen = true
    clearTimeout(finishTimer)
    ctl = new AbortController()
    toured = false
    document.body.classList.add('ob-anim', 'ob-on')
    container.classList.add('is-open')
    root.classList.add('is-open')
    window.addEventListener('keydown', onKey, true)
    advisor.setState('listening')
    run().catch((e) => {
      if (!(e instanceof Aborted)) {
        console.warn('[onboarding] error', e)
        close('skip')
      }
    })
  }

  // speechSynthesis voices arrive async in Chrome
  try {
    synth?.addEventListener?.('voiceschanged', () => {
      cachedVoice = undefined
    })
  } catch {
    /* noop */
  }

  if (params.has('onboarding') || !done) setTimeout(open, 350)

  return { open, isDone: () => done }
}
