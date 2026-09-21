# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Liquid Gradient Tool** — a browser-only tool for designing animated
"liquid"/mesh gradients and exporting a seamlessly looping video/GIF for
use as a hero-section background. Plain ES modules, no framework, no
build step, no `package.json` — `index.html` loads `src/main.js`
directly via `<script type="module">`.

## Running locally

Must be served over HTTP, not opened as `file://` — GIF export loads a
Web Worker, which browsers block for local files.

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open in Chrome/Edge (requires WebGL2 and `MediaRecorder` with
`video/webm` support).

## Testing / verification

There is no test suite, linter, or build in this repo. Verification in
this project has been done ad hoc with Playwright against a local
static server. Playwright is available globally in this environment
but is not a project dependency, so it must be pointed at explicitly:

```bash
NODE_PATH=$(npm root -g) node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  // ...
})();
"
```

Do not run `playwright install` — the browser is pre-installed at that
path. Headless/software WebGL (swiftshader) logs noisy
`GL Driver Message ... GPU stall due to ReadPixels` and
`Automatic fallback to software WebGL` warnings on every `readPixels`
call; pipe test output through `grep -v "GL Driver\|Automatic fallback\|404"`.

When changing anything that touches timing/animation, don't just eyeball
a screenshot — verify the loop is still seamless by reading back pixels
for `phase = 0.0` vs `phase = 1.0` directly from the renderer
(`gl.finish()` then `gl.readPixels(...)`); they must be bit-identical.
See "The seamless-loop technique" below for why that's the actual
invariant, and why it holds for any `amplitude`/`loops` value, not just
`loops = 1`.

## Architecture

- **`src/main.js`** — the entire UI/state layer. One mutable `state`
  object; `currentParams()` derives shader-ready params from it (e.g.
  `speedToAmplitude()` applies a cubic ease to the speed slider — see
  below). A `requestAnimationFrame` loop (`previewLoop`) continuously
  re-renders, using `state.duration` as the wall-clock loop period.
  There's no framework or reactivity layer: every control's event
  listener mutates `state` directly and, where needed, re-renders the
  affected DOM (e.g. `renderColorList()`, `updateMaskUi()`).
- **`src/render/shaders.js`** — GLSL source as template strings
  (`VERTEX_SHADER`, `FRAGMENT_SHADER`), plus the vendored 4D simplex
  noise (`SIMPLEX_4D`). The vertex shader draws a fullscreen triangle
  from `gl_VertexID` alone — no vertex buffers.
- **`src/render/LiquidGradientRenderer.js`** — thin WebGL2 wrapper.
  Compiles/links the program once in the constructor; `render(params,
  phase)` sets all uniforms and issues one draw call. Owns a single
  mask texture bound to `TEXTURE0`: `setMaskImage()` uploads a
  user-supplied image into it, otherwise it stays a 1×1 white
  placeholder (so mask mode `'custom'` with nothing uploaded yet is a
  harmless no-op, not a black screen).
- **`src/export/exportWebm.js`** / **`exportGif.js`** — both take a
  `renderFrame(phase)` callback (which just calls
  `renderer.render(currentParams(), phase)`) and drive it frame-by-frame
  at exact `phase = i / totalFrames` steps, independent of the live
  preview loop. WebM paces emission to real time via
  `canvas.captureStream(0)` + `track.requestFrame()` (so a manual,
  exactly-once-per-frame capture instead of wall-clock sampling); GIF
  renders as fast as possible and hands frames to gif.js with explicit
  per-frame delays.
- **`src/presets.js`** — static palette data plus `presetGradientCss()`
  for the swatch UI. No other state.
- **`vendor/`** — runtime dependencies checked into the repo instead of
  fetched from a CDN or installed via npm (there is no `node_modules`):
  - `vendor/webgl-noise/simplex4d.glsl` — reference copy of the
    Ashima/Gustavson 4D simplex noise. The version actually used at
    runtime is hand-inlined into `SIMPLEX_4D` in `shaders.js`; if you
    ever touch the noise math, keep both in sync.
  - `vendor/gifjs/` — gif.js and its worker script, loaded dynamically
    by `exportGif.js` via `<script>`/`Worker` URLs built with
    `import.meta.url`. Don't switch this to a CDN import.

### The seamless-loop technique (the one non-obvious invariant)

The tool's entire value proposition is that exports loop with no visible
seam. This works by sampling the 4D simplex noise at
`vec4(x, y, cos(θ)·amplitude, sin(θ)·amplitude)`, where
`θ = phase · 2π · loops` (`loopCircle()` / `fbm()` in `shaders.js`).
Because `(cos θ, sin θ)` is periodic, `phase = 0.0` and `phase = 1.0`
always land on the exact same point in noise-space — frame 0 and the
last frame are pixel-identical — **for any `amplitude` and any positive
integer `loops`**, not only `loops = 1`.

`loops` is currently hardcoded to `1` in `main.js`'s `currentParams()`.
The "Скорость движения" (speed) UI slider instead controls `amplitude`
(via `speedToAmplitude()`, a cubic ease chosen empirically because
frame-to-frame visual change saturates once amplitude passes ≈0.4 —
raw linear mapping spent most of the slider's range feeling identical).

If you add any new time-varying effect to the shader, it must be driven
through this same phase→circle mapping, never through `phase` directly,
or the exported loop will visibly jump at the seam.

### Mask modes

`state.maskMode` is `'none' | 'circle' | 'custom'`, mapped to
`u_maskMode` 0/1/2 in the fragment shader. `'circle'` is a pure
distance-field mask, no texture involved. `'custom'` samples
`u_maskTex` (luminance × alpha of the uploaded image), stretched to
fill the canvas with no aspect-ratio correction. Both non-`'none'`
modes blend the gradient against `state.bgColor` via `mix()`, and both
support `state.maskInvert`.

### Glass mode

`state.glassEnabled` (+ `glassSpecular`/`glassFresnel`/`glassContrast`/
`glassAngle`) turns on a "liquid glass sphere" overlay: a fake normal
for a sphere inscribed in the canvas (same `r = length(uv-0.5, aspect-
corrected) * 2` convention as the circle mask, so `r = 1` at the
silhouette) drives a Blinn-Phong specular highlight, a Fresnel rim glow,
and a diffuse light/dark hemisphere split, all computed in the fragment
shader after the mask blend (end of `main()` in `shaders.js`). It is
**completely independent of `maskMode`** — glass lights the whole frame
regardless of what shape the mask cropped, fading its own influence to
zero past the sphere's silhouette (`sphereFade`/`rimFade`) rather than
hard-clipping — so combine it with the `'circle'` mask (as the UI hint
says) if you want the background outside the sphere actually cropped
away, not just unlit. All of its inputs (light angle, intensities) are
static UI parameters, never derived from `phase`, so it cannot break
the seamless-loop invariant above — verified with the same
`phase=0.0` vs `phase=1.0` pixel-readback check with `glassEnabled:
true`.
