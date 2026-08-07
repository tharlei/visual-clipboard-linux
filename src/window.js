'use strict';

const { BrowserWindow, globalShortcut, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, PANEL_HEIGHT, PREVIEW_CHARS, DEBUG } = require('./constants');
const state = require('./state');

let shownAt = 0;
// the panels' close handler hides instead of closing (tray app) — that would also veto a real
// quit, so flip this before the quit closes the windows
let quitting = false;
require('electron').app.on('before-quit', () => { quitting = true; });

function panels() {
  state.wins = state.wins.filter((w) => !w.isDestroyed());
  return state.wins;
}

// 'cursor' → display under the pointer, 'all' → every display, anything else → a pinned display id
function targetDisplays() {
  const all = screen.getAllDisplays();
  const mode = state.config.display || 'cursor';
  if (mode === 'all') return all;
  if (mode === 'cursor') return [screen.getDisplayNearestPoint(screen.getCursorScreenPoint())];
  return [all.find((d) => String(d.id) === String(mode)) || screen.getPrimaryDisplay()];
}

function displayList() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `Monitor ${i + 1} — ${d.size.width}×${d.size.height}${d.id === primary ? ' (principal)' : ''}`,
  }));
}

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
  // the panel only ever shows its own local page. dropping a file on it, or any other
  // navigation, would leave the CSP'd index.html behind while keeping the clp preload.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (DEBUG) {
    win.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg));
  }
  win.loadFile('renderer/index.html');
  win.on('blur', () => {
    if (win.webContents.isDevToolsOpened()) return;
    // ignore the focus-steal that fires right after showing (menu/overview closing) — else a
    // launch-shown panel hides instantly and looks like it never opened
    if (Date.now() - shownAt < 600) return;
    // with one panel per monitor, clicking another panel blurs this one — only hide the
    // whole set once no panel holds the focus
    setTimeout(() => { if (!panels().some((w) => w.isFocused())) hidePanel(); }, 80);
  });
  win.on('close', (e) => { if (quitting) return; e.preventDefault(); win.hide(); });
  // a renderer that keeps dying (hostile image hitting a decoder bug) would reload forever
  let crashes = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (quitting || win.isDestroyed()) return;
    if (++crashes > 3) {
      // destroy, don't just give up: a kept-but-rendererless window still passes isDestroyed(),
      // so showPanel() would show an empty transparent panel forever — the app reads as frozen.
      // syncPanels() rebuilds a fresh one on the next open, and only then, so this never loops.
      console.error(`[clp] renderer morreu ${crashes}x (${details.reason}), recriando no próximo abrir`);
      win.destroy();
      return;
    }
    console.error(`[clp] renderer morreu (${details.reason}), recarregando`);
    win.hide();
    win.webContents.reload();
  });
  // covers every hide path (blur, close, Escape, select) — renderer purges its DOM on this
  win.on('hide', () => win.webContents.send('panel:hidden'));
  return win;
}

function syncPanels() {
  const need = targetDisplays().length;
  const wins = panels();
  while (wins.length > need) wins.pop().destroy();
  while (wins.length < need) wins.push(createPanel());
  return wins;
}

function refreshPanels() {
  const wasVisible = panels().some((w) => w.isVisible());
  syncPanels();
  if (wasVisible) showPanel(false);
}

function createWindow() {
  syncPanels();
  const onDisplays = () => { if ((state.config.display || 'cursor') === 'all') refreshPanels(); };
  screen.on('display-added', onDisplays);
  screen.on('display-removed', onDisplays);
}

function showPanel(activate = true) {
  const displays = targetDisplays();
  const wins = syncPanels();
  shownAt = Date.now();
  wins.forEach((win, i) => {
    const { x, y, width, height } = (displays[i] || displays[0]).workArea;
    win.setBounds({ x, y: y + height - PANEL_HEIGHT, width, height: PANEL_HEIGHT });
    // show every panel without focus first: focusing them in turn would blur the previous one
    win.showInactive();
    // a just-recreated panel (crash give-up path) is still loading its page — a send now lands
    // on no listener and the panel opens empty until the next broadcast
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => win.webContents.send('panel:shown'));
    } else {
      win.webContents.send('panel:shown');
    }
    // hardware acceleration is off, so Chromium's software presenter blits frames straight
    // into the X window — and X11 hands the panel a fresh XID on remap. The first frame can
    // land in the pre-remap XID ("XGetWindowAttributes failed" in launch.log): the panel maps
    // fully transparent with a correct DOM behind it. One repaint after the remap settles
    // re-presents into the live XID.
    setTimeout(() => { if (!win.isDestroyed()) win.webContents.invalidate(); }, 150);
  });
  if (activate) {
    const cursorId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
    const win = wins[Math.max(0, displays.findIndex((d) => d.id === cursorId))];
    win.show();
    win.focus();
  }
  // the poll skips unchanged image targets to avoid Chromium's per-read retention, so force
  // one fresh read — the history must be current when the user looks at it. Right AFTER the
  // show and off this tick: readClipboard() is synchronous and can spend seconds on a 15 MB
  // image (X11 transfer, sha256, decode, writeFileSync). In front of the show that stall is
  // the panel visibly freezing on open; behind it the new clip just arrives via broadcast().
  state.imageDue = true;
  if (state.pollNow) setTimeout(state.pollNow, 0);
  if (DEBUG) {
    setTimeout(() => {
      // DATA_DIR, not tmpdir: this frame is clipboard content and a fixed /tmp name is
      // a symlink-clobber target on a shared machine
      const shot = path.join(DATA_DIR, 'debug-panel.png');
      // the panel can be destroyed inside these 2.5s (crash give-up, display change)
      if (wins[0].isDestroyed()) return;
      wins[0].webContents.capturePage().then((img) => {
        fs.writeFileSync(shot, img.toPNG());
        console.log('[clp] debug screenshot: ' + shot);
      }).catch(() => {});
    }, 2500);
  }
}

function hidePanel() {
  for (const win of panels()) if (win.isVisible()) win.hide();
}

function togglePanel() {
  if (panels().some((w) => w.isVisible())) hidePanel();
  else showPanel();
}

function sendAll(channel, payload) {
  for (const win of panels()) win.webContents.send(channel, payload);
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
    visible: panels().some((w) => w.isVisible()),
    config: {
      // what actually toggles the panel — may be the fallback while the saved one is in conflict
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

function broadcast() {
  sendAll('clips:changed', snapshot());
}

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
    // in-memory only: persisting the fallback would let a transient conflict (another instance,
    // another app holding the key for one session) permanently overwrite the user's choice
    console.warn(`[clp] atalho ${wanted} em conflito, usando ${fallback}`);
    state.activeShortcut = fallback;
  } else {
    console.error(`[clp] atalho ${wanted} em conflito e sem alternativa — abra pela bandeja`);
    state.activeShortcut = null;
  }
  return state.activeShortcut;
}

module.exports = {
  createWindow, showPanel, hidePanel, togglePanel, refreshPanels,
  panels, sendAll, snapshot, broadcast, registerShortcut,
};
