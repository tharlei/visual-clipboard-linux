'use strict';

const { DEFAULT_CONFIG } = require('./constants');

// Mutable state shared across modules. Plain object on purpose: modules read and
// assign state.x directly, and because this file imports nothing else there can
// never be a require cycle through it.
module.exports = {
  wins: [],
  tray: null,
  config: { ...DEFAULT_CONFIG },
  activeShortcut: null,
  store: { version: 1, boards: [], clips: [] },
  lastSig: undefined,
  hasXdotool: false,
  imageDue: true,
  pollNow: null,
  restartApp: null,
  // read by the heartbeat: a poll delta far below HEARTBEAT_MS/POLL_MS means the main
  // process was blocked, which is the one thing a frozen app cannot report about itself
  pollCount: 0,
  pollMaxMs: 0,
  pollErrors: 0,
};
