import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import type { Logger } from '../src/logger.js';

export function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

export const silentLogger: Logger = pino({ level: 'silent' });

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Walk top-level ISO-BMFF boxes. */
export function boxes(
  buf: Buffer,
  offset = 0,
  end = buf.length,
): { type: string; start: number; size: number }[] {
  const out = [];
  let o = offset;
  while (o + 8 <= end) {
    const size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    if (size < 8) break;
    out.push({ type, start: o, size });
    o += size;
  }
  return out;
}

/** Fails with a clear message if the promise hasn't settled within ms. */
export function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} still pending after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
