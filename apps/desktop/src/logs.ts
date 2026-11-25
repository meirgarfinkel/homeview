import { chmodSync, closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Get the log file ready in dir and return its path. A log over maxBytes is
 * moved to kasa-home.old.log, replacing the one before, so the logs never
 * take more than about twice maxBytes.
 */
export function openLogFile(dir: string, maxBytes = 5_000_000): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = path.join(dir, 'kasa-home.log');
  try {
    if (statSync(file).size > maxBytes) renameSync(file, path.join(dir, 'kasa-home.old.log'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  closeSync(openSync(file, 'a', 0o600));
  chmodSync(file, 0o600);
  return file;
}
