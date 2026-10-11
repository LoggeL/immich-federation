const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function setLogLevel(level: string) {
  threshold = LEVELS[(level as Level) in LEVELS ? (level as Level) : 'info'];
}

const write = (level: Level, scope: string, message: string, extra?: unknown) => {
  if (LEVELS[level] < threshold) {
    return;
  }
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (extra !== undefined) {
    line += ' ' + (extra instanceof Error ? (extra.stack ?? extra.message) : safeJson(extra));
  }
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
};

const safeJson = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  };
}

/** Strip secrets (share keys, api keys, session keys) from a URL before logging it. */
export function redactUrl(url: string) {
  return url.replace(/([?&](?:key|slug|apiKey|sessionKey)=)[^&#]*/gi, '$1***');
}

/** Error message incl. the low-level cause (fetch() hides e.g. ECONNREFUSED in error.cause). */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code || cause?.message;
  return detail && !error.message.includes(detail) ? `${error.message} (${detail})` : error.message;
}
