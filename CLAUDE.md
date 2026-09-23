# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Liquid Gradient Tool** — a browser-only tool for designing animated
"liquid"/mesh gradients and exporting a seamlessly looping video/GIF for
use as a hero-section background. Plain ES modules, no framework, no
build step, no `package.json` — `index.html` loads `src/main.js`
directly via `<script type="module">`
(through `src/boot.js`, see below).

## Running locally

Must be served over HTTP, not opened as `file://` — GIF export loads a
Web Worker, which browsers block for local files.

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open in Chrome/Edge (requires WebGL2 and WebCodecs; MP4 additionally
needs the browser's H.264 encoder).

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

- **`src/boot.js`** — the entry point. Touch-first devices
  (`(hover: none) and (pointer: coarse)`: phones, tablets) get a
  "desktop only" banner (`.desktop-only`, swapped in by the same media
  query in `style.css`) and `main.js` is never imported, so no WebGL
  context or render loop starts there. On desktop it sets
  `document.documentElement.style.zoom` to
  `max(1, min(innerWidth / 1920, innerHeight / 1080))` (the mock is
  1920×1080; 2560×1440 → 1.33) and then imports `main.js`. Nothing in
  the app reads pointer coordinates, so CSS `zoom` is safe; if you add
  something that does, remember `getBoundingClientRect()` returns
  zoomed values.
- **`src/main.js`** — the entire UI/state layer. One mutable `state`
  object; `currentParams()` derives shader-ready params from it (e.g.
  `speedToAmplitude()` applies a cubic ease to the speed slider — see
  below). A `requestAnimationFrame` loop (`previewLoop`) continuously
  re-renders, using `state.duration` as the wall-clock loop period.
  There's no framework or reactivity layer: every control's event
  listener mutates `state` directly and, where needed, re-renders the
  affected DOM (e.g. `renderColorList()`, `updateOutputMeta()`). Errors/success are reported inline via
  `showStatus()`, not `alert()`. The global Ctrl+Z palette undo is
  skipped while a text/number input has focus (`isTextEditing()`).
- **`src/render/shaders.js`** — GLSL source as template strings
  (`VERTEX_SHADER`, `FRAGMENT_SHADER`), plus the vendored 4D simplex
  noise (`SIMPLEX_4D`). The vertex shader draws a fullscreen triangle
  from `gl_VertexID` alone — no vertex buffers.
- **`src/render/LiquidGradientRenderer.js`** — thin WebGL2 wrapper.
  Compiles/links the program once in the constructor; `render(params,
  phase)` sets all uniforms and issues one draw call. No textures.
- **Exporters** all take a `renderFrame(phase)` callback (which just
  calls `renderer.render(currentParams(), phase)`) and drive it
  frame-by-frame at exact `phase = i / totalFrames` steps. The UI has one
  export button; `state.format` is `'webm+mp4' | 'webm' | 'mp4' | 'gif'`
  and `'webm+mp4'` runs the two video exports sequentially, keeping the
  WebM even if MP4 fails (typically: no H.264 encoder).
  - **`src/export/exportVideo.js`** — default path for WebM and MP4:
    WebCodecs `VideoEncoder` (VP9 / H.264 High) with `bitrate` from the
    UI and `alpha: 'discard'`, timestamps from the frame index (not the
    clock), packed by the vendored muxers. Codec level strings are
    computed from size × fps via the H.264 / VP9 level tables in that
    file — encoders reject configs whose level is too low.
    `videoSupportProblem()` probes `isConfigSupported` and distinguishes
    "no encoder" from "unsupported size/fps".
  - **webm-muxer writes the wrong duration**: it sets Segment › Info ›
    Duration to the *start* of the last frame (48 frames @ 24 fps →
    1.958 s), so players give the loop's last frame ~0 time.
    `setWebmDuration()` patches that EBML element after `finalize()`.
    mp4-muxer is fine (uses chunk durations). Verify both with a
    `<video>`'s `duration` after any muxer change.
  - **`src/export/exportWebm.js`** — `MediaRecorder` path, used only
    when "Убрать из WebM" (remove alpha) is unchecked: Chrome's
    MediaRecorder writes VP9 with an alpha plane (`AlphaMode = 1`) for
    canvas captures even though our pixels are opaque, and WebCodecs
    here reports `alpha: 'keep'` for VP9 as unsupported. It stamps
    frames by wall clock, so it paces against an absolute schedule and
    still stretches the video if rendering is slower than real time.
  - **`src/export/exportGif.js`** — gif.js, renders as fast as possible
    with explicit per-frame delays.
- **H.264 can't be tested in this sandbox**: the pre-installed Chromium
  has no proprietary codecs (`isConfigSupported` false for any `avc1.*`,
  MediaRecorder `video/mp4;codecs=avc1` false). To exercise the MP4
  code path, copy `exportVideo.js` to a temp file with `avcCodec` →
  `vp9Codec` and mp4-muxer `codec: 'avc'` → `'vp9'` (MP4 can carry VP9),
  import it in the page, and check `<video>.duration` and that the
  file starts with `ftyp` then `moov`. Delete the temp file afterwards.
- **Custom sizes are rounded to even** in `clampSize()` — H.264 (4:2:0)
  rejects odd dimensions.
- **Export and preview share one canvas, so the preview loop is paused
  during export** (`exporting` flag in `main.js`, set by `setBusy()`).
  This is load-bearing: `previewLoop` calls `renderer.setSize()` to the
  preview size every frame, and gif.js copies frames with an unscaled
  `drawImage(canvas, 0, 0)` — before the flag existed, 47 of 48 GIF
  frames at default settings (1600×900 → 480×270 GIF) were a cropped
  top-left corner of the full-size render. Any new export path must go
  through `setBusy(true)` too.
- **UI layout** follows the Figma mock (file `crJpeY2AsxP794ZHPIIQwd`,
  node `2001:115`; its colors are the tokens on `:root` in `style.css`).
  `.layout` is one flat CSS grid with named areas: `.controls` (colors +
  flow cards side by side, grain card below, 568px) | `.canvas-wrap`
  preview | `.output` export card (332px), and the `.gallery` of
  results underneath (hidden until the first export). ≤1439px the export
  card moves under the preview; ≤1023px it's one column with the preview
  sticky on top. The canvas sits in an absolutely positioned
  `.canvas-box` so its intrinsic size (the export size) never stretches
  the grid row. Sliders are restyled native ranges: `bindRange()` writes
  the `--fill` percentage the WebKit track gradient uses. Icons are text
  glyphs (↶ ↷ ▾ ⠿ ✕ ↻) on purpose — the user asked to keep them rather
  than the mock's icon set. The global `[hidden] { display: none
  !important }` rule exists because component rules like
  `.field { display: flex }` otherwise override the `hidden` attribute.
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
  - `vendor/webm-muxer/`, `vendor/mp4-muxer/` — unmodified `.mjs`
    builds (MIT, ~65 KB each), imported as ES modules by
    `exportVideo.js`. npm marks both as superseded by Mediabunny; they
    were kept on purpose (Mediabunny's smallest bundle is ~684 KB,
    MPL-2.0) — see each folder's README.

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

### Grain layer

"Шум (зерно)" (`state.grain*`, passed as `params.grain`) is drawn at the
end of the fragment shader on a grid of `u_grainSize`-pixel cells in
**output pixels** (`gl_FragCoord`), so it scales with the export size
(GIF, rendered smaller, gets relatively bigger grain). Size 1 = one
pixel per cell; ≥ 2 = round dots jittered anywhere in their cell, which
needs a 3×3 neighbour search so dots aren't clipped (dots kept near
cell centres read as a visible grid).

- **Animated, and still seamless.** The grain re-rolls every frame:
  `frame = mod(floor(u_phase * u_grainFrames + 0.5), u_grainFrames)` is
  the hash's z. `u_grainFrames` must equal the exporter's frame count
  (`round(fps × duration)`), which `currentParams(fps)` computes via
  `loopFrames()` — GIF passes its own capped fps, so don't render GIF
  frames with the default `currentParams()`. The `mod` makes phase 1.0
  frame 0 again (verified: phase 0 vs 1 bit-identical for all blend
  modes); the `+ 0.5` stops `i / n * n` rounding down to `i − 1`.
- Randomness: Dave Hoskins' "Hash without Sine" (`hash13` / `hash23`,
  xy = cell, z = frame). Checked at size 1: changed-pixel share matched
  density (0.101 / 0.499 / 0.9 for 10 / 50 / 90%); variance 100% gives
  a uniform brightness spread (mean 126.9, σ 73.5 vs 127.5 / 73.6).
- Blend modes `blendOverlay()` / `blendSoftLight()` follow W3C
  Compositing and Blending Level 1; they matched a JS reference of
  those formulas exactly on 18 flat-backdrop combinations.
- GLSL lives in JS template literals — a backtick in a shader comment
  ends the string and breaks the module (it happened once).

### Removed on purpose

The output is always a full-frame rectangle. Masks (a circle mask, and
before it custom image masks) and a "glass" sphere-lighting mode
existed at some point and were removed at the user's request — don't
reintroduce them unless asked.

### Slider semantics worth knowing

"Баланс цветов" is `state.softness` → `pow(field, mix(2.2, 0.45, x))`
in the shader: it biases the field toward the first vs. last colors of
the list, it is not a contrast control. `bindRange()` captures each
slider's initial `state` value as its double-click reset default.
