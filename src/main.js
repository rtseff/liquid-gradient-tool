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
  loops: 1,
  seed: [randomSeedValue(), randomSeedValue()],
  circleMask: false,
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

// --- DOM refs -------------------------------------------------------------

const el = {
  presetList: document.getElementById('presetList'),
  colorList: document.getElementById('colorList'),
  addColorBtn: document.getElementById('addColorBtn'),
  randomizeBtn: document.getElementById('randomizeBtn'),
  scale: document.getElementById('scale'),
  scaleOut: document.getElementById('scaleOut'),
  warp: document.getElementById('warp'),
  warpOut: document.getElementById('warpOut'),
  softness: document.getElementById('softness'),
  softnessOut: document.getElementById('softnessOut'),
  loops: document.getElementById('loops'),
  loopsOut: document.getElementById('loopsOut'),
  circleMask: document.getElementById('circleMask'),
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
    renderColorList();
  });
  el.presetList.appendChild(btn);
});

// --- Colors ------------------------------------------------------------

function renderColorList() {
  el.colorList.innerHTML = '';
  state.colors.forEach((color, index) => {
    const node = colorRowTemplate.content.firstElementChild.cloneNode(true);
    const input = node.querySelector('.color-input');
    input.value = color;
    input.addEventListener('input', () => {
      state.colors[index] = input.value;
    });
    const removeBtn = node.querySelector('.remove-color');
    removeBtn.disabled = state.colors.length <= 2;
    removeBtn.addEventListener('click', () => {
      if (state.colors.length <= 2) return;
      state.colors.splice(index, 1);
      renderColorList();
    });
    el.colorList.appendChild(node);
  });
}

el.addColorBtn.addEventListener('click', () => {
  if (state.colors.length >= 6) return;
  const last = state.colors[state.colors.length - 1] || '#ffffff';
  state.colors.push(last);
  renderColorList();
});

el.randomizeBtn.addEventListener('click', () => {
  state.seed = [randomSeedValue(), randomSeedValue()];
});

renderColorList();

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
bindRange(el.loops, el.loopsOut, 'loops', (v) => String(v));
bindRange(el.duration, el.durationOut, 'duration', (v) => `${v.toFixed(1)}с`);

el.gifWidth.value = state.gifWidth;
el.gifWidthOut.textContent = `${state.gifWidth}px`;
el.gifWidth.addEventListener('input', () => {
  state.gifWidth = parseInt(el.gifWidth.value, 10);
  el.gifWidthOut.textContent = `${state.gifWidth}px`;
});

el.circleMask.addEventListener('change', () => {
  state.circleMask = el.circleMask.checked;
  el.bgColorField.hidden = !state.circleMask;
});

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
    loops: state.loops,
    seed: state.seed,
    circleMask: state.circleMask,
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
