'use strict';

const { BrowserWindow, globalShortcut, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, PANEL_HEIGHT, PREVIEW_CHARS, DEBUG } = require('./constants');
const state = require('./state');

let shownAt = 0;
let quitting = false;
require('electron').app.on('before-quit', () => { quitting = true; });

/** Lifts the panels' close veto for paths that never emit before-quit (app.exit). */
function allowClose() { quitting = true; }

/** Live panel windows, pruning destroyed ones. */
function panels() {
  state.wins = state.wins.filter((w) => !w.isDestroyed());
  return state.wins;
}

/** 'cursor' → display under the pointer, 'all' → every display, anything else → a pinned display id. */
function targetDisplays() {
  const all = screen.getAllDisplays();
  const mode = state.config.display || 'cursor';
  if (mode === 'all') return all;
  if (mode === 'cursor') return [screen.getDisplayNearestPoint(screen.getCursorScreenPoint())];
  return [all.find((d) => String(d.id) === String(mode)) || screen.getPrimaryDisplay()];
}

/** Displays as { id, label } for the settings picker. */
function displayList() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `Monitor ${i + 1} — ${d.size.width}×${d.size.height}${d.id === primary ? ' (principal)' : ''}`,
  }));
}

/** Builds one frameless, transparent, navigation-locked panel window. */
function createPanel() {
  const win = new BrowserWindow({
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
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (DEBUG) {
    win.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg));
  }
  win.loadFile('renderer/index.html');
  win.on('blur', () => {
    if (win.webContents.isDevToolsOpened()) return;
    if (Date.now() - shownAt < 600) return;
    setTimeout(() => { if (!panels().some((w) => w.isFocused())) hidePanel(); }, 80);
  });
  win.on('close', (e) => { if (quitting) return; e.preventDefault(); win.hide(); });
  let crashes = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (quitting || win.isDestroyed()) return;
    if (++crashes > 3) {
      console.error(`[clp] renderer morreu ${crashes}x (${details.reason}), recriando no próximo abrir`);
      win.destroy();
      return;
    }
    console.error(`[clp] renderer morreu (${details.reason}), recarregando`);
    win.hide();
    win.webContents.reload();
  });
  win.on('unresponsive', () => console.error('[clp] painel não responde'));
  win.on('responsive', () => console.log('[clp] painel voltou a responder'));
  win.on('hide', () => win.webContents.send('panel:hidden'));
  return win;
}

/** Grows or shrinks the panel set to one window per target display. */
function syncPanels() {
  const need = targetDisplays().length;
  const wins = panels();
  while (wins.length > need) wins.pop().destroy();
  while (wins.length < need) wins.push(createPanel());
  return wins;
}

/** Rebuilds the panel set after a display change, restoring visibility. */
function refreshPanels() {
  const wasVisible = panels().some((w) => w.isVisible());
  syncPanels();
  if (wasVisible) showPanel(false);
}

/** Creates the initial panels and watches for displays being added or removed. */
function createWindow() {
  syncPanels();
  const onDisplays = () => { if ((state.config.display || 'cursor') === 'all') refreshPanels(); };
  screen.on('display-added', onDisplays);
  screen.on('display-removed', onDisplays);
}

/** Positions and shows every panel, focusing the one under the cursor when `activate`. */
function showPanel(activate = true) {
  const displays = targetDisplays();
  const wins = syncPanels();
  shownAt = Date.now();
  wins.forEach((win, i) => {
    const { x, y, width, height } = (displays[i] || displays[0]).workArea;
    win.setBounds({ x, y: y + height - PANEL_HEIGHT, width, height: PANEL_HEIGHT });
    win.showInactive();
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => win.webContents.send('panel:shown'));
    } else {
      win.webContents.send('panel:shown');
    }
    setTimeout(() => { if (!win.isDestroyed()) win.webContents.invalidate(); }, 150);
  });
  if (activate) {
    const cursorId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
    const win = wins[Math.max(0, displays.findIndex((d) => d.id === cursorId))];
    win.show();
    win.focus();
  }
  state.imageDue = true;
  if (state.pollNow) setTimeout(state.pollNow, 0);
  if (DEBUG) {
    setTimeout(() => {
      const shot = path.join(DATA_DIR, 'debug-panel.png');
      if (wins[0].isDestroyed()) return;
      wins[0].webContents.capturePage().then((img) => {
        fs.writeFileSync(shot, img.toPNG());
        console.log('[clp] debug screenshot: ' + shot);
      }).catch(() => {});
    }, 2500);
  }
}

/** Hides every visible panel. */
function hidePanel() {
  for (const win of panels()) if (win.isVisible()) win.hide();
}

/** Hides the panels when any is visible, otherwise shows them focused. */
function togglePanel() {
  if (panels().some((w) => w.isVisible())) hidePanel();
  else showPanel();
}

/** Sends an IPC message to every panel. */
function sendAll(channel, payload) {
  for (const win of panels()) win.webContents.send(channel, payload);
}

/** Renderer-facing view of the store, config and capabilities. */
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
    visible: panels().some((w) => w.isVisible()),
    config: {
      shortcut: state.activeShortcut || state.config.shortcut,
      autoPaste: state.config.autoPaste,
      pasteDelayMs: state.config.pasteDelayMs,
      maxItems: state.config.maxItems,
      display: state.config.display,
      paused: !!state.config.paused,
    },
    displays: displayList(),
    caps: { xdotool: state.hasXdotool },
  };
}

/** Pushes a fresh snapshot to every panel. */
function broadcast() {
  sendAll('clips:changed', snapshot());
}

/** Registers the configured accelerator, falling back in memory only when it conflicts. */
function registerShortcut() {
  const tryReg = (accel) => {
    try { return globalShortcut.register(accel, togglePanel); } catch { return false; }
  };
  const fallback = 'Control+Alt+Shift+V';
  const wanted = state.config.shortcut;
  globalShortcut.unregisterAll();
  if (tryReg(wanted)) {
    state.activeShortcut = wanted;
  } else if (wanted !== fallback && tryReg(fallback)) {
    console.warn(`[clp] atalho ${wanted} em conflito, usando ${fallback}`);
    state.activeShortcut = fallback;
  } else {
    console.error(`[clp] atalho ${wanted} em conflito e sem alternativa — abra pela bandeja`);
    state.activeShortcut = null;
  }
  return state.activeShortcut;
}

module.exports = {
  createWindow, showPanel, hidePanel, togglePanel, refreshPanels, allowClose,
  panels, sendAll, snapshot, broadcast, registerShortcut,
};
