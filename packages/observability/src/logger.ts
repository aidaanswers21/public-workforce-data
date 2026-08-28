import pino from 'pino';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerOptions {
  name: string;
  level?: LogLevel;
  /** Static fields attached to every line (service, version, run id). */
  base?: Record<string, unknown>;
}

/**
 * Fields that must never reach the log stream, even by accident.
 *
 * Personal contact data is business data, not telemetry: it belongs in the
 * database with provenance, not in logs that get shipped to third parties.
 */
const REDACTED_PATHS = [
  'email',
  'emails',
  'address',
  'addressNormalized',
  'phone',
  'phonePublished',
  'apiKey',
  'api_key',
  'token',
  'password',
  'authorization',
  'secret',
  '*.email',
  '*.address',
  '*.apiKey',
  '*.token',
  '*.password',
  '*.authorization',
];

export type Logger = pino.Logger;

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    name: options.name,
    level: options.level ?? (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info',
    base: { service: options.name, ...options.base },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}

/** A logger that discards everything. Used in tests to keep output readable. */
export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
