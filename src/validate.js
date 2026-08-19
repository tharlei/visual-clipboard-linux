'use strict';

const path = require('node:path');

const { BOARD_COLORS, MAX_IGNORE_PATTERNS } = require('./constants');

const ID_RE = /^[a-z0-9_]+$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const MODIFIER_RE = /^(Control|Ctrl|Alt|AltGr|Shift|Super|Meta|Command|Cmd|CommandOrControl|CmdOrCtrl)$/;
const CLIP_TYPES = new Set(['text', 'link', 'code', 'image', 'file']);
const RISKY_EXTS = new Set([
  'desktop', 'sh', 'bash', 'zsh', 'fish', 'ksh', 'run', 'appimage', 'bin', 'elf', 'so',
  'py', 'pl', 'rb', 'php', 'lua', 'jar', 'deb', 'rpm', 'exe', 'msi', 'bat', 'cmd', 'ps1',
]);

/** True when an accelerator carries at least one modifier and every prefix part is a known one. */
function hasModifier(accel) {
  const parts = String(accel).split('+');
  parts.pop();
  return parts.length > 0 && parts.every((m) => MODIFIER_RE.test(m));
}

/** Coerces and clamps a config object, keeping the default on anything invalid. */
function normalizeConfig(raw, defaults) {
  const c = { ...defaults, ...(raw || {}) };
  return {
    shortcut: hasModifier(c.shortcut) ? String(c.shortcut) : defaults.shortcut,
    maxItems: Math.max(10, Math.min(5000, Math.round(Number(c.maxItems) || defaults.maxItems))),
    autoPaste: !!c.autoPaste,
    pasteDelayMs: Math.max(0, Math.min(2000, Number(c.pasteDelayMs) || 0)),
    display: String(c.display || defaults.display).slice(0, 64),
    paused: !!c.paused,
    ignorePatterns: (Array.isArray(c.ignorePatterns) ? c.ignorePatterns : [])
      .filter((p) => typeof p === 'string' && p.length > 0)
      .map((p) => p.slice(0, 200))
      .slice(0, MAX_IGNORE_PATTERNS),
  };
}

/** Coerces a store read from disk, dropping ids, paths and payloads that fail their shape. */
function sanitizeStore(store) {
  store.version = 1;
  store.boards = (Array.isArray(store.boards) ? store.boards : [])
    .filter((b) => b && ID_RE.test(String(b.id)));
  for (const b of store.boards) {
    b.id = String(b.id);
    b.name = String(b.name == null ? 'Board' : b.name).slice(0, 40);
    if (!HEX_COLOR_RE.test(String(b.color))) b.color = BOARD_COLORS[0];
  }

  const boardIds = new Set(store.boards.map((b) => b.id));
  store.clips = (Array.isArray(store.clips) ? store.clips : [])
    .filter((c) => c && ID_RE.test(String(c.id)));
  for (const c of store.clips) {
    c.id = String(c.id);
    if (!CLIP_TYPES.has(c.type)) c.type = 'text';
    if (typeof c.text !== 'string') c.text = '';
    if (typeof c.hash !== 'string') c.hash = '';
    if (!Number.isFinite(c.createdAt)) c.createdAt = 0;
    c.pinned = !!c.pinned;
    c.boardIds = (Array.isArray(c.boardIds) ? c.boardIds : []).map(String).filter((b) => boardIds.has(b));
    if (c.imageFile !== undefined && c.imageFile !== `images/${c.id}.png`) delete c.imageFile;
    if (c.files !== undefined && (!Array.isArray(c.files) || !c.files.every((f) => typeof f === 'string' && f))) {
      delete c.files;
    }
  }
  store.clips = store.clips.filter((c) => {
    if (c.type === 'image') return !!c.imageFile;
    if (c.type === 'file') return !!(c.files && c.files.length);
    return true;
  });
  return store;
}

/** True when opening this path could execute code — exec bit, shebang, desktop entry or risky extension. */
function riskyToOpen(filePath, stat, head = '') {
  if (stat.isDirectory()) return false;
  if (!stat.isFile()) return true;
  if (stat.mode & 0o111) return true;
  if (/^#!|^\[Desktop Entry\]/.test(String(head).trimStart())) return true;
  return RISKY_EXTS.has(path.extname(filePath).slice(1).trim().toLowerCase());
}

/** True when the text contains any of the user's ignore patterns, case-insensitively. */
function matchesIgnore(text, patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return false;
  const hay = String(text).toLowerCase();
  return patterns.some((p) => typeof p === 'string' && p.length > 0 && hay.includes(p.toLowerCase()));
}

module.exports = { hasModifier, normalizeConfig, sanitizeStore, riskyToOpen, matchesIgnore };
