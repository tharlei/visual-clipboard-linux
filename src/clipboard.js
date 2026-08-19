'use strict';

const { clipboard, nativeImage } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const {
  DATA_DIR, THUMBS_DIR, MAX_IMAGE_BYTES, MAX_TEXT_CHARS,
  GNOME_FILES_FORMAT, SECRET_HINT_FORMATS, VIDEO_EXTS, IMAGE_EXTS, POLL_SLOW_MS, DEBUG,
} = require('./constants');
const state = require('./state');
const { saveStore, saveDebounced, newId, sha } = require('./storage');
const { broadcast, hidePanel } = require('./window');
const { matchesIgnore } = require('./validate');

let imgGate = { len: -1, head: null, sig: null };
let lastFmtKey = null;

/** Absolute paths from the file:// URIs in a uri-list payload. */
function parseFileUris(text) {
  return text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('file://'))
    .map((l) => { try { return fileURLToPath(l); } catch { return null; } })
    .filter(Boolean);
}

/** 'image' | 'video' | 'other', from the extension. */
function fileKindOf(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

/** sha256 of an image buffer, reusing the last one when length and first 4KB are unchanged. */
function shaImage(png) {
  const head = png.subarray(0, 4096);
  if (imgGate.len === png.length && imgGate.head && head.equals(imgGate.head)) return imgGate.sig;
  const sig = sha(png);
  imgGate = { len: png.length, head: Buffer.from(head), sig };
  return sig;
}

/** Reads current clipboard into { sig, kind?, skip?, ...payload }. sig === null means empty. */
function readClipboard() {
  const formats = clipboard.availableFormats();

  const fmtKey = formats.join('|');
  if (fmtKey !== lastFmtKey) {
    lastFmtKey = fmtKey;
    state.imageDue = true;
  }

  if (formats.some((f) => SECRET_HINT_FORMATS.has(f))) {
    return { sig: 'secret:' + sha(clipboard.readText() || ''), skip: true };
  }

  let fileBuf = clipboard.readBuffer(GNOME_FILES_FORMAT);
  if (!fileBuf.length) fileBuf = clipboard.readBuffer('text/uri-list');
  if (fileBuf && fileBuf.length) {
    const files = parseFileUris(fileBuf.toString('utf8'));
    if (files.length) return { sig: 'F:' + sha(fileBuf), kind: 'file', files };
  }

  const imgFormat = formats.find((f) => f.startsWith('image/'));
  if (imgFormat) {
    if (!state.imageDue) return { sig: state.lastSig };
    state.imageDue = false;
    const png = clipboard.readBuffer('image/png');
    if (png.length) {
      if (png.length > MAX_IMAGE_BYTES) return { sig: 'I:big:' + png.length, skip: true };
      return { sig: 'I:' + shaImage(png), kind: 'image', png };
    }
    const raw = clipboard.readBuffer(imgFormat);
    const sig = raw.length ? 'I:' + shaImage(raw) : 'I:fmt:' + imgFormat;
    if (sig === state.lastSig) return { sig };
    const img = clipboard.readImage();
    const decoded = img.isEmpty() ? null : img.toPNG();
    if (!decoded || !decoded.length || decoded.length > MAX_IMAGE_BYTES) return { sig, skip: true };
    return { sig, kind: 'image', png: decoded };
  }

  const text = clipboard.readText();
  if (!text || !text.trim()) return { sig: null };
  if (text.length > MAX_TEXT_CHARS) return { sig: 'T:big:' + text.length, skip: true };
  if (matchesIgnore(text, state.config.ignorePatterns)) return { sig: 'ign:' + sha(text), skip: true };
  return { sig: 'T:' + sha(text), kind: 'text', text };
}

/** 'link' | 'code' | 'text', from shape and keyword density. */
function classifyText(text) {
  const t = text.trim();
  if (/^https?:\/\/\S+$/i.test(t) && !/\s/.test(t)) return 'link';
  if (t.includes('\n')) {
    const symbolHits = (t.match(/[{};]|=>|<\//g) || []).length;
    const keywordHits = (t.match(/\b(function|const|let|var|def|class|import|return|if|for|while|fn|pub|end|echo|public|private)\b/g) || []).length;
    if (symbolHits + keywordHits >= 2 && symbolHits >= 1) return 'code';
  }
  return 'text';
}

/** One clipboard tick: reads, times the read, and captures when the signature changed. */
function poll() {
  if (state.config.paused) return;
  let r;
  state.pollCount++;
  const t0 = Date.now();
  try {
    r = readClipboard();
  } catch (err) {
    state.pollErrors++;
    console.error('[clp] poll:', err);
    return;
  } finally {
    const ms = Date.now() - t0;
    if (ms > state.pollMaxMs) state.pollMaxMs = ms;
    if (ms > POLL_SLOW_MS) {
      console.warn(`[clp] poll lento ${ms}ms tipo=${(r && r.kind) || 'nenhum'} — main travado nesse intervalo`);
    }
  }
  if (DEBUG && state.pollCount % 10 === 0) console.log(`[clp] poll#${state.pollCount} sig=${r.sig && r.sig.slice(0, 16)}`);
  if (r.sig === state.lastSig) return;
  state.lastSig = r.sig;
  if (!r.sig || r.skip) return;
  if (DEBUG) console.log('[clp] capture kind=', r.kind);
  try { capture(r); } catch (err) { console.error('[clp] capture:', err); }
}

/** Stores a read as a new clip, or bumps the existing one with the same signature to the top. */
function capture(r) {
  const existing = state.store.clips.find((c) => c.hash === r.sig);
  if (existing) {
    existing.createdAt = Date.now();
    state.store.clips.splice(state.store.clips.indexOf(existing), 1);
    state.store.clips.unshift(existing);
    saveDebounced();
    broadcast();
    return;
  }

  const clip = {
    id: newId(),
    type: 'text',
    text: '',
    files: undefined,
    fileKind: undefined,
    imageFile: undefined,
    w: undefined,
    h: undefined,
    hash: r.sig,
    pinned: false,
    boardIds: [],
    createdAt: Date.now(),
  };

  if (r.kind === 'file') {
    clip.type = 'file';
    clip.files = r.files;
    clip.fileKind = fileKindOf(r.files[0]);
    clip.text = r.files.join('\n');
  } else if (r.kind === 'image') {
    clip.type = 'image';
    clip.imageFile = `images/${clip.id}.png`;
    const size = nativeImage.createFromBuffer(r.png).getSize();
    clip.w = size.width;
    clip.h = size.height;
    try {
      fs.writeFileSync(path.join(DATA_DIR, clip.imageFile), r.png, { mode: 0o600 });
    } catch (err) {
      console.error('[clp] falha ao gravar imagem:', err);
      return;
    }
  } else {
    clip.type = classifyText(r.text);
    clip.text = r.text;
  }

  state.store.clips.unshift(clip);
  enforceCap();
  saveDebounced();
  broadcast();
}

/** Removes a clip's stored image and thumbnail from disk. */
function deleteImageFile(clip) {
  if (clip.imageFile) {
    try { fs.unlinkSync(path.join(DATA_DIR, clip.imageFile)); } catch {}
  }
  try { fs.unlinkSync(path.join(THUMBS_DIR, clip.id + '.png')); } catch {}
}

/** Drops the oldest evictable clips (not pinned, in no board) down to maxItems. */
function enforceCap() {
  const evictable = () => state.store.clips.filter((c) => !c.pinned && c.boardIds.length === 0);
  let extra = evictable().length - state.config.maxItems;
  if (extra <= 0) return;
  for (let i = state.store.clips.length - 1; i >= 0 && extra > 0; i--) {
    const c = state.store.clips[i];
    if (c.pinned || c.boardIds.length) continue;
    deleteImageFile(c);
    state.store.clips.splice(i, 1);
    extra--;
  }
}

/** Puts a clip back on the clipboard and presets lastSig so the poll ignores our own write. */
function writeClipToClipboard(clip) {
  if (clip.type === 'image') {
    clipboard.writeImage(nativeImage.createFromPath(path.join(DATA_DIR, clip.imageFile)));
  } else if (clip.type === 'file') {
    const body = ['copy', ...clip.files.map((f) => pathToFileURL(f).toString())].join('\n');
    clipboard.writeBuffer(GNOME_FILES_FORMAT, Buffer.from(body, 'utf8'));
  } else {
    clipboard.writeText(clip.text);
  }
  try { state.lastSig = readClipboard().sig; } catch {}
}

/** Fires ctrl+v through xdotool after the configured delay, when enabled and available. */
function autoPaste() {
  if (!state.hasXdotool || !state.config.autoPaste) return;
  setTimeout(() => {
    execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], (err) => {
      if (err) console.error('[clp] xdotool:', err.message);
    });
  }, state.config.pasteDelayMs);
}

/** Copies a clip, hides the panel and auto-pastes. */
function selectClip(id) {
  const clip = state.store.clips.find((c) => c.id === id);
  if (!clip) return;
  writeClipToClipboard(clip);
  hidePanel();
  autoPaste();
}

/** Probes for xdotool and broadcasts the capability. */
function detectXdotool() {
  execFile('xdotool', ['version'], (err) => {
    state.hasXdotool = !err;
    if (err) console.warn('[clp] xdotool ausente — colagem automática desativada. Instale: sudo apt install xdotool');
    broadcast();
  });
}

/** Deletes every clip that is neither pinned nor in a board. */
function clearHistory() {
  for (const c of state.store.clips) {
    if (!c.pinned && c.boardIds.length === 0) deleteImageFile(c);
  }
  state.store.clips = state.store.clips.filter((c) => c.pinned || c.boardIds.length > 0);
  saveStore();
  broadcast();
}

module.exports = {
  readClipboard, classifyText, poll, deleteImageFile, enforceCap,
  writeClipToClipboard, selectClip, detectXdotool, clearHistory,
};
