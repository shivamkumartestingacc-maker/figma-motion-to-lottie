/**
 * dotLottie (.lottie) packaging: wraps a Lottie JSON animation plus image
 * assets into the ZIP container defined by the dotLottie 1.0 spec.
 *
 * Layout:
 *   manifest.json
 *   animations/<id>.json
 *   images/<file>
 */

import JSZip from 'jszip'
import type { LottieAnimation, LottieAsset } from './builder.js'

export interface DotLottieMeta {
  id: string
  name: string
  author?: string
  description?: string
  keywords?: string[]
  loop: boolean
  autoplay: boolean
  themeColor?: string
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}


/**
 * Build the .lottie ZIP. `images` maps image-asset ids to raw bytes.
 * Returns both the zip bytes and the animation JSON with file-based image
 * asset references (needed by the preview).
 */
export async function buildDotLottie(
  animation: LottieAnimation,
  images: Map<string, { bytes: Uint8Array; ext: string; w: number; h: number }>,
  meta: DotLottieMeta,
): Promise<{ zip: Uint8Array; jsonForPreview: LottieAnimation }> {
  const zip = new JSZip()

  // manifest
  const manifest: Record<string, unknown> = {
    version: '1.0',
    generator: 'Figma Motion to dotLottie (plugin)',
    author: meta.author ?? '',
    description: meta.description ?? meta.name,
    keywords: meta.keywords ?? ['figma', 'motion', 'lottie'],
    revision: 1,
    activeAnimationId: meta.id,
    animations: [
      {
        id: meta.id,
        name: meta.name,
        autoplay: meta.autoplay,
        loop: meta.loop,
        speed: 1,
        direction: 1,
        ...(meta.themeColor ? { themeColor: meta.themeColor } : {}),
      },
    ],
  }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2))

  // animation JSON with file-based image assets
  const jsonForPreview = JSON.parse(
    JSON.stringify(animation),
  ) as LottieAnimation
  const fileAssets: LottieAsset[] = []
  const imageFiles: { name: string; bytes: Uint8Array }[] = []

  // Rewrite image assets: embedded base64 → images/<file>
  const animationJson = JSON.parse(JSON.stringify(animation)) as LottieAnimation
  for (const asset of animationJson.assets) {
    if (asset.e === 1 && asset.p) {
      const bytes = images.get(asset.id)?.bytes
      if (bytes) {
        const ext = images.get(asset.id)!.ext
        const name = `${asset.id}.${ext}`
        asset.u = 'images/'
        asset.e = 0
        asset.p = name
        imageFiles.push({ name, bytes })
      } else {
        // keep embedded as fallback
        fileAssets.push(asset)
      }
    } else {
      fileAssets.push(asset)
    }
  }
  animationJson.assets = fileAssets

  zip.file(`animations/${meta.id}.json`, JSON.stringify(animationJson))
  for (const img of imageFiles) zip.file(`images/${img.name}`, img.bytes)

  const zipBytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  return { zip: zipBytes, jsonForPreview: jsonForPreview as LottieAnimation }
}

/**
 * Serialize an animation for download as a standalone .json file, embedding
 * image assets as base64.
 */
export async function animationToJsonBytes(animation: LottieAnimation, images: Map<string, { bytes: Uint8Array; ext: string; w: number; h: number }>): Promise<Uint8Array> {
  const copy = JSON.parse(JSON.stringify(animation)) as LottieAnimation
  for (const asset of copy.assets) {
    if (asset.e === 1 && asset.p) continue
    const img = images.get(asset.id)
    if (img) {
      asset.u = ''
      asset.e = 1
      asset.p = `data:image/${img.ext};base64,${base64(img.bytes)}`
    }
  }
  return new TextEncoder().encode(JSON.stringify(copy))
}
