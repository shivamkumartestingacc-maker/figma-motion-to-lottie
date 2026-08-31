/**
 * Intermediate, runtime-agnostic model produced by the Figma collector and
 * consumed by the pure Lottie builder. Everything here is plain JSON-safe
 * data so the builder can be unit-tested without Figma.
 */

import type { LottiePath } from './path.js'

export interface Mat2D {
  /** affine transform: x' = a*x + c*y + e ; y' = b*x + d*y + f (Figma convention, y-down) */
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

export interface Warning {
  code: string
  message: string
  node?: string
}

/**
 * A single keyframe at time `t` (seconds).
 * `o`/`i` are the outgoing/incoming Bezier control points for the segment
 * starting at this keyframe (Lottie semantics). `hold` means the value stays
 * frozen until the next keyframe. `sampled` marks dense linear samples.
 */
export interface Keyframe<T> {
  t: number
  value: T
  /** outgoing Bezier control (start of segment to next keyframe) */
  o?: [number, number]
  /** incoming Bezier control (end of segment, assigned to next keyframe) */
  i?: [number, number]
  hold?: boolean
  /** sampled stream: segments are linear */
  sampled?: boolean
  /** spring segment: expand into dense samples when building */
  spring?: { samples: { t: number; p: number }[] }
}

export interface Stream<T> {
  keyframes: Keyframe<T>[]
}

export type PaintModel =
  | { kind: 'solid'; color: RGBA; opacity: number }
  | {
      kind: 'linear' | 'radial'
      start: [number, number]
      end: [number, number]
      stops: { position: number; color: RGBA }[]
      opacity: number
    }
  | { kind: 'image'; hash: string; opacity: number }
  | { kind: 'unsupported'; label: string }

export type ShapeKind = 'rect' | 'ellipse' | 'star' | 'polygon' | 'path'

export interface ShapeModel {
  kind: ShapeKind
  /** base geometry in node-local pixels */
  w: number
  h: number
  /** top-left, top-right, bottom-right, bottom-left (rect only) */
  radii?: [number, number, number, number]
  pointCount?: number
  /** star inner radius as 0..1 fraction of outer radius */
  innerRatio?: number
  /** ellipse arc (pie/ring), angles in degrees, null = full */
  arc?: { start: number; end: number; innerRadius: number } | null
  /** vector paths (flattened subpaths) */
  paths?: { path: LottiePath }[]
  /** geometry animation streams (effective px values) */
  size?: Stream<[number, number]>
  corners?: Stream<[number, number, number, number]>
  /** stroke width in px */
  strokeWeight?: Stream<number>
  /** trim 0..100 */
  trimStart?: Stream<number>
  trimEnd?: Stream<number>
}

export interface LayerModel {
  id: string
  name: string
  /** 'shape' | 'precomp' | 'image' */
  layerType: 'shape' | 'precomp' | 'image'
  /** static transform relative to parent */
  pos: [number, number] // layer center in parent coords
  rotation: number // degrees
  scale: [number, number] // fraction (1 = 100%)
  opacity: number // 0..1
  w: number
  h: number
  /** clip children/content to layer bounds (Figma clipsContent) */
  mask?: boolean
  /** mask in layer-local space (for image clipping e.g. avatar circles) */
  maskPath?: LottiePath
  blendMode?: string

  streams: {
    pos?: Stream<[number, number]> // effective center in parent coords
    rotation?: Stream<number> // effective degrees
    scale?: Stream<[number, number]> // effective percent (100 = 1x)
    opacity?: Stream<number> // effective percent (100 = opaque)
  }

  /** ty=4 shape layer */
  shape?: ShapeModel
  fills?: PaintModel[]
  strokes?: PaintModel[]
  strokeWeight?: number
  strokeCap?: string
  strokeJoin?: string
  /** animated paint colors keyed by paint index */
  fillColorStreams?: Map<number, Stream<RGBA>>
  strokeColorStreams?: Map<number, Stream<RGBA>>

  /** ty=0 precomp */
  precomp?: { children: LayerModel[]; fills: PaintModel[] }

  /** ty=2 image layer */
  image?: { assetId: string }
}

export interface SceneModel {
  name: string
  w: number
  h: number
  /** seconds */
  duration: number
  fps: number
  clips: boolean
  backgroundFills: PaintModel[]
  children: LayerModel[]
  warnings: Warning[]
  /** image assets keyed by id */
  assets: Map<string, { bytes: Uint8Array; ext: string; w: number; h: number }>
}

export interface ExportOptions {
  fps: number
}

export function warn(list: Warning[], code: string, message: string, node?: string) {
  list.push({ code, message, node })
}
