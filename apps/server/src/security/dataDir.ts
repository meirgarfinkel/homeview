import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The data directory holds generated secrets (TLS key, session secret).
 * It is created owner-only (0700) and every file in it is 0600.
 */
export function ensureDataDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export function writePrivateFile(file: string, contents: string): void {
  writeFileSync(file, contents, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Read a random secret from `name`, creating it on first use. */
export function loadOrCreateSecret(dir: string, name: string, bytes = 32): string {
  const file = path.join(ensureDataDir(dir), name);
  if (existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim();
    if (value.length >= 32) return value;
  }
  const value = randomBytes(bytes).toString('hex');
  writePrivateFile(file, `${value}\n`);
  return value;
}
