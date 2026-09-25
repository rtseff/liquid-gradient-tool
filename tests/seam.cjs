'use strict';

// Seam test: verifies the seamless-loop invariant described in CLAUDE.md
// ("The seamless-loop technique") — for any amplitude/loops/grain config,
// render(params, phase=0) must be pixel-identical to render(params, phase=1).
//
// CommonJS on purpose, so `NODE_PATH=$(npm root -g) node tests/seam.cjs`
// picks up the globally-installed Playwright (this repo has no
// package.json / node_modules, and no "type": "module").
//
// Usage:
//   NODE_PATH=$(npm root -g) node tests/seam.cjs 2>&1 | grep -v "GL Driver\|Automatic fallback"
//   NODE_PATH=$(npm root -g) node tests/seam.cjs --self-test 2>&1 | grep -v "GL Driver\|Automatic fallback"
//
// --self-test intentionally breaks one case (renders phase=1 with a
// slightly shifted seed) to prove the comparison actually catches a
// broken loop; it expects that one case to FAIL and exits accordingly.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..');
const SELF_TEST = process.argv.includes('--self-test');

const CONTENT_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
};

const SEAM_TEST_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>seam test</title></head>
<body>
<canvas id="c" width="160" height="90"></canvas>
<script type="module">
  import { LiquidGradientRenderer } from '/src/render/LiquidGradientRenderer.js';
  const canvas = document.getElementById('c');
  try {
    window.__renderer = new LiquidGradientRenderer(canvas);
    window.__ready = true;
  } catch (err) {
    window.__error = String(err && err.stack || err);
  }
</script>
</body>
</html>`;

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/__seam.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(SEAM_TEST_PAGE);
      return;
    }
    const filePath = path.join(REPO_ROOT, urlPath === '/' ? '/index.html' : urlPath);
    if (!filePath.startsWith(REPO_ROOT)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// --- Test cases -------------------------------------------------------

const COLOR_POOL = ['#ff3355', '#33ff88', '#3388ff', '#ffee33', '#ff33ee', '#33eeff'];

function colors(n) {
  return COLOR_POOL.slice(0, n);
}

function baseParams(overrides = {}) {
  return {
    colors: colors(3),
    scale: 1.3,
    warp: 0.9,
    softness: 0.3,
    loops: 1,
    speed: 0.5, // this IS the shader amplitude (LiquidGradientRenderer.render's params.speed)
    seed: [17.3, 42.9],
    grain: {
      enabled: false,
      size: 1,
      density: 0.5,
      opacity: 0.3,
      variance: 1,
      softness: 0.3,
      blend: 'overlay',
      color: '#ffffff',
      frames: 120,
    },
    ...overrides,
  };
}

function buildCases() {
  const cases = [];

  // Amplitude sweep, loops 1 and 2, grain off.
  for (const amplitude of [0.001, 0.125, 1]) {
    for (const loops of [1, 2]) {
      cases.push({
        name: `amplitude=${amplitude} loops=${loops} grain=off`,
        w: 160,
        h: 90,
        params: baseParams({ speed: amplitude, loops }),
      });
    }
  }

  // Grain on: blend modes x sizes, frames=120.
  for (const blend of ['normal', 'overlay', 'softlight']) {
    for (const size of [1, 3]) {
      cases.push({
        name: `grain blend=${blend} size=${size}`,
        w: 160,
        h: 90,
        params: baseParams({
          speed: 0.4,
          grain: {
            enabled: true,
            size,
            density: 0.5,
            opacity: 0.3,
            variance: 1,
            softness: 0.3,
            blend,
            color: '#ffffff',
            frames: 120,
          },
        }),
      });
    }
  }

  // Color count sweep.
  for (let n = 2; n <= 6; n++) {
    cases.push({
      name: `colors=${n}`,
      w: 160,
      h: 90,
      params: baseParams({ colors: colors(n), speed: 0.6 }),
    });
  }

  // Different seeds.
  for (const seed of [[0, 0], [1234.5, -987.6]]) {
    cases.push({
      name: `seed=[${seed[0]},${seed[1]}]`,
      w: 160,
      h: 90,
      params: baseParams({ seed, speed: 0.7 }),
    });
  }

  // Odd canvas size.
  cases.push({
    name: 'odd size 97x61',
    w: 97,
    h: 61,
    params: baseParams({ speed: 0.55, loops: 2 }),
  });

  return cases;
}

// --- Runner -------------------------------------------------------

async function main() {
  const start = Date.now();
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium',
  });

  let exitCode = 0;
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto(`${baseUrl}/__seam.html`);
    await page.waitForFunction(() => window.__ready === true || window.__error, { timeout: 15000 });

    const pageError = await page.evaluate(() => window.__error || null);
    if (pageError) {
      console.error(`FAIL page error: ${pageError}`);
      exitCode = 1;
    } else {
      const cases = buildCases();

      const renderReadback = async (params, phase, w, h) => {
        return page.evaluate(
          ({ params, phase, w, h }) => {
            const renderer = window.__renderer;
            renderer.setSize(w, h);
            renderer.render(params, phase);
            const gl = renderer.gl;
            gl.finish();
            const buf = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            return Array.from(buf);
          },
          { params, phase, w, h }
        );
      };

      let anyFail = false;

      for (const c of cases) {
        let phase1Params = c.params;
        if (SELF_TEST && c.name === cases[0].name) {
          // Deliberately break the loop invariant: shift the seed used
          // for phase=1 only, so frame 0 and the "last" frame no longer
          // land on the same point in noise-space. This case MUST FAIL
          // if the comparison is doing its job.
          phase1Params = { ...c.params, seed: [c.params.seed[0] + 0.01, c.params.seed[1]] };
        }

        const px0 = await renderReadback(c.params, 0.0, c.w, c.h);
        const px1 = await renderReadback(phase1Params, 1.0, c.w, c.h);

        let diff = 0;
        for (let i = 0; i < px0.length; i++) {
          if (px0[i] !== px1[i]) diff++;
        }

        const label = SELF_TEST && c.name === cases[0].name ? `${c.name} [self-test: expect FAIL]` : c.name;

        if (diff === 0) {
          if (SELF_TEST && c.name === cases[0].name) {
            console.log(`FAIL ${label}: expected a mismatch but got none (self-test did not catch the break)`);
            anyFail = true;
          } else {
            console.log(`ok   ${label}`);
          }
        } else {
          if (SELF_TEST && c.name === cases[0].name) {
            console.log(`ok   ${label}: FAIL (${diff} differing bytes) as expected`);
          } else {
            console.log(`FAIL ${label} (${diff} differing bytes)`);
            anyFail = true;
          }
        }
      }

      // Sanity check: the test must not be trivially green. At amplitude 1,
      // phase 0 and phase 0.5 must differ (otherwise a bug that made phase
      // a no-op would still pass every case above).
      const sanityParams = baseParams({ speed: 1, loops: 1 });
      const pxA = await renderReadback(sanityParams, 0.0, 160, 90);
      const pxB = await renderReadback(sanityParams, 0.5, 160, 90);
      let sanityDiff = 0;
      for (let i = 0; i < pxA.length; i++) {
        if (pxA[i] !== pxB[i]) sanityDiff++;
      }
      if (sanityDiff === 0) {
        console.log('FAIL sanity check: phase=0 and phase=0.5 (amplitude=1) are identical — test would not catch a broken phase mapping');
        anyFail = true;
      } else {
        console.log(`ok   sanity check: phase=0 vs phase=0.5 differ (${sanityDiff} bytes) — test is non-trivial`);
      }

      if (pageErrors.length) {
        console.log(`FAIL page errors during run: ${pageErrors.join('; ')}`);
        anyFail = true;
      }

      exitCode = anyFail ? 1 : 0;
    }
  } catch (err) {
    console.error(`FAIL error: ${err && err.stack || err}`);
    exitCode = 1;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n${exitCode === 0 ? 'PASS' : 'FAIL'} — done in ${elapsed}s${SELF_TEST ? ' (--self-test)' : ''}`);
  process.exitCode = exitCode;
}

main();
