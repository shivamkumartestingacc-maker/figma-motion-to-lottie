/**
 * Plugin UI: live Lottie preview (lottie-web), transport controls, export
 * settings and download buttons. All libraries are bundled locally — no
 * network access needed.
 */

import lottie, { type AnimationItem } from 'lottie-web'

interface ReadyMessage {
  type: 'ready'
  animation: unknown
  lottie: Uint8Array
  name: string
  duration: number
  fps: number
  warnings: { code: string; message: string; node?: string }[]
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const playerEl = $<HTMLDivElement>('player')
const hintEl = $<HTMLDivElement>('hint')
const errorEl = $<HTMLDivElement>('error')
const transportEl = $<HTMLElement>('transport')
const panelEl = $<HTMLElement>('panel')
const playBtn = $<HTMLButtonElement>('playBtn')
const scrub = $<HTMLInputElement>('scrub')
const timeEl = $<HTMLSpanElement>('time')
const nameInput = $<HTMLInputElement>('name')
const fpsSelect = $<HTMLSelectElement>('fps')
const loopChk = $<HTMLInputElement>('loop')
const jsonBtn = $<HTMLButtonElement>('jsonBtn')
const lottieBtn = $<HTMLButtonElement>('lottieBtn')
const warningsEl = $<HTMLElement>('warnings')
const warningsList = $<HTMLUListElement>('warningsList')
const toastEl = $<HTMLDivElement>('toast')

let anim: AnimationItem | null = null
let current: ReadyMessage | null = null
let playing = true
let toastTimer: number | undefined

function show(id: HTMLElement, visible: boolean) {
  id.hidden = !visible
}

function toast(msg: string) {
  toastEl.textContent = msg
  toastEl.classList.add('show')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1800)
}

function postRun() {
  parent.postMessage(
    { pluginMessage: { type: 'run', fps: Number(fpsSelect.value), loop: loopChk.checked, autoplay: true } },
    '*',
  )
}

function loadAnimation(data: ReadyMessage) {
  current = data
  nameInput.value = data.name
  if (data.warnings.length > 0) {
    warningsList.innerHTML = ''
    for (const w of data.warnings) {
      const li = document.createElement('li')
      li.textContent = w.node ? `${w.node}: ${w.message}` : w.message
      warningsList.appendChild(li)
    }
    show(warningsEl, true)
  } else {
    show(warningsEl, false)
  }

  if (anim) {
    anim.destroy()
    anim = null
  }
  anim = lottie.loadAnimation({
    container: playerEl,
    renderer: 'svg',
    loop: loopChk.checked,
    autoplay: true,
    animationData: data.animation as never,
    rendererSettings: { preserveAspectRatio: 'xMidYMid meet', progressiveLoad: true },
  })
  playing = true
  playBtn.textContent = 'Pause'
  anim.addEventListener('enterFrame', () => {
    const t = anim!.currentFrame / (anim!.frameRate || data.fps)
    scrub.value = String(Math.round((t / Math.max(data.duration, 0.001)) * 1000))
    timeEl.textContent = `${t.toFixed(2)}s`
  })
  anim.setSubframe(true)
}

function download(bytes: Uint8Array | string, mime: string, filename: string) {
  const blob = new Blob([bytes as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4000)
}

function safeName(name: string): string {
  const n = name.trim().replace(/[\\/:*?"<>|]+/g, '-')
  return n || 'animation'
}

playBtn.addEventListener('click', () => {
  if (!anim) return
  if (playing) {
    anim.pause()
    playBtn.textContent = 'Play'
  } else {
    anim.play()
    playBtn.textContent = 'Pause'
  }
  playing = !playing
})

scrub.addEventListener('input', () => {
  if (!anim || !current) return
  const t = (Number(scrub.value) / 1000) * Math.max(current.duration, 0.001)
  anim.goToAndStop(t * (anim.frameRate || current.fps), true)
})

loopChk.addEventListener('change', () => {
  if (anim) anim.loop = loopChk.checked
  postRun()
})

fpsSelect.addEventListener('change', postRun)

jsonBtn.addEventListener('click', () => {
  if (!current) return
  const json = JSON.stringify(current.animation)
  download(json, 'application/json;charset=utf-8', `${safeName(current.name)}.json`)
  toast('Lottie JSON downloaded')
})

lottieBtn.addEventListener('click', () => {
  if (!current) return
  download(current.lottie, 'application/octet-stream', `${safeName(current.name)}.lottie`)
  toast('.lottie file downloaded')
})

window.onmessage = (ev: MessageEvent) => {
  const msg = ev.data?.pluginMessage as
    | { type: 'loading' }
    | { type: 'error'; title?: string; message: string }
    | ReadyMessage
  if (!msg) return
  switch (msg.type) {
    case 'loading':
      show(hintEl, true)
      hintEl.innerHTML = '<strong>Reading Motion keyframes…</strong>'
      show(errorEl, false)
      break
    case 'error':
      show(playerEl, false)
      show(hintEl, false)
      show(errorEl, true)
      show(transportEl, false)
      show(panelEl, false)
      errorEl.innerHTML = `<strong>${msg.title ?? 'Error'}</strong><br/>${escapeHtml(msg.message)}`
      break
    case 'ready':
      show(hintEl, false)
      show(errorEl, false)
      show(playerEl, true)
      show(transportEl, true)
      show(panelEl, true)
      loadAnimation(msg)
      break
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
