# Figma Motion → dotLottie

A Figma plugin that exports your **Figma Motion** animations as **Lottie JSON**
and **dotLottie (`.lottie`)** files — using the *actual Motion keyframe data*
from the file, not a screen recording or an SVG guess. Keyframes, easing
curves, springs, transforms, opacity, trims and shapes are converted directly
into Lottie properties so the animation plays "as it is" after export.

```
Figma Motion (keyframes)  →  Lottie JSON  →  .lottie (ZIP: manifest.json + animations/*.json + images/)
```

## Why

- Figma Motion itself exports MP4/GIF/WebM/animated SVG — raster or CSS, not
  a runtime animation format.
- Figma's Plugin API (Update 130, June 2026) now exposes Motion data
  (`node.animations`, `node.timelines`, `figma.motion.*`), which makes a true
  keyframe-level export possible.
- This plugin reads that Motion data and hands you a file developers can drop
  into web/iOS/Android via any Lottie/dotLottie player.

## Requirements

- Figma desktop / web with **Update 130 (June 23, 2026) or newer** (Motion
  Plugin API). The plugin checks at startup and shows a friendly error
  otherwise.
- A Frame (top-level) with a Motion timeline containing your animation.
- Figma **Full seat** for Motion if on a paid plan (same requirement as
  Figma's own Motion feature).

## Install (development / self-hosted)

1. `npm install`
2. `npm run build` → produces `dist/main.js`, `dist/ui.js`, `dist/ui.html`
3. In Figma: **Plugins → Development → New plugin… → Link existing plugin**,
   then pick `manifest.json` in this folder. (Or import via
   `Plugins → Development → Import plugin from manifest…`.)
4. Run **Figma Motion → dotLottie** from your plugin menu.

`dist/` is committed so the plugin also runs without building.

## Usage

1. Select the **frame** that contains your Motion animation (or any node inside it).
2. Run the plugin.
3. The panel shows a live Lottie preview (play/pause, scrub, loop) plus export
   options:
   - **Name** — file/animations name
   - **Frame rate** — 30 / 60 / 120 fps (keyframe times are converted to frames)
   - **loop** — sets the dotLottie manifest `loop`
4. **Download .lottie** → spec-compliant dotLottie ZIP:
   ```
   manifest.json            # dotLottie 1.0 manifest
   animations/motion.json   # the Lottie JSON
   images/img_*.png         # rasterized assets (text fallback, media, unsupported nodes)
   ```
5. **JSON** → standalone `.json` with image assets embedded as base64.

> Tip: open `.lottie` files in LottieFiles (dotlottie web player / mobile
> runtimes), or any Lottie player that supports the container format.

## What gets converted "as is"

| Figma Motion feature | Lottie output |
| --- | --- |
| Position / Translation X/Y | Layer position (`p`) keyframes |
| Rotation | Layer rotation (`r`) |
| Scale X/Y | Layer scale (`s`) |
| Opacity | Layer opacity (`o`) |
| Width / Height (rect, ellipse) | Shape size or path-morph keyframes |
| Corner radius (uniform + per-corner) | `rc` radius or path morph |
| Stroke weight | Stroke width (`st.w`) |
| Path trim start/end | Trim paths (`tm`) — line-drawing animations |
| Fill / stroke color (solid paints) | Fill/stroke color keyframes |
| Ease in/out/in-out, back curves | Cubic-bezier control points on keyframes |
| Custom cubic bezier | Exact `x1,y1,x2,y2` mapping |
| Springs (GENTLE/QUICK/BOUNCY/SLOW/CUSTOM_SPRING) | Dense sampled keyframes (damped spring model) |
| Hold | `h: 1` hold keyframes |
| Frames / groups / components / instances | Nested precomps (full vector hierarchy, correct parent transforms) |
| Rectangles / ellipses / stars / polygons | Native Lottie shapes (`rc`/`el`/`sr`) |
| Vectors | Lottie paths (`sh`) from Figma `vectorPaths` |
| Lines, boolean ops, shape-with-text | Outline fills (exact visual) |
| Text | SVG-outline conversion to vector paths (falls back to PNG) |
| Image fills, video/embeds/widgets | PNG raster assets (`images/`) |
| Solid / linear / radial gradients | Lottie gradient fills (`gf`/`gs`) |
| Auto-layout animation (spacing) | ⚠️ Warned — a Lottie layer model stays fixed |

### Known limitations (honest list)

- **Effects** (shadows, blurs, glows) are not representable in plain Lottie —
  skipped with a warning.
- **Angular/diamond gradients, image fills on shapes, mixed paints** fall back
  to rasterized PNG (a warning tells you which node).
- **Text** is exported as outlined vector paths (editable as paths, not as
  font-rendered text layers) or rasterized if outline extraction fails.
- **Stroke alignment** inside/outside is approximated with center alignment.
- **Sheared transforms** (rotation + non-uniform scale) on a node get
  rasterized to keep the exact visual.
- Auto-layout gap/spacing/padding keyframes are read but not re-applied
  (Lottie has no layout engine) — a warning is emitted; node positions use
  the current layout.
- Spring easings are re-sampled via a damped-spring model; visually faithful,
  but not a byte-for-byte copy of Figma's internal curve.

## Architecture

```
src/
  model.ts        Intermediate scene model (runtime-agnostic, JSON-safe)
  motion.ts       Motion data helpers: track ops (SET/OFFSET/SCALE), stream
                  merging, easing → bezier control points, spring sampling,
                  affine matrix math
  path.ts         SVG path parser → Lottie paths; rounded rects, ellipse arcs
  svgparse.ts     DOM-free SVG parser (text-outline conversion)
  collect.ts      Figma runtime → SceneModel: reads node.animations,
                  timelines, paints, geometry, rasterizes fallbacks
  builder.ts      SceneModel → Lottie JSON (pure, unit-tested)
  dotlottie.ts    Lottie JSON + images → .lottie ZIP (JSZip)
  main.ts         Figma plugin main thread (message protocol with the UI)
  ui.ts / ui.html Plugin panel: live lottie-web preview + downloads
tests/            Vitest suites (easing, streams, paths, svg, builder)
```

Pipeline: `collect.ts` (runs in Figma) → `model.ts` (plain data) →
`builder.ts` (pure) → `dotlottie.ts` (ZIP). Keeping the builder pure means it
can be tested and reused outside Figma.

Times: Motion uses **seconds** → Lottie frames via `frame = second × fps`.
Values: Figma opacity/scale/trim normalized 0–1 are converted to Lottie's
0–100 scale; pixels/degrees pass through.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # esbuild → dist/
npm run watch       # rebuild on change
```

## Publishing (optional)

To publish to the Figma Community you need a Figma account with publish
rights: run the dev plugin, then **Plugins → Development → Publish…**.
Replace the placeholder `id` in `manifest.json` with the id Figma generates
on first publish.

## License

MIT (see `LICENSE`). Not affiliated with Figma, LottieFiles, or the Lottie
project.
