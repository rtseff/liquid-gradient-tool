# mp4-muxer (vendored)

`mp4-muxer.mjs` is the unmodified `build/mp4-muxer.mjs` from
[`mp4-muxer`](https://www.npmjs.com/package/mp4-muxer) v5.2.2 by
Vanilagy, taken from the npm registry tarball
(`https://registry.npmjs.org/mp4-muxer/-/mp4-muxer-5.2.2.tgz`).
License: MIT (see `LICENSE`).

Used by `src/export/exportVideo.js` to pack H.264 chunks produced by
WebCodecs `VideoEncoder` into an `.mp4` file (`fastStart: 'in-memory'`,
so the `moov` box sits at the start and the video can start playing
before it is fully downloaded).

The package is marked as superseded by the same author's Mediabunny.
It was kept instead because Mediabunny's smallest bundle is ~684 KB
(MPL-2.0) versus ~69 KB here, and muxing already-encoded frames needs
no new features.
