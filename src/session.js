// Session persistence: the settings go to localStorage, exported files
// (Blobs, often several MB) go to IndexedDB. Both are per-browser and
// per-origin; every call fails soft so a blocked or full storage never
// breaks the tool itself.

const SETTINGS_KEY = 'liquid-gradient:settings:v1';
const DB_NAME = 'liquid-gradient';
const DB_VERSION = 1;
const STORE = 'results';

// Oldest results beyond this are dropped from storage (and the gallery).
export const MAX_SAVED_RESULTS = 30;

// Oldest pattern-history entries beyond this are dropped, both here (the
// validator) and in main.js (which also imports this to cap the array it
// builds).
export const MAX_PATTERN_HISTORY = 5;

// --- Settings ---------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/;

// Per-key checks: a saved value is used only if it has the right shape,
// otherwise the default stays. Ranges mirror the controls in index.html.
const numberIn = (min, max) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const oneOf = (...values) => (v) => values.includes(v);
const isSeed = (v) => Array.isArray(v) && v.length === 2 && v.every(numberIn(-1e6, 1e6));
// A saved value with more entries than MAX_PATTERN_HISTORY (e.g. from a
// future version) is rejected wholesale, same as any other out-of-range
// value, and the default (an empty array, then re-seeded from
// state.seed) takes over.
// pinned is optional: absent (or not present at all) means "not pinned",
// so old saved histories from before pinning existed still validate.
const isPatternHistory = (v) =>
  Array.isArray(v) &&
  v.length <= MAX_PATTERN_HISTORY &&
  v.every(
    (item) =>
      item &&
      typeof item === 'object' &&
      isSeed(item.seed) &&
      typeof item.createdAt === 'number' &&
      Number.isFinite(item.createdAt) &&
      item.createdAt > 0 &&
      (item.pinned === undefined || typeof item.pinned === 'boolean'),
  );
const VALIDATORS = {
  colors: (v) => Array.isArray(v) && v.length >= 2 && v.length <= 6 && v.every((c) => typeof c === 'string' && HEX.test(c)),
  scale: numberIn(0.6, 5),
  warp: numberIn(0, 2.5),
  softness: numberIn(0, 1),
  speed: numberIn(0, 1),
  seed: isSeed,
  patternHistory: isPatternHistory,
  previewRadius: numberIn(0, 0.5),
  grainEnabled: (v) => typeof v === 'boolean',
  grainSize: (v) => Number.isInteger(v) && v >= 1 && v <= 8,
  grainDensity: numberIn(0.02, 1),
  grainOpacity: numberIn(0.02, 1),
  grainVariance: numberIn(0, 1),
  grainSoftness: numberIn(0, 1),
  grainBlend: oneOf('normal', 'overlay', 'softlight'),
  grainColor: (v) => typeof v === 'string' && HEX.test(v),
  width: (v) => Number.isInteger(v) && v >= 64 && v <= 3840 && v % 2 === 0,
  height: (v) => Number.isInteger(v) && v >= 64 && v <= 3840 && v % 2 === 0,
  duration: (v) => Number.isInteger(v) && v >= 1 && v <= 10,
  fps: oneOf(24, 30, 60),
  format: oneOf('webm+mp4', 'webm', 'mp4', 'gif'),
  bitrate: numberIn(0.5, 10),
  gifWidth: numberIn(240, 960),
  poster: (v) => typeof v === 'boolean',
};

// All VALIDATORS keys, for callers (the settings-link export in main.js)
// that need "every persisted setting" without duplicating the list.
export const SETTINGS_KEYS = Object.freeze(Object.keys(VALIDATORS));

// Filters an arbitrary object down to the keys VALIDATORS knows about,
// keeping only values that pass their validator — used both for the
// localStorage blob (loadSettings) and for settings decoded from a
// shared link (main.js), so both paths reject the same malformed data.
export function validateSettings(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const result = {};
  for (const [key, isValid] of Object.entries(VALIDATORS)) {
    if (key in obj && isValid(obj[key])) result[key] = obj[key];
  }
  return result;
}

export function loadSettings() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
  } catch {
    return {};
  }
  return validateSettings(saved);
}

export function saveSettings(state) {
  const data = {};
  for (const key of Object.keys(VALIDATORS)) data[key] = state[key];
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
  } catch (err) {
    console.warn('Settings not saved:', err);
  }
}

// --- Exported files ---------------------------------------------------------

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function transact(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const value = run(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(value.result ?? value);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

// entry: { name, blob, isVideo, width, height, batch } → resolves to its id.
export function saveResult(entry) {
  return transact('readwrite', (store) => store.add(entry));
}

// All saved results, oldest first (ids are auto-incremented).
export function loadResults() {
  return transact('readonly', (store) => store.getAll());
}

export function deleteResults(ids) {
  return transact('readwrite', (store) => {
    ids.forEach((id) => store.delete(id));
    return {};
  });
}
