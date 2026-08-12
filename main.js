'use strict';

const { app, globalShortcut, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// first require on purpose: it patches console.*, so every line any other module logs while
// loading already carries a timestamp
const { bootLine } = require('./src/log');
const {
  DATA_DIR, QUIT_FLAG, POLL_MS, HEARTBEAT_MS, RESTART_CODE,
} = require('./src/constants');
const state = require('./src/state');
const { strayPids } = require('./src/procs');
const { loadStore, flushSave } = require('./src/storage');
// requiring protocol.js also registers the clp:// scheme as privileged (must happen before ready)
const { registerClpProtocol } = require('./src/protocol');
const { readClipboard, poll, detectXdotool } = require('./src/clipboard');
const { createWindow, showPanel, togglePanel, registerShortcut, panels } = require('./src/window');
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

// ...but it does not remove the GPU *process*: Chromium still forks one for software
// compositing, and when that one dies (exit_code=9 across a suspend, or launch failures)
// GpuProcessHost runs out of fallback modes and calls LOG(FATAL) "GPU process isn't usable.
// Goodbye.", killing the browser process with it — 32 of the 43 deaths in launch.log.
//
// No Chromium switch is applied for that, deliberately. Both candidates were tried and both
// are worse than the supervisor loop in install.sh, which restarts the app on exactly this
// kind of death and is the whole reason it exists:
//   --in-process-gpu               folds the GPU and viz threads into this process. Measured:
//                                  they go from a child with Seccomp=2/NoNewPrivs=1/CapEff=0
//                                  to here, where Seccomp=0. That deletes one sandbox stage
//                                  from the exact chain this app defends (hostile clipboard
//                                  image -> renderer decoder bug -> viz/GPU Mojo -> browser).
//   --disable-gpu-process-crash-limit  keeps the sandbox but only lifts the retry ceiling: one
//                                  failing episode wrote 129 "GPU process launch failed" lines
//                                  in 24ms, drowning the log this app relies on to explain
//                                  itself.
// Letting it die and come back costs a visible restart and keeps both the sandbox and the log.
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

function ownsPidFile() {
  try { return fs.readFileSync(PID_FILE, 'utf8') === String(process.pid); } catch { return false; }
}

// Reiniciar (tray menu and the panel's settings). Deliberately not app.relaunch() under the
// supervisor: exiting with RESTART_CODE hands the respawn back to the launcher, so the new
// instance keeps the log redirect, the sandbox decision and the supervision itself. Without a
// supervisor (dev run, `npm start`) relaunch is the only way back.
function restartApp(reason) {
  console.warn(`[clp] reiniciar (${reason}) pid=${process.pid}`);
  try { globalShortcut.unregisterAll(); } catch {}
  try { flushSave(); } catch {}
  if (ownsPidFile()) { try { fs.unlinkSync(PID_FILE); } catch {} }
  for (const pid of strayPids(app.getAppPath(), process.pid)) {
    console.warn(`[clp] matando instância presa pid=${pid}`);
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  // no QUIT_FLAG here: this exit must respawn, unlike Sair
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
    // a stale flag (SIGKILL after Sair was pressed) would make the supervisor treat the next
    // crash as a deliberate quit and stop supervising
    fs.rmSync(QUIT_FLAG, { force: true });
    const incumbent = claimPidFile();
    if (incumbent) {
      // behave exactly like second-instance: the running app toggles, this one leaves —
      // before it loads the store, registers a shortcut or puts up a second tray icon
      console.warn(`[clp] instância ${incumbent} já ativa — repassando toggle e saindo`);
      try { process.kill(incumbent, 'SIGUSR2'); } catch {}
      app.exit(0);
      return;
    }
    loadStore();
    isPrimary = true;
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
    // tray-only app: a manual launch (menu/command) would show no window — pop the panel once.
    // autostart passes --hidden so login boots silently into the tray.
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
    // an X11 key grab does not always survive a suspend or a VT switch: the process stays
    // alive, the tray still works, and the shortcut silently does nothing — "o programa parou
    // de funcionar" with no error anywhere. Take it again on the way back. lastSig is left
    // alone on purpose: nothing can reach the clipboard while the machine is asleep, so
    // reseeding here would only drop whatever was copied just before it went under.
    powerMonitor.on('resume', () => {
      console.log(`[clp] atalho após resume: ${registerShortcut() || 'nenhum'}`);
    });

    app.on('child-process-gone', (_e, d) => {
      console.error(`[clp] child-gone tipo=${d.type} motivo=${d.reason} exit=${d.exitCode} ${d.name || ''}`);
    });

    // The one line that separates a freeze from a crash. At POLL_MS=500 a healthy beat reports
    // poll=+120; a much smaller delta means the main process spent the minute blocked (the
    // synchronous clipboard read on a dead X11 selection owner is the prime suspect), and a
    // missing beat means it never came back. Nothing else in launch.log can tell those apart.
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
      if (accel && !held) {
        console.warn('[clp] atalho global perdido — re-registrando');
        registerShortcut();
      }
    }, HEARTBEAT_MS);
  }).catch((err) => { console.error('[clp] boot:', err); app.exit(1); });

  app.on('window-all-closed', () => { /* tray app: keep running */ });

  app.on('before-quit', () => {
    // a duplicate quitting on the incumbent's behalf owns nothing here: no shortcut, an
    // unloaded store (saving it would blank history.json) and the incumbent's pid file
    if (!isPrimary) return;
    console.log(`[clp] sair pid=${process.pid}`);
    globalShortcut.unregisterAll();
    flushSave();
    if (ownsPidFile()) { try { fs.unlinkSync(PID_FILE); } catch {} }
    // tell the supervisor this exit was asked for, whatever code Chromium ends up returning
    try { fs.writeFileSync(QUIT_FLAG, ''); } catch (err) { console.error('[clp] quit flag:', err); }
    // "Failed to shutdown." (12x in launch.log) is Electron aborting on a shutdown that never
    // finished — and before that abort the app sits there, quit but still holding the tray icon
    // and the global shortcut. unref'd so it never keeps a healthy shutdown alive.
    // Known ceiling: this is a JS timer, so it only fires while the event loop still turns. One
    // instance was measured spinning at 100% CPU two minutes after its SIGTERM, and no timer
    // was ever going to run there — the SIGKILL escalation in install.sh's stop_running(), and
    // strayPids() behind the Reiniciar button, are what cover that half.
    setTimeout(() => {
      console.error('[clp] shutdown travou — forçando saída');
      process.exit(0);
    }, 5000).unref();
  });
}
