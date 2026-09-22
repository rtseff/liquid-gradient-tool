# webm-muxer (vendored)

`webm-muxer.mjs` is the unmodified `build/webm-muxer.mjs` from
[`webm-muxer`](https://www.npmjs.com/package/webm-muxer) v5.1.4 by
Vanilagy, taken from the npm registry tarball
(`https://registry.npmjs.org/webm-muxer/-/webm-muxer-5.1.4.tgz`).
License: MIT (see `LICENSE`).

Used by `src/export/exportVideo.js` to pack VP9 chunks produced by
WebCodecs `VideoEncoder` into a `.webm` file.

The package is marked as superseded by the same author's Mediabunny.
It was kept instead because Mediabunny's smallest bundle is ~684 KB
(MPL-2.0) versus ~65 KB here, and muxing already-encoded frames needs
no new features.
