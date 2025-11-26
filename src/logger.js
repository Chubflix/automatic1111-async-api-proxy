// Lightweight debug logger with named scopes.
// Usage: const log = require('./logger')('worker'); log.debug('message');
// Controlled via env DEBUG. Examples:
//   DEBUG=*           -> enable all debug/info
//   DEBUG=worker      -> enable only worker scope
//   DEBUG=server,db   -> enable server and db scopes

function parseDebugEnv() {
  const raw = process.env.DEBUG || '';
  const set = new Set();
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    set.add(part);
  }
  return set;
}

const enabled = parseDebugEnv();
const enableAll = enabled.has('*');

function fmt(scope, level, msg) {
  const ts = new Date().toISOString();
  return `${ts} [${scope}] ${level.toUpperCase()}: ${msg}`;
}

function stringify(arg) {
  if (arg instanceof Error) {
    return arg.stack || `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === 'object') {
    try { return JSON.stringify(arg); } catch (_e) { return String(arg); }
  }
  return String(arg);
}

module.exports = function createLogger(scope) {
  const name = String(scope || 'app');
  const isEnabled = enableAll || enabled.has(name);

  return {
    debug: (...args) => {
      if (!isEnabled) return;
      const msg = args.map(stringify).join(' ');
      process.stdout.write(fmt(name, 'debug', msg) + '\n');
    },
    info: (...args) => {
      if (!isEnabled) return;
      const msg = args.map(stringify).join(' ');
      process.stdout.write(fmt(name, 'info', msg) + '\n');
    },
    warn: (...args) => {
      const msg = args.map(stringify).join(' ');
      process.stderr.write(fmt(name, 'warn', msg) + '\n');
    },
    error: (...args) => {
      const msg = args.map(stringify).join(' ');
      process.stderr.write(fmt(name, 'error', msg) + '\n');
    },
  };
};
