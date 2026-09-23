// Entry point: decides whether the app runs at all, and at what scale.

// Phones and tablets (touch as the primary input) only get the "desktop
// only" banner — style.css swaps it in with the same media query — and
// main.js, with its WebGL context and render loop, is never loaded.
const touchOnly = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

// The layout is drawn for a 1920×1080 screen. Bigger screens (2K, 4K)
// scale the whole UI up proportionally instead of leaving it small in
// the middle; smaller ones keep 1:1 and use the responsive breakpoints.
const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;

function fitToScreen() {
  const scale = Math.max(1, Math.min(window.innerWidth / DESIGN_WIDTH, window.innerHeight / DESIGN_HEIGHT));
  document.documentElement.style.zoom = scale === 1 ? '' : String(scale);
}

if (!touchOnly) {
  fitToScreen();
  window.addEventListener('resize', fitToScreen);
  import('./main.js');
}
