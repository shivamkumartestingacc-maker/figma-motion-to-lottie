/**
 * Collects a Figma Motion frame into the runtime-agnostic SceneModel.
 * Runs inside the Figma plugin sandbox and reads both the scene graph and the
 * Motion animation data exposed by the Plugin API (Update 130+).
 */

import {
  colorFrom,
  combineTuple,
  combineXY,
  decompose,
  matInvert,
  matMul,
  matPoint,
  mergeTracks,
  numFrom,
  vecFrom,
  type KeyframeBindingLike,
  type KeyframeValueLike,
  type Numeric,
} from './motion.js'
import type { LayerModel, Mat2D, PaintModel, RGBA, SceneModel, ShapeModel, Stream } from './model.js'
import { svgPathToLottie, type LottiePath } from './path.js'
import { parseSvgShapes } from './svgparse.js'

interface CollectCtx {
  warnings: SceneModel['warnings']
  assets: SceneModel['assets']
  duration: number
  unsupportedSet: Set<string>
}

const F = {
  TX: 'TRANSLATION_X',
  TY: 'TRANSLATION_Y',
  TXY: 'TRANSLATION_XY',
  ROT: 'ROTATION',
  SX: 'SCALE_X',
  SY: 'SCALE_Y',
  SXY: 'SCALE_XY',
  OP: 'OPACITY',
  W: 'WIDTH',
  H: 'HEIGHT',
  CR: 'CORNER_RADIUS',
  RTL: 'RECTANGLE_TOP_LEFT_CORNER_RADIUS',
  RTR: 'RECTANGLE_TOP_RIGHT_CORNER_RADIUS',
  RBR: 'RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS',
  RBL: 'RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS',
  SW: 'STROKE_WEIGHT',
  TRS: 'PATH_TRIM_START',
  TRE: 'PATH_TRIM_END',
  SPACING: 'STACK_SPACING',
} as const

export async function collectScene(frame: FrameNode, opts: { fps: number }): Promise<SceneModel> {
  const ctx: CollectCtx = {
    warnings: [],
    assets: new Map(),
    duration: 0,
    unsupportedSet: new Set(),
  }

  const abs = toMat2D(frame.absoluteTransform)
  const children: LayerModel[] = []
  for (const child of frame.children) {
    const layers = await convertNode(child, abs, ctx)
    if (layers) children.push(...(Array.isArray(layers) ? layers : [layers]))
  }

  let duration = ctx.duration
  try {
    const timelines = (frame as unknown as { timelines?: { duration: number }[] }).timelines ?? []
    duration = Math.max(duration, ...timelines.map((t) => t.duration ?? 0))
  } catch {
    /* older runtime */
  }
  if (duration <= 0) {
    warn(ctx, 'NO_MOTION', 'No Motion animation data found on this frame (or its timeline is 0s). Exported a 2s static composition.')
    duration = 2
  }

  return {
    name: frame.name || 'Animation',
    w: frame.width,
    h: frame.height,
    duration,
    fps: opts.fps,
    clips: !!frame.clipsContent,
    backgroundFills: toPaintModels((frame.fills as Paint[]) ?? [], ctx, 'frame background', frame.width, frame.height),
    children,
    warnings: ctx.warnings,
    assets: ctx.assets,
  }
}

function toMat2D(t: Transform): Mat2D {
  return { a: t[0][0], b: t[1][0], c: t[0][1], d: t[1][1], e: t[0][2], f: t[1][2] }
}

async function convertNode(
  node: SceneNode,
  parentAbs: Mat2D,
  ctx: CollectCtx,
): Promise<LayerModel | LayerModel[] | null> {
  if (!node || typeof node !== 'object' || !('type' in node)) return null
  if ((node as unknown as { visible?: boolean }).visible === false) return null

  const abs = toMat2D(node.absoluteTransform)
  const rel = matMul(matInvert(parentAbs), abs)
  const w = node.width
  const h = node.height
  const dec = decompose(rel)
  const center = matPoint(rel, w / 2, h / 2)

  const anim = readAnimations(node)
  const streams = buildTransformStreams(anim, center, dec.scale)
  const shapeStreams = buildShapeStreams(anim, (node as unknown as { width: number; height: number }).width, (node as unknown as { height: number }).height, nodeRadii(node))
  const fillColorStreams = readPaintColorStreams(anim, 'fills', ctx)
  const strokeColorStreams = readPaintColorStreams(anim, 'strokes', ctx)
  for (const binding of allBindings(anim)) ctx.duration = Math.max(ctx.duration, binding.timelineDuration ?? 0)

  const effects = (node as unknown as { effects?: Effect[] }).effects ?? []
  if (effects.length > 0 && !ctx.unsupportedSet.has('EFFECTS')) {
    ctx.unsupportedSet.add('EFFECTS')
    warn(ctx, 'EFFECTS', 'Layer effects (shadows, blurs, etc.) cannot be represented in plain Lottie and were skipped.')
  }

  const base: Omit<LayerModel, 'layerType'> = {
    id: node.id,
    name: node.name || node.type,
    pos: center,
    rotation: dec.rotation,
    scale: dec.scale,
    opacity: (node as unknown as { opacity?: number }).opacity ?? 1,
    w,
    h,
    blendMode: (node as unknown as { blendMode?: string }).blendMode,
    streams,
    fills: toPaintModels((node as unknown as { fills?: Paint[] | symbol }).fills as Paint[] ?? [], ctx, 'fill', w, h),
    strokes: toPaintModels((node as unknown as { strokes?: Paint[] }).strokes ?? [], ctx, 'stroke', w, h),
    strokeWeight: (node as unknown as { strokeWeight?: number | symbol }).strokeWeight as number | undefined,
    strokeCap: (node as unknown as { strokeCap?: string }).strokeCap,
    strokeJoin: (node as unknown as { strokeJoin?: string }).strokeJoin,
    fillColorStreams: fillColorStreams ?? undefined,
    strokeColorStreams: strokeColorStreams ?? undefined,
    shape: undefined,
    precomp: undefined,
    image: undefined,
  }

  switch (node.type) {
    case 'FRAME':
    case 'GROUP':
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE': {
      const kids = (node as unknown as { children?: SceneNode[] }).children ?? []
      if (kids.length === 0) return rasterFallback(node, base, ctx)
      const children: LayerModel[] = []
      for (const kid of kids) {
        const layers = await convertNode(kid, abs, ctx)
        if (layers) children.push(...(Array.isArray(layers) ? layers : [layers]))
      }
      const layer: LayerModel = {
        ...base,
        layerType: 'precomp',
        precomp: { children, fills: [] },
        mask: !!((node as unknown as { clipsContent?: boolean }).clipsContent),
      }
      if (node.type === 'COMPONENT_SET') {
        warn(ctx, 'COMPONENT_SET', `Component set "${node.name}" was flattened from its current variant state.`, node.name)
      }
      return layer
    }

    case 'RECTANGLE':
      return shapeLayer(base, {
        kind: 'rect',
        w,
        h,
        radii: nodeRadii(node),
        size: shapeStreams.size,
        corners: shapeStreams.corners,
        strokeWeight: shapeStreams.strokeWeight ?? undefined,
      }, ctx)

    case 'ELLIPSE': {
      const arcData = (node as unknown as { arcData?: ArcData }).arcData
      return shapeLayer(base, {
        kind: 'ellipse',
        w,
        h,
        arc: arcData ? { start: arcData.startingAngle, end: arcData.endingAngle, innerRadius: arcData.innerRadius } : null,
        size: shapeStreams.size ?? undefined,
        strokeWeight: shapeStreams.strokeWeight ?? undefined,
      }, ctx)
    }

    case 'STAR':
      return shapeLayer(base, {
        kind: 'star',
        w,
        h,
        pointCount: (node as unknown as StarNode).pointCount,
        innerRatio: (node as unknown as StarNode).innerRadius,
        strokeWeight: shapeStreams.strokeWeight ?? undefined,
      }, ctx)

    case 'POLYGON':
      return shapeLayer(base, {
        kind: 'polygon',
        w,
        h,
        pointCount: (node as unknown as PolygonNode).pointCount,
        strokeWeight: shapeStreams.strokeWeight ?? undefined,
      }, ctx)

    case 'VECTOR': {
      const vectorPaths = (node as unknown as { vectorPaths?: { data: string; windingRule: string }[] }).vectorPaths
      if (!vectorPaths || vectorPaths.length === 0) return rasterFallback(node, base, ctx)
      const paths: { path: LottiePath }[] = []
      for (const vp of vectorPaths) {
        for (const p of svgPathToLottie(vp.data)) paths.push({ path: p })
      }
      return shapeLayer(base, {
        kind: 'path',
        w,
        h,
        paths,
        strokeWeight: shapeStreams.strokeWeight ?? undefined,
        trimStart: shapeStreams.trimStart ?? undefined,
        trimEnd: shapeStreams.trimEnd ?? undefined,
      }, ctx)
    }

    case 'LINE': {
      const strokeGeom = (node as unknown as { strokeGeometry?: { data: string }[] }).strokeGeometry
      if (!strokeGeom || strokeGeom.length === 0) return rasterFallback(node, base, ctx)
      const paths: { path: LottiePath }[] = []
      for (const p of strokeGeom) for (const sp of svgPathToLottie(p.data)) paths.push({ path: { ...sp, c: true } })
      const outline: LayerModel = {
        ...base,
        layerType: 'shape',
        shape: { kind: 'path', w, h, paths },
        fills: base.strokes ?? [],
        strokes: [],
        strokeWeight: undefined,
      }
      if (shapeStreams.strokeWeight) {
        warn(ctx, 'LINE_STROKE_ANIM', 'Animated stroke width on a line is baked into its outline and was skipped.', base.name)
      }
      return outline
    }

    case 'TEXT': {
      try {
        const svg = (await node.exportAsync({ format: 'SVG_STRING', svgOutlineText: true, contentsOnly: true })) as string
        const parsed = parseSvgShapes(svg)
        if (parsed.shapes.length > 0) {
          return parsed.shapes.map((s, index) => {
            const path = translatePath(s.path, -parsed.origin[0], -parsed.origin[1])
            const fill: PaintModel = s.fill
              ? { kind: 'solid', color: s.fill, opacity: s.opacity }
              : { kind: 'solid', color: s.stroke ?? { r: 0, g: 0, b: 0, a: 1 }, opacity: s.opacity }
            return {
              ...base,
              id: `${node.id}-t${index}`,
              name: `${base.name} (glyphs ${index + 1})`,
              layerType: 'shape' as const,
              shape: { kind: 'path', w, h, paths: [{ path }] },
              fills: [fill],
              strokes: [],
            }
          })
        }
        warn(ctx, 'TEXT_SVG', `Could not extract vector outlines from text "${node.name}"; rasterized it instead.`, base.name)
      } catch (e) {
        warn(ctx, 'TEXT_SVG', `Text "${node.name}" could not be exported as SVG outlines (${String(e)}); rasterized instead.`, base.name)
      }
      return rasterFallback(node, base, ctx)
    }

    case 'BOOLEAN_OPERATION':
    case 'SHAPE_WITH_TEXT': {
      const fillGeom = (node as unknown as { fillGeometry?: { data: string }[] }).fillGeometry
      if (fillGeom && fillGeom.length > 0) {
        const paths: { path: LottiePath }[] = []
        for (const p of fillGeom) for (const sp of svgPathToLottie(p.data)) paths.push({ path: { ...sp, c: true } })
        return shapeLayer(base, { kind: 'path', w, h, paths, strokeWeight: shapeStreams.strokeWeight ?? undefined }, ctx)
      }
      return rasterFallback(node, base, ctx)
    }

    default:
      return rasterFallback(node, base, ctx)
  }
}

function shapeLayer(base: Omit<LayerModel, 'layerType'>, shape: ShapeModel, ctx: CollectCtx): LayerModel {
  const strokeAlign = (getStrokeAlign(base) ?? '').toString()
  if (strokeAlign && strokeAlign !== 'CENTER') {
    warn(ctx, 'STROKE_ALIGN', `Stroke alignment "${strokeAlign}" is approximated with center alignment.`, base.name)
  }
  return { ...base, layerType: 'shape', shape }
}

function getStrokeAlign(base: Omit<LayerModel, 'layerType'>): unknown {
  return (base as unknown as { strokeAlign?: unknown }).strokeAlign
}

function translatePath(p: LottiePath, dx: number, dy: number): LottiePath {
  return {
    c: p.c,
    v: p.v.map(([x, y]) => [x + dx, y + dy] as [number, number]),
    i: p.i,
    o: p.o,
  }
}

async function rasterFallback(node: SceneNode, base: Omit<LayerModel, 'layerType'>, ctx: CollectCtx): Promise<LayerModel> {
  warn(ctx, 'RASTERIZED', `"${node.name}" (${node.type}) was rasterized to PNG because its content can't be represented as Lottie vectors.`, base.name)
  let bytes: Uint8Array
  try {
    bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } })
  } catch (e) {
    warn(ctx, 'RASTER_FAILED', `Could not rasterize "${node.name}": ${String(e)}`, base.name)
    return {
      ...base,
      layerType: 'shape',
      shape: { kind: 'rect', w: base.w, h: base.h, radii: [0, 0, 0, 0] },
      fills: [{ kind: 'solid', color: { r: 0.9, g: 0.9, b: 0.9, a: 1 }, opacity: 1 }],
      strokes: [],
    }
  }
  const assetId = `img_${node.id.replace(/[^a-zA-Z0-9_-]/g, '')}`
  if (!ctx.assets.has(assetId)) ctx.assets.set(assetId, { bytes, ext: 'png', w: base.w, h: base.h })
  return { ...base, layerType: 'image', image: { assetId }, fills: undefined, strokes: undefined, shape: undefined, precomp: undefined }
}

// ---------------------------------------------------------------------------
// Motion reading helpers

function readAnimations(node: SceneNode): Record<string, KeyframeBindingLike> {
  try {
    return ((node as unknown as { animations?: Record<string, KeyframeBindingLike> }).animations ?? {}) as Record<string, KeyframeBindingLike>
  } catch {
    return {}
  }
}

function allBindings(anim: Record<string, KeyframeBindingLike>): KeyframeBindingLike[] {
  const out: KeyframeBindingLike[] = []
  for (const key of Object.keys(anim)) {
    const v = anim[key]
    if (typeof v === 'object' && v !== null && 'tracks' in v) out.push(v)
  }
  return out
}

export function buildTransformStreams(
  anim: Record<string, KeyframeBindingLike>,
  center: [number, number],
  baseScale: [number, number],
): LayerModel['streams'] {
  const tx = fieldStream(anim, F.TX, numFrom)
  const ty = fieldStream(anim, F.TY, numFrom)
  const txy = fieldStream(anim, F.TXY, vecFrom)
  const trans = combineXY(tx, ty, txy)

  const rotation = fieldStream(anim, F.ROT, numFrom)
  const sx = fieldStream(anim, F.SX, numFrom)
  const sy = fieldStream(anim, F.SY, numFrom)
  const sxy = fieldStream(anim, F.SXY, vecFrom)
  const opacity = fieldStream(anim, F.OP, numFrom)

  const streams: LayerModel['streams'] = {}
  if (trans) streams.pos = mapStream(trans, ([dx, dy]) => [center[0] + dx, center[1] + dy] as [number, number])
  if (rotation) streams.rotation = mapStream(rotation, (v) => (typeof v === 'number' ? v : 0))
  // Missing scale axis must stay at its base (100% of the node), not 0
  const scaleBases: [number, number] = [baseScale[0] * 100, baseScale[1] * 100]
  const scaleA = sx ? mapStream(sx, (v) => (typeof v === 'number' ? normalizePercent(v) : scaleBases[0])) : singleton(scaleBases[0])
  const scaleB = sy ? mapStream(sy, (v) => (typeof v === 'number' ? normalizePercent(v) : scaleBases[1])) : singleton(scaleBases[1])
  const scaleXY = sxy
    ? mapStream(sxy, (v) =>
        Array.isArray(v) ? ([normalizePercent(v[0] as number), normalizePercent(v[1] as number)] as [number, number]) : scaleBases,
      )
    : null
  const scale = combineXY(scaleA, scaleB, scaleXY)
  if (scale) streams.scale = mapStream(scale, ([x, y]) => [x, y] as [number, number])
  if (opacity) streams.opacity = mapStream(opacity, (v) => (typeof v === 'number' ? (Math.abs(v) <= 1.5 ? v * 100 : v) : 100))
  return streams
}

function buildShapeStreams(anim: Record<string, KeyframeBindingLike>, w: number, h: number, radii: [number, number, number, number]) {
  const wStream = fieldStream(anim, F.W, numFrom)
  const hStream = fieldStream(anim, F.H, numFrom)
  let size: Stream<number[]> | null = null
  if (wStream || hStream) size = combineTuple([wStream ?? singleton(w), hStream ?? singleton(h)])

  const rU = fieldStream(anim, F.CR, numFrom)
  const rTL = fieldStream(anim, F.RTL, numFrom)
  const rTR = fieldStream(anim, F.RTR, numFrom)
  const rBR = fieldStream(anim, F.RBR, numFrom)
  const rBL = fieldStream(anim, F.RBL, numFrom)
  let corners: Stream<number[]> | null = null
  if (rU || rTL || rTR || rBR || rBL) {
    const num = (s: Stream<Numeric> | null, fb: number) => (s ? mapStream(s, (v) => (typeof v === 'number' ? v : fb)) : singleton(fb))
    // merge: uniform radius overrides individual fallbacks only when it's the single source
    const uniform = rU ? mapStream(rU, (v) => (typeof v === 'number' ? v : 0)) : null
    corners = combineTuple([
      uniform ?? num(rTL, radii[0]),
      uniform ?? num(rTR, radii[1]),
      uniform ?? num(rBR, radii[2]),
      uniform ?? num(rBL, radii[3]),
    ])
    void rU
  }
  // trim 0..1 (normalized) → 0..100 %
  const trimStart = fieldStream(anim, F.TRS, numFrom)
  const trimEnd = fieldStream(anim, F.TRE, numFrom)
  const normTrim = (s: Stream<Numeric> | null): Stream<number> | null =>
    s ? mapStream(s, (v) => (typeof v === 'number' ? (Math.abs(v) <= 1.5 ? v * 100 : v) : 0)) : null

  return {
    size: (size as import('./model.js').Stream<[number, number]> | null) ?? undefined,
    corners: (corners as import('./model.js').Stream<[number, number, number, number]> | null) ?? undefined,
    strokeWeight: (fieldStream(anim, F.SW, numFrom) as import('./model.js').Stream<number> | null) ?? undefined,
    trimStart: normTrim(trimStart) ?? undefined,
    trimEnd: normTrim(trimEnd) ?? undefined,
  }
}

function readPaintColorStreams(
  anim: Record<string, KeyframeBindingLike>,
  collection: 'fills' | 'strokes',
  ctx: CollectCtx,
): Map<number, Stream<RGBA>> | null {
  const entry = anim[collection] as unknown as Record<string, unknown> | undefined
  if (!entry || typeof entry !== 'object') return null
  const out = new Map<number, Stream<RGBA>>()
  for (const key of Object.keys(entry)) {
    const binding = entry[key] as unknown
    if (!binding || typeof binding !== 'object' || !('tracks' in (binding as object))) continue
    const stream = mergeTracks([binding as KeyframeBindingLike], colorFrom, ctx.warnings)
    if (stream && stream.keyframes.some((k) => k.value && typeof k.value === 'object' && !Array.isArray(k.value))) {
      out.set(Number(key), stream as unknown as Stream<RGBA>)
    }
  }
  return out.size ? out : null
}

function fieldStream(
  anim: Record<string, KeyframeBindingLike>,
  field: string,
  read: (v: KeyframeValueLike | null | undefined) => Numeric,
): Stream<Numeric> | null {
  const binding = anim[field]
  if (!binding) return null
  return mergeTracks([binding], read, [])
}

function singleton<T>(value: T): Stream<T> {
  return { keyframes: [{ t: 0, value, sampled: true }] }
}

function mapStream<T, U>(s: Stream<T>, fn: (v: T) => U): Stream<U> {
  return { keyframes: s.keyframes.map((k) => ({ ...k, value: fn(k.value) as U })) }
}

function normalizePercent(v: number): number {
  return Math.abs(v) <= 2 ? v * 100 : v
}

function nodeRadii(node: SceneNode): [number, number, number, number] {
  const n = node as unknown as {
    topLeftRadius?: number
    topRightRadius?: number
    bottomLeftRadius?: number
    bottomRightRadius?: number
    cornerRadius?: number
  }
  const r = n.cornerRadius ?? 0
  return [n.topLeftRadius ?? r, n.topRightRadius ?? r, n.bottomRightRadius ?? r, n.bottomLeftRadius ?? r]
}

function toPaintModels(
  paints: Paint[],
  ctx: CollectCtx,
  role: string,
  w: number,
  h: number,
): PaintModel[] {
  if (!Array.isArray(paints)) {
    warn(ctx, 'MIXED_PAINTS', `Mixed "mixed" paints on ${role} are not supported.`)
    return []
  }
  return paints.map((paint): PaintModel => {
    switch (paint.type) {
      case 'SOLID':
        return { kind: 'solid', color: clampColor(paint.color), opacity: paint.opacity ?? 1 }
      case 'GRADIENT_LINEAR':
      case 'GRADIENT_RADIAL': {
        const m = paint.gradientTransform
        // gradient unit space (0..1) scaled by node size
        const start: [number, number] = [m[0][2] * w, m[1][2] * h]
        const end: [number, number] = [(m[0][0] + m[0][2]) * w, (m[1][0] + m[1][2]) * h]
        return {
          kind: paint.type === 'GRADIENT_LINEAR' ? 'linear' : 'radial',
          start,
          end,
          stops: paint.gradientStops.map((s) => ({ position: s.position, color: clampColor(s.color) })),
          opacity: paint.opacity ?? 1,
        }
      }
      case 'IMAGE':
        warn(ctx, 'IMAGE_PAINT', `Image paint on ${role} (${paint.imageHash ?? '?'}) cannot fill a shape directly.`)
        return { kind: 'unsupported', label: 'image' }
      default:
        warn(ctx, 'UNSUPPORTED_PAINT', `Paint type "${(paint as Paint).type}" on ${role} is not supported.`)
        return { kind: 'unsupported', label: String((paint as Paint).type) }
    }
  })
}

function clampColor(c: { r: number; g: number; b: number; a?: number }): RGBA {
  return {
    r: Math.max(0, Math.min(1, c.r ?? 0)),
    g: Math.max(0, Math.min(1, c.g ?? 0)),
    b: Math.max(0, Math.min(1, c.b ?? 0)),
    a: Math.max(0, Math.min(1, c.a ?? 1)),
  }
}

function warn(ctx: CollectCtx, code: string, message: string, node?: string) {
  ctx.warnings.push({ code, message, node })
}
