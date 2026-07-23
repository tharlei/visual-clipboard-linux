'use strict';

const os = require('node:os');
const path = require('node:path');

const DATA_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'visual-clipboard'
);
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUTOSTART_FILE = path.join(os.homedir(), '.config', 'autostart', 'visual-clipboard.desktop');

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const POLL_MS = 500;
const PREVIEW_CHARS = 300;
const PANEL_HEIGHT = 320;
const THUMB_HEIGHT = 240;
const THUMB_WIDTH = 480;

const GNOME_FILES_FORMAT = 'x-special/gnome-copied-files';
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const BOARD_COLORS = ['#32D74B', '#0A84FF', '#FF9F0A', '#BF5AF2', '#FF375F', '#64D2FF', '#30D5C8'];

const DEFAULT_CONFIG = {
  shortcut: 'Control+Alt+V',
  maxItems: 500,
  autoPaste: true,
  pasteDelayMs: 150,
};

const DEBUG = !!process.env.CLP_DEBUG;

module.exports = {
  DATA_DIR, IMAGES_DIR, THUMBS_DIR, HISTORY_FILE, CONFIG_FILE, AUTOSTART_FILE,
  MAX_IMAGE_BYTES, MAX_TEXT_CHARS, POLL_MS, PREVIEW_CHARS, PANEL_HEIGHT,
  THUMB_HEIGHT, THUMB_WIDTH,
  GNOME_FILES_FORMAT, VIDEO_EXTS, IMAGE_EXTS, BOARD_COLORS,
  DEFAULT_CONFIG, DEBUG,
};
