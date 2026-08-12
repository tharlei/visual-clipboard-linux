'use strict';

// Covers src/procs.js — the pid set the Reiniciar button SIGKILLs. Getting this wrong kills a
// process that is not ours, so every rule gets a case: match on the app path and never the
// name, skip our own subtree, follow a stray's children, and survive a comm with ') ' in it.
// Plain asserts against a fake /proc: procs.js pulls only node:fs + node:path, no Electron.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { strayPids } = require('../src/procs');

const APP = '/home/u/.local/share/visual-clipboard/app';
const BIN = `${APP}/node_modules/electron/dist/electron`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clp-proc-'));

// stat is "pid (comm) state ppid ..." — comm is the field that can hide spaces and parens
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
// the stray opened a file through shell.openPath() and the viewer is still its child —
// sweeping a whole process tree would take the user's editor down with the restart
proc(202, { ppid: STRAY, comm: 'gedit', cmdline: ['/usr/bin/gedit', '/home/u/notes.txt'] });

// a comm containing ') ' would push the ppid field off by one on a naive split
proc(300, { ppid: 1, comm: 'weird) name (x', cmdline: [BIN, APP] });

proc(400, { ppid: 1, comm: 'firefox', cmdline: ['/usr/lib/firefox/firefox', '--new-tab'] });
// same binary name, different install — the app path is what makes a process ours
proc(401, { ppid: 1, cmdline: ['/opt/other-app/node_modules/electron/dist/electron', '/opt/other-app'] });
// only MENTIONS the app path, in an argument. A terminal tailing the log, an editor, a pgrep —
// killing these was the actual bug the first dry run of strayPids exposed.
proc(402, { ppid: 1, comm: 'bash', cmdline: ['/bin/bash', '-c', `tail -f ${APP}/../launch.log`] });
proc(403, { ppid: 1, comm: 'grep', cmdline: ['pgrep', '-af', APP] });
// a sibling directory whose name merely starts the same must not match on a prefix test
proc(404, { ppid: 1, cmdline: [`${APP}-old/node_modules/electron/dist/electron`, `${APP}-old`] });
// non-numeric /proc entries must be ignored, not crash the scan
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
// an empty or root appPath would match every process on the box
for (const bad of ['', '/', '.', 'relative/path', null, undefined]) {
  assert.deepEqual(strayPids(bad, SELF, root), [], `refuses appPath ${JSON.stringify(bad)}`);
}

fs.rmSync(root, { recursive: true, force: true });
console.log('ok — procs');
