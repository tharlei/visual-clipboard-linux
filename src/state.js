'use strict';

const { DEFAULT_CONFIG } = require('./constants');

/** Mutable state shared across modules; imports nothing else, so it can never close a require cycle. */
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
  pollCount: 0,
  pollMaxMs: 0,
  pollErrors: 0,
};
