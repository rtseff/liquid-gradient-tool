import { LiquidGradientRenderer } from './render/LiquidGradientRenderer.js';
import { exportVideo } from './export/exportVideo.js';
import { exportGif } from './export/exportGif.js';
import { PRESETS, presetGradientCss } from './presets.js';
import {
  loadSettings,
  saveSettings,
  validateSettings,
  SETTINGS_KEYS,
  saveResult,
  loadResults,
  deleteResults,
  MAX_SAVED_RESULTS,
  MAX_PATTERN_HISTORY,
} from './session.js';

// Settings shared via "Скопировать ссылку на настройки" leave out
// patternHistory (personal — not something a link recipient should
// inherit) and previewRadius (a preview-only cosmetic, not part of the
// gradient itself).
const LINK_EXCLUDED_SETTINGS = new Set(['patternHistory', 'previewRadius']);

// Max pinned pattern-history entries — one slot short of the strip's
// cap so a freshly generated pattern always has room (see
// pushPatternHistory()).
const MAX_PINNED_PATTERNS = MAX_PATTERN_HISTORY - 1;

// base64url, safe for UTF-8: TextEncoder -> btoa over the raw bytes,
// then the usual +/ -> -_ swap and padding strip (and the reverse for
// decoding). Used for the settings-link hash.
function bytesToBase64Url(bytes) {
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeSettingsLink(obj) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

function decodeSettingsLink(b64url) {
  return new TextDecoder().decode(base64UrlToBytes(b64url));
}

const MAX_COLORS = 6;
const MIN_COLORS = 2;

const canvas = document.getElementById('previewCanvas');
const renderer = new LiquidGradientRenderer(canvas);

const state = {
  colors: [...PRESETS[0].colors],
  scale: 1.3,
  warp: 0.9,
  softness: 0.3,
  speed: 0.5, // raw slider value 0..1, eased into an amplitude via speedToAmplitude()
  seed: [randomSeedValue(), randomSeedValue()],
  // Last MAX_PATTERN_HISTORY patterns, newest first, including the
  // current one: { seed: [number, number], createdAt: Date.now() }.
  patternHistory: [],
  // Preview-only corner radius, as a share of the canvas's short side:
  // 0.5 turns a 1:1 preview into a circle. Never reaches the export.
  previewRadius: 0.025,
  grainEnabled: false,
  grainSize: 1, // px in the exported file
  grainDensity: 0.5,
  grainOpacity: 0.3,
  grainVariance: 1,
  grainSoftness: 0.3,
  grainBlend: 'overlay', // 'normal' | 'overlay' | 'softlight'
  grainColor: '#ffffff',
  width: 1600,
  height: 900,
  duration: 4,
  fps: 30,
  format: 'webm+mp4', // 'webm+mp4' | 'webm' | 'mp4' | 'gif'
  bitrate: 1.5, // Mbit/s
  gifWidth: 480,
  poster: true, // export a phase-0 PNG alongside video formats
};

// Factory values (double-click / reset targets), then the previous
// session's settings on top — see session.js.
const DEFAULTS = structuredClone(state);
Object.assign(state, loadSettings());

// "Скопировать ссылку на настройки" import: a `#s=<base64url JSON>` hash
// overrides the restored settings once. Applied here, before the
// pattern-history seeding below, so a seed carried by the link is picked
// up by that same "add current seed if missing" logic. The hash is then
// stripped (so reloading doesn't reapply it) and, since this change
// didn't come from a user event, saved immediately rather than waiting
// for the debounced auto-save. Status is shown once `el` exists, below.
let pendingLinkStatus = null;
const settingsLinkMatch = location.hash.match(/(?:^|[&#])s=([^&]*)/);
if (settingsLinkMatch) {
  try {
    const imported = validateSettings(JSON.parse(decodeSettingsLink(settingsLinkMatch[1])));
    Object.assign(state, imported);
    pendingLinkStatus = { message: 'Настройки из ссылки применены.', kind: 'success' };
  } catch (err) {
    console.warn('Broken settings link:', err);
    pendingLinkStatus = { message: 'Не удалось прочитать ссылку с настройками — она повреждена.', kind: 'error' };
  }
  history.replaceState(null, '', location.pathname + location.search);
}

function seedsEqual(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

// Adds a new entry to the front of pattern history. If that pushes the
// list past MAX_PATTERN_HISTORY, the oldest *unpinned* entry is dropped
// instead of always the oldest, so pinned patterns survive "Новый узор".
// Pinning is capped at MAX_PINNED_PATTERNS (below), which leaves at
// least one unpinned entry to evict whenever the strip is full.
function pushPatternHistory(entry) {
  state.patternHistory.unshift(entry);
  while (state.patternHistory.length > MAX_PATTERN_HISTORY) {
    let oldestUnpinnedIndex = -1;
    for (let i = state.patternHistory.length - 1; i >= 0; i--) {
      if (!state.patternHistory[i].pinned) {
        oldestUnpinnedIndex = i;
        break;
      }
    }
    if (oldestUnpinnedIndex === -1) break; // shouldn't happen: see cap above
    state.patternHistory.splice(oldestUnpinnedIndex, 1);
  }
}

// First run, or a session saved before pattern history existed: seed the
// history with the current pattern so it's never empty.
if (!state.patternHistory.some((item) => seedsEqual(item.seed, state.seed))) {
  pushPatternHistory({ seed: [...state.seed], createdAt: Date.now() });
}
if (pendingLinkStatus?.kind === 'success') saveSettings(state);

const FORMAT_LABELS = { 'webm+mp4': 'WebM + MP4', webm: 'WebM', mp4: 'MP4', gif: 'GIF', png: 'PNG' };

const FORMAT_HINTS = {
  'webm+mp4': 'Для hero-секции: WebM (VP9) — основной файл, MP4 (H.264) — запасной для Safari. Подключайте оба через <source>.',
  webm: 'WebM (VP9) — лёгкий файл для Chrome, Edge и Firefox. Для Safari добавьте MP4.',
  mp4: 'MP4 (H.264) воспроизводится везде, включая Safari на iPhone и Mac. Альфа-канала в H.264 нет.',
  gif: 'GIF — для превью и соцсетей: палитра 256 цветов, файл заметно тяжелее видео.',
};

// While an export runs, the preview loop must not touch the canvas: it
// resizes the canvas back to the preview size every frame, and gif.js
// copies frames with an unscaled drawImage(canvas, 0, 0) — so a preview
// frame sneaking in between export frames turns the GIF into a cropped
// corner of the full-size render.
let exporting = false;

function randomSeedValue() {
  return Math.random() * 1000 - 500;
}

// Accepts "#rgb", "rgb", "#rrggbb" or "rrggbb" (any case) and returns a
// normalized "#rrggbb", or null if the string isn't a valid hex color
// yet — used to validate the color list's hex text inputs without
// fighting the user mid-keystroke (a partial string like "#04" is
// simply not applied, not treated as an error).
function normalizeHex(value) {
  const trimmed = value.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return `#${trimmed.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed.toLowerCase().split('').map((c) => c + c).join('')}`;
  }
  return null;
}

// The noise's frame-to-frame change saturates fast as the sampling
// radius grows (past ~0.4 it's already near-maximally decorrelated),
// so a linear slider would spend most of its range feeling identical.
// Cubic easing spreads the perceptually useful "calm -> lively" range
// across the whole slider while still hitting full speed at 100%.
function speedToAmplitude(rawSpeed) {
  return rawSpeed ** 3;
}

function gifSize(source = state) {
  const width = Math.min(source.gifWidth, source.width);
  return { width, height: Math.round((width * source.height) / source.width) };
}

// --- DOM refs -------------------------------------------------------------

const el = {
  presetList: document.getElementById('presetList'),
  presetToggle: document.getElementById('presetToggle'),
  colorList: document.getElementById('colorList'),
  colorCount: document.getElementById('colorCount'),
  addColorBtn: document.getElementById('addColorBtn'),
  addColorLabel: document.getElementById('addColorLabel'),
  undoColorBtn: document.getElementById('undoColorBtn'),
  redoColorBtn: document.getElementById('redoColorBtn'),
  newPatternBtn: document.getElementById('newPatternBtn'),
  patternHistory: document.getElementById('patternHistory'),
  scale: document.getElementById('scale'),
  scaleOut: document.getElementById('scaleOut'),
  warp: document.getElementById('warp'),
  warpOut: document.getElementById('warpOut'),
  softness: document.getElementById('softness'),
  softnessOut: document.getElementById('softnessOut'),
  speed: document.getElementById('speed'),
  speedOut: document.getElementById('speedOut'),
  customWidth: document.getElementById('customWidth'),
  customHeight: document.getElementById('customHeight'),
  sizePresetBtns: [...document.querySelectorAll('.size-preset-btn')],
  duration: document.getElementById('duration'),
  fps: document.getElementById('fps'),
  grainEnabled: document.getElementById('grainEnabled'),
  grainSliders: document.getElementById('grainSliders'),
  grainSide: document.getElementById('grainSide'),
  grainSize: document.getElementById('grainSize'),
  grainSizeOut: document.getElementById('grainSizeOut'),
  grainDensity: document.getElementById('grainDensity'),
  grainDensityOut: document.getElementById('grainDensityOut'),
  grainOpacity: document.getElementById('grainOpacity'),
  grainOpacityOut: document.getElementById('grainOpacityOut'),
  grainVariance: document.getElementById('grainVariance'),
  grainVarianceOut: document.getElementById('grainVarianceOut'),
  grainSoftnessField: document.getElementById('grainSoftnessField'),
  grainSoftness: document.getElementById('grainSoftness'),
  grainSoftnessOut: document.getElementById('grainSoftnessOut'),
  grainBlend: document.getElementById('grainBlend'),
  grainColor: document.getElementById('grainColor'),
  grainColorHex: document.getElementById('grainColorHex'),
  grainColorReset: document.getElementById('grainColorReset'),
  format: document.getElementById('format'),
  bitrateField: document.getElementById('bitrateField'),
  bitrate: document.getElementById('bitrate'),
  bitrateOut: document.getElementById('bitrateOut'),
  gifWidthField: document.getElementById('gifWidthField'),
  gifWidth: document.getElementById('gifWidth'),
  gifWidthOut: document.getElementById('gifWidthOut'),
  posterField: document.getElementById('posterField'),
  poster: document.getElementById('poster'),
  exportBtn: document.getElementById('exportBtn'),
  exportLabel: document.getElementById('exportLabel'),
  exportMeta: document.getElementById('exportMeta'),
  formatHint: document.getElementById('formatHint'),
  copySettingsLinkBtn: document.getElementById('copySettingsLinkBtn'),
  exportProgress: document.getElementById('exportProgress'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),
  cancelExportBtn: document.getElementById('cancelExportBtn'),
  statusLine: document.getElementById('statusLine'),
  gallery: document.getElementById('gallery'),
  galleryScroll: document.querySelector('.gallery-scroll'),
  results: document.getElementById('results'),
};

const colorRowTemplate = document.getElementById('colorRowTemplate');
const patternItemTemplate = document.getElementById('patternItemTemplate');
const resultTemplate = document.getElementById('resultTemplate');

// showStatus() is defined further down but hoisted, and el.statusLine
// exists as of the line above, so the settings-link result (parsed near
// the top of the module, before el existed) can be surfaced here.
if (pendingLinkStatus) showStatus(pendingLinkStatus.message, pendingLinkStatus.kind);

el.copySettingsLinkBtn.addEventListener('click', () => copySettingsLink(el.copySettingsLinkBtn));

// Builds `#s=<base64url JSON>` from every persisted setting except
// patternHistory/previewRadius (see LINK_EXCLUDED_SETTINGS) and copies
// it to the clipboard — same "Скопировано" idiom as copyResultHtml().
async function copySettingsLink(btn) {
  const data = {};
  for (const key of SETTINGS_KEYS) {
    if (LINK_EXCLUDED_SETTINGS.has(key)) continue;
    data[key] = state[key];
  }
  const url = `${location.origin}${location.pathname}#s=${encodeSettingsLink(data)}`;
  try {
    await navigator.clipboard.writeText(url);
    const original = btn.textContent;
    btn.textContent = 'Скопировано';
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  } catch (err) {
    console.warn(err);
    showStatus('Не удалось скопировать ссылку — скопируйте вручную из буфера обмена браузера.', 'error');
  }
}

// --- Presets ---------------------------------------------------------------

const presetButtons = PRESETS.map((preset) => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'preset-swatch';
  btn.style.background = presetGradientCss(preset.colors);
  btn.title = preset.name;
  btn.setAttribute('aria-pressed', 'false');
  const label = document.createElement('span');
  label.textContent = preset.name;
  btn.appendChild(label);
  btn.addEventListener('click', () => {
    state.colors = [...preset.colors];
    pushColorHistory();
    renderColorList();
  });
  el.presetList.appendChild(btn);
  return { btn, colors: preset.colors };
});

el.presetToggle.addEventListener('click', () => {
  const open = el.presetList.hidden;
  el.presetList.hidden = !open;
  el.presetToggle.setAttribute('aria-expanded', String(open));
});

function updatePresetActive() {
  const current = state.colors.join(',');
  presetButtons.forEach(({ btn, colors }) => {
    btn.setAttribute('aria-pressed', String(colors.join(',') === current));
  });
}

// --- Colors ------------------------------------------------------------
//
// Every add/remove/edit/reorder of the palette is pushed onto an
// undo/redo history stack (snapshots of state.colors), so mistakes made
// while experimenting with a palette are cheap to back out of.

const colorHistory = [[...state.colors]];
let colorHistoryIndex = 0;

function updateHistoryButtons() {
  el.undoColorBtn.disabled = colorHistoryIndex <= 0;
  el.redoColorBtn.disabled = colorHistoryIndex >= colorHistory.length - 1;
}

function pushColorHistory() {
  // Adding a new entry after undoing discards the redo branch, same as
  // any standard undo stack.
  colorHistory.length = colorHistoryIndex + 1;
  colorHistory.push([...state.colors]);
  colorHistoryIndex++;
  updateHistoryButtons();
  updatePresetActive();
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];

function renderColorList() {
  el.colorList.innerHTML = '';
  state.colors.forEach((color, index) => {
    const node = colorRowTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.color-index').textContent = ROMAN[index] ?? String(index + 1);
    const input = node.querySelector('.color-input');
    const hexInput = node.querySelector('.color-hex');
    input.value = color;
    hexInput.value = color;
    input.addEventListener('input', () => {
      state.colors[index] = input.value;
      hexInput.value = input.value;
    });
    // Commit to history only once the picker closes (or the field
    // loses focus), not on every intermediate drag tick.
    input.addEventListener('change', () => {
      pushColorHistory();
    });

    // Typing a hex code is the other way to set a color: apply it live
    // as soon as it's a complete, valid hex string (so a partial string
    // like "#04" is just left alone, not rejected), and commit to
    // history + revert an invalid final value on blur/Enter, mirroring
    // how the native picker above commits on 'change'.
    hexInput.addEventListener('input', () => {
      const normalized = normalizeHex(hexInput.value);
      if (!normalized) return;
      state.colors[index] = normalized;
      input.value = normalized;
    });
    hexInput.addEventListener('change', () => {
      const normalized = normalizeHex(hexInput.value);
      if (normalized) {
        hexInput.value = normalized;
        pushColorHistory();
      } else {
        hexInput.value = state.colors[index];
      }
    });
    hexInput.addEventListener('focus', () => hexInput.select());

    const removeBtn = node.querySelector('.remove-color');
    removeBtn.disabled = state.colors.length <= MIN_COLORS;
    if (removeBtn.disabled) removeBtn.title = `Нужно минимум ${MIN_COLORS} цвета`;
    removeBtn.addEventListener('click', () => {
      if (state.colors.length <= MIN_COLORS) return;
      state.colors.splice(index, 1);
      pushColorHistory();
      renderColorList();
    });

    // Drag-and-drop reordering. The drag itself only ever starts from
    // the handle (not the color swatch or remove button, both of which
    // need ordinary clicks to keep working), but the whole row is a
    // drop target so dropping anywhere on it reorders.
    const handle = node.querySelector('.drag-handle');
    handle.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
      node.classList.add('dragging');
    });
    handle.addEventListener('dragend', () => {
      node.classList.remove('dragging');
    });
    node.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      node.classList.add('drag-over');
    });
    node.addEventListener('dragleave', () => {
      node.classList.remove('drag-over');
    });
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      node.classList.remove('drag-over');
      const fromIndex = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isNaN(fromIndex) || fromIndex === index) return;
      const [moved] = state.colors.splice(fromIndex, 1);
      state.colors.splice(index, 0, moved);
      pushColorHistory();
      renderColorList();
    });

    el.colorList.appendChild(node);
  });

  const full = state.colors.length >= MAX_COLORS;
  el.addColorBtn.disabled = full;
  el.addColorLabel.textContent = full ? `Максимум ${MAX_COLORS} цветов` : '+ Добавить цвет';
  el.colorCount.textContent = `${state.colors.length}/${MAX_COLORS}`;
  updatePresetActive();
}

el.addColorBtn.addEventListener('click', () => {
  if (state.colors.length >= MAX_COLORS) return;
  state.colors.push(state.colors[state.colors.length - 1]);
  pushColorHistory();
  renderColorList();
});

el.undoColorBtn.addEventListener('click', () => {
  if (colorHistoryIndex <= 0) return;
  colorHistoryIndex--;
  state.colors = [...colorHistory[colorHistoryIndex]];
  updateHistoryButtons();
  renderColorList();
});

el.redoColorBtn.addEventListener('click', () => {
  if (colorHistoryIndex >= colorHistory.length - 1) return;
  colorHistoryIndex++;
  state.colors = [...colorHistory[colorHistoryIndex]];
  updateHistoryButtons();
  renderColorList();
});

function isTextEditing(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true;
  return target.tagName === 'INPUT' && ['text', 'number'].includes(target.type);
}

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  // Inside a text field Ctrl+Z must keep undoing the typing, not the palette.
  if (isTextEditing(e.target)) return;
  e.preventDefault();
  if (e.shiftKey) {
    el.redoColorBtn.click();
  } else {
    el.undoColorBtn.click();
  }
});

// "N" for "Новый узор" — e.code so it works in any keyboard layout
// (including Russian, where e.key would be a Cyrillic letter).
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyN') return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (isTextEditing(e.target) || exporting) return;
  e.preventDefault();
  el.newPatternBtn.click();
});

renderColorList();
updateHistoryButtons();

// --- Sliders -------------------------------------------------------------

function bindRange(input, output, key, format = (v) => v.toFixed(2), onChange) {
  const defaultValue = DEFAULTS[key];
  const min = parseFloat(input.min);
  const max = parseFloat(input.max);
  const apply = (value) => {
    state[key] = value;
    input.value = value;
    // Accent part of the track, up to the thumb (see style.css).
    input.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
    output.textContent = format(value);
    onChange?.();
  };
  apply(state[key]);
  input.title = 'Двойной клик — значение по умолчанию';
  input.addEventListener('input', () => apply(parseFloat(input.value)));
  input.addEventListener('dblclick', () => apply(defaultValue));
}

bindRange(el.scale, el.scaleOut, 'scale');
bindRange(el.warp, el.warpOut, 'warp');
bindRange(el.softness, el.softnessOut, 'softness');
bindRange(el.speed, el.speedOut, 'speed', (v) => `${Math.round(v * 100)}%`);
bindRange(el.gifWidth, el.gifWidthOut, 'gifWidth', (v) => `${v} px`, updateOutputMeta);
bindRange(el.bitrate, el.bitrateOut, 'bitrate', (v) => `${v.toFixed(1)} Мбит/с`, updateOutputMeta);

el.newPatternBtn.addEventListener('click', () => {
  state.seed = [randomSeedValue(), randomSeedValue()];
  pushPatternHistory({ seed: [...state.seed], createdAt: Date.now() });
  renderPatternHistory();
});

// --- Pattern history --------------------------------------------------
//
// A strip of the last MAX_PATTERN_HISTORY patterns in the preview area.
// Clicking an entry restores its seed without touching the order or
// timestamps; the active entry is the one whose seed matches state.seed.

// The on-screen label is a bare age ("42 с", "3 мин", "21 ч") so it fits even
// the 48px items without an ellipsis — the strip itself says these are
// past patterns. The title/aria-label carries the full phrase ("3 минуты
// назад") and starts with the visible text (WCAG 2.5.3 Label in Name).
const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
const SHORT_UNITS = { second: 'с', minute: 'мин', hour: 'ч', day: 'дн' };

function relativeTimeParts(createdAt) {
  const diffSec = Math.floor((Date.now() - createdAt) / 1000);
  if (diffSec < 60) return [Math.max(0, diffSec), 'second'];
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return [diffMin, 'minute'];
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return [diffHour, 'hour'];
  return [Math.floor(diffHour / 24), 'day'];
}

function shortAgeLabel(createdAt) {
  const [value, unit] = relativeTimeParts(createdAt);
  return `${value} ${SHORT_UNITS[unit]}`;
}

function longAgeLabel(createdAt) {
  const [value, unit] = relativeTimeParts(createdAt);
  return rtf.format(-value, unit);
}

// { slot, btn, item, thumbCanvas, timeEl, pinBtn } for the strip's
// current buttons, kept around so updatePatternActive()/
// updatePatternTimes()/updatePatternPins() can refresh them without
// recreating the <canvas> thumbnails (which would lose their rendered
// pixels for nothing).
let patternButtons = [];

function updatePatternActive() {
  patternButtons.forEach(({ btn, item }) => {
    btn.setAttribute('aria-pressed', String(seedsEqual(item.seed, state.seed)));
  });
}

function updatePatternTimes() {
  patternButtons.forEach(({ btn, item, timeEl }) => {
    const short = shortAgeLabel(item.createdAt);
    timeEl.textContent = short;
    const title = `${short} — вернуть узор, созданный ${longAgeLabel(item.createdAt)}`;
    btn.title = title;
    btn.setAttribute('aria-label', title);
  });
}

// Refreshes every pin button's glyph/label and, once MAX_PINNED_PATTERNS
// pinned entries exist, disables the pin button on the rest (they'd have
// nowhere to go — see pushPatternHistory()).
function updatePatternPins() {
  const pinnedCount = state.patternHistory.filter((item) => item.pinned).length;
  patternButtons.forEach(({ slot, pinBtn, item }) => {
    const pinned = Boolean(item.pinned);
    pinBtn.textContent = pinned ? '★' : '☆';
    pinBtn.setAttribute('aria-pressed', String(pinned));
    slot.classList.toggle('is-pinned', pinned);
    const atCap = !pinned && pinnedCount >= MAX_PINNED_PATTERNS;
    pinBtn.disabled = atCap;
    const label = pinned ? 'Открепить узор' : 'Закрепить узор';
    pinBtn.title = atCap ? `Можно закрепить не больше ${MAX_PINNED_PATTERNS}` : label;
    pinBtn.setAttribute('aria-label', label);
  });
}

function togglePatternPin(item) {
  if (item.pinned) {
    delete item.pinned;
  } else {
    const pinnedCount = state.patternHistory.filter((i) => i.pinned).length;
    if (pinnedCount >= MAX_PINNED_PATTERNS) return;
    item.pinned = true;
  }
  updatePatternPins();
}

function renderPatternHistory() {
  el.patternHistory.innerHTML = '';
  patternButtons = state.patternHistory.map((item) => {
    const slot = patternItemTemplate.content.firstElementChild.cloneNode(true);
    const btn = slot.querySelector('.pattern-item');
    const thumbCanvas = slot.querySelector('.pattern-thumb');
    const timeEl = slot.querySelector('.pattern-time');
    const pinBtn = slot.querySelector('.pattern-pin');
    btn.addEventListener('click', () => {
      // Export and the preview loop share one canvas; the loop already
      // skips rendering while exporting, so switching the seed mid-export
      // would just be silently ignored until it finishes — refuse it
      // instead so the click isn't lost.
      if (exporting) return;
      state.seed = [...item.seed];
      updatePatternActive();
    });
    pinBtn.addEventListener('click', () => togglePatternPin(item));
    el.patternHistory.appendChild(slot);
    return { slot, btn, item, thumbCanvas, timeEl, pinBtn };
  });
  updatePatternActive();
  updatePatternTimes();
  updatePatternPins();
}

renderPatternHistory();
// Every second, so the first minute counts up in seconds.
setInterval(updatePatternTimes, 1000);

// --- Grain layer ----------------------------------------------------------

const percent = (v) => `${Math.round(v * 100)}%`;

// Edge softness only exists for round dots (size ≥ 2); at 1 px every dot
// is a single pixel, so the slider would do nothing.
function updateGrainSoftnessAvailability() {
  const available = state.grainSize >= 2;
  el.grainSoftness.disabled = !available;
  el.grainSoftnessField.classList.toggle('is-disabled', !available);
  el.grainSoftnessField.title = available ? '' : 'Работает для размера от 2 px';
}

bindRange(el.grainSize, el.grainSizeOut, 'grainSize', (v) => `${v} px`, updateGrainSoftnessAvailability);
bindRange(el.grainDensity, el.grainDensityOut, 'grainDensity', percent);
bindRange(el.grainOpacity, el.grainOpacityOut, 'grainOpacity', percent);
bindRange(el.grainVariance, el.grainVarianceOut, 'grainVariance', percent);
bindRange(el.grainSoftness, el.grainSoftnessOut, 'grainSoftness', percent);

el.grainBlend.value = state.grainBlend;
el.grainBlend.addEventListener('change', () => {
  state.grainBlend = el.grainBlend.value;
});

function updateGrainVisibility() {
  el.grainSliders.hidden = !state.grainEnabled;
  el.grainSide.hidden = !state.grainEnabled;
}

el.grainEnabled.checked = state.grainEnabled;
updateGrainVisibility();
el.grainEnabled.addEventListener('change', () => {
  state.grainEnabled = el.grainEnabled.checked;
  updateGrainVisibility();
  refreshPreviewRenderSize();
});

// Same swatch <-> hex behavior as the palette rows: apply a hex as soon as
// it's complete, revert an invalid value on blur/Enter.
el.grainColor.value = state.grainColor;
el.grainColorHex.value = state.grainColor;
el.grainColor.addEventListener('input', () => {
  state.grainColor = el.grainColor.value;
  el.grainColorHex.value = el.grainColor.value;
});
el.grainColorHex.addEventListener('input', () => {
  const normalized = normalizeHex(el.grainColorHex.value);
  if (!normalized) return;
  state.grainColor = normalized;
  el.grainColor.value = normalized;
});
el.grainColorHex.addEventListener('change', () => {
  el.grainColorHex.value = normalizeHex(el.grainColorHex.value) ?? state.grainColor;
});
el.grainColorHex.addEventListener('focus', () => el.grainColorHex.select());

const defaultGrainColor = DEFAULTS.grainColor;
el.grainColorReset.addEventListener('click', () => {
  state.grainColor = defaultGrainColor;
  el.grainColor.value = defaultGrainColor;
  el.grainColorHex.value = defaultGrainColor;
});

// --- Output settings --------------------------------------------------------

function videoContainers(format = state.format) {
  return { 'webm+mp4': ['webm', 'mp4'], webm: ['webm'], mp4: ['mp4'], gif: [] }[format];
}

function updateOutputMeta() {
  const containers = videoContainers();
  const isGif = state.format === 'gif';
  el.bitrateField.hidden = isGif;
  el.gifWidthField.hidden = !isGif;
  el.posterField.hidden = isGif;

  el.exportLabel.textContent = `Экспорт ${FORMAT_LABELS[state.format]}`;
  const seconds = `${state.duration.toFixed(1)} с`;
  if (isGif) {
    const gif = gifSize();
    el.exportMeta.textContent = `${gif.width}×${gif.height} - ${seconds} - ${Math.min(state.fps, 30)} fps`;
  } else {
    // Target bitrate × duration; real VP9/H.264 output of a slow gradient
    // usually lands at or below this.
    const approxBytes = (state.bitrate * 1e6 * state.duration) / 8;
    const perFile = containers.length > 1 ? ' на файл' : '';
    el.exportMeta.textContent =
      `${state.width}×${state.height} - ${seconds} - ${state.fps} fps - ~${formatBytes(approxBytes)}${perFile}`;
  }

  el.formatHint.textContent = FORMAT_HINTS[state.format];
}

el.format.value = state.format;
el.format.addEventListener('change', () => {
  state.format = el.format.value;
  updateOutputMeta();
});

el.poster.checked = state.poster;
el.poster.addEventListener('change', () => {
  state.poster = el.poster.checked;
});

function updateSizePresetActive() {
  el.sizePresetBtns.forEach((btn) => {
    const match = Number(btn.dataset.w) === state.width && Number(btn.dataset.h) === state.height;
    btn.setAttribute('aria-pressed', String(match));
  });
}

function applyResolution(w, h) {
  state.width = w;
  state.height = h;
  updateOutputMeta();
  refreshPreviewRenderSize();
  updateSizePresetActive();
}

el.sizePresetBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    applyResolution(Number(btn.dataset.w), Number(btn.dataset.h));
    el.customWidth.value = state.width;
    el.customHeight.value = state.height;
  });
});

// Rounded to even: H.264 (4:2:0) encoders reject odd frame dimensions.
function clampSize(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(3840, Math.max(64, Math.round(n / 2) * 2));
}

el.customWidth.value = state.width;
el.customHeight.value = state.height;
updateSizePresetActive();
el.customWidth.addEventListener('change', () => {
  applyResolution(clampSize(el.customWidth.value, state.width), state.height);
  el.customWidth.value = state.width;
});
el.customHeight.addEventListener('change', () => {
  applyResolution(state.width, clampSize(el.customHeight.value, state.height));
  el.customHeight.value = state.height;
});

el.duration.value = String(state.duration);
el.duration.addEventListener('change', () => {
  state.duration = parseInt(el.duration.value, 10);
  updateOutputMeta();
});

el.fps.value = String(state.fps);
el.fps.addEventListener('change', () => {
  state.fps = parseInt(el.fps.value, 10);
  updateOutputMeta();
});

updateOutputMeta();

// --- Live preview loop -------------------------------------------------

// Frames in one loop, computed exactly like the exporters do, so the
// grain re-rolls once per exported frame. GIF passes its own (≤ 30) fps.
function loopFrames(fps, duration) {
  return Math.max(1, Math.round(fps * duration));
}

// Builds shader-ready params from any state-shaped object — the live
// `state` for the preview/thumbnails, or an export snapshot (see
// "Export" below) so a frame mid-export never reads the live state.
function buildParams(source, fps) {
  return {
    colors: source.colors,
    scale: source.scale,
    warp: source.warp,
    softness: source.softness,
    loops: 1,
    speed: speedToAmplitude(source.speed),
    seed: source.seed,
    grain: {
      enabled: source.grainEnabled,
      size: source.grainSize,
      density: source.grainDensity,
      opacity: source.grainOpacity,
      variance: source.grainVariance,
      softness: source.grainSoftness,
      blend: source.grainBlend,
      color: source.grainColor,
      frames: loopFrames(fps, source.duration),
    },
  };
}

function currentParams(fps = state.fps) {
  return buildParams(state, fps);
}

// Pattern-history thumbnails share the one WebGL canvas with the live
// preview, so they're drawn first each frame (into their own 2D <canvas>
// via drawImage right after each WebGL render, while the drawing buffer
// is still valid) and the preview's own render — the one that's actually
// on screen — runs last and restores the canvas to the preview size.
// Redrawn only when the params that affect them change, and throttled so
// dragging a slider doesn't re-render 5 thumbnails every frame.
const THUMB_LONG_SIDE = 144;
const THUMB_THROTTLE_MS = 150;
let lastPatternSignature = null;
let lastPatternThumbRender = 0;

function thumbSize() {
  if (state.width >= state.height) {
    return { w: THUMB_LONG_SIDE, h: Math.max(1, Math.round((THUMB_LONG_SIDE * state.height) / state.width)) };
  }
  return { w: Math.max(1, Math.round((THUMB_LONG_SIDE * state.width) / state.height)), h: THUMB_LONG_SIDE };
}

function patternSignature() {
  return JSON.stringify([
    state.colors,
    state.scale,
    state.warp,
    state.softness,
    state.speed, // amplitude moves the phase-0 point too
    state.width,
    state.height,
    state.patternHistory.map((item) => item.seed),
  ]);
}

function renderPatternThumbnails() {
  if (!patternButtons.length) return;
  const { w: tw, h: th } = thumbSize();
  const baseParams = currentParams();
  for (const { item, thumbCanvas } of patternButtons) {
    renderer.setSize(tw, th);
    renderer.render({ ...baseParams, seed: item.seed, grain: { ...baseParams.grain, enabled: false } }, 0);
    thumbCanvas.width = tw;
    thumbCanvas.height = th;
    thumbCanvas.getContext('2d').drawImage(canvas, 0, 0, tw, th);
  }
}

// --- Preview render size ---------------------------------------------------
//
// The exported size (up to 3840x2160) is only needed pixel-for-pixel for
// two things that read exact output pixels: grain (drawn in output
// pixels, gl_FragCoord — see CLAUDE.md) and exports/thumbnails, which
// each set their own canvas size directly around their own render call.
// The live preview itself is shown shrunk to a few hundred px on screen,
// so rendering the full export size every frame wastes GPU time for no
// visible gain. With grain off, the render buffer is instead sized to
// the canvas's actual on-screen footprint — CSS size x devicePixelRatio
// x the root `zoom` boot.js applies — capped at the export size, with the
// export's aspect ratio preserved to the pixel (so u_resolution, which
// the shader derives uv from, always has the same aspect as the export).
// With grain on, it's the full export size, same as before, so grain's
// per-output-pixel cell size and jitter look exactly as they will in the
// exported file.
//
// Recomputed only when the canvas's box resizes, the export size changes
// (applyResolution) or grain is toggled — never per frame off a
// getBoundingClientRect() call.

function currentZoom() {
  const z = parseFloat(document.documentElement.style.zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

// "Contain"-fits state.width:state.height into the canvas's box, in the
// box's own (pre-zoom) CSS pixel space — same space canvas.offsetWidth
// and friends already use elsewhere in this file.
function previewCssFitSize() {
  const box = canvas.parentElement;
  const boxW = box.clientWidth;
  const boxH = box.clientHeight;
  if (!boxW || !boxH || !state.width || !state.height) {
    return { cssW: state.width || 1, cssH: state.height || 1 };
  }
  const scale = Math.min(boxW / state.width, boxH / state.height);
  return { cssW: state.width * scale, cssH: state.height * scale };
}

function computePreviewRenderSize() {
  const { cssW, cssH } = previewCssFitSize();
  if (state.grainEnabled) {
    return { w: state.width, h: state.height, cssW, cssH };
  }
  const factor = (window.devicePixelRatio || 1) * currentZoom();
  const w = Math.min(state.width, Math.max(1, Math.round(cssW * factor)));
  // Derived from the (possibly capped) w, not rounded independently, so
  // the buffer's aspect always matches the export's to the pixel.
  const h = Math.min(state.height, Math.max(1, Math.round((w * state.height) / state.width)));
  return { w, h, cssW, cssH };
}

let previewRenderSize = { w: state.width, h: state.height, cssW: state.width, cssH: state.height };

function refreshPreviewRenderSize() {
  previewRenderSize = computePreviewRenderSize();
  canvas.style.width = `${previewRenderSize.cssW}px`;
  canvas.style.height = `${previewRenderSize.cssH}px`;
}

refreshPreviewRenderSize();

// The box's own size drives the fit; resizing the canvas itself (done
// above, and by exports/thumbnails setting canvas.width/height directly)
// must not re-trigger this or it'd fight exports over the buffer size —
// only the box is observed here. Changing canvas.style.width/height does
// resize the canvas element itself, which is exactly what the separate
// radiusObserver below (observing `canvas`) is for, so corner handles
// stay put without an explicit call here.
const previewSizeObserver = new ResizeObserver(refreshPreviewRenderSize);
previewSizeObserver.observe(canvas.parentElement);

// --- Preview corner radius ------------------------------------------------
//
// Drag any corner handle toward the centre to round the preview's corners
// (the exported file stays a full rectangle — see CLAUDE.md). Positions
// are measured with getBoundingClientRect() and turned into a fraction of
// the short side, so the root CSS zoom set by boot.js cancels out.

const radiusHandles = [...document.querySelectorAll('.radius-handle')];
const MAX_PREVIEW_RADIUS = 0.5;
// Handles never sit closer than this to the edges, so they stay grabbable
// at radius 0 (layout px, like the offsets they're added to).
const HANDLE_MIN_INSET = 12;

function applyPreviewRadius() {
  const short = Math.min(canvas.offsetWidth, canvas.offsetHeight);
  const radiusPx = state.previewRadius * short;
  canvas.style.borderRadius = `${radiusPx}px`;
  const inset = Math.max(radiusPx * (1 - Math.SQRT1_2), HANDLE_MIN_INSET);
  const { offsetLeft: x, offsetTop: y, offsetWidth: w, offsetHeight: h } = canvas;
  radiusHandles.forEach((handle) => {
    const { corner } = handle.dataset;
    handle.style.left = `${corner[1] === 'l' ? x + inset : x + w - inset}px`;
    handle.style.top = `${corner[0] === 't' ? y + inset : y + h - inset}px`;
  });
  const percent = Math.round((state.previewRadius / MAX_PREVIEW_RADIUS) * 100);
  radiusHandles[0].setAttribute('aria-valuenow', String(percent));
  radiusHandles[0].setAttribute('aria-valuetext', `${Math.round(radiusPx)} px`);
}

function setPreviewRadius(value) {
  state.previewRadius = Math.min(MAX_PREVIEW_RADIUS, Math.max(0, value));
  applyPreviewRadius();
}

radiusHandles[0].setAttribute('aria-valuemin', '0');
radiusHandles[0].setAttribute('aria-valuemax', '100');

// How far a pointer is in from the handle's corner, along the diagonal.
function inwardDistance(e, corner, rect) {
  const dx = corner[1] === 'l' ? e.clientX - rect.left : rect.right - e.clientX;
  const dy = corner[0] === 't' ? e.clientY - rect.top : rect.bottom - e.clientY;
  return (dx + dy) / 2;
}

for (const handle of radiusHandles) {
  handle.title = 'Потяните к центру — скругление углов превью. Двойной клик — по умолчанию';
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('is-dragging');
    const rect = canvas.getBoundingClientRect();
    drag = { start: inwardDistance(e, handle.dataset.corner, rect), radius: state.previewRadius };
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // Relative to where the drag started: the handle is clamped to
    // HANDLE_MIN_INSET at small radii, so an absolute mapping would jump.
    // It rides the corner arc's midpoint, r·(1 − 1/√2) in from each edge,
    // hence the division.
    const rect = canvas.getBoundingClientRect();
    const delta = inwardDistance(e, handle.dataset.corner, rect) - drag.start;
    setPreviewRadius(drag.radius + delta / (1 - Math.SQRT1_2) / Math.min(rect.width, rect.height));
  });
  const endDrag = () => {
    drag = null;
    handle.classList.remove('is-dragging');
    scheduleSave();
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('dblclick', () => {
    setPreviewRadius(DEFAULTS.previewRadius);
    scheduleSave();
  });
}

radiusHandles[0].addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 0.05 : 0.01;
  const next = {
    ArrowUp: state.previewRadius + step,
    ArrowRight: state.previewRadius + step,
    ArrowDown: state.previewRadius - step,
    ArrowLeft: state.previewRadius - step,
    Home: 0,
    End: MAX_PREVIEW_RADIUS,
  }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  setPreviewRadius(next);
  scheduleSave();
});

// The canvas's displayed size follows the window and the export size.
// The box too: its canvas can move without resizing (letterboxing).
const radiusObserver = new ResizeObserver(applyPreviewRadius);
radiusObserver.observe(canvas);
radiusObserver.observe(canvas.parentElement);

const previewStart = performance.now();
function previewLoop(now) {
  if (!exporting) {
    const signature = patternSignature();
    if (signature !== lastPatternSignature && now - lastPatternThumbRender > THUMB_THROTTLE_MS) {
      lastPatternSignature = signature;
      lastPatternThumbRender = now;
      renderPatternThumbnails();
    }
    const elapsedSec = (now - previewStart) / 1000;
    const phase = (elapsedSec % state.duration) / state.duration;
    renderer.setSize(previewRenderSize.w, previewRenderSize.h);
    renderer.render(currentParams(), phase);
  }
  requestAnimationFrame(previewLoop);
}
requestAnimationFrame(previewLoop);

// --- Export --------------------------------------------------------------

// Blocked while exporting: an export runs off a snapshot (see below), so
// these panels changing mid-export can't corrupt the output any more —
// this is purely so the user isn't left editing controls that visibly do
// nothing. #exportBtn/#exportProgress (with #cancelExportBtn) sit outside
// all three, so the export/cancel controls stay reachable. The preview's
// corner-radius handles are preview-only and are left alone.
const inertPanels = [
  document.querySelector('.controls'),
  document.querySelector('.pattern-bar'),
  el.exportProgress.closest('.output').querySelector('.output-settings'),
].filter(Boolean);

function setBusy(busy) {
  exporting = busy;
  el.exportBtn.disabled = busy;
  el.format.disabled = busy;
  el.exportProgress.hidden = !busy;
  inertPanels.forEach((panel) => panel.toggleAttribute('inert', busy));
  if (busy) {
    el.statusLine.hidden = true;
  } else {
    el.progressFill.style.width = '0%';
  }
}

function updateProgress(fraction, label) {
  el.progressFill.style.width = `${Math.round(fraction * 100)}%`;
  el.progressLabel.textContent = label;
}

function showStatus(message, kind) {
  el.statusLine.textContent = message;
  el.statusLine.dataset.kind = kind;
  el.statusLine.hidden = false;
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} МБ`
    : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

// Every file of the most recent export run (WebM + MP4 is one run, two
// files) carries the "Последнее" badge.
let latestBatch = 0;

function updateLatestBadges() {
  el.results.querySelectorAll('.result-card').forEach((card) => {
    card.querySelector('.result-badge').hidden = Number(card.dataset.batch) !== latestBatch;
  });
}

function renderResult({ id, name, blob, isVideo, width, height, batch }) {
  const node = resultTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.batch = String(batch);
  if (id !== undefined) node.dataset.id = String(id);
  const url = URL.createObjectURL(blob);
  const previewSlot = node.querySelector('.result-preview');
  if (isVideo) {
    const video = document.createElement('video');
    video.src = url;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    previewSlot.appendChild(video);
  } else {
    const img = document.createElement('img');
    img.src = url;
    img.alt = name;
    previewSlot.appendChild(img);
  }
  node.querySelector('.result-name').textContent = name;
  node.querySelector('.result-name').title = `${name} · ${width}×${height}`;
  node.querySelector('.result-size').textContent = formatBytes(blob.size);
  const link = node.querySelector('.result-download');
  link.href = url;
  link.download = name;
  // WebM and MP4 of one export share a name and thumbnail, so say which is which.
  const ext = name.slice(name.lastIndexOf('.') + 1);
  link.textContent = `Скачать ${FORMAT_LABELS[ext] ?? ext.toUpperCase()}`;
  const htmlBtn = node.querySelector('.result-html-btn');
  if (isVideo) {
    htmlBtn.hidden = false;
    htmlBtn.addEventListener('click', () => copyResultHtml(node, htmlBtn));
  }
  el.results.prepend(node);
  el.gallery.hidden = false;
  latestBatch = Math.max(latestBatch, batch);
  return node;
}

// Builds a <video> snippet for this card's export batch (WebM/MP4/poster
// PNG, whichever files that batch produced — batch cards, including ones
// restored from IndexedDB, all carry the same data-batch) and copies it
// to the clipboard.
async function copyResultHtml(card, btn) {
  const batch = card.dataset.batch;
  const names = [...el.results.querySelectorAll(`.result-card[data-batch="${batch}"]`)]
    .map((c) => c.querySelector('.result-download').download);
  const webm = names.find((n) => n.endsWith('.webm'));
  const mp4 = names.find((n) => n.endsWith('.mp4'));
  const png = names.find((n) => n.endsWith('.png'));
  const sources = [];
  if (webm) sources.push(`  <source src="${webm}" type="video/webm">`);
  if (mp4) sources.push(`  <source src="${mp4}" type="video/mp4">`);
  const posterAttr = png ? ` poster="${png}"` : '';
  const html = `<video autoplay muted loop playsinline${posterAttr}>\n${sources.join('\n')}\n</video>`;
  try {
    await navigator.clipboard.writeText(html);
    const original = btn.textContent;
    btn.textContent = 'Скопировано';
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  } catch (err) {
    console.warn(err);
    showStatus('Не удалось скопировать HTML — скопируйте вручную из буфера обмена браузера.', 'error');
  }
}

function removeCard(card) {
  card.querySelectorAll('video, img').forEach((media) => URL.revokeObjectURL(media.src));
  card.remove();
}

// Newly exported file: show it, then store it for the next session and
// drop the oldest cards/files beyond MAX_SAVED_RESULTS.
async function addResult(entry) {
  const node = renderResult(entry);
  updateLatestBadges();
  el.results.scrollLeft = 0;
  updateGalleryFade();
  try {
    node.dataset.id = String(await saveResult(entry));
  } catch (err) {
    console.warn('Result not saved for the next session:', err);
  }
  const cards = [...el.results.querySelectorAll('.result-card')];
  const excess = cards.slice(MAX_SAVED_RESULTS);
  if (excess.length) {
    const ids = excess.map((card) => Number(card.dataset.id)).filter(Number.isFinite);
    excess.forEach(removeCard);
    updateGalleryFade();
    if (ids.length) deleteResults(ids).catch((err) => console.warn(err));
  }
}

async function restoreResults() {
  let saved;
  try {
    saved = await loadResults();
  } catch (err) {
    console.warn('Saved results not restored:', err);
    return;
  }
  // Oldest first, each prepended, so the newest ends up on the left.
  saved.forEach(renderResult);
  updateLatestBadges();
  updateGalleryFade();
}

// Fade on each edge only while there are cards scrolled out of view there.
function updateGalleryFade() {
  const { scrollLeft, scrollWidth, clientWidth } = el.results;
  el.galleryScroll.classList.toggle('more-before', scrollLeft > 1);
  el.galleryScroll.classList.toggle('more-after', scrollLeft + clientWidth < scrollWidth - 1);
}
el.results.addEventListener('scroll', updateGalleryFade, { passive: true });

// The strip has no scrollbar, so a plain vertical mouse wheel scrolls it
// sideways. At either end the event is left alone and scrolls the page;
// trackpads (which already send deltaX) are not touched.
el.results.addEventListener('wheel', (e) => {
  if (e.deltaX !== 0 || e.deltaY === 0 || e.shiftKey || e.ctrlKey) return;
  const { scrollLeft, scrollWidth, clientWidth } = el.results;
  const atStart = scrollLeft <= 0;
  const atEnd = scrollLeft + clientWidth >= scrollWidth - 1;
  if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return;
  e.preventDefault();
  // Firefox reports line-based deltas for mouse wheels.
  el.results.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
}, { passive: false });
window.addEventListener('resize', updateGalleryFade);

// The state keys an export run depends on. Snapshotted once per export
// click (see the click handler below) so a slider/color/pattern change
// mid-export can never leak into a frame: every exporter, and every
// renderFrame callback it drives, reads only this snapshot — never the
// live `state` — from the moment the click is handled onward.
const EXPORT_STATE_KEYS = [
  'colors', 'scale', 'warp', 'softness', 'speed', 'seed',
  'grainEnabled', 'grainSize', 'grainDensity', 'grainOpacity',
  'grainVariance', 'grainSoftness', 'grainBlend', 'grainColor',
  'width', 'height', 'duration', 'fps', 'format', 'bitrate', 'gifWidth', 'poster',
];

function snapshotExportState() {
  const picked = {};
  for (const key of EXPORT_STATE_KEYS) picked[key] = state[key];
  return structuredClone(picked);
}

async function exportOneVideo(snapshot, container, stepLabel, batch, signal) {
  const { width, height, fps, duration } = snapshot;
  const bitrate = Math.round(snapshot.bitrate * 1e6);
  const label = container === 'webm' ? 'WebM' : 'MP4';
  const onProgress = (p) => updateProgress(p, `${stepLabel}${label}… ${Math.round(p * 100)}%`);
  const renderFrame = (phase) => renderer.render(buildParams(snapshot, fps), phase);
  renderer.setSize(width, height);
  const blob = await exportVideo({ container, canvas, renderFrame, width, height, fps, duration, bitrate, onProgress, signal });
  const name = `liquid-gradient-${width}x${height}.${container}`;
  addResult({ name, blob, isVideo: true, width, height, batch });
  return `${name} (${formatBytes(blob.size)})`;
}

// Renders the same snapshot at phase 0 (the exported loop's first frame)
// at the export size and saves it as a PNG poster — for the <video
// poster="..."> attribute. Reuses the WebGL canvas right after a video
// export's own renders, so it must run before setBusy(false) restores the
// preview loop. The canvas context is created with preserveDrawingBuffer
// (LiquidGradientRenderer.js), so render() then toBlob() back-to-back,
// with nothing else touching the canvas in between, always reads the
// frame that was just drawn.
async function exportPosterFile(snapshot, batch, signal) {
  if (signal.aborted) throw new DOMException('Экспорт отменён.', 'AbortError');
  const { width, height, fps } = snapshot;
  renderer.setSize(width, height);
  renderer.render(buildParams(snapshot, fps), 0);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось создать PNG'))), 'image/png');
  });
  const name = `liquid-gradient-${width}x${height}.png`;
  addResult({ name, blob, isVideo: false, width, height, batch });
  return `${name} (${formatBytes(blob.size)})`;
}

async function exportGifFile(snapshot, batch, signal) {
  const { width, height } = gifSize(snapshot);
  const fps = Math.min(snapshot.fps, 30);
  renderer.setSize(width, height);
  const blob = await exportGif({
    canvas,
    renderFrame: (phase) => renderer.render(buildParams(snapshot, fps), phase),
    width,
    height,
    fps,
    duration: snapshot.duration,
    onProgress: (p, stage) => {
      const label = stage === 'render' ? 'Рендер кадров…' : 'Кодирование GIF…';
      updateProgress(p, `${label} ${Math.round(p * 100)}%`);
    },
    signal,
  });
  const name = `liquid-gradient-${width}x${height}.gif`;
  addResult({ name, blob, isVideo: false, width, height, batch });
  return `${name} (${formatBytes(blob.size)})`;
}

// The controller behind #cancelExportBtn — created fresh per export run,
// cleared once it's done so a stray click afterward is a no-op.
let exportAbortController = null;

function isAbortError(err) {
  return err instanceof DOMException ? err.name === 'AbortError' : err?.name === 'AbortError';
}

el.exportBtn.addEventListener('click', async () => {
  const snapshot = snapshotExportState();
  const controller = new AbortController();
  exportAbortController = controller;
  setBusy(true);
  const batch = Date.now();
  const done = [];
  const failed = [];
  let cancelled = false;
  try {
    if (snapshot.format === 'gif') {
      try {
        done.push(await exportGifFile(snapshot, batch, controller.signal));
      } catch (err) {
        if (isAbortError(err)) {
          cancelled = true;
        } else {
          console.error(err);
          failed.push(`GIF: ${err.message}`);
        }
      }
    } else {
      const containers = videoContainers(snapshot.format);
      for (const [i, container] of containers.entries()) {
        if (cancelled) break;
        const step = containers.length > 1 ? `${i + 1}/${containers.length} · ` : '';
        try {
          done.push(await exportOneVideo(snapshot, container, step, batch, controller.signal));
        } catch (err) {
          if (isAbortError(err)) {
            // Cancelling mid-'webm+mp4' must not start the second file.
            cancelled = true;
            break;
          }
          // One format failing (typically no H.264 encoder) must not throw
          // away the other one that already succeeded.
          console.error(err);
          failed.push(`${container.toUpperCase()}: ${err.message}`);
        }
      }
      if (!cancelled && snapshot.poster) {
        try {
          done.push(await exportPosterFile(snapshot, batch, controller.signal));
        } catch (err) {
          if (isAbortError(err)) {
            cancelled = true;
          } else {
            console.error(err);
            failed.push(`PNG: ${err.message}`);
          }
        }
      }
    }
  } finally {
    setBusy(false);
    exportAbortController = null;
  }
  if (cancelled) {
    // Whatever file(s) had already finished stay in the gallery.
    showStatus('Экспорт отменён.', 'cancelled');
    return;
  }
  const parts = [];
  if (done.length) parts.push(`Готово: ${done.join(', ')}.`);
  if (failed.length) parts.push(`Не удалось — ${failed.join('; ')}.`);
  showStatus(parts.join(' '), failed.length ? 'error' : 'success');
});

el.cancelExportBtn.addEventListener('click', () => {
  exportAbortController?.abort();
});

// --- Session ---------------------------------------------------------------
//
// Every setting lives in `state` and only user input changes it, so one
// debounced save after any input/change/click (plus on leaving the page)
// covers all controls — including palette edits, undo and "Новый узор".

let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(state), 300);
}
['input', 'change', 'click', 'drop'].forEach((type) => document.addEventListener(type, scheduleSave, true));
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) scheduleSave();
});
window.addEventListener('pagehide', () => saveSettings(state));

restoreResults();
