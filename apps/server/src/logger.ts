import { createRequire } from 'node:module';
import type { FastifyBaseLogger } from 'fastify';
import { pino } from 'pino';

export type Logger = FastifyBaseLogger;

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

/** Pretty output in a terminal during development, JSON lines otherwise. */
export function loggerOptions(level: LogLevel) {
  const pretty =
    process.env['NODE_ENV'] !== 'production' && process.stdout.isTTY && prettyAvailable();
  return {
    level,
    redact: ['req.headers.authorization', 'req.headers.cookie', '*.password'],
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
}

export function createLogger(level: LogLevel = 'info'): Logger {
  return pino(loggerOptions(level));
}
