'use strict';

const {
  app, BrowserWindow, Tray, Menu, clipboard, globalShortcut,
  ipcMain, nativeImage, protocol, screen, shell, net,
} = require('electron');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const DATA_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'visual-clipboard'
);
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUTOSTART_FILE = path.join(os.homedir(), '.config', 'autostart', 'visual-clipboard.desktop');

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const POLL_MS = 500;
const PREVIEW_CHARS = 300;
const PANEL_HEIGHT = 320;

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

process.on('uncaughtException', (err) => console.error('[clp] uncaught:', err));

const DEBUG = !!process.env.CLP_DEBUG;

let win = null;
let shownAt = 0;
let tray = null;
let config = { ...DEFAULT_CONFIG };
let store = { version: 1, boards: [], clips: [] };
let lastSig;
let hasXdotool = false;
let saveTimer = null;
// ponytail: cache to skip re-hashing an unchanged large image every poll
let imgGate = { len: -1, head: null, sig: null };

// ---------- storage ----------

function loadJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      try { fs.renameSync(file, file + '.bak'); } catch {}
      console.warn(`[clp] ${path.basename(file)} corrompido, backup em .bak:`, err.message);
    }
    return { ...fallback };
  }
}

function loadStore() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  store = loadJson(HISTORY_FILE, { version: 1, boards: [], clips: [] });
  config = loadJson(CONFIG_FILE, DEFAULT_CONFIG);
  if (!fs.existsSync(CONFIG_FILE)) saveJsonAtomic(CONFIG_FILE, config);
}

function saveJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}

function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try { saveJsonAtomic(HISTORY_FILE, store); } catch (err) { console.error('[clp] falha ao salvar:', err); }
}

function saveDebounced() {
  if (saveTimer) return;
  saveTimer = setTimeout(saveStore, 300);
}

function saveConfig() {
  try { saveJsonAtomic(CONFIG_FILE, config); } catch (err) { console.error('[clp] falha ao salvar config:', err); }
}

function newId() {
  return Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}

function sha(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ---------- clipboard reading ----------

function parseFileUris(text) {
  return text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('file://'))
    .map((l) => { try { return fileURLToPath(l); } catch { return null; } })
    .filter(Boolean);
}

function fileKindOf(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'other';
}

function shaImage(png) {
  const head = png.subarray(0, 4096);
  if (imgGate.len === png.length && imgGate.head && head.equals(imgGate.head)) return imgGate.sig;
  const sig = sha(png);
  imgGate = { len: png.length, head: Buffer.from(head), sig };
  return sig;
}

// Reads current clipboard into { sig, kind?, skip?, ...payload }. sig === null => empty.
function readClipboard() {
  const formats = clipboard.availableFormats();

  if (formats.includes('x-kde-passwordManagerHint')) {
    return { sig: 'secret:' + sha(clipboard.readText() || ''), skip: true };
  }

  // custom targets are readable but never listed by availableFormats() — probe directly
  let fileBuf = clipboard.readBuffer(GNOME_FILES_FORMAT);
  if (!fileBuf.length) fileBuf = clipboard.readBuffer('text/uri-list');
  if (fileBuf && fileBuf.length) {
    const files = parseFileUris(fileBuf.toString('utf8'));
    if (files.length) return { sig: 'F:' + sha(fileBuf), kind: 'file', files };
  }

  if (formats.some((f) => f.startsWith('image/'))) {
    let png = clipboard.readBuffer('image/png');
    if (!png || !png.length) {
      const img = clipboard.readImage();
      png = img.isEmpty() ? null : img.toPNG();
    }
    if (png && png.length) {
      if (png.length > MAX_IMAGE_BYTES) return { sig: 'I:big:' + png.length, skip: true };
      return { sig: 'I:' + shaImage(png), kind: 'image', png };
    }
  }

  const text = clipboard.readText();
  if (!text || !text.trim()) return { sig: null };
  if (text.length > MAX_TEXT_CHARS) return { sig: 'T:big:' + text.length, skip: true };
  return { sig: 'T:' + sha(text), kind: 'text', text };
}

function classifyText(text) {
  const t = text.trim();
  if (/^https?:\/\/\S+$/i.test(t) && !/\s/.test(t)) return 'link';
  if (t.includes('\n')) {
    const symbolHits = (t.match(/[{};]|=>|<\//g) || []).length;
    const keywordHits = (t.match(/\b(function|const|let|var|def|class|import|return|if|for|while|fn|pub|end|echo|public|private)\b/g) || []).length;
    if (symbolHits + keywordHits >= 2 && symbolHits >= 1) return 'code';
  }
  return 'text';
}

// ---------- capture ----------

let pollCount = 0;

function poll() {
  let r;
  pollCount++;
  try { r = readClipboard(); } catch (err) { console.error('[clp] poll:', err); return; }
  if (DEBUG && pollCount % 10 === 0) console.log(`[clp] poll#${pollCount} sig=${r.sig && r.sig.slice(0, 16)}`);
  if (r.sig === lastSig) return;
  lastSig = r.sig;
  if (!r.sig || r.skip) return;
  if (DEBUG) console.log('[clp] capture kind=', r.kind);
  try { capture(r); } catch (err) { console.error('[clp] capture:', err); }
}

function capture(r) {
  const existing = store.clips.find((c) => c.hash === r.sig);
  if (existing) {
    existing.createdAt = Date.now();
    store.clips.splice(store.clips.indexOf(existing), 1);
    store.clips.unshift(existing);
    saveDebounced();
    broadcast();
    return;
  }

  const clip = {
    id: newId(),
    type: 'text',
    text: '',
    files: undefined,
    fileKind: undefined,
    imageFile: undefined,
    w: undefined,
    h: undefined,
    hash: r.sig,
    pinned: false,
    boardIds: [],
    createdAt: Date.now(),
  };

  if (r.kind === 'file') {
    clip.type = 'file';
    clip.files = r.files;
    clip.fileKind = fileKindOf(r.files[0]);
    clip.text = r.files.join('\n');
  } else if (r.kind === 'image') {
    clip.type = 'image';
    clip.imageFile = `images/${clip.id}.png`;
    const size = nativeImage.createFromBuffer(r.png).getSize();
    clip.w = size.width;
    clip.h = size.height;
    try {
      fs.writeFileSync(path.join(DATA_DIR, clip.imageFile), r.png);
    } catch (err) {
      console.error('[clp] falha ao gravar imagem:', err);
      return;
    }
  } else {
    clip.type = classifyText(r.text);
    clip.text = r.text;
  }

  store.clips.unshift(clip);
  enforceCap();
  saveDebounced();
  broadcast();
}

function deleteImageFile(clip) {
  if (!clip.imageFile) return;
  try { fs.unlinkSync(path.join(DATA_DIR, clip.imageFile)); } catch {}
}

function enforceCap() {
  const evictable = () => store.clips.filter((c) => !c.pinned && c.boardIds.length === 0);
  let extra = evictable().length - config.maxItems;
  if (extra <= 0) return;
  for (let i = store.clips.length - 1; i >= 0 && extra > 0; i--) {
    const c = store.clips[i];
    if (c.pinned || c.boardIds.length) continue;
    deleteImageFile(c);
    store.clips.splice(i, 1);
    extra--;
  }
}

// ---------- write back / select ----------

function writeClipToClipboard(clip) {
  if (clip.type === 'image') {
    clipboard.writeImage(nativeImage.createFromPath(path.join(DATA_DIR, clip.imageFile)));
  } else if (clip.type === 'file') {
    const body = ['copy', ...clip.files.map((f) => pathToFileURL(f).toString())].join('\n');
    clipboard.writeBuffer(GNOME_FILES_FORMAT, Buffer.from(body, 'utf8'));
  } else {
    clipboard.writeText(clip.text);
  }
  // read-back presets the signature so the watcher never re-captures our own write
  try { lastSig = readClipboard().sig; } catch {}
}

function autoPaste() {
  if (!hasXdotool || !config.autoPaste) return;
  setTimeout(() => {
    execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], (err) => {
      if (err) console.error('[clp] xdotool:', err.message);
    });
  }, config.pasteDelayMs);
}

function selectClip(id) {
  const clip = store.clips.find((c) => c.id === id);
  if (!clip) return;
  writeClipToClipboard(clip);
  hidePanel();
  autoPaste();
}

// ---------- snapshot / broadcast ----------

function snapshot() {
  return {
    clips: store.clips.map((c) => ({
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
    boards: store.boards,
    config: {
      shortcut: config.shortcut,
      autoPaste: config.autoPaste,
      pasteDelayMs: config.pasteDelayMs,
      maxItems: config.maxItems,
    },
    caps: { xdotool: hasXdotool },
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('clips:changed', snapshot());
}

// ---------- window ----------

function positionWindow() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  win.setBounds({ x, y: y + height - PANEL_HEIGHT, width, height: PANEL_HEIGHT });
}

function createWindow() {
  win = new BrowserWindow({
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
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
}

function showPanel(activate = true) {
  positionWindow();
  shownAt = Date.now();
  if (activate) {
    win.show();
    win.focus();
  } else {
    // launch auto-show: show on top WITHOUT grabbing focus, so the launch/overview
    // focus churn never fires a blur that would hide it instantly
    win.showInactive();
  }
  win.webContents.send('panel:shown');
  if (DEBUG) {
    setTimeout(() => {
      win.webContents.capturePage().then((img) => {
        fs.writeFileSync(path.join(os.tmpdir(), 'clp-panel.png'), img.toPNG());
        console.log('[clp] debug screenshot: ' + path.join(os.tmpdir(), 'clp-panel.png'));
      }).catch(() => {});
    }, 2500);
  }
}

function hidePanel() {
  if (win && win.isVisible()) win.hide();
}

function togglePanel() {
  if (win.isVisible()) hidePanel();
  else showPanel();
}

// ---------- clp:// protocol ----------

protocol.registerSchemesAsPrivileged([
  { scheme: 'clp', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

function registerClpProtocol() {
  protocol.handle('clp', (req) => {
    try {
      const { host, pathname } = new URL(req.url);
      const parts = pathname.split('/').filter(Boolean);
      let realPath = null;
      if (host === 'img') {
        const clip = store.clips.find((c) => c.id === parts[0] && c.imageFile);
        if (clip) realPath = path.join(DATA_DIR, clip.imageFile);
      } else if (host === 'file') {
        const clip = store.clips.find((c) => c.id === parts[0] && c.files);
        const idx = Number(parts[1] || 0);
        if (clip && clip.files[idx]) realPath = clip.files[idx];
      }
      if (!realPath || !fs.existsSync(realPath)) return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(realPath).toString());
    } catch {
      return new Response(null, { status: 400 });
    }
  });
}

// ---------- tray ----------

const ICON_FILE = path.join(__dirname, 'assets', 'icon.png');

function trayIcon() {
  // ponytail: reload+resize the bundled PNG each call; called ~once at boot, cost negligible
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
      fs.unlinkSync(AUTOSTART_FILE);
    }
  } catch (err) {
    console.error('[clp] autostart:', err);
  }
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Abrir (${config.shortcut.replace('Control', 'Ctrl')})`, click: () => showPanel() },
    { label: 'Configurações…', click: () => { showPanel(); win.webContents.send('settings:open'); } },
    { label: 'Limpar histórico', click: () => { clearHistory(); } },
    { type: 'checkbox', label: 'Iniciar com o sistema', checked: isAutostart(), click: (item) => setAutostart(item.checked) },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.exit(0); } },
  ]));
}

function createTray() {
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('Visual Clipboard — histórico do clipboard');
    updateTrayMenu();
    tray.on('click', () => togglePanel());
  } catch (err) {
    console.warn('[clp] tray indisponível (extensão AppIndicator?):', err.message);
  }
}

// ---------- mutations ----------

function clearHistory() {
  for (const c of store.clips) {
    if (!c.pinned && c.boardIds.length === 0) deleteImageFile(c);
  }
  store.clips = store.clips.filter((c) => c.pinned || c.boardIds.length > 0);
  saveStore();
  broadcast();
}

// ---------- IPC ----------

function setupIpc() {
  ipcMain.handle('clips:get', () => snapshot());
  ipcMain.handle('clips:getText', (_e, id) => {
    const clip = store.clips.find((c) => c.id === id);
    return clip ? clip.text : '';
  });
  ipcMain.handle('clips:select', (_e, id) => selectClip(id));
  ipcMain.handle('clips:update', (_e, id, text) => {
    const clip = store.clips.find((c) => c.id === id);
    if (!clip || clip.type === 'image' || clip.type === 'file') return;
    clip.text = String(text);
    clip.type = classifyText(clip.text);
    clip.hash = 'T:' + sha(clip.text);
    clip.createdAt = Date.now();
    store.clips.splice(store.clips.indexOf(clip), 1);
    store.clips.unshift(clip);
    writeClipToClipboard(clip);
    saveDebounced();
    broadcast();
  });
  ipcMain.handle('clips:delete', (_e, id) => {
    const i = store.clips.findIndex((c) => c.id === id);
    if (i < 0) return;
    deleteImageFile(store.clips[i]);
    store.clips.splice(i, 1);
    saveDebounced();
    broadcast();
  });
  ipcMain.handle('clips:clear', () => clearHistory());
  ipcMain.handle('clips:pin', (_e, id, value) => {
    const clip = store.clips.find((c) => c.id === id);
    if (!clip) return;
    clip.pinned = !!value;
    saveDebounced();
    broadcast();
  });
  ipcMain.handle('clips:openFile', (_e, id) => {
    const clip = store.clips.find((c) => c.id === id);
    if (clip && clip.files && clip.files[0]) shell.openPath(clip.files[0]);
  });
  ipcMain.handle('boards:create', (_e, name) => {
    const board = {
      id: 'b_' + newId(),
      name: String(name || '').trim().slice(0, 40) || 'Board',
      color: BOARD_COLORS[store.boards.length % BOARD_COLORS.length],
    };
    store.boards.push(board);
    saveDebounced();
    broadcast();
    return board;
  });
  ipcMain.handle('boards:assign', (_e, clipId, boardId, on) => {
    const clip = store.clips.find((c) => c.id === clipId);
    if (!clip || !store.boards.some((b) => b.id === boardId)) return;
    clip.boardIds = clip.boardIds.filter((b) => b !== boardId);
    if (on) clip.boardIds.push(boardId);
    saveDebounced();
    broadcast();
  });
  ipcMain.handle('boards:delete', (_e, id) => {
    store.boards = store.boards.filter((b) => b.id !== id);
    for (const c of store.clips) {
      if (c.boardIds && c.boardIds.length) c.boardIds = c.boardIds.filter((b) => b !== id);
    }
    saveDebounced();
    broadcast();
  });
  ipcMain.handle('panel:hide', () => hidePanel());
  ipcMain.handle('config:update', (_e, patch) => {
    const next = { ...config, ...(patch || {}) };
    next.autoPaste = !!next.autoPaste;
    next.pasteDelayMs = Math.max(0, Math.min(2000, Number(next.pasteDelayMs) || 0));
    next.maxItems = Math.max(10, Math.min(5000, Math.round(Number(next.maxItems) || DEFAULT_CONFIG.maxItems)));
    next.shortcut = String(next.shortcut || DEFAULT_CONFIG.shortcut);
    const shortcutChanged = next.shortcut !== config.shortcut;
    config = next;
    if (shortcutChanged) {
      globalShortcut.unregisterAll();
      registerShortcut();
    }
    saveConfig();
    enforceCap();
    saveStore();
    updateTrayMenu();
    broadcast();
    return { shortcut: config.shortcut };
  });
  // drag a real file out (image/file clips) — dropping into a terminal yields the path
  ipcMain.on('clips:startDrag', (e, id) => {
    const clip = store.clips.find((c) => c.id === id);
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

// ---------- shortcut / lifecycle ----------

function registerShortcut() {
  const tryReg = (accel) => {
    try { return globalShortcut.register(accel, togglePanel); } catch { return false; }
  };
  if (!tryReg(config.shortcut)) {
    const fallback = 'Control+Alt+Shift+V';
    console.warn(`[clp] atalho ${config.shortcut} em conflito, usando ${fallback}`);
    config.shortcut = fallback;
    tryReg(fallback);
  }
}

function detectXdotool() {
  execFile('xdotool', ['version'], (err) => {
    hasXdotool = !err;
    if (err) console.warn('[clp] xdotool ausente — colagem automática desativada. Instale: sudo apt install xdotool');
    broadcast();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => togglePanel());

  app.whenReady().then(() => {
    loadStore();
    registerClpProtocol();
    setupIpc();
    createWindow();
    createTray();
    registerShortcut();
    detectXdotool();
    // tray-only app: a manual launch (menu/command) would show no window — pop the panel once.
    // autostart passes --hidden so login boots silently into the tray.
    if (!process.argv.includes('--hidden')) {
      win.webContents.once('did-finish-load', () => showPanel(false));
    }
    try { lastSig = readClipboard().sig; } catch { lastSig = null; }
    setInterval(poll, POLL_MS);
  });

  app.on('window-all-closed', () => { /* tray app: keep running */ });

  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    saveStore();
  });
}
