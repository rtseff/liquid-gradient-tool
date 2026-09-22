import { LiquidGradientRenderer } from './render/LiquidGradientRenderer.js';
import { exportWebm } from './export/exportWebm.js';
import { exportGif } from './export/exportGif.js';
import { PRESETS, presetGradientCss } from './presets.js';

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
  maskMode: 'none', // 'none' | 'circle'
  maskInvert: false,
  bgColor: '#000000',
  width: 1600,
  height: 900,
  duration: 4,
  fps: 30,
  gifWidth: 480,
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

function gifSize() {
  const width = Math.min(state.gifWidth, state.width);
  return { width, height: Math.round((width * state.height) / state.width) };
}

// --- DOM refs -------------------------------------------------------------

const el = {
  presetList: document.getElementById('presetList'),
  colorList: document.getElementById('colorList'),
  colorCount: document.getElementById('colorCount'),
  addColorBtn: document.getElementById('addColorBtn'),
  undoColorBtn: document.getElementById('undoColorBtn'),
  redoColorBtn: document.getElementById('redoColorBtn'),
  newPatternBtn: document.getElementById('newPatternBtn'),
  scale: document.getElementById('scale'),
  scaleOut: document.getElementById('scaleOut'),
  warp: document.getElementById('warp'),
  warpOut: document.getElementById('warpOut'),
  softness: document.getElementById('softness'),
  softnessOut: document.getElementById('softnessOut'),
  speed: document.getElementById('speed'),
  speedOut: document.getElementById('speedOut'),
  maskSegments: document.querySelectorAll('.segment[data-mask]'),
  circleOptions: document.getElementById('circleOptions'),
  maskInvert: document.getElementById('maskInvert'),
  bgColor: document.getElementById('bgColor'),
  resolutionPreset: document.getElementById('resolutionPreset'),
  customSizeRow: document.getElementById('customSizeRow'),
  customWidth: document.getElementById('customWidth'),
  customHeight: document.getElementById('customHeight'),
  duration: document.getElementById('duration'),
  durationOut: document.getElementById('durationOut'),
  fps: document.getElementById('fps'),
  gifWidth: document.getElementById('gifWidth'),
  gifWidthOut: document.getElementById('gifWidthOut'),
  exportWebmBtn: document.getElementById('exportWebmBtn'),
  exportGifBtn: document.getElementById('exportGifBtn'),
  webmMeta: document.getElementById('webmMeta'),
  gifMeta: document.getElementById('gifMeta'),
  exportProgress: document.getElementById('exportProgress'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),
  statusLine: document.getElementById('statusLine'),
  results: document.getElementById('results'),
};

const colorRowTemplate = document.getElementById('colorRowTemplate');
const resultTemplate = document.getElementById('resultTemplate');

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

function renderColorList() {
  el.colorList.innerHTML = '';
  state.colors.forEach((color, index) => {
    const node = colorRowTemplate.content.firstElementChild.cloneNode(true);
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
  el.addColorBtn.textContent = full ? `Максимум ${MAX_COLORS} цветов` : '+ Добавить цвет';
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

renderColorList();
updateHistoryButtons();

// --- Sliders -------------------------------------------------------------

function bindRange(input, output, key, format = (v) => v.toFixed(2), onChange) {
  const defaultValue = state[key];
  const apply = (value) => {
    state[key] = value;
    input.value = value;
    output.textContent = format(value);
    onChange?.();
  };
  apply(defaultValue);
  input.title = 'Двойной клик — значение по умолчанию';
  input.addEventListener('input', () => apply(parseFloat(input.value)));
  input.addEventListener('dblclick', () => apply(defaultValue));
}

bindRange(el.scale, el.scaleOut, 'scale');
bindRange(el.warp, el.warpOut, 'warp');
bindRange(el.softness, el.softnessOut, 'softness');
bindRange(el.speed, el.speedOut, 'speed', (v) => `${Math.round(v * 100)}%`);
bindRange(el.duration, el.durationOut, 'duration', (v) => `${v.toFixed(1)} с`, updateOutputMeta);
bindRange(el.gifWidth, el.gifWidthOut, 'gifWidth', (v) => `${v} px`, updateOutputMeta);

el.newPatternBtn.addEventListener('click', () => {
  state.seed = [randomSeedValue(), randomSeedValue()];
});

// --- Frame shape (circle mask) --------------------------------------------

function updateMaskUi() {
  el.maskSegments.forEach((segment) => {
    segment.setAttribute('aria-checked', String(segment.dataset.mask === state.maskMode));
  });
  el.circleOptions.hidden = state.maskMode !== 'circle';
}

el.maskSegments.forEach((segment) => {
  segment.addEventListener('click', () => {
    state.maskMode = segment.dataset.mask;
    updateMaskUi();
  });
});

el.maskInvert.addEventListener('change', () => {
  state.maskInvert = el.maskInvert.checked;
});

el.bgColor.value = state.bgColor;
el.bgColor.addEventListener('input', () => {
  state.bgColor = el.bgColor.value;
});

updateMaskUi();

// --- Output settings --------------------------------------------------------

function updateOutputMeta() {
  const gif = gifSize();
  el.webmMeta.textContent = `${state.width}×${state.height} · ${state.duration} с · ${state.fps} fps`;
  el.gifMeta.textContent = `${gif.width}×${gif.height} · ${Math.min(state.fps, 30)} fps`;
}

function applyResolution(w, h) {
  state.width = w;
  state.height = h;
  updateOutputMeta();
}

el.resolutionPreset.value = `${state.width}x${state.height}`;

el.resolutionPreset.addEventListener('change', () => {
  const val = el.resolutionPreset.value;
  if (val === 'custom') {
    el.customSizeRow.hidden = false;
    el.customWidth.value = state.width;
    el.customHeight.value = state.height;
    return;
  }
  el.customSizeRow.hidden = true;
  const [w, h] = val.split('x').map(Number);
  applyResolution(w, h);
});

function clampSize(value, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(3840, Math.max(64, n));
}

// Picking a preset blurs a just-edited size field, and the browser fires
// that field's pending 'change' *after* the preset applied — so only
// honor these fields while "custom" is actually selected.
el.customWidth.addEventListener('change', () => {
  if (el.resolutionPreset.value !== 'custom') return;
  applyResolution(clampSize(el.customWidth.value, state.width), state.height);
  el.customWidth.value = state.width;
});
el.customHeight.addEventListener('change', () => {
  if (el.resolutionPreset.value !== 'custom') return;
  applyResolution(state.width, clampSize(el.customHeight.value, state.height));
  el.customHeight.value = state.height;
});

el.fps.value = String(state.fps);
el.fps.addEventListener('change', () => {
  state.fps = parseInt(el.fps.value, 10);
  updateOutputMeta();
});

updateOutputMeta();

// --- Live preview loop -------------------------------------------------

function currentParams() {
  return {
    colors: state.colors,
    scale: state.scale,
    warp: state.warp,
    softness: state.softness,
    loops: 1,
    speed: speedToAmplitude(state.speed),
    seed: state.seed,
    maskMode: state.maskMode,
    maskInvert: state.maskInvert,
    bgColor: state.bgColor,
  };
}

const previewStart = performance.now();
function previewLoop(now) {
  if (!exporting) {
    const elapsedSec = (now - previewStart) / 1000;
    const phase = (elapsedSec % state.duration) / state.duration;
    renderer.setSize(state.width, state.height);
    renderer.render(currentParams(), phase);
  }
  requestAnimationFrame(previewLoop);
}
requestAnimationFrame(previewLoop);

// --- Export --------------------------------------------------------------

function setBusy(busy) {
  exporting = busy;
  el.exportWebmBtn.disabled = busy;
  el.exportGifBtn.disabled = busy;
  el.exportProgress.hidden = !busy;
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

function addResult({ name, blob, isVideo, width, height }) {
  const node = resultTemplate.content.firstElementChild.cloneNode(true);
  const url = URL.createObjectURL(blob);
  const previewSlot = node.querySelector('.result-preview');
  previewSlot.style.aspectRatio = `${width} / ${height}`;
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
  node.querySelector('.result-size').textContent = formatBytes(blob.size);
  const link = node.querySelector('.result-download');
  link.href = url;
  link.download = name;
  el.results.prepend(node);
}

el.exportWebmBtn.addEventListener('click', async () => {
  setBusy(true);
  const { width, height } = state;
  try {
    renderer.setSize(width, height);
    const blob = await exportWebm({
      canvas,
      renderFrame: (phase) => renderer.render(currentParams(), phase),
      fps: state.fps,
      duration: state.duration,
      onProgress: (p) => updateProgress(p, `Запись WebM… ${Math.round(p * 100)}%`),
    });
    const name = `liquid-gradient-${width}x${height}.webm`;
    addResult({ name, blob, isVideo: true, width, height });
    showStatus(`Готово: ${name} (${formatBytes(blob.size)})`, 'success');
  } catch (err) {
    console.error(err);
    showStatus(`Не удалось экспортировать WebM: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
});

el.exportGifBtn.addEventListener('click', async () => {
  setBusy(true);
  const { width, height } = gifSize();
  try {
    renderer.setSize(width, height);
    const blob = await exportGif({
      canvas,
      renderFrame: (phase) => renderer.render(currentParams(), phase),
      width,
      height,
      fps: Math.min(state.fps, 30),
      duration: state.duration,
      onProgress: (p, stage) => {
        const label = stage === 'render' ? 'Рендер кадров…' : 'Кодирование GIF…';
        updateProgress(p, `${label} ${Math.round(p * 100)}%`);
      },
    });
    const name = `liquid-gradient-${width}x${height}.gif`;
    addResult({ name, blob, isVideo: false, width, height });
    showStatus(`Готово: ${name} (${formatBytes(blob.size)})`, 'success');
  } catch (err) {
    console.error(err);
    showStatus(`Не удалось экспортировать GIF: ${err.message}`, 'error');
  } finally {
    setBusy(false);
  }
});
