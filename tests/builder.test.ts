import { describe, expect, it } from 'vitest'
import { buildAnimation } from '../src/builder.js'
import { buildDotLottie } from '../src/dotlottie.js'
import { sampleSpring } from '../src/motion.js'
import type { LayerModel, SceneModel, Stream } from '../src/model.js'
import { svgPathToLottie } from '../src/path.js'

function kfs<T>(values: { t: number; value: T; o?: [number, number]; i?: [number, number] }[]): Stream<T> {
  return { keyframes: values }
}

function makeScene(overrides: Partial<SceneModel> = {}): SceneModel {
  const rect = svgPathToLottie('M 0 0 L 100 0 L 100 100 L 0 100 Z')[0]
  const vectorPathLayer: LayerModel = {
    id: 'vec',
    name: 'Vector',
    layerType: 'shape',
    pos: [150, 50],
    rotation: 0,
    scale: [1, 1],
    opacity: 1,
    w: 100,
    h: 100,
    streams: {
      pos: kfs([
        { t: 0, value: [150, 50], o: [0.42, 0], i: [0.58, 1] },
        { t: 1, value: [300, 200], o: [0.42, 0], i: [0.58, 1] },
      ]),
    },
    shape: {
      kind: 'path',
      w: 100,
      h: 100,
      paths: [{ path: rect }],
      trimStart: kfs([{ t: 0, value: 0 }, { t: 1, value: 100 }]),
    },
    fills: [{ kind: 'solid', color: { r: 0.2, g: 0.4, b: 0.6, a: 1 }, opacity: 1 }],
    strokes: [
      { kind: 'solid', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1 },
    ],
    strokeWeight: 4,
    strokeCap: 'ROUND',
    strokeJoin: 'ROUND',
  }

  const rectLayer: LayerModel = {
    id: 'rect',
    name: 'Button',
    layerType: 'shape',
    pos: [100, 100],
    rotation: 0,
    scale: [1, 1],
    opacity: 1,
    w: 100,
    h: 50,
    streams: {
      rotation: kfs([
        { t: 0, value: 0, o: [0.34, 1.56], i: [0.64, 1] },
        { t: 1.5, value: 180 },
      ]),
      opacity: kfs([
        { t: 0, value: 100 },
        { t: 1, value: 0 },
      ]),
    },
    shape: {
      kind: 'rect',
      w: 100,
      h: 50,
      radii: [8, 8, 8, 8],
      size: kfs([
        { t: 0, value: [100, 50] },
        { t: 1, value: [200, 100] },
      ]),
    },
    fills: [
      { kind: 'linear', start: [0, 0], end: [100, 50], stops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }], opacity: 1 },
    ],
    strokes: [{ kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 }],
    strokeWeight: 2,
  }

  const child: LayerModel = {
    id: 'child',
    name: 'Child',
    layerType: 'shape',
    pos: [50, 25],
    rotation: 0,
    scale: [1, 1],
    opacity: 1,
    w: 20,
    h: 20,
    streams: {
      scale: kfs([
        { t: 0, value: [100, 100] },
        { t: 0.5, value: [150, 150] },
      ]),
    },
    shape: { kind: 'ellipse', w: 20, h: 20, arc: null },
    fills: [{ kind: 'solid', color: { r: 0, g: 1, b: 0, a: 1 }, opacity: 1 }],
  }

  const group: LayerModel = {
    id: 'group',
    name: 'Group',
    layerType: 'precomp',
    pos: [100, 100],
    rotation: 30,
    scale: [0.5, 0.5],
    opacity: 1,
    w: 100,
    h: 50,
    streams: {
      rotation: kfs([
        { t: 0, value: 30 },
        { t: 1, value: -30 },
      ]),
    },
    fills: [],
    precomp: { children: [child], fills: [] },
  }

  return {
    name: 'Fixture',
    w: 400,
    h: 300,
    duration: 2,
    fps: 60,
    clips: true,
    backgroundFills: [{ kind: 'solid', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1 }],
    children: [vectorPathLayer, rectLayer, group],
    warnings: [],
    assets: new Map([['img_1', { bytes: new Uint8Array([1, 2, 3]), ext: 'png', w: 10, h: 10 }]]),
    ...overrides,
  }
}

describe('builder', () => {
  it('produces a complete animation', () => {
    const { animation, warnings } = buildAnimation(makeScene())
    expect(animation.w).toBe(400)
    expect(animation.h).toBe(300)
    expect(animation.fr).toBe(60)
    expect(animation.op).toBe(120)
    // clipped root: content wrapped in one masked precomp (background inside)
    expect(animation.layers).toHaveLength(1)
    expect(animation.layers[0].ty).toBe(0)
    expect(animation.layers[0].masksProperties).toBeDefined()
    const content = animation.assets.find((a) => a.id === 'motion_content')!
    expect(content.layers).toHaveLength(4) // background + 3 children
    expect(warnings).toHaveLength(0)
  })

  it('animates layer position with easing controls', () => {
    const { animation } = buildAnimation(makeScene())
    const content = animation.assets.find((a) => a.id === 'motion_content')!
    const vecLayer = content.layers!.find((l) => l.nm === 'Vector')!
    const p = vecLayer.ks.p
    expect(p.a).toBe(1)
    const k = (p.k as { t: number; s: number[]; o: { x: number[]; y: number[] } }[])[0]
    expect(k.t).toBe(0)
    expect(k.s).toEqual([150, 50])
    expect(k.o.x[0]).toBeCloseTo(0.42, 4)
  })

  it('expands spring easings into dense keyframes', () => {
    const springScene = makeScene()
    springScene.children[0].streams.pos = {
      keyframes: [
        { t: 0, value: [0, 0], o: [0, 0], i: [1, 1], spring: { samples: sampleSpring(0.8) } },
        { t: 1, value: [100, 0], o: [0, 0], i: [1, 1] },
      ],
    }
    const { animation } = buildAnimation(springScene)
    const content = animation.assets.find((a) => a.id === 'motion_content')!
    const vecLayer = content.layers!.find((l) => l.nm === 'Vector')!
    const k = vecLayer.ks.p.k as unknown[]
    expect(k.length).toBeGreaterThan(10)
    const yValues = (k as { s: number[] }[]).map((x) => x.s[1])
    // spring stays on the y axis (no animation) — samples interpolate [0,0]→[100,0]
    expect(yValues.every((y) => y === 0)).toBe(true)
  })

  it('maps hold easings to h:1', () => {
    const holdScene = makeScene()
    holdScene.children[0].streams.opacity = {
      keyframes: [
        { t: 0, value: 100, hold: true },
        { t: 1, value: 0 },
      ],
    }
    const { animation } = buildAnimation(holdScene)
    const content = animation.assets.find((a) => a.id === 'motion_content')!
    const vecLayer = content.layers!.find((l) => l.nm === 'Vector')!
    const k = vecLayer.ks.o.k as { h?: number }[]
    expect(k[0].h).toBe(1)
  })

  it('includes image assets as base64 entries', () => {
    const scene = makeScene()
    scene.children = [
      { ...scene.children[0], layerType: 'image', image: { assetId: 'img_1' }, shape: undefined, fills: [] },
    ]
    const { animation } = buildAnimation(scene)
    const img = animation.assets.find((a) => a.id === 'img_1')!
    expect(img.e).toBe(1)
    expect(typeof img.p).toBe('string')
  })

  it('keeps nested precomp hierarchy', () => {
    const { animation } = buildAnimation(makeScene())
    const compIds = animation.assets.map((a) => a.id)
    expect(compIds).toContain('comp_group')
    const groupAsset = animation.assets.find((a) => a.id === 'comp_group')!
    expect(groupAsset.layers![0].nm).toBe('Child')
    // child position is inside group local space (50,25)
    expect((groupAsset.layers![0].ks.p.k as number[])).toEqual([50, 25])
  })

  it('builds a valid dotLottie zip', async () => {
    const scene = makeScene()
    const { animation } = buildAnimation(scene)
    const { zip } = await buildDotLottie(animation, scene.assets, {
      id: 'anim1',
      name: 'Fixture',
      loop: true,
      autoplay: true,
    })
    expect(zip.length).toBeGreaterThan(0)
    // magic bytes PK
    expect(zip[0]).toBe(0x50)
    expect(zip[1]).toBe(0x4b)
  })
})

describe('collect transform streams', () => {
  it('keeps the missing scale axis at 100%', async () => {
    const { buildTransformStreams } = await import('../src/collect.js')
    const anim = {
      SCALE_X: {
        baseValue: { type: 'FLOAT', value: 1 },
        timelineDuration: 1,
        tracks: [
          {
            id: 't',
            keyframeOperation: 'SET',
            keyframes: [
              { timelinePosition: 0, value: { type: 'FLOAT', value: 1 }, easing: { type: 'LINEAR' } },
              { timelinePosition: 1, value: { type: 'FLOAT', value: 0.5 }, easing: { type: 'LINEAR' } },
            ],
          },
        ],
      },
    } as never
    const streams = buildTransformStreams(anim, [50, 50], [1, 1])
    expect(streams.scale).toBeDefined()
    const kfs = streams.scale!.keyframes
    expect(kfs[0].value).toEqual([100, 100])
    expect(kfs[1].value).toEqual([50, 100])
  })
})
