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

There is no linter or build in this repo, but there is one automated
test: **`tests/seam.cjs`**. It's CommonJS on purpose (the repo has no
`package.json`, so `NODE_PATH=$(npm root -g)` is how it finds the
globally-installed Playwright, which is otherwise not a project
dependency). It needs no `npm install`:

```bash
NODE_PATH=$(npm root -g) node tests/seam.cjs 2>&1 | grep -v "GL Driver\|Automatic fallback"
```

`tests/seam.cjs` spins up a plain Node `http` server over the repo root
(plus a virtual `/__seam.html` test page that imports
`LiquidGradientRenderer.js` directly — it never touches `main.js` or the
real UI), drives it with Playwright/Chromium
(`executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium'`),
and for a matrix of cases — amplitude 0.001/0.125/1, `loops` 1 and 2,
grain off and on (blend `normal`/`overlay`/`softlight`, sizes 1 and 3,
120 frames), 2–6 colors, different seeds, and an odd canvas size
(97×61) as well as the normal 160×90 — renders `phase = 0.0` and
`phase = 1.0` (`gl.finish()` then `gl.readPixels(...)`) and asserts the
two framebuffers are byte-identical, per "The seamless-loop technique"
below. It also asserts phase 0 vs phase 0.5 at amplitude 1 *differ*, so
the test can't pass trivially. Exits non-zero on any mismatch or page
error. Verified to actually catch a broken loop via a `--self-test`
flag that deliberately shifts the seed used for `phase = 1.0` on one
case and expects (and gets) a `FAIL` there:
`NODE_PATH=$(npm root -g) node tests/seam.cjs --self-test 2>&1 | grep -v "GL Driver\|Automatic fallback"`.

Do not run `playwright install` — the browser is pre-installed at that
path. Headless/software WebGL (swiftshader) logs noisy
`GL Driver Message ... GPU stall due to ReadPixels` and
`Automatic fallback to software WebGL` warnings on every `readPixels`
call; pipe test output through `grep -v "GL Driver\|Automatic fallback\|404"`.

When changing anything that touches timing/animation, don't just eyeball
a screenshot — run `tests/seam.cjs` (or, for a one-off check outside its
matrix, read back pixels for `phase = 0.0` vs `phase = 1.0` directly
from the renderer the same way it does — `gl.finish()` then
`gl.readPixels(...)`; they must be bit-identical). See "The
seamless-loop technique" below for why that's the actual invariant, and
why it holds for any `amplitude`/`loops` value, not just `loops = 1` —
`tests/seam.cjs` covers both `loops` values and a range of amplitudes
for exactly that reason.

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
- **`src/session.js`** — the session survives reloads. Settings: the
  keys of `state` listed in its `VALIDATORS` go to `localStorage`
  (`liquid-gradient:settings:v1`); on load each saved value is used only
  if it passes its validator, so stale/garbage data falls back to the
  default per key. `main.js` keeps the factory values in `DEFAULTS`
  (double-click reset and "✕" on the grain color use those, not the
  restored ones) and saves with one debounced capture-phase listener
  for input/change/click/drop plus `pagehide` — every state change comes
  from a user event, so new controls are covered automatically, but a
  **new state key must be added to `VALIDATORS`** or it won't persist.
  Exported files: IndexedDB `liquid-gradient` › `results` (Blob + name,
  size, `batch`), capped at `MAX_SAVED_RESULTS` (30) — the oldest are
  deleted from both the DB and the gallery. `batch` is the export
  click's timestamp; every card of the newest batch (WebM + MP4 + PNG
  poster = up to three files) gets the "Последнее" badge. Storage errors
  only `console.warn`.
- **Settings link** — "Скопировать ссылку на настройки" (below
  `#formatHint` in the export card) copies
  `location.origin + location.pathname + '#s=' + base64url(JSON)`, the
  JSON being every `VALIDATORS` key from `session.js` *except*
  `patternHistory` (personal) and `previewRadius` (preview-only cosmetic)
  — see `LINK_EXCLUDED_SETTINGS` and `SETTINGS_KEYS` in `main.js`.
  base64url is UTF-8-safe (`TextEncoder` → `btoa` over the raw bytes,
  then `+/` → `-_`, padding stripped). On load, a `#s=` hash is decoded
  and passed through `session.js`'s exported `validateSettings(obj)` —
  the same per-key check `loadSettings()` uses — before being applied
  over the restored settings, right where `Object.assign(state,
  loadSettings())` already sits, so a seed carried by the link flows
  into the pattern-history seeding right below it. A broken/tampered
  hash is caught and ignored (`showStatus` reports the error). Either
  way `history.replaceState()` strips the hash immediately so a reload
  doesn't reapply it, and a successful import is saved right away with
  `saveSettings()` since it didn't come from a user event.
  Import also drops `LINK_EXCLUDED_SETTINGS`, and a link with nothing
  valid left reports an error. The import code runs once at module load,
  so a `#s=` pasted into an already-open tab triggers a `hashchange` →
  `location.reload()` (deferred to the end of a running export).
- **Pattern history** (`#patternHistory` in `.pattern-bar` at the bottom
  of `.canvas-wrap`, right of the "↻ Новый узор" button, which drops its
  text below a 460px-wide preview; **N** — `e.code === 'KeyN'`, so it
  works in any keyboard layout — clicks that same button, unless a text
  field has focus, an export is running, or it's a key-repeat) — the
  last `MAX_PATTERN_HISTORY` (5) seeds, newest first, as
  `state.patternHistory = [{ seed, createdAt, pinned?, params }]`,
  persisted like any other state key. `params` is the entry's own look
  (`PATTERN_KEYS` in session.js: colors, scale, warp, softness, speed).
  "Новый узор" unshifts an entry with the current look; clicking one
  sets `state.seed` and restores its `params` into the sliders and
  palette (`applyPatternParams()`; a palette change goes on the undo
  stack). The *active* entry follows the controls (`syncActivePattern()`
  each preview frame), so edits stay with it; other entries never
  change. Thumbnails render each entry with its own `params`. Entries
  saved before `params` existed get the current look on load. Order and
  timestamps never change;
  `aria-pressed` marks the entry whose seed equals `state.seed`. Each
  entry also has a ☆/★ pin toggle (`.pattern-pin`, layered over the
  thumbnail's corner via a `.pattern-slot` wrapper — `<button>` can't
  nest inside `<button>`) — pinned entries are exempt from eviction:
  `pushPatternHistory()` in `main.js` drops the oldest *unpinned* entry
  once the list exceeds `MAX_PATTERN_HISTORY`, never a pinned one.
  Pinning is capped at `MAX_PINNED_PATTERNS` (`MAX_PATTERN_HISTORY − 1`
  = 4) — one slot short of the cap, so a freshly generated pattern
  always has somewhere to land; past the cap, other entries' pin buttons
  go `disabled`. `isPatternHistory` rejects a saved history with more
  than 4 pins. `.pattern-pin` is a 24×24 hit target (WCAG 2.2 target
  size) with a smaller visible disc drawn by `::before` at `z-index: -1`;
  the button's own `z-index: 1` keeps that disc above the thumbnail. On load the current
  seed is added if missing, so the strip is never empty. Labels: a
  bare age on screen ("42 с", "3 мин", fits 48px items), the full
  `Intl.RelativeTimeFormat('ru')` phrase in title/aria-label; refreshed
  every second so the first minute counts up. Thumbnails are
  rendered on the shared WebGL canvas inside `previewLoop`'s
  `!exporting` branch, before the preview's own render, at phase 0 with
  grain off, and copied into per-item 2D canvases with `drawImage` right
  after each draw; the preview render afterwards restores the size. They
  redraw only when `patternSignature()` changes (export size, each
  entry's seed and params), throttled. **A new shader param
  that changes the phase-0 image must be added to `patternSignature()`**,
  or thumbnails go stale. `.canvas-box` reserves `--pattern-strip-h` at
  the bottom so the canvas never sits under the strip.
- **Preview corner radius** (`.radius-handle` ×4 in `.canvas-box`) —
  **preview only**, the export stays a full rectangle (the user chose
  this; see "Removed on purpose"). `state.previewRadius` is a share of
  the canvas's short side, 0…0.5 (0.5 on a 1:1 size = circle), applied
  as a px `border-radius` by `applyPreviewRadius()`, re-run by a
  ResizeObserver on the canvas and its box. Handles sit on each corner
  arc's midpoint (`r·(1 − 1/√2)` in, min 12px) and drag *relative* to
  the pointerdown point. Pointer math uses `getBoundingClientRect()`
  ratios only, so boot.js's root `zoom` cancels out. The first handle is
  the keyboard `role="slider"` (arrows, Shift = ×5, Home/End); the other
  three are `aria-hidden`.
- **`src/render/shaders.js`** — GLSL source as template strings
  (`VERTEX_SHADER`, `FRAGMENT_SHADER`), plus the vendored 4D simplex
  noise (`SIMPLEX_4D`). The vertex shader draws a fullscreen triangle
  from `gl_VertexID` alone — no vertex buffers.
- **`src/render/LiquidGradientRenderer.js`** — thin WebGL2 wrapper.
  Compiles/links the program once in the constructor; `render(params,
  phase)` sets all uniforms and issues one draw call. No textures.
- **Export never reads live `state`.** `el.exportBtn`'s click handler
  takes one `structuredClone` snapshot of the export-relevant `state`
  keys (`snapshotExportState()`, `EXPORT_STATE_KEYS` in `main.js`) before
  starting anything, and every exporter — including its `renderFrame`
  callback — is given that snapshot, never `state`. For `'webm+mp4'` both
  files come from the same snapshot. This is what makes an export
  immune to the user moving a slider, editing a color or picking a new
  pattern while it runs: exporters take shader params via `buildParams
  (source, fps)`, a `source`-agnostic version of what used to be
  `currentParams()` (`currentParams(fps)` is now just
  `buildParams(state, fps)`, still used by the live preview and pattern
  thumbnails). Adding a new export-affecting control means adding its
  key to both `EXPORT_STATE_KEYS` and `VALIDATORS` (session.js) — the
  latter for persistence, the former so export snapshots it.
  Controls are also made inert while exporting (`inertPanels` in
  `setBusy()`: `.controls`, `.pattern-bar`, `.output-settings`) so none
  of this is left silently doing nothing — `#exportBtn`/`#exportProgress`
  (which holds `#cancelExportBtn`) sit outside all three and stay
  reachable; the preview's corner-radius handles are preview-only and
  are deliberately left alone. `setBusy()` also moves focus to `#cancelExportBtn` on
  start and back to `#exportBtn` at the end (only if focus was on the
  export controls or `<body>`), both with `preventScroll`.
- **Cancelling an export** goes through a plain `AbortController` created
  fresh per export click and stored so `#cancelExportBtn` can call
  `.abort()` on it. `exportVideo`/`exportGif` take a `signal` and check
  `signal.throwIfAborted()` between frames (and, for `exportVideo`, while
  draining the encoder queue), so a cancellation surfaces as a normal
  rejection with `err.name === 'AbortError'` — the click handler treats
  that specially: no `console.error`, no entry in the failure list,
  status becomes "Экспорт отменён." (`kind: 'cancelled'`, a dedicated,
  non-red `.status[data-kind]` style), and for `'webm+mp4'` the loop
  breaks instead of starting the second container. Whatever file(s) had
  already finished stay in the gallery. `exportVideo.js` closes its
  `VideoEncoder` exactly once via a small `closeEncoder()` guarded by a
  `encoderClosed` flag in a `finally`, since `.close()` throws if called
  twice and abort can land mid-loop before `flush()`/`close()` would
  otherwise run. `exportGif.js` can't simply skip a step: once frame
  rendering has finished, gif.js's own `render()`/worker pipeline is
  already the only way to stop, so cancelling then calls the GIF's
  `.abort()` (present in `vendor/gifjs/gif.js`) and the pending promise
  rejects with the abort signal's reason.
- **PNG poster.** `state.poster` (bool, default `true`; in
  `EXPORT_STATE_KEYS`/`VALIDATORS`) adds a checkbox in `.output-settings`,
  hidden for GIF. For video formats, after the container(s) export, the
  click handler renders the same snapshot's phase 0 at export size
  (`renderer.setSize`/`render`) and calls `canvas.toBlob(...,
  'image/png')` immediately after — safe because the GL context is
  created with `preserveDrawingBuffer: true`. Saved via `addResult` as
  `liquid-gradient-WxH.png`, same `batch`, `isVideo: false` (shown as
  `<img>`); `FORMAT_LABELS.png` gives the download button "Скачать PNG".
- **Size preset buttons** (`.size-preset-btn`, under the width×height
  fields) call the existing `applyResolution()`; `aria-pressed` tracks
  whether `state.width`/`height` match, refreshed by
  `updateSizePresetActive()` on every `applyResolution()` call.
- **Exporters** all take a `renderFrame(phase)` callback and drive it
  frame-by-frame at exact `phase = i / totalFrames` steps. The UI has one
  export button; `state.format` is `'webm+mp4' | 'webm' | 'mp4' | 'gif'`
  and `'webm+mp4'` runs the two video exports sequentially, keeping the
  WebM even if MP4 fails (typically: no H.264 encoder).
  - **`src/export/exportVideo.js`** — the only video path (WebM and
    MP4 both): WebCodecs `VideoEncoder` (VP9 / H.264 High) with
    `bitrate` from the UI and `alpha: 'discard'`, timestamps from the
    frame index (not the clock), packed by the vendored muxers. Codec
    level strings are computed from size × fps via the H.264 / VP9
    level tables in that file — encoders reject configs whose level is
    too low. `videoSupportProblem()` probes `isConfigSupported` and
    distinguishes "no encoder" from "unsupported size/fps".
  - **webm-muxer writes the wrong duration**: it sets Segment › Info ›
    Duration to the *start* of the last frame (48 frames @ 24 fps →
    1.958 s), so players give the loop's last frame ~0 time.
    `setWebmDuration()` patches that EBML element after `finalize()`.
    mp4-muxer is fine (uses chunk durations). Verify both with a
    `<video>`'s `duration` after any muxer change.
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
- **Preview renders at screen size, not export size** (grain off):
  `previewRenderSize` = the export aspect contain-fit into `.canvas-box`
  × `devicePixelRatio` × boot.js's root `zoom`, capped at the export
  size, `h` derived from `w` so the aspect matches to the pixel. With
  grain on it's the full export size (grain is in output pixels).
  Cached; recomputed by `refreshPreviewRenderSize()` on a ResizeObserver
  over `.canvas-box`, `applyResolution()` and the grain toggle, never per
  frame. It also sets `canvas.style.width/height` explicitly — otherwise
  `max-width/max-height: 100%` would size the canvas from its (now
  smaller) buffer. Exports and thumbnails set their own size as before.
- **Visual style is shadcn/ui** (new-york-v4 components, neutral dark
  theme), ported to plain CSS — there is no React/Tailwind here. The
  `:root` tokens in `style.css` are shadcn's `.dark` values
  (`apps/v4/app/globals.css` in shadcn-ui/ui) converted from oklch to
  hex (`--background`, `--card`, `--primary`, `--muted-foreground`, …,
  radii `--radius-sm/md/lg/xl` = 6/8/10/14px), and each component block
  names the shadcn component whose Tailwind classes it mirrors (Button
  outline/ghost/link/default, Input, Select trigger, Slider, Switch,
  Checkbox, ToggleGroup, Card, Badge, Progress). New controls should
  reuse those blocks (e.g. add the class to the shared "outline" rule)
  rather than invent a look. Native `<select>`s keep the OS list; only
  the trigger is restyled, with a `▾` glyph via `.select-wrap::after`.
- **UI layout** follows the Figma mock (file `crJpeY2AsxP794ZHPIIQwd`,
  node `2001:115`) for structure and sizes; its original colors were
  replaced by the shadcn tokens above.
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
  than the mock's icon set. The gallery strip hides its scrollbar, so
  `main.js` maps a vertical mouse wheel to horizontal scroll (handing it
  back to the page at either end) and toggles `.more-before` /
  `.more-after` for the edge fades. The global `[hidden] { display: none
  !important }` rule exists because component rules like
  `.field { display: flex }` otherwise override the `hidden` attribute.
- **Color contrast (WCAG 2.2 AA)** is a requirement, not a nicety. Text
  must be ≥ 4.5:1 on `--card` *and* `--field` (#212121, the opaque
  equivalent of shadcn's `bg-input/30` on the card), so nothing dimmer
  than `--muted-foreground` (#a1a1a1, 6.2:1 on field) may be used for
  text. Boundaries of interactive controls (inputs, selects, color rows,
  buttons, the empty part of slider tracks, the switch, the checkbox)
  use `--control-border` (#6e6e6e, 3.2:1 on field, 3.5:1 on card;
  1.4.11) — this is the one deliberate deviation from shadcn, whose
  `--input` (white 15%) and `--muted` track are ~1.3–1.6:1. `--border`
  (white 10%) is only for cards. shadcn's 3px `ring-ring/50` focus ring
  is kept, but always together with a `--ring` border or a solid 2px
  `--ring` outline, since the translucent ring alone is ~1.9:1. Check with axe-core (`npm pack axe-core`, inject `axe.min.js`,
  `axe.run` with the wcag2aa/wcag22aa tags) — it can't judge text over
  the preset gradients or single-glyph icons, so compute those by hand.
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
  (`round(fps × duration)`), which `buildParams(source, fps)` computes
  via `loopFrames(fps, source.duration)` — GIF passes its own capped
  fps (and, mid-export, the export snapshot's `duration`, not
  `state.duration`), so don't render GIF frames with the default
  `currentParams()`. The `mod` makes phase 1.0 frame 0 again (verified:
  phase 0 vs 1 bit-identical for all blend modes); the `+ 0.5` stops
  `i / n * n` rounding down to `i − 1`.
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
