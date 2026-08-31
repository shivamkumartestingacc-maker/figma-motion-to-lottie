/**
 * End-to-end smoke test: build the fixture animation, then load it with the
 * real lottie-web SVG renderer under jsdom and assert it renders shapes.
 *
 * Notes on the jsdom environment (needed to run lottie-web in Node):
 * - `window`/`document` must be set on globalThis BEFORE lottie-web is imported
 *   (its UMD wrapper captures them at module scope).
 * - jsdom has no 2d canvas implementation and no getBBox; both are stubbed.
 * - frame advance goes through requestAnimationFrame, which jsdom only exposes
 *   with `pretendToBeVisual: true`; we additionally force `anim.goToAndStop`
 *   so the assertion does not depend on timer timing.
 */

import { JSDOM } from 'jsdom'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { buildAnimation, type LottieAnimation, type LottieLayer } from '../src/builder.js'
import { sampleSpring } from '../src/motion.js'
import type { SceneModel } from '../src/model.js'
import { svgPathToLottie } from '../src/path.js'

function makeScene(): SceneModel {
  const heart = svgPathToLottie('M 50 30 C 50 10 20 10 20 30 C 20 50 50 70 50 90 C 50 70 80 50 80 30 C 80 10 50 10 50 30 Z')[0]
  const dot = svgPathToLottie('M 0 0 L 40 0 L 40 40 L 0 40 Z')[0]
  void heart
  return {
    name: 'Render Fixture',
    w: 240,
    h: 240,
    duration: 2,
    fps: 60,
    clips: true,
    backgroundFills: [{ kind: 'solid', color: { r: 0.98, g: 0.98, b: 0.98, a: 1 }, opacity: 1 }],
    children: [
      {
        id: 'box',
        name: 'Box',
        layerType: 'shape',
        pos: [120, 120],
        rotation: 0,
        scale: [1, 1],
        opacity: 1,
        w: 80,
        h: 80,
        streams: {
          pos: { keyframes: [{ t: 0, value: [120, 120], o: [0.42, 0], i: [0.58, 1] }, { t: 1, value: [160, 90], o: [0.42, 0], i: [0.58, 1] }] },
          rotation: { keyframes: [{ t: 0, value: 0 }, { t: 1.5, value: 360 }] },
        },
        shape: { kind: 'rect', w: 80, h: 80, radii: [16, 16, 16, 16], size: { keyframes: [{ t: 0, value: [80, 80] }, { t: 1, value: [100, 100] }] } },
        fills: [{ kind: 'solid', color: { r: 0.05, g: 0.6, b: 0.9, a: 1 }, opacity: 1 }],
        strokes: [],
      },
      {
        id: 'star',
        name: 'Star',
        layerType: 'shape',
        pos: [60, 60],
        rotation: 0,
        scale: [1, 1],
        opacity: 1,
        w: 40,
        h: 40,
        streams: { opacity: { keyframes: [{ t: 0, value: 100 }, { t: 1, value: 20 }] } },
        shape: { kind: 'star', w: 40, h: 40, pointCount: 5, innerRatio: 0.4 },
        fills: [{ kind: 'solid', color: { r: 1, g: 0.8, b: 0, a: 1 }, opacity: 1 }],
        strokes: [{ kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 }],
        strokeWeight: 2,
      },
      {
        id: 'line',
        name: 'Line',
        layerType: 'shape',
        pos: [120, 200],
        rotation: 0,
        scale: [1, 1],
        opacity: 1,
        w: 120,
        h: 4,
        streams: {},
        shape: { kind: 'path', w: 120, h: 4, paths: [{ path: dot }], trimStart: { keyframes: [{ t: 0, value: 0 }, { t: 1, value: 100 }] } },
        fills: [{ kind: 'solid', color: { r: 0.2, g: 0.2, b: 0.2, a: 1 }, opacity: 1 }],
        strokes: [],
      },
      {
        id: 'nested',
        name: 'Nested',
        layerType: 'precomp',
        pos: [180, 180],
        rotation: 0,
        scale: [1, 1],
        opacity: 1,
        w: 60,
        h: 60,
        streams: { scale: { keyframes: [{ t: 0, value: [100, 100] }, { t: 1, value: [20, 20] }] } },
        fills: [],
        precomp: {
          children: [
            {
              id: 'dot',
              name: 'Dot',
              layerType: 'shape',
              pos: [30, 30],
              rotation: 0,
              scale: [1, 1],
              opacity: 1,
              w: 40,
              h: 40,
              streams: {},
              shape: { kind: 'ellipse', w: 40, h: 40, arc: null },
              fills: [{ kind: 'solid', color: { r: 0.9, g: 0.2, b: 0.2, a: 1 }, opacity: 1 }],
              strokes: [],
            },
          ],
          fills: [],
        },
      },
    ],
    warnings: [],
    assets: new Map(),
  }
}

interface RenderResult {
  frames: number
  visibleShapes: number
  errors: string[]
}

async function render(animation: LottieAnimation): Promise<RenderResult> {
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })
  const g = dom.window
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number
  g.cancelAnimationFrame = (id: number) => clearTimeout(id)
  ;(globalThis as Record<string, unknown>).window = g
  ;(globalThis as Record<string, unknown>).document = dom.window.document
  ;(globalThis as Record<string, unknown>).Navigator = dom.window.Navigator
  if (dom.window.SVGElement && !(dom.window.SVGElement.prototype as unknown as { getBBox?: unknown }).getBBox) {
    ;(dom.window.SVGElement.prototype as unknown as { getBBox: () => unknown }).getBBox = () => ({ x: 0, y: 0, width: 100, height: 100 })
  }
  const ctxStub = new Proxy<Record<string, unknown>>({}, {
    get: (t, key) => {
      if (key === 'measureText') return () => ({ width: 0 })
      if (typeof key === 'string' && !(key in t)) t[key] = () => {}
      return t[key as string]
    },
    set: (t, key, value) => {
      t[key as string] = value
      return true
    },
  })
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ctxStub) as unknown as HTMLCanvasElement['getContext']

  const lottie = (await import('lottie-web')).default
  const stage = dom.window.document.getElementById('stage') as unknown as Element

  const errors: string[] = []
  // The "worker" data-manager path (completeAnimation) runs synchronously in
  // Node, so the animation is configured by the time loadAnimation returns.
  const anim = lottie.loadAnimation({
    container: stage,
    renderer: 'svg',
    loop: false,
    autoplay: false,
    animationData: JSON.parse(JSON.stringify(animation)),
  })
  anim.addEventListener('error', (e: unknown) => {
    const native = (e as { nativeError?: Error })?.nativeError
    errors.push(native ? native.message : String(e))
  })
  anim.goToAndStop(30, true)
  const visibleShapes = stage.querySelectorAll('svg path, svg rect').length
  const animData = (anim as unknown as { animationData?: { ip: number; op: number } }).animationData
  const frames = animData ? Math.floor(animData.op - animData.ip) : 0
  anim.destroy()
  return { frames, visibleShapes, errors }
}

describe('lottie-web smoke render', () => {
  it('loads and renders the built animation', async () => {
    const { animation } = buildAnimation(makeScene())
    const result = await render(animation)
    expect(result.frames).toBe(120)
    expect(result.errors).toEqual([])
    expect(result.visibleShapes).toBeGreaterThan(0)
  }, 20000)

  it('renders spring-sampled keyframes', async () => {
    const scene = makeScene()
    scene.children[0].streams.pos = {
      keyframes: [
        { t: 0, value: [120, 120], spring: { samples: sampleSpring(0.7) } },
        { t: 0.6, value: [160, 90] },
      ],
    }
    const { animation } = buildAnimation(scene)
    const result = await render(animation)
    expect(result.frames).toBe(120)
    expect(result.errors).toEqual([])
    expect(result.visibleShapes).toBeGreaterThan(0)
  }, 20000)
})
