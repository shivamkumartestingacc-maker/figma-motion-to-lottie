/**
 * Minimal, DOM-free SVG parser used to turn Figma's SVG exports (e.g. text
 * rendered as outlines) into Lottie shape paths. Handles the machine-generated
 * subset Figma emits: nested <g transform>, fill/stroke attributes, and
 * path/rect/ellipse/circle/line/polygon/polyline elements.
 */

import type { RGBA } from './model.js'
import {
  ellipsePath,
  identity,
  mul,
  roundedRectPath,
  svgPathToLottie,
  type LottiePath,
} from './path.js'

type M = [number, number, number, number, number, number]

interface Frame {
  transform: M
  fill: string | null
  fillOpacity: number | null
  stroke: string | null
  strokeOpacity: number | null
  strokeWidth: number | null
  opacity: number | null
}

export interface ExtractedShape {
  path: LottiePath
  fill?: RGBA
  stroke?: RGBA
  opacity: number
}

export interface SvgParseResult {
  /** offset to subtract so coordinates land in node-local space */
  origin: [number, number]
  shapes: ExtractedShape[]
}

export function parseSvgShapes(svg: string): SvgParseResult {
  const viewBox = parseViewBox(svg)
  const origin: [number, number] = [viewBox.minX, viewBox.minY]

  const stack: Frame[] = []
  let defsDepth = 0
  const shapes: ExtractedShape[] = []
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*\/?>/g
  let m: RegExpExecArray | null

  const currentFrame = (): Frame =>
    stack.length ? stack[stack.length - 1] : { transform: identity(), fill: null, fillOpacity: null, stroke: null, strokeOpacity: null, strokeWidth: null, opacity: null }

  while ((m = tagRe.exec(svg))) {
    const name = m[1].toLowerCase()
    const attrs = parseAttrs(m[2])
    if (m[0].endsWith('/>') || name === 'path' || name === 'rect' || name === 'ellipse' || name === 'circle' || name === 'line' || name === 'polygon' || name === 'polyline') {
      // self-closing element (or leaf)
      if (name === 'g' || name === 'defs' || name === 'clipPath' || name === 'mask' || name === 'filter' || name === 'symbol') {
        continue
      }
      if (defsDepth > 0) continue
      if (name === 'path') {
        const d = attrs['d']
        if (!d) continue
        const frame = currentFrame()
        const local: M = parseTransform(attrs['transform'])
        const total = mul(frame.transform, local)
        const paths = svgPathToLottie(d)
        const op = opacityValue(attrs['opacity'] ?? frame.opacity)
        const fill = parseColor(attrs['fill'] ?? frame.fill)
        const stroke = parseColor(attrs['stroke'] ?? frame.stroke)
        const fillOpacity = opacityValue(attrs['fill-opacity'] ?? frame.fillOpacity)
        const strokeOpacity = opacityValue(attrs['stroke-opacity'] ?? frame.strokeOpacity)
        for (const p of paths) {
          const tp = transformPath(p, total)
          if (fill) {
            shapes.push({ path: tp, fill, opacity: op * (fillOpacity ?? 1) })
          }
          if (stroke) {
            shapes.push({ path: tp, stroke, opacity: op * (strokeOpacity ?? 1) })
          }
        }
      } else if (name === 'rect') {
        const frame = currentFrame()
        const total = mul(frame.transform, parseTransform(attrs['transform']))
        const x = num(attrs['x']) || 0
        const y = num(attrs['y']) || 0
        const w = num(attrs['width']) || 0
        const h = num(attrs['height']) || 0
        if (w > 0 && h > 0) {
          const r = num(attrs['rx']) ?? num(attrs['ry']) ?? 0
          const d = `M0 0 L${w} 0 L${w} ${h} L0 ${h} Z`
          const p = r > 0 ? roundedRectPath(w, h, r, r, r, r) : svgPathToLottie(d)[0]
          pushPainted(total, p, frame, attrs, shapes)
        }
      } else if (name === 'ellipse' || name === 'circle') {
        const frame = currentFrame()
        const total = mul(frame.transform, parseTransform(attrs['transform']))
        const cx = num(attrs['cx']) || 0
        const cy = num(attrs['cy']) || 0
        const rx = name === 'circle' ? num(attrs['r']) || 0 : num(attrs['rx']) || 0
        const ry = name === 'circle' ? num(attrs['r']) || 0 : num(attrs['ry']) || 0
        if (rx > 0 && ry > 0) {
          const p = ellipsePath(cx, cy, rx, ry)
          pushPainted(total, p, frame, attrs, shapes)
        }
      } else if (name === 'line') {
        const frame = currentFrame()
        const total = mul(frame.transform, parseTransform(attrs['transform']))
        const x1 = num(attrs['x1']) || 0
        const y1 = num(attrs['y1']) || 0
        const x2 = num(attrs['x2']) || 0
        const y2 = num(attrs['y2']) || 0
        const d = `M${x1} ${y1} L${x2} ${y2}`
        const frame2 = { ...frame, stroke: attrs['stroke'] ?? frame.stroke }
        for (const p of svgPathToLottie(d)) pushPainted(total, p, frame2, attrs, shapes)
      } else if (name === 'polygon' || name === 'polyline') {
        const frame = currentFrame()
        const total = mul(frame.transform, parseTransform(attrs['transform']))
        const ptsStr = attrs['points'] ?? ''
        const pts = ptsStr.trim().split(/[\s,]+/).map(Number)
        if (pts.length >= 4 && pts.every((n) => Number.isFinite(n))) {
          let d = ''
          for (let i = 0; i < pts.length; i += 2) d += `${i === 0 ? 'M' : 'L'}${pts[i]} ${pts[i + 1]} `
          if (name === 'polygon') d += 'Z'
          const frame2 = { ...frame, fill: attrs['fill'] ?? frame.fill }
          for (const p of svgPathToLottie(d)) pushPainted(total, p, frame2, attrs, shapes)
        }
      }
      continue
    }
    // opening tags
    if (name === 'defs' || name === 'clipPath' || name === 'mask' || name === 'filter' || name === 'symbol') {
      defsDepth++
      continue
    }
    if (name === 'g') {
      const frame = currentFrame()
      const f: Frame = {
        transform: mul(frame.transform, parseTransform(attrs['transform'])),
        fill: attrs['fill'] ?? frame.fill,
        fillOpacity: attrs['fill-opacity'] !== undefined ? opacityValue(attrs['fill-opacity']) : frame.fillOpacity,
        stroke: attrs['stroke'] ?? frame.stroke,
        strokeOpacity: attrs['stroke-opacity'] !== undefined ? opacityValue(attrs['stroke-opacity']) : frame.strokeOpacity,
        strokeWidth: attrs['stroke-width'] !== undefined ? num(attrs['stroke-width']) : frame.strokeWidth,
        opacity: attrs['opacity'] !== undefined ? opacityValue(attrs['opacity']) : frame.opacity,
      }
      stack.push(f)
      continue
    }
    if (name === 'text' || name === 'tspan' || name === 'use' || name === 'image') {
      // shapes inside are handled by our explicit element cases only;
      // unknown containers push an identity frame so transforms still apply
      const frame = currentFrame()
      stack.push({ ...frame, transform: mul(frame.transform, parseTransform(attrs['transform'])) })
      continue
    }
  }
  return { origin, shapes }
}

function pushPainted(
  total: M,
  p: LottiePath,
  frame: Frame,
  attrs: Record<string, string>,
  out: ExtractedShape[],
) {
  const tp = transformPath(p, total)
  const op = opacityValue(attrs['opacity'] ?? frame.opacity)
  const fill = parseColor(attrs['fill'] ?? frame.fill)
  const stroke = parseColor(attrs['stroke'] ?? frame.stroke)
  const fillOpacity = opacityValue(attrs['fill-opacity'] ?? frame.fillOpacity)
  if (fill) out.push({ path: tp, fill, opacity: op * (fillOpacity ?? 1) })
  if (stroke) out.push({ path: tp, stroke, opacity: op })
}

export function transformPath(p: LottiePath, m: M): LottiePath {
  const t = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  return {
    c: p.c,
    v: p.v.map(([x, y]) => t(x, y)),
    i: p.i.map(([x, y], idx) => {
      const v0 = t(p.v[idx][0], p.v[idx][1])
      return [m[0] * x + m[2] * y, m[1] * x + m[3] * y]
    }),
    o: p.o.map(([x, y], idx) => {
      return [m[0] * x + m[2] * y, m[1] * x + m[3] * y]
    }),
  }
}

function parseViewBox(svg: string): { minX: number; minY: number; w: number; h: number } {
  const m = /<svg[^>]*viewBox\s*=\s*["']([^"']+)["']/i.exec(svg)
  if (m) {
    const parts = m[1].trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return { minX: parts[0], minY: parts[1], w: parts[2], h: parts[3] }
    }
  }
  return { minX: 0, minY: 0, w: 0, h: 0 }
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z-:]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out[m[1]] = m[3] ?? m[4] ?? ''
  return out
}

function parseTransform(s: string | undefined): M {
  if (!s) return identity()
  let m: M = identity()
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g
  let hit: RegExpExecArray | null
  while ((hit = re.exec(s))) {
    const fn = hit[1]
    const args = hit[2].trim().split(/[\s,]+/).map(Number)
    if (fn === 'matrix' && args.length === 6) {
      m = mul(m, [args[0], args[1], args[2], args[3], args[4], args[5]])
    } else if (fn === 'translate' && args.length >= 2) {
      m = mul(m, [1, 0, 0, 1, args[0], args[1]])
    } else if (fn === 'scale' && args.length >= 1) {
      const sx = args[0]
      const sy = args.length > 1 ? args[1] : sx
      m = mul(m, [sx, 0, 0, sy, 0, 0])
    } else if (fn === 'rotate' && args.length >= 1) {
      const rad = (args[0] * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const rot: M = [cos, sin, -sin, cos, 0, 0]
      if (args.length >= 3) {
        const t = mul(mul([1, 0, 0, 1, args[1], args[2]], rot), [1, 0, 0, 1, -args[1], -args[2]])
        m = mul(m, t)
      } else {
        m = mul(m, rot)
      }
    } else if (fn === 'skewX' && args.length >= 1) {
      m = mul(m, [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0])
    } else if (fn === 'skewY' && args.length >= 1) {
      m = mul(m, [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0])
    }
  }
  return m
}

function parseColor(s: string | null | undefined): RGBA | null {
  if (!s) return null
  const str = s.trim()
  if (str === 'none' || str === 'transparent') return null
  let m = /^#([0-9a-fA-F]{3,8})$/.exec(str)
  if (m) {
    let hex = m[1]
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
    if (hex.length === 6) hex += 'ff'
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: parseInt(hex.slice(6, 8), 16) / 255,
      }
    }
    return null
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(str)
  if (m) {
    const parts = m[1].split(/[\s,\/]+/).filter(Boolean)
    if (parts.length >= 3) {
      const to255 = (p: string) =>
        p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)
      const r = to255(parts[0]) / 255
      const g = to255(parts[1]) / 255
      const b = to255(parts[2]) / 255
      let a = 1
      if (parts[3] !== undefined) a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])
      return { r, g, b, a: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1 }
    }
  }
  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0],
    white: [255, 255, 255],
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
  }
  if (named[str.toLowerCase()]) {
    const [r, g, b] = named[str.toLowerCase()]
    return { r: r / 255, g: g / 255, b: b / 255, a: 1 }
  }
  return null
}

function opacityValue(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 1
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}
