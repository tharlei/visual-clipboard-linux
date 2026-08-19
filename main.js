'use strict';

const { app, globalShortcut, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { bootLine } = require('./src/log');
const {
  DATA_DIR, QUIT_FLAG, HEARTBEAT_FILE, POLL_MS, HEARTBEAT_MS, RESTART_CODE,
  EXIT_GRACE_S, WATCHDOG_S,
} = require('./src/constants');
const state = require('./src/state');
const { strayPids, killSelfIn, guardHeartbeat } = require('./src/procs');
const { loadStore, flushSave } = require('./src/storage');
const { registerClpProtocol } = require('./src/protocol');
const { readClipboard, poll, detectXdotool } = require('./src/clipboard');
const {
  createWindow, showPanel, togglePanel, registerShortcut, panels, allowClose,
} = require('./src/window');
const { createTray } = require('./src/tray');
const { setupIpc } = require('./src/ipc');

process.umask(0o077);

app.disableHardwareAcceleration();

process.on('uncaughtException', (err) => console.error('[clp] uncaught:', err));

const PID_FILE = path.join(DATA_DIR, 'app.pid');
let isPrimary = false;

/** Pid from app.pid when it still belongs to a live instance of this app, else null. */
function livingIncumbent() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!pid || pid === process.pid) return null;
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmd.includes(app.getAppPath()) ? pid : null;
  } catch { return null; }
}

/** Takes ownership of app.pid atomically; returns the incumbent pid when another instance holds it. */
function claimPidFile() {
  const tmp = PID_FILE + '.' + process.pid;
  fs.writeFileSync(tmp, String(process.pid));
  try {
    for (let i = 0; i < 3; i++) {
      try {
        fs.linkSync(tmp, PID_FILE);
        return null;
      } catch {
        const pid = livingIncumbent();
        if (pid) return pid;
        try { fs.unlinkSync(PID_FILE); } catch {}
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** True while app.pid still names this process. */
function ownsPidFile() {
  try { return fs.readFileSync(PID_FILE, 'utf8') === String(process.pid); } catch { return false; }
}

/** Restarts the app: arms the detached killer, clears strays, then exits for the supervisor to respawn. */
function restartApp(reason) {
  console.warn(`[clp] reiniciar (${reason}) pid=${process.pid}`);
  try { flushSave(); } catch {}
  if (ownsPidFile()) { try { fs.unlinkSync(PID_FILE); } catch {} }
  for (const pid of strayPids(app.getAppPath(), process.pid)) {
    console.warn(`[clp] matando instância presa pid=${pid}`);
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  killSelfIn(EXIT_GRACE_S);
  allowClose();
  try { globalShortcut.unregisterAll(); } catch {}
  if (process.env.CLP_SUPERVISED) return app.exit(RESTART_CODE);
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
  app.exit(0);
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => { console.log('[clp] toggle via second-instance'); togglePanel(); });

  app.whenReady().then(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    bootLine();
    fs.rmSync(QUIT_FLAG, { force: true });
    const incumbent = claimPidFile();
    if (incumbent) {
      console.warn(`[clp] instância ${incumbent} já ativa — repassando toggle e saindo`);
      try { process.kill(incumbent, 'SIGUSR2'); } catch {}
      app.exit(0);
      return;
    }
    loadStore();
    isPrimary = true;
    try { fs.writeFileSync(HEARTBEAT_FILE, ''); } catch (err) { console.error('[clp] heartbeat:', err); }
    if (guardHeartbeat(HEARTBEAT_FILE, WATCHDOG_S, path.join(DATA_DIR, 'launch.log'))) {
      console.log(`[clp] watchdog armado: ${WATCHDOG_S}s sem heartbeat = SIGKILL`);
    }
    process.on('SIGUSR2', () => { console.log('[clp] toggle via sinal'); togglePanel(); });
    setInterval(() => {
      if (!ownsPidFile()) {
        console.warn('[clp] app.pid sumiu/alheio — reescrevendo');
        try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
      }
    }, 5000);
    registerClpProtocol();
    setupIpc();
    createWindow();
    registerShortcut();
    createTray();
    detectXdotool();
    if (!process.argv.includes('--hidden')) {
      state.wins[0].webContents.once('did-finish-load', () => showPanel(false));
    }
    try { state.lastSig = readClipboard().sig; } catch { state.lastSig = null; }
    state.pollNow = poll;
    state.restartApp = restartApp;
    setInterval(poll, POLL_MS);

    for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown']) {
      powerMonitor.on(ev, () => console.log(`[clp] power:${ev}`));
    }
    powerMonitor.on('resume', () => {
      console.log(`[clp] atalho após resume: ${registerShortcut() || 'nenhum'}`);
    });

    app.on('child-process-gone', (_e, d) => {
      console.error(`[clp] child-gone tipo=${d.type} motivo=${d.reason} exit=${d.exitCode} ${d.name || ''}`);
    });

    let lastPolls = 0;
    setInterval(() => {
      const polls = state.pollCount - lastPolls;
      lastPolls = state.pollCount;
      const wins = panels();
      const accel = state.activeShortcut;
      const held = !!accel && globalShortcut.isRegistered(accel);
      const mem = app.getAppMetrics()
        .map((p) => `${p.type}=${Math.round(p.memory.workingSetSize / 1024)}MB`).join(' ');
      console.log(
        `[clp] hb up=${Math.round(process.uptime() / 60)}min ocioso=${powerMonitor.getSystemIdleTime()}s`
        + ` clips=${state.store.clips.length} poll=+${polls} lento=${state.pollMaxMs}ms err=${state.pollErrors}`
        + ` paineis=${wins.length}/${wins.filter((w) => w.isVisible()).length}`
        + ` atalho=${accel || 'nenhum'}:${accel ? (held ? 'ok' : 'PERDIDO') : '-'} ${mem}`
      );
      state.pollMaxMs = 0;
      try { fs.writeFileSync(HEARTBEAT_FILE, ''); } catch {}
      if (accel && !held) {
        console.warn('[clp] atalho global perdido — re-registrando');
        registerShortcut();
      }
    }, HEARTBEAT_MS);
  }).catch((err) => { console.error('[clp] boot:', err); app.exit(1); });

  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    if (!isPrimary) return;
    console.log(`[clp] sair pid=${process.pid}`);
    globalShortcut.unregisterAll();
    flushSave();
    if (ownsPidFile()) { try { fs.unlinkSync(PID_FILE); } catch {} }
    try { fs.writeFileSync(QUIT_FLAG, ''); } catch (err) { console.error('[clp] quit flag:', err); }
    killSelfIn(EXIT_GRACE_S);
  });
}
