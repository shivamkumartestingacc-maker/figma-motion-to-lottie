/**
 * Pure helpers for reading Figma Motion data structures (structural typings only,
 * so this module can be unit-tested without the Figma runtime).
 */

import type { Keyframe, Mat2D, RGBA, Stream, Warning } from './model.js'

export interface MotionEasingLike {
  type: string
  easingFunctionCubicBezier?: { x1: number; y1: number; x2: number; y2: number }
  easingFunctionSpring?: { bounce: number }
}

export interface KeyframeValueLike {
  type: string
  value: unknown
}

export interface ManualKeyframeLike {
  id?: string
  timelinePosition: number
  easing?: MotionEasingLike | { type: 'VARIABLE_ALIAS'; id: string }
  value: KeyframeValueLike
}

export interface ManualKeyframeTrackLike {
  id: string
  keyframeOperation: 'SET' | 'OFFSET' | 'SCALE'
  keyframes: ManualKeyframeLike[]
}

export interface KeyframeBindingLike {
  baseValue: KeyframeValueLike
  timelineDuration: number
  tracks: ManualKeyframeTrackLike[]
}

export type Numeric = number | [number, number] | RGBA | null

/** Reads a FLOAT field value out of a KeyframeValue. */
export function numFrom(value: KeyframeValueLike | null | undefined): number | null {
  if (!value) return null
  if (value.type === 'FLOAT' && typeof value.value === 'number') return value.value
  return null
}

export function vecFrom(value: KeyframeValueLike | null | undefined): [number, number] | null {
  if (!value) return null
  if (value.type === 'VECTOR' && value.value) {
    const v = value.value as { x?: unknown; y?: unknown }
    if (typeof v.x === 'number' && typeof v.y === 'number') return [v.x, v.y]
  }
  return null
}

export function colorFrom(value: KeyframeValueLike | null | undefined): RGBA | null {
  if (!value) return null
  if (value.type === 'COLOR' && value.value) {
    const c = value.value as { r: number; g: number; b: number; a: number }
    return { r: c.r, g: c.g, b: c.b, a: c.a }
  }
  return null
}

export interface Controls {
  o: [number, number]
  i: [number, number]
  hold?: boolean
  spring?: { samples: { t: number; p: number }[] }
}

/**
 * Map a Figma Motion easing to Lottie control points.
 * `o` is the outgoing control for this keyframe; `i` is the incoming control
 * for the NEXT keyframe. Spring easings are flagged so the builder can expand
 * them into dense samples.
 */
export function easingToControls(
  easing: MotionEasingLike | { type: 'VARIABLE_ALIAS'; id: string } | undefined,
  warnings: Warning[],
): Controls {
  if (!easing) return { o: [0.42, 0], i: [0.58, 1] }
  if (easing.type === 'VARIABLE_ALIAS') {
    warn(warnings, 'UNRESOLVED_VARIABLE', 'Easing variable could not be resolved; used ease-in-out.', 'easing')
    return { o: [0.42, 0], i: [0.58, 1] }
  }
  switch ((easing as MotionEasingLike).type) {
    case 'LINEAR':
      return { o: [0, 0], i: [1, 1] }
    case 'EASE_IN':
      return { o: [0.42, 0], i: [1, 1] }
    case 'EASE_OUT':
      return { o: [0, 0], i: [0.58, 1] }
    case 'EASE_IN_AND_OUT':
      return { o: [0.42, 0], i: [0.58, 1] }
    case 'EASE_IN_BACK':
      return { o: [0.36, 0], i: [0.66, -0.56] }
    case 'EASE_OUT_BACK':
      return { o: [0.34, 1.56], i: [0.64, 1] }
    case 'EASE_IN_AND_OUT_BACK':
      return { o: [0.68, -0.55], i: [0.32, 1.55] }
    case 'CUSTOM_CUBIC_BEZIER': {
      const b = (easing as MotionEasingLike).easingFunctionCubicBezier
      return {
        o: [b?.x1 ?? 0.42, b?.y1 ?? 0],
        i: [b?.x2 ?? 0.58, b?.y2 ?? 1],
      }
    }
    case 'GENTLE':
      return springControls(0.18)
    case 'QUICK':
      return springControls(0.22)
    case 'BOUNCY':
      return springControls(0.55)
    case 'SLOW':
      return springControls(0.2)
    case 'CUSTOM_SPRING':
      return springControls((easing as MotionEasingLike).easingFunctionSpring?.bounce ?? 0.5)
    case 'HOLD':
      return { o: [0, 0], i: [1, 1], hold: true }
    default:
      warn(warnings, 'UNKNOWN_EASING', `Unknown easing "${(easing as MotionEasingLike).type}"; used ease-in-out.`, 'easing')
      return { o: [0.42, 0], i: [0.58, 1] }
  }
}

export function springControls(bounce: number): Controls {
  return { o: [0, 0], i: [1, 1], spring: { samples: sampleSpring(bounce) } }
}

/** Sample a damped spring with normalized `bounce` 0..1 into progress points. */
export function sampleSpring(bounce: number, steps = 30): { t: number; p: number }[] {
  const zeta = Math.max(0.06, 1 - bounce * 0.93) // 1 = no overshoot
  const out: { t: number; p: number }[] = []
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    // keep overshoot/undershoot, just bound extremes so values stay sane
    out.push({ t, p: Math.max(-0.5, Math.min(1.5, dampedStep(t, zeta))) })
  }
  return out
}

function dampedStep(t: number, zeta: number): number {
  if (zeta >= 0.999) return 1 - Math.exp(-9.2 * t)
  const w = 4.6 / zeta // settle to ~1% residual at t=1
  const wd = w * Math.sqrt(1 - zeta * zeta)
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t))
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/**
 * Resolve a keyframe track into a stream of effective raw values.
 * - SET    → value is absolute
 * - OFFSET → value is added to the baseValue
 * - SCALE  → value multiplies the baseValue
 */
export function resolveTrack(
  track: ManualKeyframeTrackLike,
  base: KeyframeValueLike | null | undefined,
  read: (v: KeyframeValueLike | null | undefined) => Numeric,
  warnings: Warning[],
): Stream<Numeric> | null {
  const resolved: Keyframe<Numeric>[] = []
  for (const kf of track.keyframes) {
    const raw = read(kf.value)
    if (raw === null) continue
    let value = raw
    const baseNum = read(base)
    if (
      typeof raw === 'number' &&
      typeof baseNum === 'number' &&
      track.keyframeOperation !== 'SET'
    ) {
      value =
        track.keyframeOperation === 'OFFSET'
          ? baseNum + raw
          : track.keyframeOperation === 'SCALE'
            ? baseNum * raw
            : raw
    }
    const c = easingToControls(kf.easing as never, warnings)
    resolved.push({ t: kf.timelinePosition, value, o: c.o, i: c.i, hold: c.hold, spring: c.spring })
  }
  if (resolved.length === 0) return null
  resolved.sort((a, b) => a.t - b.t)
  return { keyframes: resolved }
}

/** Merge multiple tracks on the same bindings by sampling at union times. */
export function mergeTracks(
  bindings: KeyframeBindingLike[],
  read: (v: KeyframeValueLike | null | undefined) => Numeric,
  warnings: Warning[],
): Stream<Numeric> | null {
  const streams: Stream<Numeric>[] = []
  for (const binding of bindings) {
    for (const track of binding.tracks) {
      const s = resolveTrack(track, binding.baseValue, read, warnings)
      if (s) streams.push(s)
    }
  }
  if (streams.length === 0) return null
  if (streams.length === 1) return streams[0]

  const times = new Set<number>()
  for (const s of streams) for (const kf of s.keyframes) times.add(kf.t)
  const sorted = [...times].sort((a, b) => a - b)
  // later tracks override earlier ones (Figma applies styles then manual tracks)
  const keyframes: Keyframe<Numeric>[] = sorted.map((t) => {
    let value: Numeric = null
    for (const s of streams) {
      const v = evalStream(s, t)
      if (v !== null) value = v
    }
    const kf = streams
      .map((s) => s.keyframes.find((k) => k.t === t))
      .filter((k): k is Keyframe<Numeric> => !!k)
      .pop()
    return { t, value, o: kf?.o, i: kf?.i, hold: kf?.hold, spring: kf?.spring }
  })
  return { keyframes }
}

/**
 * Combine translation X / Y / XY streams into a 2-D offset stream.
 */
export function combineXY(
  x: Stream<Numeric> | null,
  y: Stream<Numeric> | null,
  xy: Stream<Numeric> | null,
): Stream<[number, number]> | null {
  const active: { stream: Stream<Numeric>; useX: boolean; useY: boolean }[] = []
  if (x) active.push({ stream: x, useX: true, useY: false })
  if (y) active.push({ stream: y, useX: false, useY: true })
  if (xy) active.push({ stream: xy, useX: true, useY: true })
  if (active.length === 0) return null

  const times = new Set<number>()
  for (const p of active) for (const kf of p.stream.keyframes) times.add(kf.t)
  const sorted = [...times].sort((a, b) => a - b)

  const keyframes: Keyframe<[number, number]>[] = sorted.map((t) => {
    let vx = 0
    let vy = 0
    for (const p of active) {
      const v = evalStream(p.stream, t)
      if (v === null) continue
      if (Array.isArray(v)) {
        vx += v[0] ?? 0
        vy += v[1] ?? 0
      } else if (p.useX && p.useY) {
        vx += v as number
        vy += v as number
      } else if (p.useX) {
        vx += v as number
      } else {
        vy += v as number
      }
    }
    const kf = active
      .map((p) => p.stream.keyframes.find((k) => k.t === t))
      .filter((k): k is Keyframe<Numeric> => !!k)
      .pop()
    return { t, value: [vx, vy], o: kf?.o, i: kf?.i, hold: kf?.hold, spring: kf?.spring }
  })
  return { keyframes }
}

/** Combine per-axis scalar streams (e.g. WIDTH+HEIGHT, corner radii) into a tuple stream. */
export function combineTuple(
  parts: (Stream<Numeric> | null | undefined)[],
): Stream<number[]> | null {
  const active = parts.filter((p): p is Stream<Numeric> => !!p)
  if (active.length === 0) return null
  const times = new Set<number>()
  for (const p of active) for (const kf of p.keyframes) times.add(kf.t)
  const sorted = [...times].sort((a, b) => a - b)
  const keyframes: Keyframe<number[]>[] = sorted.map((t) => {
    const value = parts.map((p) => {
      if (!p) return 0
      const v = evalStream(p, t)
      return typeof v === 'number' ? v : Array.isArray(v) ? v[0] : 0
    })
    const kf = active
      .map((p) => p.keyframes.find((k) => k.t === t))
      .filter((k): k is Keyframe<Numeric> => !!k)
      .pop()
    return { t, value, o: kf?.o, i: kf?.i, hold: kf?.hold, spring: kf?.spring }
  })
  return { keyframes }
}

/** Evaluate a stream at time t using bezier easing between keyframes. */
export function evalStream<T>(stream: Stream<T>, t: number): T {
  const kfs = stream.keyframes
  if (kfs.length === 0) return undefined as unknown as T
  if (t <= kfs[0].t) return kfs[0].value
  const last = kfs[kfs.length - 1]
  if (t >= last.t) return last.value
  let j = 0
  while (j < kfs.length - 2 && kfs[j + 1].t <= t) j++
  const a = kfs[j]
  const b = kfs[j + 1]
  if (a.hold) return a.value
  const span = b.t - a.t
  if (span <= 0) return a.value
  const u = (t - a.t) / span
  const p = bezierProgress(u, a.o ?? [0, 0], a.i ?? [1, 1])
  return lerpValue(a.value, b.value, p) as T
}

function lerpValue<T>(a: T, b: T, p: number): T {
  if (typeof a === 'number' && typeof b === 'number') return (a + (b - a) * p) as T
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return p < 0.5 ? a : b
    return a.map((v, i) =>
      typeof v === 'number' && typeof (b as unknown[])[i] === 'number'
        ? v + (((b as unknown[])[i] as number) - v) * p
        : v,
    ) as unknown as T
  }
  return p < 0.5 ? a : b
}

/** Evaluate the y value of a cubic-bezier easing at normalized time u (x). */
export function bezierProgress(u: number, o: [number, number], i: [number, number]): number {
  if (u <= 0) return 0
  if (u >= 1) return 1
  const t = solveBezierX(u, o, i)
  return cubic(t, o[1], i[1], 1)
}

function cubic(t: number, p1: number, p2: number, p3: number): number {
  const mt = 1 - t
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3
}

function bezierX(t: number, o: [number, number], i: [number, number]): number {
  return cubic(t, o[0], i[0], 1)
}

function solveBezierX(x: number, o: [number, number], i: [number, number]): number {
  let t = x
  for (let n = 0; n < 8; n++) {
    const cur = bezierX(t, o, i) - x
    if (Math.abs(cur) < 1e-5) return t
    const d = 3 * (1 - t) * (1 - t) * o[0] + 6 * (1 - t) * t * (i[0] - o[0]) + 3 * t * t * (1 - i[0])
    if (Math.abs(d) < 1e-6) break
    t -= cur / d
  }
  let lo = 0
  let hi = 1
  for (let n = 0; n < 20; n++) {
    const mid = (lo + hi) / 2
    if (bezierX(mid, o, i) < x) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** 2x3 affine helpers (Figma matrix convention, y-down). */
export function matMul(a: Mat2D, b: Mat2D): Mat2D {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  }
}

export function matInvert(m: Mat2D): Mat2D {
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) < 1e-9) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  }
}

export function matPoint(m: Mat2D, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]
}

export interface Decomposed {
  rotation: number
  scale: [number, number]
  /** 0 when no shear; >0 means the transform needs a raster fallback */
  shear: number
}

export function decompose(m: Mat2D): Decomposed {
  const sx = Math.sqrt(m.a * m.a + m.b * m.b)
  const sy = Math.sqrt(m.c * m.c + m.d * m.d)
  const det = m.a * m.d - m.b * m.c
  const sySigned = det < 0 ? -sy : sy
  const rotation = (Math.atan2(m.b, m.a) * 180) / Math.PI
  const cosAngle = sx === 0 || sySigned === 0 ? 0 : (m.a * m.c + m.b * m.d) / (sx * sySigned)
  return { rotation, scale: [sx, sySigned], shear: Math.abs(cosAngle) }
}

function warn(list: Warning[], code: string, message: string, node?: string) {
  list.push({ code, message, node })
}
