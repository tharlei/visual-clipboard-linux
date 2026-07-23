'use strict';

const { DEFAULT_CONFIG } = require('./constants');

// Mutable state shared across modules. Plain object on purpose: modules read and
// assign state.x directly, and because this file imports nothing else there can
// never be a require cycle through it.
module.exports = {
  win: null,
  tray: null,
  config: { ...DEFAULT_CONFIG },
  store: { version: 1, boards: [], clips: [] },
  lastSig: undefined,
  hasXdotool: false,
  imageDue: true,
  pollNow: null,
};
