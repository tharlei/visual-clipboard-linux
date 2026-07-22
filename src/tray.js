'use strict';

const { app, Menu, Tray, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { AUTOSTART_FILE } = require('./constants');
const state = require('./state');
const { clearHistory } = require('./clipboard');
const { showPanel, togglePanel } = require('./window');

const ICON_FILE = path.join(__dirname, '..', 'assets', 'icon.png');

function trayIcon() {
  return nativeImage.createFromPath(ICON_FILE).resize({ width: 22, height: 22 });
}

function isAutostart() {
  return fs.existsSync(AUTOSTART_FILE);
}

function setAutostart(on) {
  try {
    if (on) {
      fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
      fs.writeFileSync(AUTOSTART_FILE, [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Visual Clipboard',
        // --no-sandbox: same AppArmor/SIGTRAP fix as the launcher (this bypasses it); --hidden: no panel at login
        `Exec="${process.execPath}" --no-sandbox "${app.getAppPath()}" --hidden`,
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

function updateTrayMenu() {
  if (!state.tray) return;
  state.tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Abrir (${state.config.shortcut.replace('Control', 'Ctrl')})`, click: () => showPanel() },
    { label: 'Configurações…', click: () => { showPanel(); state.win.webContents.send('settings:open'); } },
    { label: 'Limpar histórico', click: () => { clearHistory(); } },
    // ponytail: toggle off the filesystem, not item.checked — AppIndicator (Linux tray) doesn't
    // flip a checkbox's state on click, so item.checked reports the old value and nothing happens.
    { type: 'checkbox', label: 'Iniciar com o sistema', checked: isAutostart(), click: () => { setAutostart(!isAutostart()); updateTrayMenu(); } },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.exit(0); } },
  ]));
}

function createTray() {
  try {
    state.tray = new Tray(trayIcon());
    state.tray.setToolTip('Visual Clipboard — histórico do clipboard');
    updateTrayMenu();
    state.tray.on('click', () => togglePanel());
  } catch (err) {
    console.warn('[clp] tray indisponível (extensão AppIndicator?):', err.message);
  }
}

module.exports = { trayIcon, updateTrayMenu, createTray };
