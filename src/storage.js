'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { IMAGES_DIR, THUMBS_DIR, HISTORY_FILE, CONFIG_FILE, DEFAULT_CONFIG } = require('./constants');
const state = require('./state');

let saveTimer = null;

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

function loadStore() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  state.store = loadJson(HISTORY_FILE, { version: 1, boards: [], clips: [] });
  state.config = loadJson(CONFIG_FILE, DEFAULT_CONFIG);
  if (!fs.existsSync(CONFIG_FILE)) saveJsonAtomic(CONFIG_FILE, state.config);
}

function saveJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try { saveJsonAtomic(HISTORY_FILE, state.store); } catch (err) { console.error('[clp] falha ao salvar:', err); }
}

function saveDebounced() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveStore, 300);
}

function saveConfig() {
  try { saveJsonAtomic(CONFIG_FILE, state.config); } catch (err) { console.error('[clp] falha ao salvar config:', err); }
}

function newId() {
  return Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = { loadStore, saveStore, saveDebounced, saveConfig, newId, sha };
