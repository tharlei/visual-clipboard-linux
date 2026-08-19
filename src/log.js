'use strict';

const pkg = require('../package.json');

/** Local timestamp with milliseconds, for the launch.log line prefix. */
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

for (const [name, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERRO']]) {
  const orig = console[name].bind(console);
  console[name] = (...args) => orig(`${stamp()} ${level} ${process.pid}`, ...args);
}

/** Logs the one line that identifies this run: version, Electron, sandbox, supervisor, session. */
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
