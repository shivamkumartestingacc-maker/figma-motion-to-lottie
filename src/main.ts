/**
 * Figma plugin main thread: reads the selection, collects Motion data,
 * builds Lottie/dotLottie output and talks to the UI panel.
 */

import { buildAnimation, type LottieAnimation } from './builder.js'
import { collectScene } from './collect.js'
import { buildDotLottie } from './dotlottie.js'
import type { SceneModel } from './model.js'

interface UiMessage {
  type: 'run'
  fps: number
  loop: boolean
  autoplay: boolean
}

interface UiState {
  fps: number
  loop: boolean
  autoplay: boolean
}

const state: UiState = { fps: 60, loop: true, autoplay: true }

function findMotionFrame(): FrameNode | null {
  const sel = figma.currentPage.selection
  if (sel.length !== 1) return null
  const first = sel[0] as unknown as { type: string; parent?: { type: string } | null }
  if (first.type === 'PAGE') return null
  // walk up to the top-level frame (Motion timelines live on the top-level frame)
  let node: { type: string; parent?: { type: string } | null } | null = first
  while (node && node.parent && node.parent.type !== 'PAGE' && node.parent.type !== 'SECTION') {
    node = node.parent
  }
  if (node && (node.type === 'FRAME' || node.type === 'COMPONENT')) return node as unknown as FrameNode
  return null
}

async function run() {
  const frame = findMotionFrame()
  if (!frame) {
    figma.ui.postMessage({
      type: 'error',
      message: 'Select a frame that contains your Figma Motion animation (or a node inside it), then run the plugin again.',
      title: 'No frame selected',
    })
    return
  }

  if (typeof figma.motion === 'undefined') {
    figma.ui.postMessage({
      type: 'error',
      message: 'This version of Figma does not expose the Motion Plugin API (needs Update 130, June 2026 or newer). Update Figma and try again.',
      title: 'Motion API unavailable',
    })
    return
  }

  figma.ui.postMessage({ type: 'loading' })

  try {
    const scene: SceneModel = await collectScene(frame, { fps: state.fps })
    const { animation, warnings } = buildAnimation(scene)
    const { zip } = await buildDotLottie(animation, scene.assets, {
      id: 'motion',
      name: scene.name,
      loop: state.loop,
      autoplay: state.autoplay,
      description: `Exported from Figma Motion: ${scene.name}`,
      keywords: ['figma', 'motion', 'lottie'],
    })
    figma.ui.postMessage({
      type: 'ready',
      animation,
      lottie: zip,
      name: scene.name,
      duration: scene.duration,
      fps: state.fps,
      warnings,
    })
  } catch (e) {
    figma.ui.postMessage({
      type: 'error',
      title: 'Export failed',
      message: String(e instanceof Error ? e.message : e),
    })
  }
}

figma.showUI(__html__, { width: 440, height: 620, themeColors: true })
figma.ui.onmessage = (msg: UiMessage) => {
  switch (msg.type) {
    case 'run':
      state.fps = msg.fps
      state.loop = msg.loop
      state.autoplay = msg.autoplay
      void run()
      break
    default:
      break
  }
}
void run()
