'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('clp', {
  get: () => ipcRenderer.invoke('clips:get'),
  getText: (id) => ipcRenderer.invoke('clips:getText', id),
  select: (id) => ipcRenderer.invoke('clips:select', id),
  update: (id, text) => ipcRenderer.invoke('clips:update', id, text),
  remove: (id) => ipcRenderer.invoke('clips:delete', id),
  clear: () => ipcRenderer.invoke('clips:clear'),
  pin: (id, value) => ipcRenderer.invoke('clips:pin', id, value),
  openFile: (id) => ipcRenderer.invoke('clips:openFile', id),
  createBoard: (name) => ipcRenderer.invoke('boards:create', name),
  assignBoard: (clipId, boardId, on) => ipcRenderer.invoke('boards:assign', clipId, boardId, on),
  deleteBoard: (id) => ipcRenderer.invoke('boards:delete', id),
  hide: () => ipcRenderer.invoke('panel:hide'),
  setConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  startDrag: (id) => ipcRenderer.send('clips:startDrag', id),
  onChanged: (cb) => ipcRenderer.on('clips:changed', (_e, snap) => cb(snap)),
  onShown: (cb) => ipcRenderer.on('panel:shown', () => cb()),
  onHidden: (cb) => ipcRenderer.on('panel:hidden', () => cb()),
  // called by the renderer AFTER it drops the cards, so the decoded bitmaps are
  // already unreferenced when Chromium's image cache is flushed
  purgeCache: () => { if (webFrame && typeof webFrame.clearCache === 'function') webFrame.clearCache(); },
  onSettings: (cb) => ipcRenderer.on('settings:open', () => cb()),
});
