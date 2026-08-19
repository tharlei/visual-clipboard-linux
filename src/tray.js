'use strict';

const { app, Menu, Tray, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { AUTOSTART_FILE, LAUNCHER_FILE, ELECTRON_STALE_DAYS } = require('./constants');
const state = require('./state');
const { saveConfig } = require('./storage');
const { readClipboard } = require('./clipboard');
const { showPanel, togglePanel, broadcast } = require('./window');

const ICON_FILE = path.join(__dirname, '..', 'assets', 'icon.png');

/** The 22px tray icon. */
function trayIcon() {
  return nativeImage.createFromPath(ICON_FILE).resize({ width: 22, height: 22 });
}

/** True when the autostart desktop entry exists. */
function isAutostart() {
  return fs.existsSync(AUTOSTART_FILE);
}

/** Exec line for autostart: the installed launcher, or direct electron as the dev fallback. */
function autostartExec() {
  if (fs.existsSync(LAUNCHER_FILE)) return `"${LAUNCHER_FILE}" --hidden`;
  return `"${process.execPath}" "${app.getAppPath()}" --hidden`;
}

/** Writes or removes the autostart desktop entry. */
function setAutostart(on) {
  try {
    if (on) {
      fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
      fs.writeFileSync(AUTOSTART_FILE, [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Visual Clipboard',
        `Exec=${autostartExec()}`,
        'X-GNOME-Autostart-enabled=true',
        '',
      ].join('\n'));
    } else {
      fs.rmSync(AUTOSTART_FILE, { force: true });
    }
  } catch (err) {
    console.error('[clp] autostart:', err);
  }
}

/** Days since Chromium was last replaced, read from electron/package.json's mtime. 0 when unknown. */
function electronAgeDays() {
  try {
    const pkg = path.join(app.getAppPath(), 'node_modules', 'electron', 'package.json');
    return Math.max(0, Math.floor((Date.now() - fs.statSync(pkg).mtimeMs) / 86400000));
  } catch {
    return 0;
  }
}

/** Pauses or resumes capture, reseeding the signature before resuming. */
function setPaused(on) {
  state.config.paused = on;
  if (!on) {
    try { state.lastSig = readClipboard().sig; } catch { state.lastSig = null; }
  }
  saveConfig();
  updateTrayMenu();
  broadcast();
}

/** Rebuilds the tray context menu from current state. */
function updateTrayMenu() {
  if (!state.tray) return;
  state.tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: state.activeShortcut
        ? `Abrir (${state.activeShortcut.replace('Control', 'Ctrl')})`
        : 'Abrir (nenhum atalho global ativo)',
      click: () => showPanel(),
    },
    // ponytail: toggle off state.config, not item.checked — AppIndicator reports the stale value.
    { type: 'checkbox', label: 'Pausar captura', checked: !!state.config.paused, click: () => setPaused(!state.config.paused) },
    { label: 'Reiniciar', click: () => state.restartApp && state.restartApp('bandeja') },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.quit(); } },
  ]));
}

/** Puts up the tray icon and its menu, warning when Chromium is stale. */
function createTray() {
  try {
    state.tray = new Tray(trayIcon());
    state.tray.setToolTip('Visual Clipboard — histórico do clipboard');
    const age = electronAgeDays();
    if (age >= ELECTRON_STALE_DAYS) {
      console.warn(`[clp] Chromium sem atualizar há ${age} dias — rode npm install electron@latest && ./install.sh`);
    }
    updateTrayMenu();
    state.tray.on('click', () => togglePanel());
  } catch (err) {
    console.warn('[clp] tray indisponível (extensão AppIndicator?):', err.message);
  }
}

module.exports = { trayIcon, updateTrayMenu, createTray, isAutostart, setAutostart, electronAgeDays };
