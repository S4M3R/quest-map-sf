// Karl the Fog — procedural Three.js advisor character.
// Pure scene graph + animation; no DOM. `update()` is driven by the advisor controller.
import * as THREE from 'three'

export type AdvisorState = 'sleeping' | 'waking' | 'listening' | 'thinking' | 'speaking'
export type Reaction = 'happy' | 'confused' | 'poke' | 'poof'

export interface KarlInput {
  state: AdvisorState
  /** assistant voice level 0..1 (only meaningful while speaking) */
  level: number
}

export interface Karl {
  group: THREE.Group
  update(dt: number, t: number, input: KarlInput): void
  react(r: Reaction): void
}

// ---------- materials / helpers ----------
const toon = (color: number, extra: THREE.MeshToonMaterialParameters = {}) => new THREE.MeshToonMaterial({ color, ...extra })
const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat)
  m.position.set(x, y, z)
  return m
}
const damp = (cur: number, tgt: number, k: number, dt: number) => cur + (tgt - cur) * (1 - Math.exp(-k * dt))
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

function canvasSprite(draw: (ctx: CanvasRenderingContext2D, s: number) => void, size = 128) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  draw(c.getContext('2d')!, size)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
  sp.material.opacity = 0
  return sp
}
const glyph = (text: string, fill: string) =>
  canvasSprite((ctx, s) => {
    ctx.font = `900 ${s * 0.78}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = s * 0.09
    ctx.strokeStyle = 'rgba(20,18,40,0.85)'
    ctx.strokeText(text, s / 2, s / 2 + s * 0.04)
    ctx.fillStyle = fill
    ctx.fillText(text, s / 2, s / 2 + s * 0.04)
  })
const star = (fill: string) =>
  canvasSprite((ctx, s) => {
    const c = s / 2
    ctx.fillStyle = fill
    ctx.shadowColor = fill
    ctx.shadowBlur = s * 0.12
    ctx.beginPath()
    for (let i = 0; i < 8; i++) {
      const r = i % 2 ? s * 0.11 : s * 0.42
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2
      ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r)
    }
    ctx.fill()
  })

// ---------- per-state pose targets ----------
interface Pose {
  eyeOpen: number // eye height scale; < .15 shows closed arcs
  lookX: number
  lookY: number
  lean: number // rotation.x (+ = toward camera)
  tilt: number // rotation.z
  bob: number
  bobSpeed: number
  wispR: number
  wispSpeed: number
  wispY: number
  glow: number
  grey: number
  ripple: number
  think: number
  zzz: number
}
const POSES: Record<AdvisorState, Pose> = {
  sleeping: { eyeOpen: 0, lookX: 0, lookY: -0.2, lean: 0.14, tilt: 0.12, bob: 0.035, bobSpeed: 0.7, wispR: 0.95, wispSpeed: 0.15, wispY: -0.38, glow: 0, grey: 0.4, ripple: 0, think: 0, zzz: 1 },
  waking: { eyeOpen: 1.2, lookX: 0, lookY: 0.1, lean: -0.12, tilt: 0, bob: 0.1, bobSpeed: 3.2, wispR: 1.25, wispSpeed: 2.6, wispY: 0, glow: 0.6, grey: 0, ripple: 0, think: 0, zzz: 0 },
  listening: { eyeOpen: 1.15, lookX: 0, lookY: 0, lean: 0.14, tilt: 0, bob: 0.06, bobSpeed: 1.4, wispR: 1.05, wispSpeed: 0.35, wispY: -0.15, glow: 0.25, grey: 0, ripple: 1, think: 0, zzz: 0 },
  thinking: { eyeOpen: 0.85, lookX: 0.45, lookY: 0.55, lean: -0.1, tilt: -0.14, bob: 0.05, bobSpeed: 1, wispR: 0.5, wispSpeed: 2.4, wispY: 0.78, glow: 0.3, grey: 0, ripple: 0, think: 1, zzz: 0 },
  speaking: { eyeOpen: 1, lookX: 0, lookY: 0, lean: 0, tilt: 0, bob: 0.08, bobSpeed: 1.8, wispR: 1.1, wispSpeed: 0.9, wispY: -0.1, glow: 0.6, grey: 0, ripple: 0, think: 0, zzz: 0 },
}

export function createKarl(): Karl {
  const root = new THREE.Group() // position / jump
  const body = new THREE.Group() // rotation / squash
  root.add(body)

  // ---- cloud body ----
  const white = new THREE.Color(0xf4f6ff)
  const grey = new THREE.Color(0xa9afc9)
  const bodyMat = toon(0xf4f6ff)
  const puffs: [number, number, number, number][] = [
    [0, 0, 0, 0.62], [-0.5, -0.12, 0.05, 0.42], [0.52, -0.1, 0.05, 0.45],
    [-0.22, 0.32, -0.05, 0.4], [0.28, 0.36, -0.1, 0.38], [0, -0.28, 0.15, 0.42],
  ]
  const puffMeshes = puffs.map(([x, y, z, r]) => {
    const m = mesh(new THREE.SphereGeometry(r, 28, 18), bodyMat, x, y, z)
    m.userData.base = new THREE.Vector3(x, y, z)
    body.add(m)
    return m
  })

  // ---- face ----
  const face = new THREE.Group()
  body.add(face)
  const ink = toon(0x1b1b24)
  const eyeGeo = new THREE.SphereGeometry(0.075, 18, 12)
  const arcGeo = new THREE.TorusGeometry(0.07, 0.018, 8, 18, Math.PI)
  const eyes = [-0.2, 0.2].map((x) => {
    const g = new THREE.Group()
    g.position.set(x, 0.05, 0.6)
    const open = mesh(eyeGeo, ink)
    const shine = mesh(new THREE.SphereGeometry(0.022, 8, 6), toon(0xffffff), 0.025, 0.03, 0.06)
    open.add(shine)
    const closed = mesh(arcGeo, ink) // ∪ — sleepy
    closed.rotation.z = Math.PI
    const happy = mesh(arcGeo, ink) // ∩ — joyful ^
    g.add(open, closed, happy)
    face.add(g)
    return { g, open, closed, happy, baseX: x }
  })

  const cheekMat = toon(0xffb3c7, { emissive: 0xff6f9a, emissiveIntensity: 0 })
  ;[-0.36, 0.36].forEach((x) => face.add(mesh(new THREE.SphereGeometry(0.065, 14, 10), cheekMat, x, -0.08, 0.55)))

  const mouthMat = toon(0x47304a)
  // open mouth = dark cavity + tongue; hinged at the top lip so it opens downward
  const mouthOpen = new THREE.Group()
  mouthOpen.position.set(0, -0.09, 0.61)
  const unit = new THREE.SphereGeometry(1, 20, 14)
  const cavity = mesh(unit, mouthMat)
  const tongue = mesh(unit, toon(0xff8fa8))
  mouthOpen.add(cavity, tongue)
  const smile = mesh(new THREE.TorusGeometry(0.07, 0.016, 8, 18, Math.PI), mouthMat, 0, -0.12, 0.61)
  smile.rotation.z = Math.PI
  face.add(mouthOpen, smile)
  /** w/h are half-extents of the opening */
  const shapeMouth = (w: number, h: number) => {
    cavity.scale.set(w, h, 0.04)
    cavity.position.set(0, -h, 0)
    tongue.visible = h > 0.035
    tongue.scale.set(w * 0.62, h * 0.42, 0.03)
    tongue.position.set(0, -h * 1.5, 0.012)
  }

  // ---- orbiting wisps ----
  const wisps = new THREE.Group()
  root.add(wisps)
  const wispMat = toon(0xdfe6ff, { transparent: true, opacity: 0.85 })
  for (let i = 0; i < 6; i++) {
    const w = mesh(new THREE.SphereGeometry(0.08 + (i % 3) * 0.015, 12, 8), wispMat)
    w.userData.a = (i / 6) * Math.PI * 2
    wisps.add(w)
  }

  // ---- listening ripples (sound coming in) ----
  const ripples = [0, 1].map(() => {
    const m = mesh(new THREE.TorusGeometry(1, 0.012, 6, 64), new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0, depthWrite: false }), 0, 0, -0.1)
    root.add(m)
    return m
  })

  // ---- thinking bubbles ----
  const thinkMat = toon(0xf4f6ff, { transparent: true, opacity: 0 })
  const bubbles = ([[0.52, 0.72, 0.055], [0.74, 0.92, 0.08], [0.98, 1.16, 0.11]] as const).map(([x, y, r]) => {
    const m = mesh(new THREE.SphereGeometry(r, 14, 10), thinkMat, x, y, 0.2)
    root.add(m)
    return m
  })

  // ---- sprites: Zzz, ?, sparkles ----
  const zs = [0, 1, 2].map(() => {
    const s = glyph('z', '#cfe0ff')
    root.add(s)
    return s
  })
  const question = glyph('?', '#ffd25a')
  question.position.set(0.55, 0.95, 0.3)
  root.add(question)
  const sparkles = Array.from({ length: 10 }, (_, i) => {
    const s = star(i % 2 ? '#ffd25a' : '#9fe8ff')
    s.userData.dir = new THREE.Vector3(Math.cos((i / 10) * Math.PI * 2), Math.sin((i / 10) * Math.PI * 2) * 0.8 + 0.3, 0.4)
    root.add(s)
    return s
  })

  // ---- animation state ----
  const p: Pose = { ...POSES.sleeping }
  // speech envelope: `mouthLvl` is fast (lip sync), `bodyLvl` is slow (gesture)
  let peak = 0.15
  let mouthLvl = 0
  let bodyLvl = 0
  let silence = 1
  let mouthAmt = 0
  let happyEyes = 0
  let blinkT = 2 + Math.random() * 2
  let blink = 1
  let sacX = 0
  let sacY = 0
  let sacT = 1
  // one-shot timers count down from their duration
  const fx = { happy: 0, confused: 0, poke: 0, poof: 0, wake: 0 }
  let lastState: AdvisorState = 'sleeping'

  function react(r: Reaction) {
    if (r === 'happy') {
      fx.happy = 1.1
      sparkles.forEach((s) => (s.userData.t = 0))
    } else if (r === 'confused') fx.confused = 1.8
    else if (r === 'poke') fx.poke = 0.6
    else if (r === 'poof') fx.poof = 0.9
  }

  function update(dt: number, t: number, input: KarlInput) {
    dt = Math.min(dt, 0.1)
    const { state } = input
    if (state !== lastState) {
      if (state === 'waking' || (lastState === 'sleeping' && state !== 'sleeping')) fx.wake = 0.8
      lastState = state
    }
    for (const k of Object.keys(fx) as (keyof typeof fx)[]) fx[k] = Math.max(0, fx[k] - dt)

    // ---- pose blending ----
    const tgt = POSES[state]
    for (const k of Object.keys(p) as (keyof Pose)[]) p[k] = damp(p[k], tgt[k], k === 'eyeOpen' ? 9 : 5, dt)
    // normalise Vapi's volume with a slowly decaying peak so quiet & loud voices both animate well
    const raw = state === 'speaking' ? Math.max(0, input.level) : 0
    peak = Math.max(peak * Math.exp(-dt * 0.4), raw, 0.08)
    const norm = Math.sqrt(clamp01(raw / peak))
    mouthLvl = damp(mouthLvl, norm, norm > mouthLvl ? 28 : 13, dt)
    bodyLvl = damp(bodyLvl, state === 'speaking' ? mouthLvl : 0, 2.5, dt)
    silence = mouthLvl < 0.1 ? silence + dt : 0
    const speakW = p.glow > 0.45 ? 1 : 0 // speaking pose reached
    // hold a small open mouth between syllables; only fall back to the smile after a real pause
    const mouthOpenTgt = state === 'speaking' && silence < 0.4 ? 0.12 + mouthLvl * 0.88 : 0
    mouthAmt = damp(mouthAmt, mouthOpenTgt, mouthOpenTgt > mouthAmt ? 30 : 14, dt)
    const level = bodyLvl

    // ---- body motion ----
    const happyK = fx.happy > 0 ? Math.sin((1 - fx.happy / 1.1) * Math.PI) : 0
    const pokeK = fx.poke > 0 ? Math.sin((1 - fx.poke / 0.6) * Math.PI * 3) * (fx.poke / 0.6) : 0
    const wakeK = fx.wake > 0 ? Math.sin((1 - fx.wake / 0.8) * Math.PI) : 0
    const confK = Math.min(1, fx.confused * 2.5)
    root.position.y = Math.sin(t * p.bobSpeed * 2) * p.bob + happyK * 0.38 + level * 0.06
    body.rotation.x = p.lean + Math.sin(t * 2.3) * level * 0.07
    const listenTilt = state === 'listening' ? Math.sin(t * 0.9) * 0.1 : 0
    body.rotation.z = p.tilt + listenTilt + Math.sin(t * 0.9) * 0.04 + Math.sin(t * 1.15) * 0.05 * speakW + confK * 0.28
    body.rotation.y = Math.sin(t * 14) * 0.16 * confK + (fx.poof > 0 ? (1 - fx.poof / 0.9) * Math.PI * 2 : 0)

    // squash & stretch: stretch on jump / wake, squash on poke, breathe while sleeping
    const breathe = state === 'sleeping' ? Math.sin(t * 1.4) * 0.03 : 0
    const sy = 1 + happyK * 0.12 + wakeK * 0.14 - Math.abs(pokeK) * 0.12 + breathe + level * 0.035
    const sx = 1 - happyK * 0.06 - wakeK * 0.06 + Math.abs(pokeK) * 0.1 - breathe * 0.5 + level * 0.02
    body.scale.set(sx, sy, sx)
    // puffs jiggle a bit with voice
    puffMeshes.forEach((m, i) => {
      const b = m.userData.base as THREE.Vector3
      const j = level * 0.012 * Math.sin(t * 3.1 + i * 1.3) + pokeK * 0.03 * Math.sin(i * 2.1)
      m.position.set(b.x + j, b.y + j * 0.6, b.z)
    })
    bodyMat.color.copy(white).lerp(grey, p.grey)

    // ---- eyes ----
    blinkT -= dt
    if (blinkT <= 0) {
      blink = 0
      blinkT = 2.4 + Math.random() * 3
    }
    blink = damp(blink, 1, 18, dt)
    sacT -= dt
    if (sacT <= 0) {
      sacX = (Math.random() - 0.5) * 0.06
      sacY = (Math.random() - 0.5) * 0.04
      sacT = 0.8 + Math.random() * 2
    }
    const wantHappy = fx.happy > 0 || fx.poke > 0 ? 1 : 0
    happyEyes = damp(happyEyes, wantHappy, 14, dt)
    const open = p.eyeOpen * blink * (1 - mouthLvl * 0.12 * speakW)
    eyes.forEach((e, i) => {
      const confusedSquint = fx.confused > 0 && i === 0 ? 0.55 : 1
      e.g.position.x = e.baseX + p.lookX * 0.06 + sacX
      e.g.position.y = 0.05 + p.lookY * 0.06 + sacY
      const showArc = open < 0.18
      e.open.visible = !showArc && happyEyes < 0.5
      e.open.scale.set(1, Math.max(0.15, open) * confusedSquint, 1)
      e.closed.visible = showArc && happyEyes < 0.5
      e.happy.visible = happyEyes >= 0.5
    })

    // ---- mouth ----
    const thinkMouth = p.think
    const talking = mouthAmt > 0.06
    mouthOpen.visible = talking || thinkMouth > 0.5 || state === 'sleeping'
    smile.visible = !mouthOpen.visible
    if (talking) {
      // width drifts slowly between "o" and "ah" so it reads as vowels, not a pulsing hole
      const w = 0.085 + Math.sin(t * 4.7) * 0.014 * mouthAmt - mouthAmt * 0.01
      shapeMouth(w, 0.016 + mouthAmt * 0.085)
    } else if (state === 'sleeping') shapeMouth(0.035, 0.022 + Math.sin(t * 1.4) * 0.008)
    else shapeMouth(0.05, 0.012) // "hmm"
    mouthOpen.position.x = thinkMouth * 0.06
    smile.scale.setScalar(fx.happy > 0 || fx.poke > 0 ? 1.35 : 1)

    cheekMat.emissiveIntensity = p.glow * 0.4 + level * 0.9 + happyK * 0.8

    // ---- wisps ----
    wisps.children.forEach((w, i) => {
      const a = (w.userData.a as number) + t * p.wispSpeed * (1 + level)
      const r = p.wispR + Math.sin(t * 1.3 + i) * 0.04
      const halo = p.think // flat halo while thinking, loose cloud otherwise
      w.position.set(
        Math.cos(a) * r,
        p.wispY + Math.sin(t * 1.3 + i) * 0.18 * (1 - halo) + root.position.y * 0,
        Math.sin(a) * r * (0.5 + halo * 0.3),
      )
      w.scale.setScalar(1 - halo * 0.35 + (fx.poof > 0 ? 0.6 : 0))
    })

    // ---- ripples (listening) ----
    ripples.forEach((m, i) => {
      const ph = (t * 0.55 + i * 0.5) % 1
      m.scale.setScalar(1.45 - ph * 0.55)
      ;(m.material as THREE.MeshBasicMaterial).opacity = Math.sin(ph * Math.PI) * 0.55 * p.ripple
      m.visible = p.ripple > 0.02
    })

    // ---- thinking bubbles ----
    thinkMat.opacity = clamp01(p.think) * 0.95
    bubbles.forEach((b, i) => {
      b.visible = p.think > 0.02
      const k = Math.max(0, Math.sin(t * 4 - i * 0.9))
      b.scale.setScalar((0.6 + k * 0.5) * p.think)
    })

    // ---- Zzz ----
    zs.forEach((s, i) => {
      const ph = (t * 0.32 + i / 3) % 1
      s.position.set(0.5 + ph * 0.45 + Math.sin(ph * 6 + i) * 0.05, 0.55 + ph * 0.9, 0.3)
      s.scale.setScalar(0.16 + ph * 0.18)
      s.material.opacity = Math.sin(ph * Math.PI) * p.zzz
      s.material.rotation = -0.3 + ph * 0.4
    })

    // ---- confused "?" ----
    const qK = fx.confused > 0 ? Math.min(1, (1.8 - fx.confused) * 6) * Math.min(1, fx.confused * 3) : 0
    question.material.opacity = qK
    question.scale.setScalar(0.42 * (0.6 + qK * 0.4) + Math.sin(t * 9) * 0.02 * qK)
    question.material.rotation = Math.sin(t * 5) * 0.2

    // ---- sparkles (happy burst) ----
    sparkles.forEach((s) => {
      const st = (s.userData.t as number | undefined) ?? 1
      if (st < 1) s.userData.t = st + dt / 0.9
      const k = Math.min(1, (s.userData.t as number | undefined) ?? 1)
      const d = s.userData.dir as THREE.Vector3
      s.position.set(d.x * (0.55 + k * 0.75), 0.1 + d.y * (0.55 + k * 0.75), d.z)
      s.scale.setScalar(0.22 * (1 - k * 0.6))
      s.material.opacity = k < 1 ? Math.sin(k * Math.PI) : 0
      s.material.rotation = k * 2
    })
  }

  return { group: root, update, react }
}
