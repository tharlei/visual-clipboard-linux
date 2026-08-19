'use strict';

const { protocol, net, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { DATA_DIR, THUMBS_DIR, THUMB_HEIGHT, THUMB_WIDTH, MAX_IMAGE_BYTES } = require('./constants');
const state = require('./state');

protocol.registerSchemesAsPrivileged([
  { scheme: 'clp', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

/** Clip ids whose source is served as-is: too big, undecodable, or already small enough. */
const asIs = new Set();

/** Path to a clip's thumbnail, generating it on first use, or the source when not worth shrinking. */
function resolveThumb(id) {
  const clip = state.store.clips.find((c) => c.id === id);
  if (!clip) return null;
  const src = clip.imageFile
    ? path.join(DATA_DIR, clip.imageFile)
    : (clip.fileKind === 'image' && clip.files ? clip.files[0] : null);
  if (!src) return null;
  const thumb = path.join(THUMBS_DIR, id + '.png');
  if (fs.existsSync(thumb)) return thumb;
  if (asIs.has(id)) return src;
  const serveSource = () => { asIs.add(id); return src; };

  let stat;
  try { stat = fs.statSync(src); } catch { return null; }
  if (stat.size > MAX_IMAGE_BYTES) return serveSource();
  const img = nativeImage.createFromPath(src);
  if (img.isEmpty()) return serveSource();
  const { width, height } = img.getSize();
  const scale = Math.min(THUMB_HEIGHT / height, THUMB_WIDTH / width, 1);
  if (scale >= 1) return serveSource();
  try {
    const tmp = thumb + '.tmp';
    const small = img.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
    fs.writeFileSync(tmp, small.toPNG(), { mode: 0o600 });
    fs.renameSync(tmp, thumb);
    return thumb;
  } catch {
    try { fs.unlinkSync(thumb + '.tmp'); } catch {}
    return src;
  }
}

/** Serves clp://img/<id>, clp://file/<id>/<i> and clp://thumb/<id> from the in-memory store. */
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
