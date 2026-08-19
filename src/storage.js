'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, IMAGES_DIR, THUMBS_DIR, HISTORY_FILE, CONFIG_FILE, DEFAULT_CONFIG } = require('./constants');
const state = require('./state');
const { normalizeConfig, sanitizeStore } = require('./validate');

let saveTimer = null;

/** Parses a JSON file over `fallback`, renaming a corrupt one to .bak. */
function loadJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      try { fs.renameSync(file, file + '.bak'); } catch {}
      console.warn(`[clp] ${path.basename(file)} corrompido, backup em .bak:`, err.message);
    }
    return { ...fallback };
  }
}

/** Re-applies 0700/0600 to the data dirs and files, fixing installs from before the umask. */
function hardenPerms() {
  for (const dir of [DATA_DIR, IMAGES_DIR, THUMBS_DIR]) {
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  for (const file of [HISTORY_FILE, CONFIG_FILE]) {
    try { if (fs.existsSync(file)) fs.chmodSync(file, 0o600); } catch {}
  }
  for (const dir of [IMAGES_DIR, THUMBS_DIR]) {
    for (const name of entries(dir)) {
      try { fs.chmodSync(path.join(dir, name), 0o600); } catch {}
    }
  }
}

/** Creates the data dirs and loads history and config through the sanitizers. */
function loadStore() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  hardenPerms();
  state.store = sanitizeStore(loadJson(HISTORY_FILE, { version: 1, boards: [], clips: [] }));
  state.config = normalizeConfig(loadJson(CONFIG_FILE, DEFAULT_CONFIG), DEFAULT_CONFIG);
  if (!fs.existsSync(CONFIG_FILE)) saveJsonAtomic(CONFIG_FILE, state.config);
}

/** Writes JSON through a 0600 tmp file and renames it into place. */
function saveJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Writes history.json now, cancelling any pending debounce. */
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try { saveJsonAtomic(HISTORY_FILE, state.store); } catch (err) { console.error('[clp] falha ao salvar:', err); }
}

/** Schedules a store save 300ms out, coalescing bursts. */
function saveDebounced() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveStore, 300);
}

/** Writes a pending debounced save immediately. */
function flushSave() {
  if (saveTimer) saveStore();
}

/** Writes config.json. */
function saveConfig() {
  try { saveJsonAtomic(CONFIG_FILE, state.config); } catch (err) { console.error('[clp] falha ao salvar config:', err); }
}

/** File size in bytes, 0 when unreadable. */
function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

/** Directory entries, empty when unreadable. */
function entries(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** Disk usage of the store plus the image/thumb files no clip references anymore. */
function scanUsage() {
  const liveImages = new Set(state.store.clips.filter((c) => c.imageFile).map((c) => path.basename(c.imageFile)));
  const liveThumbs = new Set(state.store.clips.map((c) => c.id + '.png'));
  let bytes = sizeOf(HISTORY_FILE) + sizeOf(CONFIG_FILE);
  let images = 0;
  let orphanBytes = 0;
  const orphans = [];
  for (const [dir, live] of [[IMAGES_DIR, liveImages], [THUMBS_DIR, liveThumbs]]) {
    for (const name of entries(dir)) {
      const full = path.join(dir, name);
      const size = sizeOf(full);
      bytes += size;
      if (dir === IMAGES_DIR) images++;
      if (!live.has(name)) { orphans.push(full); orphanBytes += size; }
    }
  }
  return { bytes, images, clips: state.store.clips.length, orphans, orphanBytes };
}

/** Deletes the orphan files scanUsage found. */
function pruneOrphans() {
  const { orphans, orphanBytes } = scanUsage();
  for (const file of orphans) {
    try { fs.unlinkSync(file); } catch (err) { console.error('[clp] limpeza:', err.message); }
  }
  return { removed: orphans.length, bytes: orphanBytes };
}

/** Clip id: base36 timestamp plus 4 random bytes. */
function newId() {
  return Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

/** Hex sha256 of a buffer or string. */
function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = { loadStore, saveStore, saveDebounced, flushSave, saveConfig, scanUsage, pruneOrphans, newId, sha };
