'use strict';

const { protocol, net, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { DATA_DIR, THUMBS_DIR, THUMB_HEIGHT, THUMB_WIDTH, MAX_IMAGE_BYTES } = require('./constants');
const state = require('./state');

// Must run before app.whenReady — main.js requires this module at the top, which
// keeps the ordering.
protocol.registerSchemesAsPrivileged([
  { scheme: 'clp', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

// original when the source is already small or nativeImage can't decode it (gif/webp/svg).
const asIs = new Set();

function resolveThumb(id) {
  const clip = state.store.clips.find((c) => c.id === id);
  if (!clip) return null;
  const src = clip.imageFile
    ? path.join(DATA_DIR, clip.imageFile)
    : (clip.fileKind === 'image' && clip.files ? clip.files[0] : null);
  if (!src) return null;
  const thumb = path.join(THUMBS_DIR, id + '.png');
  if (fs.existsSync(thumb)) return thumb;
  // remembers "this one has no thumb" so an undecodable or already-small source is not
  // re-read and re-decoded on the main thread on every panel show
  if (asIs.has(id)) return src;
  const serveSource = () => { asIs.add(id); return src; };

  let stat;
  try { stat = fs.statSync(src); } catch { return null; }
  // decoding happens on the main thread and blocks the poll/shortcut/tray; a copied
  // file can be arbitrarily large, so hand the oversized ones straight to the renderer
  if (stat.size > MAX_IMAGE_BYTES) return serveSource();
  const img = nativeImage.createFromPath(src);
  if (img.isEmpty()) return serveSource();
  const { width, height } = img.getSize();
  // bound BOTH sides: a panorama capped only by height still decodes a huge bitmap
  const scale = Math.min(THUMB_HEIGHT / height, THUMB_WIDTH / width, 1);
  if (scale >= 1) return serveSource();
  try {
    // tmp + rename, like saveJsonAtomic: a truncated thumb would be cached forever
    const tmp = thumb + '.tmp';
    const small = img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
    fs.writeFileSync(tmp, small.toPNG());
    fs.renameSync(tmp, thumb);
    return thumb;
  } catch {
    try { fs.unlinkSync(thumb + '.tmp'); } catch {}
    return src;
  }
}

function registerClpProtocol() {
  protocol.handle('clp', (req) => {
    try {
      const { host, pathname } = new URL(req.url);
      const parts = pathname.split('/').filter(Boolean);
      let realPath = null;
      if (host === 'img') {
        const clip = state.store.clips.find((c) => c.id === parts[0] && c.imageFile);
        if (clip) realPath = path.join(DATA_DIR, clip.imageFile);
      } else if (host === 'file') {
        const clip = state.store.clips.find((c) => c.id === parts[0] && c.files);
        const idx = Number(parts[1] || 0);
        if (clip && clip.files[idx]) realPath = clip.files[idx];
      } else if (host === 'thumb') {
        realPath = resolveThumb(parts[0]);
      }
      if (!realPath || !fs.existsSync(realPath)) return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(realPath).toString());
    } catch {
      return new Response(null, { status: 400 });
    }
  });
}

module.exports = { registerClpProtocol };
