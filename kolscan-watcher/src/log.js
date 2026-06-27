// Basit zaman damgalı logger.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.KOLSCAN_LOG_LEVEL] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const tag = `[${ts()}] ${level.toUpperCase().padEnd(5)} ${scope ? `(${scope}) ` : ''}`;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(tag + args.map(fmt).join(' '));
}

function fmt(a) {
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

export function makeLogger(scope) {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
  };
}

export const log = makeLogger('');
