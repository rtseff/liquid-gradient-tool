import { VERTEX_SHADER, FRAGMENT_SHADER, MAX_COLORS } from './shaders.js';

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error: ${info}`);
  }
  return shader;
}

function hexToRgb01(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return [r, g, b];
}

export { hexToRgb01, MAX_COLORS };

export class LiquidGradientRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error('WebGL2 недоступен в этом браузере.');
    }
    this.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      throw new Error(`Program link error: ${info}`);
    }
    this.program = program;

    // Fullscreen triangle is generated in the vertex shader from
    // gl_VertexID, so a VAO with no attributes is enough.
    this.vao = gl.createVertexArray();

    this.uniforms = {
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      phase: gl.getUniformLocation(program, 'u_phase'),
      loops: gl.getUniformLocation(program, 'u_loops'),
      amplitude: gl.getUniformLocation(program, 'u_amplitude'),
      scale: gl.getUniformLocation(program, 'u_scale'),
      warp: gl.getUniformLocation(program, 'u_warp'),
      softness: gl.getUniformLocation(program, 'u_softness'),
      seed: gl.getUniformLocation(program, 'u_seed'),
      colorCount: gl.getUniformLocation(program, 'u_colorCount'),
      colors: gl.getUniformLocation(program, 'u_colors'),
      stops: gl.getUniformLocation(program, 'u_stops'),
      grainEnabled: gl.getUniformLocation(program, 'u_grainEnabled'),
      grainSize: gl.getUniformLocation(program, 'u_grainSize'),
      grainDensity: gl.getUniformLocation(program, 'u_grainDensity'),
      grainColor: gl.getUniformLocation(program, 'u_grainColor'),
      grainOpacity: gl.getUniformLocation(program, 'u_grainOpacity'),
      grainFrames: gl.getUniformLocation(program, 'u_grainFrames'),
      grainBlend: gl.getUniformLocation(program, 'u_grainBlend'),
      grainVariance: gl.getUniformLocation(program, 'u_grainVariance'),
      grainSoftness: gl.getUniformLocation(program, 'u_grainSoftness'),
    };
  }

  setSize(width, height) {
    const canvas = this.canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }

  /**
   * @param {object} params
   * @param {string[]} params.colors hex colors, evenly spaced along the gradient
   * @param {number} params.scale
   * @param {number} params.warp
   * @param {number} params.softness
   * @param {number} params.loops integer noise revolutions per full loop (keep at 1 unless you want busier motion)
   * @param {number} params.speed 0..1, how far the pattern travels per loop — the actual "fast/slow" control
   * @param {[number, number]} params.seed
   * @param {number} phase 0..1, position within the seamless loop
   */
  render(params, phase) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const colorCount = Math.min(params.colors.length, MAX_COLORS);
    const colorFloats = new Float32Array(MAX_COLORS * 3);
    const stopFloats = new Float32Array(MAX_COLORS);
    for (let i = 0; i < colorCount; i++) {
      const [r, g, b] = hexToRgb01(params.colors[i]);
      colorFloats[i * 3] = r;
      colorFloats[i * 3 + 1] = g;
      colorFloats[i * 3 + 2] = b;
      stopFloats[i] = colorCount === 1 ? 0 : i / (colorCount - 1);
    }

    gl.uniform2f(this.uniforms.resolution, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.phase, phase);
    gl.uniform1f(this.uniforms.loops, params.loops);
    gl.uniform1f(this.uniforms.amplitude, params.speed);
    gl.uniform1f(this.uniforms.scale, params.scale);
    gl.uniform1f(this.uniforms.warp, params.warp);
    gl.uniform1f(this.uniforms.softness, params.softness);
    gl.uniform2f(this.uniforms.seed, params.seed[0], params.seed[1]);
    gl.uniform1i(this.uniforms.colorCount, colorCount);
    gl.uniform3fv(this.uniforms.colors, colorFloats);
    gl.uniform1fv(this.uniforms.stops, stopFloats);

    const grain = params.grain;
    gl.uniform1f(this.uniforms.grainEnabled, grain?.enabled ? 1 : 0);
    if (grain?.enabled) {
      gl.uniform1f(this.uniforms.grainSize, grain.size);
      gl.uniform1f(this.uniforms.grainDensity, grain.density);
      gl.uniform3f(this.uniforms.grainColor, ...hexToRgb01(grain.color));
      gl.uniform1f(this.uniforms.grainOpacity, grain.opacity);
      gl.uniform1f(this.uniforms.grainFrames, grain.frames);
      gl.uniform1f(this.uniforms.grainBlend, { normal: 0, overlay: 1, softlight: 2 }[grain.blend] ?? 0);
      gl.uniform1f(this.uniforms.grainVariance, grain.variance);
      gl.uniform1f(this.uniforms.grainSoftness, grain.softness);
    }

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
