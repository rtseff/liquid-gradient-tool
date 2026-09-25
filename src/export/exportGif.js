// Uses the vendored gif.js (MIT, https://www.npmjs.com/package/gif.js).
// See vendor/gifjs for provenance — no CDN dependency at runtime.
let GifCtor = null;

async function loadGifLibrary() {
  if (GifCtor) return GifCtor;
  if (!window.GIF) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('../../vendor/gifjs/gif.js', import.meta.url).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Не удалось загрузить vendor/gifjs/gif.js'));
      document.head.appendChild(script);
    });
  }
  GifCtor = window.GIF;
  return GifCtor;
}

/**
 * Renders the seamless loop frame-by-frame at the given resolution and
 * encodes it into an animated GIF using gif.js. Frames are generated as
 * fast as the GPU allows — no real-time pacing needed, since the GIF's
 * own per-frame delays (not wall-clock timing during capture) set its
 * playback speed.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas source canvas, must already be sized to width/height
 * @param {(phase: number) => void} opts.renderFrame draws one frame for phase in [0, 1)
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fps
 * @param {number} opts.duration seconds
 * @param {number} [opts.quality] gif.js quality, 1 (best/slowest) - 30 (worst/fastest)
 * @param {(progress: number, stage: 'render' | 'encode') => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal] checked between frames; aborting rejects with an AbortError
 * @returns {Promise<Blob>}
 */
export async function exportGif({
  canvas,
  renderFrame,
  width,
  height,
  fps,
  duration,
  quality = 10,
  onProgress,
  signal,
}) {
  const GIF = await loadGifLibrary();
  const workerScript = new URL('../../vendor/gifjs/gif.worker.js', import.meta.url).href;

  const gif = new GIF({
    workers: Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)),
    quality,
    width,
    height,
    workerScript,
  });

  const totalFrames = Math.max(1, Math.round(fps * duration));
  const delayMs = 1000 / fps;

  for (let i = 0; i < totalFrames; i++) {
    signal?.throwIfAborted();
    const phase = i / totalFrames;
    renderFrame(phase);
    gif.addFrame(canvas, { delay: delayMs, copy: true });
    onProgress?.((i + 1) / totalFrames, 'render');
    // Yield to the event loop so the tab doesn't freeze on large frame counts.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // Rendering finished before any cancellation — check once more before
  // committing to gif.js's own encoding stage, which is cancelled via
  // gif.abort() instead (there's no render() to simply not call once it
  // has started).
  signal?.throwIfAborted();

  gif.on('progress', (p) => onProgress?.(p, 'encode'));

  const blob = await new Promise((resolve, reject) => {
    const onAbortSignal = () => gif.abort();
    signal?.addEventListener('abort', onAbortSignal);
    const cleanup = () => signal?.removeEventListener('abort', onAbortSignal);
    gif.on('finished', (blob) => {
      cleanup();
      resolve(blob);
    });
    gif.on('abort', () => {
      cleanup();
      reject(signal?.aborted ? signal.reason : new Error('Кодирование GIF прервано.'));
    });
    try {
      gif.render();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });

  return blob;
}
