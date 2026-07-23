'use strict';

const { BrowserWindow, globalShortcut, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PANEL_HEIGHT, PREVIEW_CHARS, DEBUG } = require('./constants');
const state = require('./state');

let shownAt = 0;

function positionWindow() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  state.win.setBounds({ x, y: y + height - PANEL_HEIGHT, width, height: PANEL_HEIGHT });
}

function createWindow() {
  const win = state.win = new BrowserWindow({
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (DEBUG) {
    win.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg));
  }
  win.loadFile('renderer/index.html');
  win.on('blur', () => {
    if (win.webContents.isDevToolsOpened()) return;
    // ignore the focus-steal that fires right after showing (menu/overview closing) — else a
    // launch-shown panel hides instantly and looks like it never opened
    if (Date.now() - shownAt < 600) return;
    win.hide();
  });
  win.on('close', (e) => { e.preventDefault(); win.hide(); });
  // covers every hide path (blur, close, Escape, select) — renderer purges its DOM on this
  win.on('hide', () => win.webContents.send('panel:hidden'));
}

function showPanel(activate = true) {
  positionWindow();
  shownAt = Date.now();
  // the poll skips unchanged image targets to avoid Chromium's per-read retention, so
  // force one fresh read now — the history must be current when the user looks at it
  state.imageDue = true;
  if (state.pollNow) state.pollNow();
  if (activate) {
    state.win.show();
    state.win.focus();
  } else {
    // launch auto-show: show on top WITHOUT grabbing focus, so the launch/overview
    // focus churn never fires a blur that would hide it instantly
    state.win.showInactive();
  }
  state.win.webContents.send('panel:shown');
  if (DEBUG) {
    setTimeout(() => {
      state.win.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(os.tmpdir(), 'clp-panel.png'), img.toPNG());
        console.log('[clp] debug screenshot: ' + path.join(os.tmpdir(), 'clp-panel.png'));
      }).catch(() => {});
    }, 2500);
  }
}

function hidePanel() {
  if (state.win && state.win.isVisible()) state.win.hide();
}

function togglePanel() {
  if (state.win.isVisible()) hidePanel();
  else showPanel();
}

function snapshot() {
  return {
    clips: state.store.clips.map((c) => ({
      id: c.id,
      type: c.type,
      fileKind: c.fileKind,
      files: c.files,
      preview: (c.text || '').slice(0, PREVIEW_CHARS),
      pinned: c.pinned,
      boardIds: c.boardIds,
      createdAt: c.createdAt,
      w: c.w,
      h: c.h,
    })),
    boards: state.store.boards,
    visible: !!(state.win && state.win.isVisible()),
    config: {
      shortcut: state.config.shortcut,
      autoPaste: state.config.autoPaste,
      pasteDelayMs: state.config.pasteDelayMs,
      maxItems: state.config.maxItems,
    },
    caps: { xdotool: state.hasXdotool },
  };
}

function broadcast() {
  if (state.win && !state.win.isDestroyed()) state.win.webContents.send('clips:changed', snapshot());
}

function registerShortcut() {
  const tryReg = (accel) => {
    try { return globalShortcut.register(accel, togglePanel); } catch { return false; }
  };
  if (!tryReg(state.config.shortcut)) {
    const fallback = 'Control+Alt+Shift+V';
    console.warn(`[clp] atalho ${state.config.shortcut} em conflito, usando ${fallback}`);
    state.config.shortcut = fallback;
    tryReg(fallback);
  }
}

module.exports = { createWindow, showPanel, hidePanel, togglePanel, snapshot, broadcast, registerShortcut };
