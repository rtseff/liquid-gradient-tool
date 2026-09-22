function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * MediaRecorder path, used only when the user chooses to keep the alpha
 * channel: Chrome's MediaRecorder writes VP9 with an alpha plane
 * (Matroska AlphaMode=1) for canvas captures, which WebCodecs'
 * VideoEncoder can't do here. Everything else goes through exportVideo.js.
 *
 * Renders the seamless loop frame-by-frame, driving the canvas track
 * manually (captureStream(0) + track.requestFrame()) so every rendered
 * frame is captured exactly once instead of relying on wall-clock sampling.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {(phase: number) => void} opts.renderFrame draws one frame for phase in [0, 1)
 * @param {number} opts.fps
 * @param {number} opts.duration seconds
 * @param {number} opts.bitrate bits per second
 * @param {(progress: number) => void} [opts.onProgress] 0..1
 * @returns {Promise<Blob>}
 */
export async function exportWebm({ canvas, renderFrame, fps, duration, bitrate, onProgress }) {
  const mimeType = pickMimeType();
  if (!mimeType) {
    throw new Error('MediaRecorder не поддерживает запись WebM в этом браузере.');
  }
  if (typeof canvas.captureStream !== 'function') {
    throw new Error('canvas.captureStream() недоступен в этом браузере.');
  }

  const totalFrames = Math.max(1, Math.round(fps * duration));
  const stream = canvas.captureStream(0); // 0 fps = manual frame pushing
  const track = stream.getVideoTracks()[0];

  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: bitrate,
  });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = (e) => reject(e.error || new Error('MediaRecorder error'));
  });

  recorder.start();

  const frameIntervalMs = 1000 / fps;
  const start = performance.now();
  for (let i = 0; i < totalFrames; i++) {
    const phase = i / totalFrames;
    renderFrame(phase);
    track.requestFrame();
    onProgress?.((i + 1) / totalFrames);
    // MediaRecorder timestamps frames by wall clock, so pace against an
    // absolute schedule (not a fixed sleep after each render, which adds
    // the render time to every frame and stretches the video). If the
    // machine can't render in real time the result is still stretched —
    // that's inherent to this path; exportVideo.js has exact timestamps.
    await sleep(Math.max(0, start + (i + 1) * frameIntervalMs - performance.now()));
  }

  recorder.stop();
  await stopped;
  track.stop();

  return new Blob(chunks, { type: 'video/webm' });
}
