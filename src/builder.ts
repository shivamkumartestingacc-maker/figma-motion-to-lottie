/**
 * Pure Lottie JSON builder: SceneModel → Lottie animation (bodyMovin schema).
 * No Figma runtime required — fully unit-testable.
 */

import { evalStream } from './motion.js'
import type { Keyframe, LayerModel, PaintModel, RGBA, SceneModel, ShapeModel, Stream, Warning } from './model.js'
import { arcPath, roundedRectPath, type LottiePath } from './path.js'

export interface BuiltAnimation {
  animation: LottieAnimation
  warnings: Warning[]
}

export interface LottieAnimation {
  v: string
  fr: number
  ip: number
  op: number
  w: number
  h: number
  nm: string
  ddd: number
  assets: LottieAsset[]
  layers: LottieLayer[]
  markers?: unknown[]
}

export interface LottieAsset {
  id: string
  nm?: string
  w?: number
  h?: number
  layers?: LottieLayer[]
  u?: string
  e?: number
  p?: string
}

export interface LottieProperty {
  a: number
  k: unknown
  [key: string]: unknown
}

export interface LottieLayer {
  ddd: number
  ind: number
  ty: number
  nm: string
  refId?: string
  sr?: number
  ks: {
    o: LottieProperty
    r: LottieProperty
    p: LottieProperty
    a: LottieProperty
    s: LottieProperty
  }
  ao: number
  bm: number
  ip: number
  op: number
  st: number
  shapes?: LottieShapeItem[]
  masksProperties?: LottieMask[]
  w?: number
  h?: number
}

export interface LottieMask {
  nm: string
  mode: string
  inv: boolean
  o: LottieProperty
  x: LottieProperty
  y: LottieProperty
  pt: LottieProperty
}

export interface LottieShapeItem {
  ty: string
  nm: string
  [key: string]: unknown
}

interface BuildCtx {
  warnings: Warning[]
  nextIndex: number
  fps: number
  compOp: number
  assets: LottieAsset[]
}

const BLEND_MAP: Record<string, number> = {
  NORMAL: 0,
  MULTIPLY: 1,
  SCREEN: 2,
  OVERLAY: 3,
  DARKEN: 4,
  LIGHTEN: 5,
  COLOR_DODGE: 6,
  COLOR_BURN: 7,
  HARD_LIGHT: 8,
  SOFT_LIGHT: 9,
  DIFFERENCE: 10,
  EXCLUSION: 11,
  HUE: 12,
  SATURATION: 13,
  COLOR: 14,
  LUMINOSITY: 15,
  PASS_THROUGH: 0,
  PLUS_DARKER: 8,
}

export function buildAnimation(scene: SceneModel): BuiltAnimation {
  const ctx: BuildCtx = {
    warnings: scene.warnings.slice(),
    nextIndex: 1,
    fps: scene.fps,
    compOp: Math.max(1, Math.round(scene.duration * scene.fps)),
    assets: [],
  }

  const rootLayers: LottieLayer[] = []
  const background = backgroundLayer(scene, ctx)
  if (background) rootLayers.push(background)
  for (const child of scene.children) rootLayers.push(buildLayer(child, ctx))

  let layers = rootLayers
  if (scene.clips) {
    const contentAsset: LottieAsset = {
      id: 'motion_content',
      nm: `${scene.name} · content`,
      w: round(scene.w, 3),
      h: round(scene.h, 3),
      layers: rootLayers,
    }
    ctx.assets.push(contentAsset)
    const wrapper: LottieLayer = {
      ddd: 0,
      ind: ctx.nextIndex++,
      ty: 0,
      nm: `${scene.name} · clipped content`,
      refId: contentAsset.id,
      ks: defaultTransform(scene.w, scene.h),
      ao: 0,
      bm: 0,
      ip: 0,
      op: ctx.compOp,
      st: 0,
      w: scene.w,
      h: scene.h,
      masksProperties: [rectMask(scene.w, scene.h, 'clip')],
    }
    layers = [wrapper]
  }

  for (const [id, img] of scene.assets) {
    ctx.assets.push({
      id,
      w: round(img.w, 3),
      h: round(img.h, 3),
      u: '',
      e: 1,
      p: base64(img.bytes),
    })
  }

  return {
    animation: {
      v: '5.7.4',
      fr: scene.fps,
      ip: 0,
      op: ctx.compOp,
      w: round(scene.w, 3),
      h: round(scene.h, 3),
      nm: scene.name,
      ddd: 0,
      assets: ctx.assets,
      layers,
    },
    warnings: ctx.warnings,
  }
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function backgroundLayer(scene: SceneModel, ctx: BuildCtx): LottieLayer | null {
  const fills = scene.backgroundFills.filter((f) => f.kind !== 'unsupported')
  if (fills.length === 0) return null
  const layer = shapeLayerBase(ctx, `${scene.name} · background`, scene.w, scene.h)
  layer.shapes = [
    { ty: 'rc', nm: 'Background', d: 1, p: stat([scene.w / 2, scene.h / 2]), s: stat([scene.w, scene.h]), r: stat(0) },
    ...paintItems(fills, null, ctx),
  ]
  return layer
}

function buildLayer(layer: LayerModel, ctx: BuildCtx): LottieLayer {
  const out: LottieLayer = {
    ddd: 0,
    ind: ctx.nextIndex++,
    ty: layer.layerType === 'precomp' ? 0 : layer.layerType === 'image' ? 2 : 4,
    nm: layer.name,
    ks: transform(layer, ctx),
    ao: 0,
    bm: BLEND_MAP[layer.blendMode ?? 'NORMAL'] ?? 0,
    ip: 0,
    op: ctx.compOp,
    st: 0,
  }
  if (layer.layerType === 'precomp') {
    const comp = buildPrecomp(layer, ctx)
    out.refId = comp.id
    out.w = layer.w
    out.h = layer.h
  } else if (layer.layerType === 'image' && layer.image) {
    out.refId = layer.image.assetId
    out.w = layer.w
    out.h = layer.h
  } else if (layer.shape) {
    out.shapes = buildShapeItems(layer, ctx)
  }
  if (layer.maskPath) {
    out.masksProperties = [{ ...rectMask(0, 0, 'mask'), pt: pathProp(layer.maskPath) }]
  } else if (layer.mask) {
    out.masksProperties = [rectMask(layer.w, layer.h, 'clip')]
  }
  return out
}

function buildPrecomp(layer: LayerModel, ctx: BuildCtx): LottieAsset {
  const children: LottieLayer[] = []
  for (const fill of layer.fills ?? []) {
    if (fill.kind === 'unsupported') continue
    const bg = shapeLayerBase(ctx, `${layer.name} · background`, layer.w, layer.h)
    bg.shapes = [
      { ty: 'rc', nm: 'Background', d: 1, p: stat([layer.w / 2, layer.h / 2]), s: stat([layer.w, layer.h]), r: stat(0) },
      ...paintItems([fill], null, ctx),
    ]
    children.push(bg)
  }
  for (const child of layer.precomp?.children ?? []) children.push(buildLayer(child, ctx))
  const asset: LottieAsset = {
    id: `comp_${layer.id.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    nm: layer.name,
    w: round(layer.w, 3),
    h: round(layer.h, 3),
    layers: children,
  }
  ctx.assets.push(asset)
  return asset
}

// ---------------------------------------------------------------------------
// transforms

function defaultTransform(w: number, h: number): LottieLayer['ks'] {
  return {
    o: stat(100),
    r: stat(0),
    p: stat([w / 2, h / 2]),
    a: stat([w / 2, h / 2]),
    s: stat([100, 100]),
  }
}

function transform(layer: LayerModel, ctx: BuildCtx): LottieLayer['ks'] {
  const s = layer.streams
  return {
    o: propOr(streamToProp(s.opacity, ctx, layer.opacity * 100), stat(layer.opacity * 100)),
    r: propOr(streamToProp(s.rotation, ctx, layer.rotation), stat(layer.rotation)),
    p: propOr(streamToProp(s.pos, ctx, layer.pos), stat(layer.pos)),
    a: stat([layer.w / 2, layer.h / 2]),
    s: propOr(
      streamToProp(s.scale, ctx, [layer.scale[0] * 100, layer.scale[1] * 100]),
      stat([layer.scale[0] * 100, layer.scale[1] * 100]),
    ),
  }
}

// ---------------------------------------------------------------------------
// animated properties

function stat(value: unknown): LottieProperty {
  return { a: 0, k: value }
}

function streamToProp(
  stream: Stream<unknown> | undefined,
  ctx: BuildCtx,
  fallback: number | number[],
): LottieProperty | null {
  if (!stream || stream.keyframes.length === 0) return null
  const mapped = toLottieKfs(stream, ctx.fps)
  if (mapped.length === 1 && mapped[0].t === 0 && mapped[0].h === undefined) {
    return stat(mapped[0].s)
  }
  return { a: 1, k: mapped }
}

/**
 * Expand spring segments into dense keyframes and assign per-keyframe Lottie
 * control points. The incoming control for keyframe j comes from the previous
 * keyframe's `i` (which describes the end of the segment j-1 → j).
 */
function toLottieKfs(stream: Stream<unknown>, fps: number): { t: number; s: number | number[]; o: { x: number[]; y: number[] }; i: { x: number[]; y: number[] }; h?: number }[] {
  const kfs = stream.keyframes
  const out: ReturnType<typeof toLottieKfs> = []
  for (let j = 0; j < kfs.length; j++) {
    const k = kfs[j]
    const next = kfs[j + 1]
    if (k.spring && next) {
      for (const smp of k.spring.samples) {
        out.push({
          t: round((k.t + (next.t - k.t) * smp.t) * fps, 4),
          s: lerp(k.value, next.value, smp.p) as number | number[],
          o: { x: [0], y: [0] },
          i: { x: [1], y: [1] },
        })
      }
      continue
    }
    const prevI = j > 0 ? kfs[j - 1].i ?? [1, 1] : [0, 0]
    out.push({
      t: round(k.t * fps, 4),
      s: k.value as number | number[],
      o: { x: [k.o?.[0] ?? 0], y: [k.o?.[1] ?? 0] },
      i: { x: [prevI[0]], y: [prevI[1]] },
      ...(k.hold ? { h: 1 as const } : {}),
    })
  }
  return out
}

function lerp<T>(a: T, b: T, p: number): T {
  if (typeof a === 'number' && typeof b === 'number') return (a + (b - a) * p) as T
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.map((v, i) => (typeof v === 'number' && typeof b[i] === 'number' ? v + (b[i] - v) * p : v)) as T
  }
  return p < 0.5 ? a : b
}

function propOr(prop: LottieProperty | null, fallback: LottieProperty): LottieProperty {
  return prop ?? fallback
}

// ---------------------------------------------------------------------------
// shape items

function shapeLayerBase(ctx: BuildCtx, nm: string, w: number, h: number): LottieLayer {
  return {
    ddd: 0,
    ind: ctx.nextIndex++,
    ty: 4,
    nm,
    ks: defaultTransform(w, h),
    ao: 0,
    bm: 0,
    ip: 0,
    op: ctx.compOp,
    st: 0,
  }
}

function buildShapeItems(layer: LayerModel, ctx: BuildCtx): LottieShapeItem[] {
  const shape = layer.shape!
  const items: LottieShapeItem[] = []
  items.push(...geometryItems(layer, shape, ctx))
  items.push(...paintItems(layer.fills ?? [], layer.fillColorStreams ?? null, ctx))
  items.push(...strokeItems(layer, ctx))
  items.push(...trimItems(shape, ctx))
  return items
}

function geometryItems(layer: LayerModel, shape: ShapeModel, ctx: BuildCtx): LottieShapeItem[] {
  const items: LottieShapeItem[] = []
  const w = shape.w
  const h = shape.h
  switch (shape.kind) {
    case 'rect': {
      const radii = shape.radii ?? [0, 0, 0, 0]
      const uniform = radii.every((r) => Math.abs(r - radii[0]) < 0.01)
      if (shape.size || shape.corners || !uniform) {
        items.push({ ty: 'sh', nm: 'Rectangle', ks: rectPathStream(shape, ctx) })
      } else {
        items.push({
          ty: 'rc',
          nm: 'Rectangle',
          d: 1,
          p: stat([w / 2, h / 2]),
          s: stat([w, h]),
          r: stat(radii[0]),
        })
      }
      break
    }
    case 'ellipse': {
      if (shape.arc) {
        const outer = Math.max(w, h) / 2
        const paths = arcPath(
          w / 2,
          h / 2,
          outer,
          shape.arc.innerRadius * outer,
          shape.arc.start,
          shape.arc.end,
          shape.arc.innerRadius > 0,
          false,
        )
        items.push(...paths.map((p, i) => ({ ty: 'sh', nm: `Arc ${i + 1}`, ks: pathProp(p) })))
      } else {
        items.push({
          ty: 'el',
          nm: 'Ellipse',
          d: 1,
          p: stat([w / 2, h / 2]),
          s: propOr(shape.size ? streamToProp(shape.size, ctx, [w, h]) : null, stat([w, h])),
        })
      }
      break
    }
    case 'star':
      items.push(starItem(w, h, shape.pointCount ?? 5, shape.innerRatio ?? 0.5))
      break
    case 'polygon':
      items.push(polygonItem(w, h, shape.pointCount ?? 3))
      break
    case 'path':
      for (const p of shape.paths ?? []) items.push({ ty: 'sh', nm: 'Path', ks: pathProp(p.path) })
      break
  }
  void layer
  return items
}

/** Builds an animated rounded-rect path from size/corner streams. */
function rectPathStream(shape: ShapeModel, ctx: BuildCtx): LottieProperty {
  const baseRadii = shape.radii ?? [0, 0, 0, 0]
  const times = new Set<number>()
  for (const s of [shape.size, shape.corners]) {
    for (const k of s?.keyframes ?? []) times.add(k.t)
  }
  if (times.size === 0) {
    const [rtl, rtr, rbr, rbl] = baseRadii
    return stat(roundedRectPath(shape.w, shape.h, rtl, rtr, rbr, rbl))
  }
  const sorted = [...times].sort((a, b) => a - b)
  const kfs = sorted.map((t) => {
    const size = shape.size ? (evalStream(shape.size, t) as number[]) : [shape.w, shape.h]
    const corners = shape.corners ? (evalStream(shape.corners, t) as number[]) : baseRadii
    const src =
      shape.size?.keyframes.find((k) => k.t === t) ??
      shape.corners?.keyframes.find((k) => k.t === t)
    return {
      t: round(t * ctx.fps, 4),
      // lottie-web expects animated path values as an array of paths
      s: [roundedRectPath(size[0] ?? shape.w, size[1] ?? shape.h, corners[0] ?? 0, corners[1] ?? 0, corners[2] ?? 0, corners[3] ?? 0)],
      o: { x: [src?.o?.[0] ?? 0], y: [src?.o?.[1] ?? 0] },
      i: { x: [src?.i?.[0] ?? 1], y: [src?.i?.[1] ?? 1] },
      ...(src?.hold ? { h: 1 } : {}),
    }
  })
  if (kfs.length === 1 && kfs[0].t === 0) return stat(kfs[0].s)
  return { a: 1, k: kfs }
}

function starItem(w: number, h: number, points: number, innerRatio: number): LottieShapeItem {
  const r = Math.min(w, h) / 2
  return {
    ty: 'sr',
    nm: 'Star',
    sy: 1,
    d: 1,
    pt: stat(points),
    p: stat([w / 2, h / 2]),
    r: stat(0),
    or: stat(r),
    os: stat(0.01),
    ir: stat(r * Math.max(0, Math.min(1, innerRatio))),
    is: stat(0.01),
  }
}

function polygonItem(w: number, h: number, points: number): LottieShapeItem {
  const r = Math.min(w, h) / 2
  return {
    ty: 'sr',
    nm: 'Polygon',
    sy: 0,
    d: 1,
    pt: stat(points),
    p: stat([w / 2, h / 2]),
    r: stat(0),
    or: stat(r),
    os: stat(0.01),
    ir: stat(0),
    is: stat(0),
  }
}

function paintItems(paints: PaintModel[], colorStreams: Map<number, Stream<RGBA>> | null, ctx: BuildCtx): LottieShapeItem[] {
  const items: LottieShapeItem[] = []
  paints.forEach((paint, i) => {
    switch (paint.kind) {
      case 'solid': {
        const colorStream = colorStreams?.get(i)
        let c: LottieProperty | null = null
        if (colorStream) {
          const rgbaToArr = (c2: RGBA): number[] => colorArr(c2, paint.opacity)
          c = streamToProp(
            { keyframes: colorStream.keyframes.map((k) => ({ ...k, value: rgbaToArr(k.value as RGBA) })) },
            ctx,
            colorArr(paint.color, paint.opacity),
          )
        }
        items.push({ ty: 'fl', nm: 'Fill', c: c ?? stat(colorArr(paint.color, paint.opacity)), o: stat(100), r: 1 })
        break
      }
      case 'linear':
      case 'radial':
        items.push(gradientFill(paint))
        break
      case 'unsupported':
        break
    }
  })
  return items
}

function strokeItems(layer: LayerModel, ctx: BuildCtx): LottieShapeItem[] {
  const items: LottieShapeItem[] = []
  const swStream = layer.shape?.strokeWeight
  const cap = capMap(layer.strokeCap ?? 'ROUND')
  const join = joinMap(layer.strokeJoin ?? 'ROUND')
  ;(layer.strokes ?? []).forEach((paint, i) => {
    switch (paint.kind) {
      case 'solid': {
        const colorStream = layer.strokeColorStreams?.get(i)
        let c: LottieProperty | null = null
        if (colorStream) {
          const rgbaToArr = (c2: RGBA): number[] => colorArr(c2, paint.opacity)
          c = streamToProp(
            { keyframes: colorStream.keyframes.map((k) => ({ ...k, value: rgbaToArr(k.value as RGBA) })) },
            ctx,
            colorArr(paint.color, paint.opacity),
          )
        }
        items.push({
          ty: 'st',
          nm: 'Stroke',
          c: c ?? stat(colorArr(paint.color, paint.opacity)),
          o: stat(100),
          w: propOr(swStream ? streamToProp(swStream, ctx, layer.strokeWeight ?? 1) : null, stat(layer.strokeWeight ?? 1)),
          lc: cap,
          lj: join,
          ml: 4,
        })
        break
      }
      case 'linear':
      case 'radial':
        items.push(gradientFill(paint))
        break
      case 'unsupported':
        break
    }
  })
  return items
}

function trimItems(shape: ShapeModel, ctx: BuildCtx): LottieShapeItem[] {
  if (!shape.trimStart && !shape.trimEnd) return []
  return [
    {
      ty: 'tm',
      nm: 'Trim Paths',
      s: propOr(shape.trimStart ? streamToProp(shape.trimStart, ctx, 0) : null, stat(0)),
      e: propOr(shape.trimEnd ? streamToProp(shape.trimEnd, ctx, 100) : null, stat(100)),
      o: stat(0),
      m: 1,
    },
  ]
}

function gradientFill(paint: Extract<PaintModel, { kind: 'linear' | 'radial' }>): LottieShapeItem {
  const g: number[] = []
  for (const s of paint.stops) g.push(round(s.position, 4), round(s.color.r, 4), round(s.color.g, 4), round(s.color.b, 4))
  const item: LottieShapeItem = {
    ty: 'gf',
    nm: 'Gradient Fill',
    o: stat(100),
    t: 1,
    s: stat(paint.start),
    e: stat(paint.end),
    g: { p: paint.stops.length, k: g },
  }
  if (paint.kind === 'radial') {
    item.h = stat(paint.start)
    item.a = stat(0)
  }
  return item
}

function capMap(cap: string): number {
  switch (cap) {
    case 'SQUARE':
      return 3
    case 'ROUND':
      return 2
    default:
      return 1 // BUTT / NONE
  }
}

function joinMap(join: string): number {
  switch (join) {
    case 'ROUND':
      return 2
    case 'BEVEL':
      return 3
    default:
      return 1 // MITER
  }
}

// ---------------------------------------------------------------------------
// paths & masks

function pathProp(p: LottiePath): LottieProperty {
  return stat({ c: p.c, v: p.v, i: p.i, o: p.o })
}

function rectMask(w: number, h: number, nm: string): LottieMask {
  return {
    nm,
    mode: 'a',
    inv: false,
    o: stat(100),
    x: stat(0),
    y: stat(0),
    pt: stat({
      c: true,
      v: [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ],
      i: [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ],
      o: [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ],
    }),
  }
}

function colorArr(c: RGBA, opacity: number): number[] {
  return [round(c.r, 4), round(c.g, 4), round(c.b, 4), round((c.a ?? 1) * opacity, 4)]
}

function round(v: number, d: number): number {
  const f = Math.pow(10, d)
  return Math.round(v * f) / f
}
