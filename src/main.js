import { LiquidGradientRenderer } from './render/LiquidGradientRenderer.js';
import { exportWebm } from './export/exportWebm.js';
import { exportGif } from './export/exportGif.js';
import { PRESETS, presetGradientCss } from './presets.js';

const canvas = document.getElementById('previewCanvas');
const renderer = new LiquidGradientRenderer(canvas);

const state = {
  colors: [...PRESETS[0].colors],
  scale: 1.3,
  warp: 0.9,
  softness: 0.3,
  speed: 0.5, // raw slider value 0..1, eased into an amplitude via speedToAmplitude()
  seed: [randomSeedValue(), randomSeedValue()],
  maskMode: 'none', // 'none' | 'circle' | 'custom'
  maskInvert: false,
  maskImage: null,
  bgColor: '#000000',
  width: 1600,
  height: 900,
  duration: 4,
  fps: 30,
  gifWidth: 480,
};

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

// --- DOM refs -------------------------------------------------------------

const el = {
  presetList: document.getElementById('presetList'),
  colorList: document.getElementById('colorList'),
  addColorBtn: document.getElementById('addColorBtn'),
  randomizeBtn: document.getElementById('randomizeBtn'),
  undoColorBtn: document.getElementById('undoColorBtn'),
  redoColorBtn: document.getElementById('redoColorBtn'),
  scale: document.getElementById('scale'),
  scaleOut: document.getElementById('scaleOut'),
  warp: document.getElementById('warp'),
  warpOut: document.getElementById('warpOut'),
  softness: document.getElementById('softness'),
  softnessOut: document.getElementById('softnessOut'),
  speed: document.getElementById('speed'),
  speedOut: document.getElementById('speedOut'),
  maskMode: document.getElementById('maskMode'),
  maskUploadRow: document.getElementById('maskUploadRow'),
  maskFileInput: document.getElementById('maskFileInput'),
  maskPreviewRow: document.getElementById('maskPreviewRow'),
  maskPreviewImg: document.getElementById('maskPreviewImg'),
  clearMaskBtn: document.getElementById('clearMaskBtn'),
  maskInvertField: document.getElementById('maskInvertField'),
  maskInvert: document.getElementById('maskInvert'),
  maskHint: document.getElementById('maskHint'),
  bgColorField: document.getElementById('bgColorField'),
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
  exportProgress: document.getElementById('exportProgress'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),
  results: document.getElementById('results'),
};

const colorRowTemplate = document.getElementById('colorRowTemplate');
const resultTemplate = document.getElementById('resultTemplate');

// --- Presets ---------------------------------------------------------------

PRESETS.forEach((preset) => {
  const btn = document.createElement('div');
  btn.className = 'preset-swatch';
  btn.style.background = presetGradientCss(preset.colors);
  btn.title = preset.name;
  btn.innerHTML = `<span>${preset.name}</span>`;
  btn.addEventListener('click', () => {
    state.colors = [...preset.colors];
    pushColorHistory();
    renderColorList();
  });
  el.presetList.appendChild(btn);
});

// --- Colors ------------------------------------------------------------
//
// Every add/remove/edit of the palette is pushed onto an undo/redo
// history stack (snapshots of state.colors), so mistakes made while
// experimenting with a palette are cheap to back out of.

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
    removeBtn.disabled = state.colors.length <= 2;
    removeBtn.addEventListener('click', () => {
      if (state.colors.length <= 2) return;
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
}

el.addColorBtn.addEventListener('click', () => {
  if (state.colors.length >= 6) return;
  const last = state.colors[state.colors.length - 1] || '#ffffff';
  state.colors.push(last);
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

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  e.preventDefault();
  if (e.shiftKey) {
    el.redoColorBtn.click();
  } else {
    el.undoColorBtn.click();
  }
});

el.randomizeBtn.addEventListener('click', () => {
  state.seed = [randomSeedValue(), randomSeedValue()];
});

renderColorList();
updateHistoryButtons();

// --- Shape sliders -------------------------------------------------------

function bindRange(input, output, key, format = (v) => v.toFixed(2)) {
  input.value = state[key];
  output.textContent = format(state[key]);
  input.addEventListener('input', () => {
    state[key] = parseFloat(input.value);
    output.textContent = format(state[key]);
  });
}

bindRange(el.scale, el.scaleOut, 'scale');
bindRange(el.warp, el.warpOut, 'warp');
bindRange(el.softness, el.softnessOut, 'softness');
bindRange(el.speed, el.speedOut, 'speed', (v) => `${Math.round(v * 100)}%`);
bindRange(el.duration, el.durationOut, 'duration', (v) => `${v.toFixed(1)}с`);

el.gifWidth.value = state.gifWidth;
el.gifWidthOut.textContent = `${state.gifWidth}px`;
el.gifWidth.addEventListener('input', () => {
  state.gifWidth = parseInt(el.gifWidth.value, 10);
  el.gifWidthOut.textContent = `${state.gifWidth}px`;
});

// --- Mask ------------------------------------------------------------

function updateMaskUi() {
  const mode = state.maskMode;
  el.maskUploadRow.hidden = mode !== 'custom';
  el.maskPreviewRow.hidden = !(mode === 'custom' && state.maskImage);
  el.maskInvertField.hidden = mode === 'none';
  el.bgColorField.hidden = mode === 'none';
  el.maskHint.hidden = mode !== 'custom';
}

el.maskMode.addEventListener('change', () => {
  state.maskMode = el.maskMode.value;
  updateMaskUi();
});

el.maskFileInput.addEventListener('change', () => {
  const file = el.maskFileInput.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    state.maskImage = image;
    renderer.setMaskImage(image);
    el.maskPreviewImg.src = url;
    updateMaskUi();
  };
  image.onerror = () => {
    alert('Не удалось загрузить изображение маски.');
    URL.revokeObjectURL(url);
  };
  image.src = url;
});

el.clearMaskBtn.addEventListener('click', () => {
  state.maskImage = null;
  el.maskFileInput.value = '';
  el.maskPreviewImg.src = '';
  updateMaskUi();
});

el.maskInvert.addEventListener('change', () => {
  state.maskInvert = el.maskInvert.checked;
});

updateMaskUi();

el.bgColor.value = state.bgColor;
el.bgColor.addEventListener('input', () => {
  state.bgColor = el.bgColor.value;
});

el.fps.value = String(state.fps);
el.fps.addEventListener('change', () => {
  state.fps = parseInt(el.fps.value, 10);
});

// --- Resolution ------------------------------------------------------------

function applyResolution(w, h) {
  state.width = w;
  state.height = h;
}

el.resolutionPreset.value = '1600x900';

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

el.customWidth.addEventListener('input', () => {
  applyResolution(parseInt(el.customWidth.value, 10) || state.width, state.height);
});
el.customHeight.addEventListener('input', () => {
  applyResolution(state.width, parseInt(el.customHeight.value, 10) || state.height);
});

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

let previewStart = performance.now();
function previewLoop(now) {
  const elapsedSec = (now - previewStart) / 1000;
  const phase = (elapsedSec % state.duration) / state.duration;
  renderer.setSize(state.width, state.height);
  renderer.render(currentParams(), phase);
  requestAnimationFrame(previewLoop);
}
requestAnimationFrame(previewLoop);

// --- Export --------------------------------------------------------------

function setBusy(busy) {
  el.exportWebmBtn.disabled = busy;
  el.exportGifBtn.disabled = busy;
  el.exportProgress.hidden = !busy;
  if (!busy) {
    el.progressFill.style.width = '0%';
  }
}

function updateProgress(fraction, label) {
  el.progressFill.style.width = `${Math.round(fraction * 100)}%`;
  el.progressLabel.textContent = label;
}

function addResult({ name, blob, isVideo }) {
  const node = resultTemplate.content.firstElementChild.cloneNode(true);
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
    previewSlot.appendChild(img);
  }
  node.querySelector('.result-name').textContent = name;
  node.querySelector('.result-size').textContent = `${(blob.size / (1024 * 1024)).toFixed(2)} МБ`;
  const link = node.querySelector('.result-download');
  link.href = url;
  link.download = name;
  el.results.prepend(node);
}

el.exportWebmBtn.addEventListener('click', async () => {
  setBusy(true);
  try {
    renderer.setSize(state.width, state.height);
    const blob = await exportWebm({
      canvas,
      renderFrame: (phase) => renderer.render(currentParams(), phase),
      fps: state.fps,
      duration: state.duration,
      onProgress: (p) => updateProgress(p, `Запись WebM… ${Math.round(p * 100)}%`),
    });
    addResult({ name: `liquid-gradient-${state.width}x${state.height}.webm`, blob, isVideo: true });
  } catch (err) {
    console.error(err);
    alert(`Не удалось экспортировать WebM: ${err.message}`);
  } finally {
    setBusy(false);
  }
});

el.exportGifBtn.addEventListener('click', async () => {
  setBusy(true);
  try {
    const aspect = state.height / state.width;
    const gifW = Math.min(state.gifWidth, state.width);
    const gifH = Math.round(gifW * aspect);
    renderer.setSize(gifW, gifH);
    const blob = await exportGif({
      canvas,
      renderFrame: (phase) => renderer.render(currentParams(), phase),
      width: gifW,
      height: gifH,
      fps: Math.min(state.fps, 30),
      duration: state.duration,
      onProgress: (p, stage) => {
        const label = stage === 'render' ? 'Рендер кадров…' : 'Кодирование GIF…';
        updateProgress(p, `${label} ${Math.round(p * 100)}%`);
      },
    });
    addResult({ name: `liquid-gradient-${gifW}x${gifH}.gif`, blob, isVideo: false });
  } catch (err) {
    console.error(err);
    alert(`Не удалось экспортировать GIF: ${err.message}`);
  } finally {
    renderer.setSize(state.width, state.height);
    setBusy(false);
  }
});
