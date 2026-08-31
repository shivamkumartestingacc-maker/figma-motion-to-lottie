/**
 * Path geometry helpers: SVG path `d` parsing → Lottie shape paths, plus
 * builders for rounded rectangles, ellipses and arcs.
 *
 * Lottie path format:
 *   { c: boolean, v: [[x,y]...], i: [[ix,iy]...], o: [[ox,oy]...] }
 * where `i`/`o` are tangents relative to their vertex.
 */

export interface LottiePath {
  c: boolean
  v: [number, number][]
  i: [number, number][]
  o: [number, number][]
}

interface Pt {
  x: number
  y: number
}

const K = 0.5522847498307936 // circle arc approximation constant

export function identity(): [number, number, number, number, number, number] {
  return [1, 0, 0, 1, 0, 0]
}

export function mul(
  m: [number, number, number, number, number, number],
  n: [number, number, number, number, number, number],
): [number, number, number, number, number, number] {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

function apply(m: [number, number, number, number, number, number], x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}

/**
 * Parse an SVG path `d` string into one or more Lottie paths (subpaths).
 * Supports the Figma subset (M, L, C, Q, Z — absolute) plus the full common
 * SVG command set (relative variants, H/V/S/T/A).
 */
export function svgPathToLottie(d: string): LottiePath[] {
  const tokens = tokenize(d)
  const result: LottiePath[] = []
  let current: LottiePath | null = null
  let cx = 0
  let cy = 0
  let startX = 0
  let startY = 0
  let subStart = false
  let lastCtrl: Pt | null = null
  let lastCmd = ''

  const close = () => {
    if (current && current.v.length > 0) {
      current.c = true
      pushSubpath(result, current)
    }
    current = null
    subStart = false
  }

  let i = 0
  let cmd = ''
  let params: number[] = []
  let needsParams = 0

  while (i < tokens.length || params.length > 0) {
    if (params.length === 0) {
      const t = tokens[i++]
      if (t === 'z' || t === 'Z') {
        if (current) close()
        cx = startX
        cy = startY
        lastCmd = t
        continue
      }
      cmd = t
      lastCmd = t
      // implied repeat of previous command when a new params token arrives
      // handled below
    }
    needsParams = paramsFor(cmd)
    while (params.length < needsParams && i < tokens.length) {
      const t = tokens[i++]
      if (isCommand(t)) {
        // previous command had fewer params than expected; treat as new command
        i--
        break
      }
      params.push(parseFloat(t))
    }
    if (params.length < needsParams) break

    switch (cmd) {
      case 'M':
      case 'm': {
        const rel = cmd === 'm'
        const x = rel ? cx + params[0] : params[0]
        const y = rel ? cy + params[1] : params[1]
        startX = x
        startY = y
        cx = x
        cy = y
        if (current && current.v.length > 0) pushSubpath(result, current)
        current = { c: false, v: [], i: [], o: [] }
        current.v.push([x, y])
        current.o.push([0, 0])
        current.i.push([0, 0])
        subStart = true
        params = []
        // "M x y" followed by more pairs means implicit "L"
        if (tokens[i] !== undefined && !isCommand(tokens[i])) {
          cmd = rel ? 'l' : 'L'
        }
        lastCtrl = null
        break
      }
      case 'L':
      case 'l':
      case 'H':
      case 'h':
      case 'V':
      case 'v': {
        if (!current) cmd = 'M'
        if (current) {
          let x = cx
          let y = cy
          if (cmd === 'L' || cmd === 'l') {
            x = cmd === 'l' ? cx + params[0] : params[0]
            y = cmd === 'l' ? cy + params[1] : params[1]
          } else if (cmd === 'H' || cmd === 'h') {
            x = cmd === 'h' ? cx + params[0] : params[0]
          } else {
            y = cmd === 'v' ? cy + params[0] : params[0]
          }
          addVertex(current, x, y)
          cx = x
          cy = y
        }
        params = []
        lastCtrl = null
        break
      }
      case 'C':
      case 'c': {
        const rel = cmd === 'c'
        const c1 = rel ? { x: cx + params[0], y: cy + params[1] } : { x: params[0], y: params[1] }
        const c2 = rel ? { x: cx + params[2], y: cy + params[3] } : { x: params[2], y: params[3] }
        const x = rel ? cx + params[4] : params[4]
        const y = rel ? cy + params[5] : params[5]
        addCubic(current, c1, c2, x, y, cx, cy)
        cx = x
        cy = y
        lastCtrl = c2
        params = []
        break
      }
      case 'S':
      case 's': {
        const rel = cmd === 's'
        const c1 =
          lastCmd === 'C' || lastCmd === 'c' || lastCmd === 'S' || lastCmd === 's'
            ? { x: 2 * cx - (lastCtrl?.x ?? cx), y: 2 * cy - (lastCtrl?.y ?? cy) }
            : { x: cx, y: cy }
        const c2 = rel ? { x: cx + params[0], y: cy + params[1] } : { x: params[0], y: params[1] }
        const x = rel ? cx + params[2] : params[2]
        const y = rel ? cy + params[3] : params[3]
        addCubic(current, c1, c2, x, y, cx, cy)
        cx = x
        cy = y
        lastCtrl = c2
        params = []
        break
      }
      case 'Q':
      case 'q': {
        const rel = cmd === 'q'
        const q: Pt = rel ? { x: cx + params[0], y: cy + params[1] } : { x: params[0], y: params[1] }
        const x = rel ? cx + params[2] : params[2]
        const y = rel ? cy + params[3] : params[3]
        convertQuad(current, q, x, y, cx, cy)
        cx = x
        cy = y
        lastCtrl = q
        params = []
        break
      }
      case 'T':
      case 't': {
        const rel = cmd === 't'
        const q: Pt =
          lastCmd === 'Q' || lastCmd === 'q' || lastCmd === 'T' || lastCmd === 't'
            ? { x: 2 * cx - (lastCtrl?.x ?? cx), y: 2 * cy - (lastCtrl?.y ?? cy) }
            : { x: cx, y: cy }
        const x = rel ? cx + params[0] : params[0]
        const y = rel ? cy + params[1] : params[1]
        convertQuad(current, q, x, y, cx, cy)
        cx = x
        cy = y
        lastCtrl = q
        params = []
        break
      }
      case 'A':
      case 'a': {
        const rel = cmd === 'a'
        const rx = params[0]
        const ry = params[1]
        const rot = (params[2] * Math.PI) / 180
        const largeArc = params[3] !== 0
        const sweep = params[4] !== 0
        const x = rel ? cx + params[5] : params[5]
        const y = rel ? cy + params[6] : params[6]
        addArc(current, cx, cy, x, y, rx, ry, rot, largeArc, sweep)
        cx = x
        cy = y
        params = []
        lastCtrl = null
        break
      }
      case 'Z':
      case 'z':
        close()
        params = []
        break
      default:
        params = []
        break
    }
  }
  if (current && current.v.length > 0) pushSubpath(result, current)
  return result
}

function pushSubpath(list: LottiePath[], p: LottiePath) {
  if (p.v.length === 0) return
  // drop duplicate closing vertex (first vertex repeated at end)
  const first = p.v[0]
  const last = p.v[p.v.length - 1]
  if (p.c && first[0] === last[0] && first[1] === last[1]) {
    p.v.pop()
    p.i.pop()
    p.o.pop()
  }
  list.push(p)
}

function tokenize(d: string): string[] {
  const out: string[] = []
  const re = /([a-zA-Z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d))) out.push(m[1] ?? m[2])
  return out
}

function isCommand(t: string): boolean {
  return /^[a-zA-Z]$/.test(t)
}

function paramsFor(cmd: string): number {
  switch (cmd) {
    case 'M':
    case 'm':
    case 'L':
    case 'l':
    case 'T':
    case 't':
      return 2
    case 'H':
    case 'h':
    case 'V':
    case 'v':
      return 1
    case 'C':
    case 'c':
    case 'S':
    case 's':
      return 6
    case 'Q':
    case 'q':
      return 4
    case 'A':
    case 'a':
      return 7
    default:
      return 0
  }
}

function addVertex(p: LottiePath, x: number, y: number) {
  p.v.push([x, y])
  p.o.push([0, 0])
  p.i.push([0, 0])
}

function addCubic(
  p: LottiePath | null,
  c1: Pt,
  c2: Pt,
  x: number,
  y: number,
  cx: number,
  cy: number,
) {
  if (!p) return
  if (p.v.length === 0) addVertex(p, cx, cy)
  const i = p.v.length - 1
  p.o[i] = [c1.x - cx, c1.y - cy]
  addVertex(p, x, y)
  p.i[p.v.length - 1] = [c2.x - x, c2.y - y]
}

function convertQuad(p: LottiePath | null, q: Pt, x: number, y: number, cx: number, cy: number) {
  if (!p) return
  const c1 = { x: cx + (2 / 3) * (q.x - cx), y: cy + (2 / 3) * (q.y - cy) }
  const c2 = { x: x + (2 / 3) * (q.x - x), y: y + (2 / 3) * (q.y - y) }
  addCubic(p, c1, c2, x, y, cx, cy)
}

function addArc(
  p: LottiePath | null,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  phi: number,
  largeArc: boolean,
  sweep: boolean,
) {
  if (!p) return
  if (rx === 0 || ry === 0) {
    addCubic(p, { x: x0, y: y0 }, { x: x1, y: y1 }, x1, y1, x0, y0)
    return
  }
  if (p.v.length === 0) addVertex(p, x0, y0)
  let rxp = Math.abs(rx)
  let ryp = Math.abs(ry)
  const cosPhi = Math.cos(phi)
  const sinPhi = Math.sin(phi)
  const dx = (x0 - x1) / 2
  const dy = (y0 - y1) / 2
  const xp = cosPhi * dx + sinPhi * dy
  const yp = -sinPhi * dx + cosPhi * dy
  const lambda = (xp * xp) / (rxp * rxp) + (yp * yp) / (ryp * ryp)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rxp *= s
    ryp *= s
  }
  const sign = largeArc !== sweep ? 1 : -1
  const num = rxp * rxp * ryp * ryp - rxp * rxp * yp * yp - ryp * ryp * xp * xp
  const den = rxp * rxp * yp * yp + ryp * ryp * xp * xp
  const coef = sign * Math.sqrt(Math.max(0, num / den))
  const cxp = coef * ((rxp * yp) / ryp)
  const cyp = coef * (-(ryp * xp) / rxp)
  const cxr = cosPhi * cxp - sinPhi * cyp + (x0 + x1) / 2
  const cyr = sinPhi * cxp + cosPhi * cyp + (y0 + y1) / 2
  const ux = (xp - cxp) / rxp
  const uy = (yp - cyp) / ryp
  const vx = (-xp - cxp) / rxp
  const vy = (-yp - cyp) / ryp
  let theta1 = Math.atan2(uy, ux)
  let dtheta = Math.atan2(uy * vx - ux * vy, ux * vx + uy * vy)
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI
  const segments = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)))
  const delta = dtheta / segments
  let cx = cxr
  let cy = cyr
  let angle = theta1
  for (let s = 0; s < segments; s++) {
    const next = angle + delta
    const a1 = angle
    const a2 = next
    const t = (4 / 3) * Math.tan((a2 - a1) / 4)
    const c1 = {
      x: cx + rxp * (Math.cos(a1) - t * Math.sin(a1)),
      y: cy + ryp * (Math.sin(a1) + t * Math.cos(a1)),
    }
    const a2c = cosPhi * (rxp * Math.cos(a2)) - sinPhi * (ryp * Math.sin(a2))
    const a2s = sinPhi * (rxp * Math.cos(a2)) + cosPhi * (ryp * Math.sin(a2))
    const c2 = {
      x: cx + a2c - t * (-sinPhi * ryp * Math.cos(a2) - cosPhi * rxp * Math.sin(a2)),
      y: cy + a2s - t * (cosPhi * ryp * Math.cos(a2) - sinPhi * rxp * Math.sin(a2)),
    }
    const x2 = cx + a2c
    const y2 = cy + a2s
    addCubic(p, c1, c2, x2, y2, cx, cy)
    // update center tracking for next segment (all in ellipse-local space)
    angle = next
  }
}

/**
 * Build a rounded rectangle path. Corners use the ellipse parametrization
 * P(θ) = C + r·(cos θ, sin θ) with Y down, so angles run clockwise:
 * TR 270→360°, BR 0→90°, BL 90→180°, TL 180→270°.
 */
export function roundedRectPath(
  w: number,
  h: number,
  rtl = 0,
  rtr = 0,
  rbr = 0,
  rbl = 0,
): LottiePath {
  const clampR = (r: number) => Math.max(0, Math.min(r, Math.min(w, h) / 2))
  rtl = clampR(rtl)
  rtr = clampR(rtr)
  rbr = clampR(rbr)
  rbl = clampR(rbl)
  const p: LottiePath = { c: true, v: [], i: [], o: [] }
  const add = (x: number, y: number) => {
    p.v.push([x, y])
    p.o.push([0, 0])
    p.i.push([0, 0])
  }
  add(rtl, 0)
  add(w - rtr, 0)
  addCornerArc(p, w - rtr, rtr, rtr, 270, 360) // top-right
  add(w, h - rbr)
  addCornerArc(p, w - rbr, h - rbr, rbr, 0, 90) // bottom-right
  add(rbr, h)
  addCornerArc(p, rbl, h - rbl, rbl, 90, 180) // bottom-left
  add(0, rtl)
  addCornerArc(p, rtl, rtl, rtl, 180, 270) // top-left; ends at (rtl, 0) == start vertex
  // drop the duplicate closing vertex (the closed flag reconnects)
  p.v.pop()
  p.i.pop()
  p.o.pop()
  return p
}

function addCornerArc(p: LottiePath, cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  if (r <= 0) return
  const start = (startDeg * Math.PI) / 180
  const end = (endDeg * Math.PI) / 180
  // ellipse param: x = cx + r*cos, y = cy + r*sin (y-down)
  const t = (4 / 3) * Math.tan((end - start) / 4)
  const c1x = cx + r * (Math.cos(start) - t * Math.sin(start))
  const c1y = cy + r * (Math.sin(start) + t * Math.cos(start))
  const c2x = cx + r * (Math.cos(end) + t * Math.sin(end))
  const c2y = cy + r * (Math.sin(end) - t * Math.cos(end))
  const ex = cx + r * Math.cos(end)
  const ey = cy + r * Math.sin(end)
  const prev = p.v[p.v.length - 1]
  p.o[p.v.length - 1] = [c1x - prev[0], c1y - prev[1]]
  p.v.push([ex, ey])
  p.i.push([c2x - ex, c2y - ey])
  p.o.push([0, 0])
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): LottiePath {
  // single path, two cubic halves
  const p: LottiePath = { c: true, v: [], i: [], o: [] }
  p.v.push([cx + rx, cy])
  p.i.push([0, 0])
  p.o.push([0, ry * K])
  p.v.push([cx, cy + ry])
  p.i.push([-rx * K, 0])
  p.o.push([0, 0])
  p.v.push([cx - rx, cy])
  p.i.push([0, -ry * K])
  p.o.push([0, ry * K])
  p.v.push([cx, cy - ry])
  p.i.push([rx * K, 0])
  p.o.push([0, 0])
  return p
}

/** Pie/ring/arc geometry (angles in degrees, 0 = +x, y-down). */
export function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  startDeg: number,
  endDeg: number,
  ring: boolean,
  pie: boolean,
): LottiePath[] {
  const paths: LottiePath[] = []
  const start = (startDeg * Math.PI) / 180
  const end = (endDeg * Math.PI) / 180
  const sweep = end - start
  const pts = (r: number): LottiePath => {
    const p: LottiePath = { c: false, v: [], i: [], o: [] }
    const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)))
    const delta = sweep / segments
    for (let s = 0; s <= segments; s++) {
      const a = start + delta * s
      const x = cx + r * Math.cos(a)
      const y = cy + r * Math.sin(a)
      p.v.push([x, y])
      p.i.push([0, 0])
      p.o.push([0, 0])
    }
    // tangent for each vertex with its neighbors in the arc
    for (let s = 0; s < p.v.length; s++) {
      const t = (4 / 3) * Math.tan(delta / 4)
      const aPrev = start + delta * (s - 0.5)
      const aNext = start + delta * (s + 0.5)
      const wx = (Math.cos(aNext) - Math.cos(aPrev)) * r * 0.5
      const wy = (Math.sin(aNext) - Math.sin(aPrev)) * r * 0.5
      p.o[s] = [wx * t * 1.5, wy * t * 1.5]
      p.i[s] = [-wx * t * 1.5, -wy * t * 1.5]
    }
    return p
  }

  if (ring) {
    const outerP = pts(outer)
    const conn1: [number, number] = [cx + inner * Math.cos(end), cy + inner * Math.sin(end)]
    const conn2: [number, number] = [cx + inner * Math.cos(start), cy + inner * Math.sin(start)]
    outerP.v.push(conn1)
    outerP.i.push([0, 0])
    outerP.o.push([0, 0])
    // inner arc, traversed backwards (its tangents flip)
    const innerP = pts(inner)
    innerP.v.reverse()
    innerP.i = innerP.o.slice().reverse()
    innerP.o = innerP.o.slice().reverse().map(([x, y]) => [-x, -y] as [number, number])
    // swap i/o so that handles follow the reversed direction
    const vCount = innerP.v.length
    for (let k = 0; k < vCount; k++) {
      const tmp = innerP.i[k]
      innerP.i[k] = innerP.o[k]
      innerP.o[k] = tmp
    }
    outerP.v.push(...innerP.v)
    outerP.i.push(...innerP.i)
    outerP.o.push(...innerP.o)
    outerP.v.push(conn2)
    outerP.i.push([0, 0])
    outerP.o.push([0, 0])
    outerP.c = true
    paths.push(outerP)
  } else if (pie) {
    const arc = pts(outer)
    arc.v.unshift([cx, cy])
    arc.i.unshift([0, 0])
    arc.o.unshift([0, 0])
    arc.c = true
    paths.push(arc)
  } else {
    paths.push(pts(outer))
  }
  return paths
}
