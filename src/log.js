'use strict';

const pkg = require('../package.json');

// launch.log interleaves our lines with Chromium's, which carry their own timestamps. Ours
// carried none, so a whole session read as "boot, nothing, FATAL" with no way to tell five
// seconds from five hours — the reason no freeze was ever diagnosable. Patching console once
// stamps every existing [clp] call site instead of touching thirty of them.
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// the pid is not decoration: a supervisor respawn, a duplicate that refused to die, and the
// instance that replaced it all append to the same launch.log. Chromium stamps its own lines
// with a pid; ours did not, so two instances read as one contradictory app.
for (const [name, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERRO']]) {
  const orig = console[name].bind(console);
  console[name] = (...args) => orig(`${stamp()} ${level} ${process.pid}`, ...args);
}

// no rotation here on purpose: stdout is an fd the launcher opened with `>>`, so renaming
// the file would leave this process appending to the renamed inode. The shell rotates.
function bootLine() {
  console.log('[clp] boot', [
    `pid=${process.pid}`,
    `app=${pkg.version}`,
    `electron=${process.versions.electron}`,
    `chrome=${process.versions.chrome}`,
    `sandbox=${process.argv.includes('--no-sandbox') ? 'off' : 'on'}`,
    `supervisor=${process.env.CLP_SUPERVISED ? 'on' : 'off'}`,
    `sessao=${process.env.XDG_SESSION_TYPE || '?'}/${process.env.XDG_CURRENT_DESKTOP || '?'}`,
    `argv=[${process.argv.slice(1).join(' ')}]`,
  ].join(' '));
}

module.exports = { bootLine };
