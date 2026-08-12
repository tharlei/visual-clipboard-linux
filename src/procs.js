'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The restart button has to clear instances that outlived their session: launch.log shows
// browser processes that stopped painting but kept the tray icon and the X11 grab, so a plain
// relaunch would come back to a desktop where the shortcut is already taken.
//
// A process qualifies only if the binary it is RUNNING lives inside our app dir — argv[0], not
// the whole cmdline, and never the process name (an unpackaged Electron app is just
// "electron"). Matching anywhere in the cmdline picks up every shell, editor and `pgrep` that
// merely mentions the path in an argument; that was not theoretical, the first dry run of this
// function targeted the terminal it was invoked from. argv[0] alone is also enough to sweep a
// whole stray instance: every Chromium child (zygote, gpu, renderer, utility, broker) re-execs
// that same binary. Walking the process tree instead would drag in whatever the stray opened
// through shell.openPath() — the user's editor is not ours to kill.
//
// Our own subtree is excluded: SIGKILLing this process's gpu/renderer right before it exits
// writes exactly the FATAL noise into launch.log that this change exists to remove.
function strayPids(appPath, selfPid, procRoot = '/proc') {
  // an empty appPath makes the startsWith() below true for every process on the box. Nothing
  // reachable passes one, and the blast radius of being wrong is the user's whole session.
  if (!appPath || !path.isAbsolute(appPath) || appPath === path.sep) return [];

  const children = new Map();
  const matches = [];
  let entries;
  try { entries = fs.readdirSync(procRoot); } catch { return []; }

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat;
    try { stat = fs.readFileSync(path.join(procRoot, name, 'stat'), 'utf8'); } catch { continue; }
    // comm sits in parentheses and may contain spaces and ')' itself — split after the LAST one,
    // so ppid is reliably the second field of the remainder
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    if (!Number.isInteger(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
    try {
      // cmdline is NUL-separated; argv[0] is the executable the kernel actually launched
      const argv0 = fs.readFileSync(path.join(procRoot, name, 'cmdline'), 'utf8').split('\0')[0];
      if (argv0.startsWith(appPath + path.sep)) matches.push(pid);
    } catch { /* the process ended between readdir and here */ }
  }

  const ours = new Set();
  const queue = [selfPid];
  while (queue.length) {
    const pid = queue.pop();
    if (ours.has(pid)) continue;
    ours.add(pid);
    for (const kid of children.get(pid) || []) queue.push(kid);
  }
  return matches.filter((pid) => !ours.has(pid));
}

module.exports = { strayPids };
