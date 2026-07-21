'use strict';

const { protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { DATA_DIR } = require('./constants');
const state = require('./state');

// Must run before app.whenReady — main.js requires this module at the top, which
// keeps the ordering.
protocol.registerSchemesAsPrivileged([
  { scheme: 'clp', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

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
      }
      if (!realPath || !fs.existsSync(realPath)) return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(realPath).toString());
    } catch {
      return new Response(null, { status: 400 });
    }
  });
}

module.exports = { registerClpProtocol };
