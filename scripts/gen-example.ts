/**
 * Generates example artifacts from the builder's fixture:
 *   examples/demo.json      (Lottie JSON)
 *   examples/demo.lottie    (dotLottie ZIP)
 *   examples/render.svg     (lottie-web render of one frame, via jsdom)
 *
 * Run: npx esbuild scripts/gen-example.ts --bundle --platform=node --format=esm --outfile=/tmp/gen-example.mjs && node /tmp/gen-example.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'
import { createRequire } from 'node:module'
const require2 = createRequire(import.meta.url)
// lottie-web's UMD guard requires a browser-ish global at require time
const lottie = () => (require2('lottie-web') as { loadAnimation: import('lottie-web').AnimationManager['loadAnimation'] }) as never
import { buildAnimation } from '../src/builder.js'
import { buildDotLottie } from '../src/dotlottie.js'
import { sampleSpring } from '../src/motion.js'
import type { SceneModel } from '../src/model.js'
import { svgPathToLottie } from '../src/path.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function makeScene(): SceneModel {
  const heart = svgPathToLottie('M 50 20 C 50 0 15 0 15 25 C 15 50 50 70 50 100 C 50 70 85 50 85 25 C 85 0 50 0 50 20 Z')[0]
  return {
    name: 'Demo',
    w: 240,
    h: 240,
    duration: 2,
    fps: 60,
    clips: true,
    backgroundFills: [{ kind: 'solid', color: { r: 0.93, g: 0.95, b: 0.97, a: 1 }, opacity: 1 }],
    children: [
      {
        id: 'heart',
        name: 'Heart',
        layerType: 'shape',
        pos: [120, 100],
        rotation: 0,
        scale: [1, 1],
        opacity: 1,
        w: 100,
        h: 100,
        streams: {
          pos: { keyframes: [{ t: 0, value: [120, 140], o: [0.42, 0], i: [0.58, 1] }, { t: 1, value: [120, 100], o: [0.34, 1.56], i: [0.64, 1] }, { t: 1.6, value: [120, 140] }] },
          rotation: { keyframes: [{ t: 0, value: -8 }, { t: 1, value: 8 }] },
          scale: { keyframes: [{ t: 0, value: [80, 80] }, { t: 0.5, value: [110, 110] }, { t: 1, value: [80, 80] }] },
        },
        shape: { kind: 'path', w: 100, h: 100, paths: [{ path: heart }] },
        fills: [{ kind: 'solid', color: { r: 0.86, g: 0.2, b: 0.35, a: 1 }, opacity: 1 }],
        strokes: [],
      },
      {
        id: 'ring',
        name: 'Ring',
        layerType: 'shape',
        pos: [200, 190],
        rotation: 0,
        scale: [1, 1],
        opacity: 1,
        w: 80,
        h: 80,
        streams: {
          rotation: { keyframes: [{ t: 0, value: 0 }, { t: 2, value: 360 }] },
        },
        shape: { kind: 'ellipse', w: 80, h: 80, arc: { start: 0, end: 300, innerRadius: 0.6 } },
        fills: [{ kind: 'solid', color: { r: 0.25, g: 0.55, b: 0.95, a: 1 }, opacity: 1 }],
        strokes: [{ kind: 'solid', color: { r: 0.05, g: 0.2, b: 0.45, a: 1 }, opacity: 1 }],
        strokeWeight: 3,
      },
      {
        id: 'dot',
        name: 'Dot',
        layerType: 'shape',
        pos: [50, 190],
        rotation: 0,
        scale: [1, 1],
        opacity: 1,
        w: 24,
        h: 24,
        streams: {
          pos: { keyframes: [{ t: 0, value: [50, 190], spring: { samples: sampleSpring(0.75) } }, { t: 0.7, value: [120, 190] }] },
        },
        shape: { kind: 'ellipse', w: 24, h: 24, arc: null },
        fills: [{ kind: 'solid', color: { r: 0.15, g: 0.75, b: 0.45, a: 1 }, opacity: 1 }],
        strokes: [],
      },
    ],
    warnings: [],
    assets: new Map(),
  }
}

async function main() { // eslint-disable
  const scene = makeScene()
  const { animation } = buildAnimation(scene)
  const { zip } = await buildDotLottie(animation, scene.assets, {
    id: 'demo',
    name: scene.name,
    loop: true,
    autoplay: true,
  })

  mkdirSync(join(root, 'examples'), { recursive: true })
  writeFileSync(join(root, 'examples', 'demo.json'), JSON.stringify(animation, null, 2))
  writeFileSync(join(root, 'examples', 'demo.lottie'), zip)

  // render one frame with lottie-web in jsdom
  const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })
  const g = dom.window as unknown as Record<string, unknown>
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number
  g.cancelAnimationFrame = (id: number) => clearTimeout(id)
  ;(globalThis as Record<string, unknown>).window = g
  ;(globalThis as Record<string, unknown>).document = dom.window.document
  const ctxStub = new Proxy({}, {
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
  ;(dom.window.HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ctxStub
  const svgProto = dom.window.SVGElement?.prototype as Record<string, unknown> | undefined
  if (svgProto && !svgProto.getBBox) svgProto.getBBox = () => ({ x: 0, y: 0, width: 100, height: 100 })

  const stage = dom.window.document.getElementById('stage') as unknown as Element
  const lottieApi = require2('lottie-web') as unknown as typeof import('lottie-web')
  const anim = lottieApi.loadAnimation({
    container: stage,
    renderer: 'svg',
    loop: false,
    autoplay: false,
    animationData: JSON.parse(JSON.stringify(animation)) as never,
  }) as unknown as { goToAndStop: (f: number, b: boolean) => void }
  await new Promise((r) => setTimeout(r, 400))
  anim.goToAndStop(60, true)
  await new Promise((r) => setTimeout(r, 100))
  const svg = stage.querySelector('svg')
  writeFileSync(join(root, 'examples', 'render.svg'), svg ? svg.outerHTML : '<svg xmlns="http://www.w3.org/2000/svg"/>')
  console.log('wrote examples/demo.json, examples/demo.lottie, examples/render.svg')
}

main().catch((e) => { console.error(e); process.exit(1) })
