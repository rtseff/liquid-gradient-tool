# webgl-noise (vendored)

`simplex4d.glsl` is the 4D simplex noise implementation from Ashima Arts /
Stefan Gustavson's `webgl-noise` project, distributed here via the
`glsl-noise` npm package (https://www.npmjs.com/package/glsl-noise, MIT,
see `LICENSE`).

It is used by `src/render/shaders.js` to drive the animated noise field.
4D noise lets the animation sample points along a closed circle in the
extra two dimensions, which is what makes the exported loop seamless
(frame 0 and the last frame connect with no visible jump).

Source: https://github.com/ashima/webgl-noise
