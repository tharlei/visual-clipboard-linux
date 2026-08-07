'use strict';

const { app, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { DATA_DIR, POLL_MS, DEBUG } = require('./src/constants');
const state = require('./src/state');
const { loadStore, flushSave } = require('./src/storage');
// requiring protocol.js also registers the clp:// scheme as privileged (must happen before ready)
const { registerClpProtocol } = require('./src/protocol');
const { readClipboard, poll, detectXdotool } = require('./src/clipboard');
const { createWindow, showPanel, togglePanel, registerShortcut } = require('./src/window');
const { createTray } = require('./src/tray');
const { setupIpc } = require('./src/ipc');

// every file this process writes carries clipboard history — password, token, private key.
// one umask beats remembering { mode: 0o600 } on each writeFileSync, now and later.
process.umask(0o077);

// the panel is 320px of thumbnails — hardware acceleration buys it nothing and cost it
// everything: on NVIDIA + X11 + a transparent window the GPU process kept dying with
// "GPU process isn't usable. Goodbye.", taking the whole app down. No DRI driver to
// dlopen, no such crash — which is also what lets the Chromium sandbox stay on (the
// failure was EACCES on dri_gbm.so *because* the GPU process was sandboxed). Load-bearing
// for security, not just for stability: see the sandbox comment in install.sh.
app.disableHardwareAcceleration();

process.on('uncaughtException', (err) => console.error('[clp] uncaught:', err));

// Chromium's singleton lock was bypassed in the wild (two live instances on 2026-07-30, the
// second sailed past requestSingleInstanceLock and stole the shortcut) — this pid file is the
// fallback net. The /proc cmdline check keeps a recycled pid from counting as us.
const PID_FILE = path.join(DATA_DIR, 'app.pid');
let isPrimary = false;

function livingIncumbent() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!pid || pid === process.pid) return null;
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes(app.getAppPath()) ? pid : null;
  } catch { return null; }
}

function claimPidFile() {
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(PID_FILE, String(process.pid), { flag: 'wx' });
      return null;
    } catch {
      const pid = livingIncumbent();
      if (pid) return pid;
      try { fs.unlinkSync(PID_FILE); } catch {}
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
  return null;
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => togglePanel());

  app.whenReady().then(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const incumbent = claimPidFile();
    if (incumbent) {
      // behave exactly like second-instance: the running app toggles, this one leaves —
      // before it loads the store, registers a shortcut or puts up a second tray icon
      console.warn(`[clp] instância ${incumbent} já ativa — repassando toggle e saindo`);
      try { process.kill(incumbent, 'SIGUSR1'); } catch {}
      app.exit(0);
      return;
    }
    loadStore();
    isPrimary = true;
    process.on('SIGUSR1', togglePanel);
    registerClpProtocol();
    setupIpc();
    createWindow();
    registerShortcut();
    createTray();
    detectXdotool();
    // tray-only app: a manual launch (menu/command) would show no window — pop the panel once.
    // autostart passes --hidden so login boots silently into the tray.
    if (!process.argv.includes('--hidden')) {
      state.wins[0].webContents.once('did-finish-load', () => showPanel(false));
    }
    try { state.lastSig = readClipboard().sig; } catch { state.lastSig = null; }
    state.pollNow = poll;
    setInterval(poll, POLL_MS);

    if (DEBUG) {
      setInterval(() => {
        const per = app.getAppMetrics()
          .map((p) => `${p.type}=${Math.round(p.memory.workingSetSize / 1024)}MB`).join(' ');
        console.log(`[clp] mem sig=${String(state.lastSig).slice(0, 10)} ${per}`);
      }, 20000);
    }
  }).catch((err) => { console.error('[clp] boot:', err); app.exit(1); });

  app.on('window-all-closed', () => { /* tray app: keep running */ });

  app.on('before-quit', () => {
    // a duplicate quitting on the incumbent's behalf owns nothing here: no shortcut, an
    // unloaded store (saving it would blank history.json) and the incumbent's pid file
    if (!isPrimary) return;
    globalShortcut.unregisterAll();
    flushSave();
    try { fs.unlinkSync(PID_FILE); } catch {}
  });
}
