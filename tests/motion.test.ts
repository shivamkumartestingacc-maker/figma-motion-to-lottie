import { describe, expect, it } from 'vitest'
import {
  bezierProgress,
  combineXY,
  easingToControls,
  evalStream,
  mergeTracks,
  resolveTrack,
  sampleSpring,
  type KeyframeBindingLike,
  type ManualKeyframeTrackLike,
  type MotionEasingLike,
} from '../src/motion.js'
import { svgPathToLottie, roundedRectPath } from '../src/path.js'
import { parseSvgShapes } from '../src/svgparse.js'

const noWarnings = () => {
  const list: never[] = []
  return list
}

const makeBinding = (op: ManualKeyframeTrackLike['keyframeOperation'], values: [number, number][], base = 1): KeyframeBindingLike => ({
  baseValue: { type: 'FLOAT', value: base },
  timelineDuration: 2,
  tracks: [
    {
      id: 't',
      keyframeOperation: op,
      keyframes: values.map(([t, v]) => ({
        id: `${t}-${v}`,
        timelinePosition: t,
        value: { type: 'FLOAT', value: v },
        easing: { type: 'LINEAR' } as MotionEasingLike,
      })),
    },
  ],
})

describe('bezier easing', () => {
  it('linear is identity', () => {
    for (const u of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(bezierProgress(u, [0, 0], [1, 1])).toBeCloseTo(u, 4)
    }
  })
  it('ease-in-out is symmetric around 0.5', () => {
    const y = bezierProgress(0.5, [0.42, 0], [0.58, 1])
    expect(y).toBeCloseTo(0.5, 3)
    expect(bezierProgress(0.25, [0.42, 0], [0.58, 1])).toBeLessThan(0.25)
    expect(bezierProgress(0.75, [0.42, 0], [0.58, 1])).toBeGreaterThan(0.75)
  })
  it('ease-out-back overshoots', () => {
    expect(bezierProgress(0.85, [0.34, 1.56], [0.64, 1])).toBeGreaterThan(1)
  })
})

describe('easing mapping', () => {
  const map = (t: MotionEasingLike['type'], extra?: object) =>
    easingToControls({ type: t, ...(extra as object) } as unknown as MotionEasingLike, [] )
  it('maps named easings', () => {
    expect(map('LINEAR').o).toEqual([0, 0])
    expect(map('EASE_IN').o).toEqual([0.42, 0])
    expect(map('EASE_OUT_BACK').o[1]).toBeGreaterThan(1)
    expect(map('HOLD').hold).toBe(true)
  })
  it('maps custom cubic bezier', () => {
    const c = map('CUSTOM_CUBIC_BEZIER', {
      easingFunctionCubicBezier: { x1: 0.1, y1: 0.9, x2: 0.2, y2: 0.8 },
    })
    expect(c.o).toEqual([0.1, 0.9])
    expect(c.i).toEqual([0.2, 0.8])
  })
})

describe('streams', () => {
  const binding = makeBinding

  it('SET uses absolute values', () => {
    const s = resolveTrack(binding('SET', [[0, 0], [1, 1]]).tracks[0], { type: 'FLOAT', value: 0 }, (v) => (v as any)?.value ?? 0, [] as any)!
    expect(s.keyframes[0].value).toBe(0)
    expect(s.keyframes[1].value).toBe(1)
  })
  it('OFFSET adds base', () => {
    const s = resolveTrack(binding('OFFSET', [[0, 0], [1, 0.5]], 1).tracks[0], { type: 'FLOAT', value: 1 }, (v) => (v as any)?.value ?? 0, [] as any)!
    expect(s.keyframes[1].value).toBe(1.5)
  })
  it('SCALE multiplies base', () => {
    const s = resolveTrack(binding('SCALE', [[0, 1], [1, 0.5]], 10).tracks[0], { type: 'FLOAT', value: 10 }, (v) => (v as any)?.value ?? 0, [] as any)!
    expect(s.keyframes[1].value).toBe(5)
  })
  it('evaluates between keyframes', () => {
    const s = resolveTrack(binding('SET', [[0, 0], [1, 100]]).tracks[0], { type: 'FLOAT', value: 0 }, (v) => (v as any)?.value ?? 0, [] as any)!
    expect(evalStream(s!, 0.5)).toBeCloseTo(50, 4)
    expect(evalStream(s!, 0)).toBe(0)
    expect(evalStream(s!, 0.25)).toBeCloseTo(25, 4)
  })
  it('merges X and XY translation streams', () => {
    const x = resolveTrack(binding('SET', [[0, 10], [1, 20]]).tracks[0], { type: 'FLOAT', value: 0 }, (v) => (v as any)?.value ?? 0, [] as any)!
    const xy = resolveTrack(
      {
        id: 'xy',
        keyframeOperation: 'SET',
        keyframes: [
          { id: '1', timelinePosition: 0, value: { type: 'VECTOR', value: { x: 5, y: 7 } }, easing: { type: 'LINEAR' } },
        ],
      },
      { type: 'VECTOR', value: { x: 0, y: 0 } },
      (v) => (v as any)?.value ? [ (v as any).value.x, (v as any).value.y ] : null,
      [] as any,
    )!
    const merged = combineXY(x, null, xy)!
    expect(merged.keyframes[0].value).toEqual([15, 7])
  })
})

describe('springs', () => {
  it('sampled spring overshoots when bouncy', () => {
    const bouncy = sampleSpring(0.9)
    const max = Math.max(...bouncy.map((s) => s.p))
    expect(max).toBeGreaterThan(1.05)
    const stiff = sampleSpring(0)
    const last = stiff[stiff.length - 1]
    expect(last.p).toBeCloseTo(1, 2)
  })
  it('flagging works in mergeTracks', () => {
    const b = mergeTracks([makeBinding('SET', [[0, 0], [1, 100]])], (v) => (v as any)?.value ?? 0, [])!
    expect(b!.keyframes.length).toBe(2)
  })
})

describe('paths', () => {
  it('parses Figma vector path', () => {
    const paths = svgPathToLottie('M 0 0 L 100 0 L 100 100 Z')
    expect(paths.length).toBe(1)
    expect(paths[0].c).toBe(true)
    expect(paths[0].v).toHaveLength(3) // Z sets the closed flag
  })
  it('parses cubic path with tangent offsets', () => {
    const paths = svgPathToLottie('M 0 0 C 10 0 20 10 30 10 L 40 10')
    expect(paths[0].v).toHaveLength(3)
    expect(paths[0].o[0]).toEqual([10, 0])
    expect(paths[0].i[1]).toEqual([-10, 0])
  })
  it('parses relative commands', () => {
    const paths = svgPathToLottie('m 10 10 l 20 0 l 0 20 z')
    expect(paths[0].v[0]).toEqual([10, 10])
    expect(paths[0].v[1]).toEqual([30, 10])
    expect(paths[0].c).toBe(true)
  })
  it('builds a symmetric rounded rect', () => {
    const p = roundedRectPath(100, 50, 10, 10, 10, 10)
    expect(p.c).toBe(true)
    expect(p.v.length).toBeGreaterThan(4)
    const ys = p.v.map((v) => v[1])
    expect(Math.min(...ys)).toBeCloseTo(0, 4)
    expect(Math.max(...ys)).toBeCloseTo(50, 4)
  })
})

describe('svg parsing', () => {
  it('extracts paths with transforms and fill', () => {
    const svg = `<svg width="40" height="20" viewBox="0 0 40 20" xmlns="http://www.w3.org/2000/svg">
      <g transform="matrix(1 0 0 1 0 0)" fill="rgb(255,0,0)">
        <path d="M 0 0 L 10 0 L 10 10 Z"/>
        <g transform="translate(10,5) scale(0.5)">
          <path d="M 0 0 L 20 0 L 20 20 Z"/>
        </g>
      </g>
    </svg>`
    const result = parseSvgShapes(svg)
    expect(result.shapes.length).toBe(2)
    expect(result.shapes[0].fill).toEqual({ r: 1, g: 0, b: 0, a: 1 })
    // translated + scaled
    const s2 = result.shapes[1].path.v[0]
    expect(s2[0]).toBeCloseTo(10, 4)
    expect(s2[1]).toBeCloseTo(5, 4)
  })
})
