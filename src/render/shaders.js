// 4D simplex noise, vendored from Ashima Arts / Stefan Gustavson's
// webgl-noise (MIT). See vendor/webgl-noise/README.md for provenance.
// The trailing `#pragma glslify` line from the original file is stripped
// since this project has no glslify build step.
export const SIMPLEX_4D = /* glsl */ `
vec4 mod289(vec4 x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0; }

float mod289(float x) {
  return x - floor(x * (1.0 / 289.0)) * 289.0; }

vec4 permute(vec4 x) {
     return mod289(((x*34.0)+1.0)*x);
}

float permute(float x) {
     return mod289(((x*34.0)+1.0)*x);
}

vec4 taylorInvSqrt(vec4 r)
{
  return 1.79284291400159 - 0.85373472095314 * r;
}

float taylorInvSqrt(float r)
{
  return 1.79284291400159 - 0.85373472095314 * r;
}

vec4 grad4(float j, vec4 ip)
  {
  const vec4 ones = vec4(1.0, 1.0, 1.0, -1.0);
  vec4 p,s;

  p.xyz = floor( fract (vec3(j) * ip.xyz) * 7.0) * ip.z - 1.0;
  p.w = 1.5 - dot(abs(p.xyz), ones.xyz);
  s = vec4(lessThan(p, vec4(0.0)));
  p.xyz = p.xyz + (s.xyz*2.0 - 1.0) * s.www;

  return p;
  }

#define F4 0.309016994374947451

float snoise(vec4 v)
  {
  const vec4  C = vec4( 0.138196601125011,
                        0.276393202250021,
                        0.414589803375032,
                       -0.447213595499958);

  vec4 i  = floor(v + dot(v, vec4(F4)) );
  vec4 x0 = v -   i + dot(i, C.xxxx);

  vec4 i0;
  vec3 isX = step( x0.yzw, x0.xxx );
  vec3 isYZ = step( x0.zww, x0.yyz );
  i0.x = isX.x + isX.y + isX.z;
  i0.yzw = 1.0 - isX;
  i0.y += isYZ.x + isYZ.y;
  i0.zw += 1.0 - isYZ.xy;
  i0.z += isYZ.z;
  i0.w += 1.0 - isYZ.z;

  vec4 i3 = clamp( i0, 0.0, 1.0 );
  vec4 i2 = clamp( i0-1.0, 0.0, 1.0 );
  vec4 i1 = clamp( i0-2.0, 0.0, 1.0 );

  vec4 x1 = x0 - i1 + C.xxxx;
  vec4 x2 = x0 - i2 + C.yyyy;
  vec4 x3 = x0 - i3 + C.zzzz;
  vec4 x4 = x0 + C.wwww;

  i = mod289(i);
  float j0 = permute( permute( permute( permute(i.w) + i.z) + i.y) + i.x);
  vec4 j1 = permute( permute( permute( permute (
             i.w + vec4(i1.w, i2.w, i3.w, 1.0 ))
           + i.z + vec4(i1.z, i2.z, i3.z, 1.0 ))
           + i.y + vec4(i1.y, i2.y, i3.y, 1.0 ))
           + i.x + vec4(i1.x, i2.x, i3.x, 1.0 ));

  vec4 ip = vec4(1.0/294.0, 1.0/49.0, 1.0/7.0, 0.0) ;

  vec4 p0 = grad4(j0,   ip);
  vec4 p1 = grad4(j1.x, ip);
  vec4 p2 = grad4(j1.y, ip);
  vec4 p3 = grad4(j1.z, ip);
  vec4 p4 = grad4(j1.w, ip);

  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  p4 *= taylorInvSqrt(dot(p4,p4));

  vec3 m0 = max(0.6 - vec3(dot(x0,x0), dot(x1,x1), dot(x2,x2)), 0.0);
  vec2 m1 = max(0.6 - vec2(dot(x3,x3), dot(x4,x4)            ), 0.0);
  m0 = m0 * m0;
  m1 = m1 * m1;
  return 49.0 * ( dot(m0*m0, vec3( dot( p0, x0 ), dot( p1, x1 ), dot( p2, x2 )))
               + dot(m1*m1, vec2( dot( p3, x3 ), dot( p4, x4 ) ) ) ) ;
  }
`;

export const VERTEX_SHADER = /* glsl */ `#version 300 es
// Fullscreen triangle, no vertex buffer needed.
void main() {
  vec2 pos = vec2(
    (gl_VertexID == 2) ? 3.0 : -1.0,
    (gl_VertexID == 0) ? 3.0 : -1.0
  );
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

export const MAX_COLORS = 6;

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform float u_phase;   // loop position, 0..1 (wraps back to 0)
uniform float u_loops;   // integer number of noise revolutions per loop
uniform float u_amplitude; // 0..1, how far the pattern travels per loop (0 = frozen, 1 = full motion) — this is what the "speed" slider actually controls
uniform float u_scale;
uniform float u_warp;
uniform float u_softness;
uniform vec2 u_seed;
uniform float u_circleMask;
uniform vec3 u_bgColor;
uniform int u_colorCount;
uniform vec3 u_colors[${MAX_COLORS}];
uniform float u_stops[${MAX_COLORS}];

out vec4 fragColor;

${SIMPLEX_4D}

// Sampling noise along a circle in the w/z plane makes the animation
// close perfectly on itself: phase 0.0 and phase 1.0 map to the same
// point on the circle, so frame 0 and the last frame are identical
// neighbours instead of a visible jump cut. This holds for ANY radius
// (u_amplitude), not just integer ones — shrinking the radius just
// makes the traversed arc of noise-space shorter, which is what reads
// as "slower" motion, without ever breaking the closure.
vec2 loopCircle(float phase, float loops, float amplitude) {
  float a = phase * 6.283185307179586 * loops;
  return vec2(cos(a), sin(a)) * amplitude;
}

// Only 3 octaves: liquid-gradient hero backgrounds read best as soft,
// large color blobs, not fine marbled texture, so we deliberately skip
// the higher-frequency detail a full fbm would add.
float fbm(vec2 p, vec2 offset, float phase, float loops, float amplitude) {
  float value = 0.0;
  float amp = 0.6;
  float freq = 1.0;
  for (int i = 0; i < 3; i++) {
    vec2 circle = loopCircle(phase, loops, amplitude) * freq;
    value += amp * snoise(vec4((p + offset) * freq, circle));
    freq *= 1.8;
    amp *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 p = uv - 0.5;
  p.x *= u_resolution.x / u_resolution.y;
  p = p * u_scale + 0.5;

  vec2 q = vec2(
    fbm(p, u_seed, u_phase, u_loops, u_amplitude),
    fbm(p, u_seed + vec2(5.2, 1.3), u_phase, u_loops, u_amplitude)
  );

  vec2 r = vec2(
    fbm(p + u_warp * q, u_seed + vec2(8.3, 2.8), u_phase, u_loops, u_amplitude),
    fbm(p + u_warp * q, u_seed + vec2(1.7, 9.2), u_phase, u_loops, u_amplitude)
  );

  float field = fbm(p + u_warp * r, u_seed, u_phase, u_loops, u_amplitude);
  field = clamp(field * 0.5 + 0.5, 0.0, 1.0);
  field = pow(field, mix(2.2, 0.45, u_softness));

  vec3 color = u_colors[0];
  for (int i = 0; i < ${MAX_COLORS - 1}; i++) {
    if (i + 1 >= u_colorCount) break;
    float t = smoothstep(u_stops[i], u_stops[i + 1], field);
    color = mix(color, u_colors[i + 1], t);
  }

  if (u_circleMask > 0.5) {
    vec2 c = uv - 0.5;
    c.x *= u_resolution.x / u_resolution.y;
    float d = length(c) * 2.0;
    float inside = 1.0 - smoothstep(0.96, 1.0, d);
    color = mix(u_bgColor, color, inside);
  }

  fragColor = vec4(color, 1.0);
}
`;
