'use strict';

/** Covers src/procs.js: the pid set Reiniciar SIGKILLs, and the detached deadlines behind it. */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { strayPids } = require('../src/procs');

const APP = '/home/u/.local/share/visual-clipboard/app';
const BIN = `${APP}/node_modules/electron/dist/electron`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clp-proc-'));

/** Writes a fake /proc/<pid> with a stat and cmdline. */
function proc(pid, { ppid, comm = 'electron', cmdline }) {
  const dir = path.join(root, String(pid));
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${comm}) S ${ppid} ${pid} 0 0 -1 4194560\n`);
  fs.writeFileSync(path.join(dir, 'cmdline'), cmdline.join('\0') + '\0');
}

const SELF = 100;
proc(SELF, { ppid: 1, cmdline: [BIN, APP] });
proc(101, { ppid: SELF, cmdline: [BIN, '--type=gpu-process'] });
proc(102, { ppid: 101, cmdline: [BIN, '--type=utility'] });

const STRAY = 200;
proc(STRAY, { ppid: 1, cmdline: [BIN, APP, '--hidden'] });
proc(201, { ppid: STRAY, cmdline: [BIN, '--type=renderer'] });
proc(202, { ppid: STRAY, comm: 'gedit', cmdline: ['/usr/bin/gedit', '/home/u/notes.txt'] });

proc(300, { ppid: 1, comm: 'weird) name (x', cmdline: [BIN, APP] });

proc(400, { ppid: 1, comm: 'firefox', cmdline: ['/usr/lib/firefox/firefox', '--new-tab'] });
proc(401, { ppid: 1, cmdline: ['/opt/other-app/node_modules/electron/dist/electron', '/opt/other-app'] });
proc(402, { ppid: 1, comm: 'bash', cmdline: ['/bin/bash', '-c', `tail -f ${APP}/../launch.log`] });
proc(403, { ppid: 1, comm: 'grep', cmdline: ['pgrep', '-af', APP] });
proc(404, { ppid: 1, cmdline: [`${APP}-old/node_modules/electron/dist/electron`, `${APP}-old`] });
fs.mkdirSync(path.join(root, 'self'));
fs.writeFileSync(path.join(root, 'uptime'), '1 1\n');

const got = strayPids(APP, SELF, root).sort((a, b) => a - b);

assert.deepEqual(got, [200, 201, 300], `unexpected kill set: ${got}`);
assert.ok(!got.includes(SELF), 'never kills the process asking for the restart');
assert.ok(!got.includes(101) && !got.includes(102), 'never kills our own children');
assert.ok(!got.includes(400) && !got.includes(401), 'never kills a process outside the app path');
assert.ok(!got.includes(402) && !got.includes(403), 'never kills a process that only names the path');
assert.ok(!got.includes(404), 'app-old/ is not inside app/');
assert.ok(!got.includes(202), "never kills what a stray opened — only what runs the app's own binary");

assert.deepEqual(strayPids(APP, SELF, path.join(root, 'nope')), [], 'unreadable procRoot yields nothing');
for (const bad of ['', '/', '.', 'relative/path', null, undefined]) {
  assert.deepEqual(strayPids(bad, SELF, root), [], `refuses appPath ${JSON.stringify(bad)}`);
}

fs.rmSync(root, { recursive: true, force: true });

const { execSync, spawn } = require('node:child_process');
const { procStart, killPidIn, guardHeartbeat } = require('../src/procs');

const SELF_START = procStart(process.pid);
assert.match(String(SELF_START), /^\d+$/, 'procStart reads field 22 of our own /proc stat');
assert.equal(procStart(2, path.join(root, 'nope')), null, 'unreadable stat yields null');

/** True while pid exists and is not a zombie. */
function alive(pid) {
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return false; }
  return stat.slice(stat.lastIndexOf(')') + 1).trim()[0] !== 'Z';
}

/** Spawns a throwaway `sleep` to arm a deadline against. */
function victim() {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  child.on('error', () => {});
  return child;
}

const doomed = victim();
assert.ok(killPidIn(doomed.pid, procStart(doomed.pid), 1), 'arms against a live process');

const spared = victim();
assert.ok(killPidIn(spared.pid, '4294967295', 1), 'arms with a bogus start time too');

execSync('sleep 3');

assert.ok(!alive(doomed.pid), 'the deadline fired without this process doing anything');
assert.ok(alive(spared.pid), 'a recycled pid is left alone — the safe direction to be wrong in');
spared.kill('SIGKILL');

assert.equal(killPidIn(1, SELF_START, 1), false, 'never targets init');
assert.equal(killPidIn(doomed.pid, 'nope', 1), false, 'refuses a non-numeric start time');
assert.equal(killPidIn(doomed.pid, SELF_START, -1), false, 'refuses a negative delay');
assert.equal(killPidIn(1.5, SELF_START, 1), false, 'refuses a non-integer pid');

const LOG = path.join(root, 'launch.log');
assert.equal(guardHeartbeat("/tmp/it's-here/alive", 180, LOG), false, "refuses a quote in the path");
assert.equal(guardHeartbeat(path.join(root, 'alive'), 180, "/tmp/o'log"), false, 'refuses it in the log path too');
assert.equal(guardHeartbeat(path.join(root, 'alive'), 0, LOG), false, 'WATCHDOG_S=0 disables the guard');

console.log('ok — procs');
