'use strict';

const { clipboard, nativeImage } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const {
  DATA_DIR, THUMBS_DIR, MAX_IMAGE_BYTES, MAX_TEXT_CHARS,
  GNOME_FILES_FORMAT, VIDEO_EXTS, IMAGE_EXTS, DEBUG,
} = require('./constants');
const state = require('./state');
const { saveStore, saveDebounced, newId, sha } = require('./storage');
const { broadcast, hidePanel } = require('./window');

let imgGate = { len: -1, head: null, sig: null };
let lastFmtKey = null;
let pollCount = 0;

// ---------- reading ----------

function parseFileUris(text) {
  return text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('file://'))
    .map((l) => { try { return fileURLToPath(l); } catch { return null; } })
    .filter(Boolean);
}

function fileKindOf(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

function shaImage(png) {
  const head = png.subarray(0, 4096);
  if (imgGate.len === png.length && imgGate.head && head.equals(imgGate.head)) return imgGate.sig;
  const sig = sha(png);
  imgGate = { len: png.length, head: Buffer.from(head), sig };
  return sig;
}

// Reads current clipboard into { sig, kind?, skip?, ...payload }. sig === null => empty.
function readClipboard() {
  const formats = clipboard.availableFormats();

  // availableFormats() is free; reading the bytes of a selection owned by another X11
  // client is not — Chromium retains a copy of the whole buffer on every call. Treat a
  // change in the target list as the only routine reason to re-read image bytes.
  const fmtKey = formats.join('|');
  if (fmtKey !== lastFmtKey) {
    lastFmtKey = fmtKey;
    state.imageDue = true;
  }

  if (formats.includes('x-kde-passwordManagerHint')) {
    return { sig: 'secret:' + sha(clipboard.readText() || ''), skip: true };
  }

  // custom targets are readable but never listed by availableFormats() — probe directly
  let fileBuf = clipboard.readBuffer(GNOME_FILES_FORMAT);
  if (!fileBuf.length) fileBuf = clipboard.readBuffer('text/uri-list');
  if (fileBuf && fileBuf.length) {
    const files = parseFileUris(fileBuf.toString('utf8'));
    if (files.length) return { sig: 'F:' + sha(fileBuf), kind: 'file', files };
  }

  const imgFormat = formats.find((f) => f.startsWith('image/'));
  if (imgFormat) {
    // an unchanged image target list means the same image: re-reading it 2x/s would retain
    // the whole PNG every time (GBs per hour). showPanel() sets imageDue so a second image
    // copied from the same app is still picked up before the user looks at the history.
    if (!state.imageDue) return { sig: state.lastSig };
    state.imageDue = false;
    const png = clipboard.readBuffer('image/png');
    if (png.length) {
      if (png.length > MAX_IMAGE_BYTES) return { sig: 'I:big:' + png.length, skip: true };
      return { sig: 'I:' + shaImage(png), kind: 'image', png };
    }
    // clipboard.readImage() decodes the bitmap and leaks ~10 KB per megapixel inside
    // Chromium's X11 clipboard — at 2 polls/s that is GBs per hour. readBuffer never
    // decodes, so hash the raw target bytes and only decode when they actually change.
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
  return { sig: 'T:' + sha(text), kind: 'text', text };
}

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

// ---------- capture ----------

function poll() {
  let r;
  pollCount++;
  try { r = readClipboard(); } catch (err) { console.error('[clp] poll:', err); return; }
  if (DEBUG && pollCount % 10 === 0) console.log(`[clp] poll#${pollCount} sig=${r.sig && r.sig.slice(0, 16)}`);
  if (r.sig === state.lastSig) return;
  state.lastSig = r.sig;
  if (!r.sig || r.skip) return;
  if (DEBUG) console.log('[clp] capture kind=', r.kind);
  try { capture(r); } catch (err) { console.error('[clp] capture:', err); }
}

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
      fs.writeFileSync(path.join(DATA_DIR, clip.imageFile), r.png);
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

function deleteImageFile(clip) {
  if (clip.imageFile) {
    try { fs.unlinkSync(path.join(DATA_DIR, clip.imageFile)); } catch {}
  }
  try { fs.unlinkSync(path.join(THUMBS_DIR, clip.id + '.png')); } catch {}
}

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

// ---------- write back / select ----------

function writeClipToClipboard(clip) {
  if (clip.type === 'image') {
    clipboard.writeImage(nativeImage.createFromPath(path.join(DATA_DIR, clip.imageFile)));
  } else if (clip.type === 'file') {
    const body = ['copy', ...clip.files.map((f) => pathToFileURL(f).toString())].join('\n');
    clipboard.writeBuffer(GNOME_FILES_FORMAT, Buffer.from(body, 'utf8'));
  } else {
    clipboard.writeText(clip.text);
  }
  // read-back presets the signature so the watcher never re-captures our own write
  try { state.lastSig = readClipboard().sig; } catch {}
}

function autoPaste() {
  if (!state.hasXdotool || !state.config.autoPaste) return;
  setTimeout(() => {
    execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], (err) => {
      if (err) console.error('[clp] xdotool:', err.message);
    });
  }, state.config.pasteDelayMs);
}

function selectClip(id) {
  const clip = state.store.clips.find((c) => c.id === id);
  if (!clip) return;
  writeClipToClipboard(clip);
  hidePanel();
  autoPaste();
}

function detectXdotool() {
  execFile('xdotool', ['version'], (err) => {
    state.hasXdotool = !err;
    if (err) console.warn('[clp] xdotool ausente — colagem automática desativada. Instale: sudo apt install xdotool');
    broadcast();
  });
}

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
