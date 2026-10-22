/**
 * Structured JSON logging. One JSON object per line so container log
 * collectors (docker logs / Loki / cloudwatch-agent) can parse levels and
 * fields without a regex.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const SERVICE = 'commerce-os';

function write(level: LogLevel, message: string, fields?: LogFields): void {
  const record = {
    time: new Date().toISOString(),
    level,
    service: SERVICE,
    msg: message,
    ...(fields ? fields : {}),
  };
  const line = `${JSON.stringify(record)}\n`;
  if (level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}

/** Default process-wide logger; safe to share across modules. */
export const logger: Logger = {
  debug: (message, fields) => write('debug', message, fields),
  info: (message, fields) => write('info', message, fields),
  warn: (message, fields) => write('warn', message, fields),
  error: (message, fields) => write('error', message, fields),
};
