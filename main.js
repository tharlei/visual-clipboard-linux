'use strict';

const { app, globalShortcut } = require('electron');

const { POLL_MS } = require('./src/constants');
const state = require('./src/state');
const { loadStore, saveStore } = require('./src/storage');
// requiring protocol.js also registers the clp:// scheme as privileged (must happen before ready)
const { registerClpProtocol } = require('./src/protocol');
const { readClipboard, poll, detectXdotool } = require('./src/clipboard');
const { createWindow, showPanel, togglePanel, registerShortcut } = require('./src/window');
const { createTray } = require('./src/tray');
const { setupIpc } = require('./src/ipc');

process.on('uncaughtException', (err) => console.error('[clp] uncaught:', err));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => togglePanel());

  app.whenReady().then(() => {
    loadStore();
    registerClpProtocol();
    setupIpc();
    createWindow();
    createTray();
    registerShortcut();
    detectXdotool();
    // tray-only app: a manual launch (menu/command) would show no window — pop the panel once.
    // autostart passes --hidden so login boots silently into the tray.
    if (!process.argv.includes('--hidden')) {
      state.win.webContents.once('did-finish-load', () => showPanel(false));
    }
    try { state.lastSig = readClipboard().sig; } catch { state.lastSig = null; }
    setInterval(poll, POLL_MS);
  });

  app.on('window-all-closed', () => { /* tray app: keep running */ });

  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    saveStore();
  });
}
