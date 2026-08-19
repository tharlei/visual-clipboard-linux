'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** Pids running the app's own binary (argv[0] inside appPath), excluding this process's subtree. */
function strayPids(appPath, selfPid, procRoot = '/proc') {
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
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    if (!Number.isInteger(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
    try {
      const argv0 = fs.readFileSync(path.join(procRoot, name, 'cmdline'), 'utf8').split('\0')[0];
      if (argv0.startsWith(appPath + path.sep)) matches.push(pid);
    } catch {}
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

/** Field 22 of /proc/<pid>/stat — the boot-clock start time, unique per pid incarnation. */
function procStart(pid, procRoot = '/proc') {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19] || null;
  } catch {
    return null;
  }
}

/** Runs a shell script in a detached child that outlives this process. */
function detach(script) {
  spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' }).unref();
}

/** Shell test that pid still has the same start time, i.e. was not recycled. */
function stillUs(pid, start) {
  return `[ "$(cut -d' ' -f22 /proc/${pid}/stat 2>/dev/null)" = "${start}" ]`;
}

/** Single-quotes a path for a shell string, or returns null when it holds a quote itself. */
function shQuote(p) {
  return typeof p === 'string' && p && !p.includes("'") ? `'${p}'` : null;
}

/** Arms a detached SIGKILL against pid, firing only while it is still the same incarnation. */
function killPidIn(pid, start, seconds) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (!/^\d+$/.test(String(start))) return false;
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  detach(`sleep ${Math.floor(seconds)}; ${stillUs(pid, start)} && kill -9 ${pid}`);
  return true;
}

/** Arms the detached killer against this process — call before anything that can block. */
function killSelfIn(seconds) {
  return killPidIn(process.pid, procStart(process.pid), seconds);
}

/** Detached watchdog: SIGKILLs this process once `file` has gone unstale-touched for staleSeconds. */
function guardHeartbeat(file, staleSeconds, logFile) {
  const start = procStart(process.pid);
  const f = shQuote(file);
  const log = shQuote(logFile);
  if (!/^\d+$/.test(String(start)) || !f || !log) return false;
  if (!Number.isFinite(staleSeconds) || staleSeconds <= 0) return false;
  const pid = process.pid;
  const alive = stillUs(pid, start);
  const stale = Math.floor(staleSeconds);
  detach(
    `while ${alive}; do sleep 30;`
    + ` hb=$(stat -c%Y ${f} 2>/dev/null || echo 0);`
    + ' age=$(( $(date +%s) - hb ));'
    + ` if [ "$age" -gt ${stale} ]; then`
    + ` echo "=== $(date '+%F %T') watchdog: sem heartbeat há \${age}s, matando ${pid} ===" >> ${log};`
    + ` ${alive} && kill -9 ${pid}; exit; fi; done`
  );
  return true;
}

module.exports = { strayPids, procStart, killPidIn, killSelfIn, guardHeartbeat };
