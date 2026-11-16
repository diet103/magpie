// Structured JSON logs on stdout. Never pass tokens, codes, tool arguments or raw text in here.
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = (process.env.LOG_LEVEL as Level) || 'info';
let silent = (process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT)) && !process.env.TEST_LOGS;

export function setLogLevel(level: Level) {
  threshold = level;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (silent || order[level] < order[threshold]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f),
};

export function errorFields(err: unknown) {
  if (err instanceof Error) {
    // "fetch failed" says nothing by itself; the reason (a refused connection, a TLS failure) is in its cause.
    const cause = err.cause instanceof Error ? ((err.cause as Error & { code?: string }).code ?? err.cause.message) : undefined;
    return { error: err.message, ...(cause ? { cause } : {}), stack: err.stack?.split('\n').slice(0, 4).join(' | ') };
  }
  return { error: String(err) };
}
