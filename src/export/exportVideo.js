// WebCodecs-based video export: frames are rendered one by one, encoded
// with VideoEncoder and packed by the vendored muxers (see vendor/*-muxer).
// Timestamps come from the frame index, not the wall clock, so this runs
// as fast as the GPU/encoder allow and the output duration is exact.
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from '../../vendor/webm-muxer/webm-muxer.mjs';
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from '../../vendor/mp4-muxer/mp4-muxer.mjs';

// H.264 levels (ITU-T H.264 Table A-1): max macroblocks/second, max frame
// size in macroblocks. Encoders reject a config whose level is too low
// for the requested size/fps, so pick the smallest level that fits.
const AVC_LEVELS = [
  { hex: '1f', mbps: 108000, fs: 3600 }, // 3.1
  { hex: '20', mbps: 216000, fs: 5120 }, // 3.2
  { hex: '28', mbps: 245760, fs: 8192 }, // 4.0
  { hex: '2a', mbps: 522240, fs: 8704 }, // 4.2
  { hex: '32', mbps: 589824, fs: 22080 }, // 5.0
  { hex: '33', mbps: 983040, fs: 36864 }, // 5.1
  { hex: '34', mbps: 2073600, fs: 36864 }, // 5.2
  { hex: '3c', mbps: 4177920, fs: 139264 }, // 6.0
  { hex: '3d', mbps: 8355840, fs: 139264 }, // 6.1
];

// VP9 levels (VP9 bitstream spec, Annex A): max luma samples/second and
// max luma picture size.
const VP9_LEVELS = [
  { code: '31', rate: 36864000, size: 983040 },
  { code: '40', rate: 83558400, size: 2228224 },
  { code: '41', rate: 160432128, size: 2228224 },
  { code: '50', rate: 311951360, size: 8912896 },
  { code: '51', rate: 588251136, size: 8912896 },
  { code: '60', rate: 1176502272, size: 35651584 },
];

function avcCodec(width, height, fps) {
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = AVC_LEVELS.find((l) => frameMbs <= l.fs && frameMbs * fps <= l.mbps) ?? AVC_LEVELS.at(-1);
  return `avc1.6400${level.hex}`; // High profile
}

function vp9Codec(width, height, fps) {
  const size = width * height;
  const level = VP9_LEVELS.find((l) => size <= l.size && size * fps <= l.rate) ?? VP9_LEVELS.at(-1);
  return `vp09.00.${level.code}.08`; // profile 0, 8-bit
}

const CONTAINERS = {
  webm: {
    label: 'WebM (VP9)',
    mime: 'video/webm',
    codec: vp9Codec,
    createMuxer: ({ width, height, fps }) => {
      const target = new WebmTarget();
      const muxer = new WebmMuxer({ target, video: { codec: 'V_VP9', width, height, frameRate: fps } });
      return { target, muxer };
    },
  },
  mp4: {
    label: 'MP4 (H.264)',
    mime: 'video/mp4',
    codec: avcCodec,
    extraConfig: { avc: { format: 'avc' } },
    createMuxer: ({ width, height, fps }) => {
      const target = new Mp4Target();
      const muxer = new Mp4Muxer({
        target,
        video: { codec: 'avc', width, height, frameRate: fps },
        fastStart: 'in-memory',
      });
      return { target, muxer };
    },
  },
};

function readVint(bytes, pos, keepMarker) {
  const first = bytes[pos];
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    mask >>= 1;
    length++;
  }
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[pos + i];
  return { value, length };
}

// webm-muxer sets Segment > Info > Duration to the *start* time of the last
// frame (e.g. 1.958 s for 48 frames at 24 fps) because it doesn't store
// per-frame durations. Players then give the loop's last frame ~0 display
// time, so overwrite it with the real length. Value is in TimestampScale
// units, which webm-muxer sets to 1 ms.
function setWebmDuration(buffer, durationMs) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const SEGMENT = 0x18538067;
  const INFO = 0x1549a966;
  const DURATION = 0x4489;
  const walk = (start, end) => {
    let pos = start;
    while (pos < end) {
      const id = readVint(bytes, pos, true);
      pos += id.length;
      const size = readVint(bytes, pos, false);
      pos += size.length;
      if (id.value === SEGMENT || id.value === INFO) {
        return walk(pos, Math.min(end, pos + size.value));
      }
      if (id.value === DURATION) {
        if (size.value === 8) view.setFloat64(pos, durationMs);
        else if (size.value === 4) view.setFloat32(pos, durationMs);
        else return false;
        return true;
      }
      pos += size.value;
    }
    return false;
  };
  if (!walk(0, bytes.length)) {
    throw new Error('не удалось записать длительность WebM');
  }
}

function encoderConfig(container, { width, height, fps, bitrate }) {
  const spec = CONTAINERS[container];
  return {
    codec: spec.codec(width, height, fps),
    width,
    height,
    bitrate,
    framerate: fps,
    // Our frames are always opaque; 'discard' guarantees the file has no
    // alpha plane (a VideoFrame captured from a canvas can otherwise
    // carry one).
    alpha: 'discard',
    ...spec.extraConfig,
  };
}

/**
 * Returns null if this browser can encode the container's codec at these
 * settings, otherwise a human-readable reason.
 */
export async function videoSupportProblem(container, settings) {
  if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') {
    return 'браузер не поддерживает WebCodecs — откройте инструмент в актуальном Chrome, Edge или Safari';
  }
  const isSupported = async (config) => {
    try {
      return (await VideoEncoder.isConfigSupported(config)).supported === true;
    } catch {
      return false;
    }
  };
  if (await isSupported(encoderConfig(container, settings))) return null;

  // Tell "no encoder for this codec at all" apart from "encoder exists
  // but not at this size/fps" by probing a small, universally valid config.
  const basic = encoderConfig(container, { width: 640, height: 360, fps: 30, bitrate: 1e6 });
  const name = container === 'mp4' ? 'H.264' : 'VP9';
  if (!(await isSupported(basic))) {
    return container === 'mp4'
      ? 'в этом браузере нет кодировщика H.264 (бывает в сборках Chromium без проприетарных кодеков) — откройте инструмент в Chrome, Edge или Safari'
      : 'в этом браузере нет кодировщика VP9';
  }
  return `кодировщик ${name} в этом браузере не поддерживает ${settings.width}×${settings.height} при ${settings.fps} fps — уменьшите размер или FPS`;
}

/**
 * @param {object} opts
 * @param {'webm'|'mp4'} opts.container
 * @param {HTMLCanvasElement} opts.canvas already sized to width × height
 * @param {(phase: number) => void} opts.renderFrame draws one frame for phase in [0, 1)
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fps
 * @param {number} opts.duration seconds
 * @param {number} opts.bitrate bits per second
 * @param {(progress: number) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal] checked between frames; aborting rejects with an AbortError
 * @returns {Promise<Blob>}
 */
export async function exportVideo({ container, canvas, renderFrame, width, height, fps, duration, bitrate, onProgress, signal }) {
  const problem = await videoSupportProblem(container, { width, height, fps, bitrate });
  if (problem) throw new Error(problem);

  const spec = CONTAINERS[container];
  const { target, muxer } = spec.createMuxer({ width, height, fps });

  let encodeError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encodeError = e;
    },
  });
  encoder.configure(encoderConfig(container, { width, height, fps, bitrate }));

  // Closed exactly once, however the loop below exits (finished, error, or
  // a caught abort) — VideoEncoder.close() throws if called twice.
  let encoderClosed = false;
  const closeEncoder = () => {
    if (encoderClosed) return;
    encoderClosed = true;
    try {
      encoder.close();
    } catch {
      // Already in a closed/errored state — nothing more to do.
    }
  };

  const totalFrames = Math.max(1, Math.round(fps * duration));
  const frameDurationUs = 1e6 / fps;
  const keyFrameEvery = Math.max(1, Math.round(fps * 2));

  try {
    for (let i = 0; i < totalFrames; i++) {
      signal?.throwIfAborted();
      if (encodeError) throw encodeError;
      renderFrame(i / totalFrames);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(i * frameDurationUs),
        duration: Math.round(frameDurationUs),
      });
      encoder.encode(frame, { keyFrame: i % keyFrameEvery === 0 });
      frame.close();
      onProgress?.((i + 1) / totalFrames);
      // Let the encoder drain and the progress bar repaint.
      while (encoder.encodeQueueSize > 4) {
        signal?.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await encoder.flush();
  } finally {
    closeEncoder();
  }
  if (encodeError) throw encodeError;
  muxer.finalize();
  if (container === 'webm') {
    setWebmDuration(target.buffer, (totalFrames * 1000) / fps);
  }
  return new Blob([target.buffer], { type: spec.mime });
}
