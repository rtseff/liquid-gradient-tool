# gif.js (vendored)

`gif.js` and `gif.worker.js` are the built distribution files of
[`gif.js`](https://www.npmjs.com/package/gif.js) v0.2.0 by Johan
Nordberg, fetched from the npm registry tarball
(`https://registry.npmjs.org/gif.js/-/gif.js-0.2.0.tgz`) rather than a
CDN, so the app has no runtime dependency on external hosts. License:
MIT (see below). Upstream: https://github.com/jnordberg/gif.js

`src/export/exportGif.js` loads `gif.js` via a `<script>` tag and hands
it `gif.worker.js`'s URL as `workerScript`, exactly as the upstream
library expects.

## License (MIT)

```
Copyright (c) Johan Nordberg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
