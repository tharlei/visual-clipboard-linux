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

function trayIcon() {
  return nativeImage.createFromPath(ICON_FILE).resize({ width: 22, height: 22 });
}

function isAutostart() {
  return fs.existsSync(AUTOSTART_FILE);
}

// route autostart through the installed launcher so it inherits its sandbox decision and log
// instead of re-deciding either here. the direct-electron form is the dev fallback, where no
// launcher exists — no --no-sandbox on it either, autostart must not be the one path that
// silently starts unsandboxed.
function autostartExec() {
  if (fs.existsSync(LAUNCHER_FILE)) return `"${LAUNCHER_FILE}" --hidden`;
  return `"${process.execPath}" "${app.getAppPath()}" --hidden`;
}

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

// npm rewrites electron/package.json on every install, so its mtime is when Chromium was last
// replaced. The binary beside it is not usable for this: it carries the release zip's zeroed
// 1979 timestamp. Returns 0 when the file is unreadable — never nag on a guess.
function electronAgeDays() {
  try {
    const pkg = path.join(app.getAppPath(), 'node_modules', 'electron', 'package.json');
    return Math.max(0, Math.floor((Date.now() - fs.statSync(pkg).mtimeMs) / 86400000));
  } catch {
    return 0;
  }
}

function setPaused(on) {
  state.config.paused = on;
  // reseed before resuming, else the first poll captures exactly the secret the pause
  // was meant to keep out of the history
  if (!on) {
    try { state.lastSig = readClipboard().sig; } catch { state.lastSig = null; }
  }
  saveConfig();
  updateTrayMenu();
  broadcast();
}

function updateTrayMenu() {
  if (!state.tray) return;
  state.tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: state.activeShortcut
        ? `Abrir (${state.activeShortcut.replace('Control', 'Ctrl')})`
        : 'Abrir (nenhum atalho global ativo)',
      click: () => showPanel(),
    },
    // ponytail: toggle off state.config, not item.checked — AppIndicator (Linux tray) doesn't
    // flip a checkbox's state on click, so item.checked reports the old value and nothing happens.
    { type: 'checkbox', label: 'Pausar captura', checked: !!state.config.paused, click: () => setPaused(!state.config.paused) },
    // the tray survives a dead or unpainted panel, so this is the restart path that still
    // works when the window is the thing that broke
    { label: 'Reiniciar', click: () => state.restartApp && state.restartApp('bandeja') },
    { type: 'separator' },
    // quit, not exit: before-quit must run — it saves the store, releases the global shortcut
    // and lets Chromium clean up its singleton files (an exit(0) here left them behind)
    { label: 'Sair', click: () => { app.quit(); } },
  ]));
}

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
