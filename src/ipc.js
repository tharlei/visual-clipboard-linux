'use strict';

const { ipcMain, dialog, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, BOARD_COLORS, MAX_TEXT_CHARS, ELECTRON_STALE_DAYS } = require('./constants');
const state = require('./state');
const { saveStore, saveDebounced, saveConfig, scanUsage, pruneOrphans, newId, sha } = require('./storage');
const {
  classifyText, deleteImageFile, enforceCap,
  writeClipToClipboard, selectClip, clearHistory,
} = require('./clipboard');
const { snapshot, broadcast, hidePanel, refreshPanels, registerShortcut, panels } = require('./window');
const { trayIcon, updateTrayMenu, isAutostart, setAutostart, electronAgeDays } = require('./tray');
const { normalizeConfig, riskyToOpen } = require('./validate');

// first bytes only — a file clip can point at a multi-gigabyte video
function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64);
    const n = fs.readSync(fd, buf, 0, 64, 0);
    return buf.subarray(0, n).toString('latin1');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function setupIpc() {
  // every channel below is privileged; only the panel windows may reach it. wrapping the
  // registration instead of each handler keeps future channels covered by default.
  const fromPanel = (e) => panels().some((w) => w.webContents === e.sender);
  const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => {
    if (!fromPanel(e)) throw new Error(`${ch}: sender não é um painel`);
    return fn(e, ...a);
  });
  const on = (ch, fn) => ipcMain.on(ch, (e, ...a) => { if (fromPanel(e)) fn(e, ...a); });

  handle('clips:get', () => snapshot());
  handle('clips:getText', (_e, id) => {
    const clip = state.store.clips.find((c) => c.id === id);
    return clip ? clip.text : '';
  });
  handle('clips:select', (_e, id) => selectClip(id));
  handle('clips:update', (_e, id, text) => {
    const clip = state.store.clips.find((c) => c.id === id);
    if (!clip || clip.type === 'image' || clip.type === 'file') return;
    clip.text = String(text).slice(0, MAX_TEXT_CHARS);
    clip.type = classifyText(clip.text);
    clip.hash = 'T:' + sha(clip.text);
    clip.createdAt = Date.now();
    state.store.clips.splice(state.store.clips.indexOf(clip), 1);
    state.store.clips.unshift(clip);
    writeClipToClipboard(clip);
    saveDebounced();
    broadcast();
  });
  handle('clips:delete', (_e, id) => {
    const i = state.store.clips.findIndex((c) => c.id === id);
    if (i < 0) return;
    deleteImageFile(state.store.clips[i]);
    state.store.clips.splice(i, 1);
    saveDebounced();
    broadcast();
  });
  handle('clips:clear', () => clearHistory());
  handle('clips:pin', (_e, id, value) => {
    const clip = state.store.clips.find((c) => c.id === id);
    if (!clip) return;
    clip.pinned = !!value;
    saveDebounced();
    broadcast();
  });
  // the path came off the clipboard, so any process on the box chose it. a .desktop or an
  // executable handed to shell.openPath() is code execution — ask before that one.
  handle('clips:openFile', async (_e, id) => {
    const clip = state.store.clips.find((c) => c.id === id);
    const file = clip && clip.files && clip.files[0];
    if (!file) return;
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    if (riskyToOpen(file, stat, readHead(file))) {
      const { response } = await dialog.showMessageBox(panels()[0], {
        type: 'warning',
        buttons: ['Cancelar', 'Abrir mesmo assim'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: 'Este arquivo pode executar código',
        detail: `${file}\n\nQualquer aplicativo pode ter colocado este caminho na área de transferência. Só abra se você reconhece o arquivo.`,
      });
      if (response !== 1) return;
    }
    shell.openPath(file);
  });
  handle('boards:create', (_e, name) => {
    const board = {
      id: 'b_' + newId(),
      name: String(name || '').trim().slice(0, 40) || 'Board',
      color: BOARD_COLORS[state.store.boards.length % BOARD_COLORS.length],
    };
    state.store.boards.push(board);
    saveDebounced();
    broadcast();
    return board;
  });
  handle('boards:assign', (_e, clipId, boardId, enabled) => {
    const clip = state.store.clips.find((c) => c.id === clipId);
    if (!clip || !state.store.boards.some((b) => b.id === boardId)) return;
    clip.boardIds = clip.boardIds.filter((b) => b !== boardId);
    if (enabled) clip.boardIds.push(boardId);
    saveDebounced();
    broadcast();
  });
  handle('boards:delete', (_e, id) => {
    state.store.boards = state.store.boards.filter((b) => b.id !== id);
    for (const c of state.store.clips) {
      if (c.boardIds && c.boardIds.length) c.boardIds = c.boardIds.filter((b) => b !== id);
    }
    saveDebounced();
    broadcast();
  });
  handle('panel:hide', () => hidePanel());
  // deferred one tick: restartApp() exits the process, and the invoke reply has to reach the
  // renderer first or the panel hangs on a promise that never settles
  handle('app:restart', () => { setTimeout(() => state.restartApp && state.restartApp('painel'), 100); });
  handle('stats:usage', () => {
    const u = scanUsage();
    const age = electronAgeDays();
    return {
      bytes: u.bytes, images: u.images, clips: u.clips,
      orphans: u.orphans.length, orphanBytes: u.orphanBytes,
      electronStale: age >= ELECTRON_STALE_DAYS ? age : 0,
    };
  });
  handle('stats:prune', () => pruneOrphans());
  handle('config:autostart', (_e, on) => {
    if (typeof on === 'boolean') setAutostart(on);
    return isAutostart();
  });
  handle('config:update', (_e, patch) => {
    // normalizeConfig rejects an accelerator with no modifier: a bare key registered here
    // would swallow that key for every app on the desktop. it also keeps the current value
    // on anything invalid, so a bad patch is a no-op rather than a reset.
    const next = normalizeConfig({ ...state.config, ...(patch || {}) }, state.config);
    const shortcutChanged = next.shortcut !== state.config.shortcut;
    const displayChanged = next.display !== state.config.display;
    state.config = next;
    if (shortcutChanged) registerShortcut();
    // deferred: switching to fewer monitors destroys windows, and this reply may be going to one
    if (displayChanged) setTimeout(refreshPanels, 0);
    saveConfig();
    enforceCap();
    saveStore();
    updateTrayMenu();
    broadcast();
    return { shortcut: state.config.shortcut };
  });
  // drag a real file out (image/file clips) — dropping into a terminal yields the path
  on('clips:startDrag', (e, id) => {
    const clip = state.store.clips.find((c) => c.id === id);
    if (!clip) return;
    let file;
    if (clip.type === 'image') file = path.join(DATA_DIR, clip.imageFile);
    else if (clip.type === 'file') file = clip.files && clip.files[0];
    else return;
    if (!file || !fs.existsSync(file)) return;
    const icon = clip.type === 'image'
      ? nativeImage.createFromPath(file).resize({ width: 96 })
      : trayIcon();
    try {
      const item = clip.type === 'file' && clip.files.length > 1
        ? { files: clip.files, icon }
        : { file, icon };
      e.sender.startDrag(item);
    } catch (err) {
      console.error('[clp] startDrag:', err);
    }
  });
}

module.exports = { setupIpc };
