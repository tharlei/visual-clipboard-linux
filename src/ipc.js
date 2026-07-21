'use strict';

const { ipcMain, globalShortcut, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, BOARD_COLORS, DEFAULT_CONFIG } = require('./constants');
const state = require('./state');
const { saveStore, saveDebounced, saveConfig, newId, sha } = require('./storage');
const {
  classifyText, deleteImageFile, enforceCap,
  writeClipToClipboard, selectClip, clearHistory,
} = require('./clipboard');
const { snapshot, broadcast, hidePanel, registerShortcut } = require('./window');
const { trayIcon, updateTrayMenu } = require('./tray');

function setupIpc() {
  ipcMain.handle('clips:get', () => snapshot());
  ipcMain.handle('clips:getText', (_e, id) => {
    const clip = state.store.clips.find((c) => c.id === id);
    return clip ? clip.text : '';
  });
  ipcMain.handle('clips:select', (_e, id) => selectClip(id));
  ipcMain.handle('clips:update', (_e, id, text) => {
    const clip = state.store.clips.find((c) => c.id === id);
    if (!clip || clip.type === 'image' || clip.type === 'file') return;
    clip.text = String(text);
    clip.type = classifyText(clip.text);
    clip.hash = 'T:' + sha(clip.text);
    clip.createdAt = Date.now();
    state.store.clips.splice(state.store.clips.indexOf(clip), 1);
    state.store.clips.unshift(clip);
    writeClipToClipboard(clip);
    saveDebounced();
    broadcast();
  });
  ipcMain.handle('clips:delete', (_e, id) => {
    const i = state.store.clips.findIndex((c) => c.id === id);
    if (i < 0) return;
    deleteImageFile(state.store.clips[i]);
    state.store.clips.splice(i, 1);
    saveDebounced();
    broadcast();
  });
  ipcMain.handle('clips:clear', () => clearHistory());
  ipcMain.handle('clips:pin', (_e, id, value) => {
    const clip = state.store.clips.find((c) => c.id === id);
    if (!clip) return;
    clip.pinned = !!value;
    saveDebounced();
    broadcast();
  });
  ipcMain.handle('clips:openFile', (_e, id) => {
    const clip = state.store.clips.find((c) => c.id === id);
    if (clip && clip.files && clip.files[0]) shell.openPath(clip.files[0]);
  });
  ipcMain.handle('boards:create', (_e, name) => {
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
  ipcMain.handle('boards:assign', (_e, clipId, boardId, on) => {
    const clip = state.store.clips.find((c) => c.id === clipId);
    if (!clip || !state.store.boards.some((b) => b.id === boardId)) return;
    clip.boardIds = clip.boardIds.filter((b) => b !== boardId);
    if (on) clip.boardIds.push(boardId);
    saveDebounced();
    broadcast();
  });
  ipcMain.handle('boards:delete', (_e, id) => {
    state.store.boards = state.store.boards.filter((b) => b.id !== id);
    for (const c of state.store.clips) {
      if (c.boardIds && c.boardIds.length) c.boardIds = c.boardIds.filter((b) => b !== id);
    }
    saveDebounced();
    broadcast();
  });
  ipcMain.handle('panel:hide', () => hidePanel());
  ipcMain.handle('config:update', (_e, patch) => {
    const next = { ...state.config, ...(patch || {}) };
    next.autoPaste = !!next.autoPaste;
    next.pasteDelayMs = Math.max(0, Math.min(2000, Number(next.pasteDelayMs) || 0));
    next.maxItems = Math.max(10, Math.min(5000, Math.round(Number(next.maxItems) || DEFAULT_CONFIG.maxItems)));
    next.shortcut = String(next.shortcut || DEFAULT_CONFIG.shortcut);
    const shortcutChanged = next.shortcut !== state.config.shortcut;
    state.config = next;
    if (shortcutChanged) {
      globalShortcut.unregisterAll();
      registerShortcut();
    }
    saveConfig();
    enforceCap();
    saveStore();
    updateTrayMenu();
    broadcast();
    return { shortcut: state.config.shortcut };
  });
  // drag a real file out (image/file clips) — dropping into a terminal yields the path
  ipcMain.on('clips:startDrag', (e, id) => {
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
