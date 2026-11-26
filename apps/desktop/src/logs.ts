import { chmodSync, closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

const LOG = 'homeview.log';
const OLD_LOG = 'homeview.old.log';

/** Move the log to homeview.old.log, replacing the one before, if it is over maxBytes. */
function rotateIfLarge(dir: string, maxBytes: number): boolean {
  const file = path.join(dir, LOG);
  try {
    if (statSync(file).size <= maxBytes) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  renameSync(file, path.join(dir, OLD_LOG));
  return true;
}

function createLogFile(file: string): void {
  closeSync(openSync(file, 'a', 0o600));
  chmodSync(file, 0o600);
}

/**
 * Get the log file ready in dir and return its path. The logs never take
 * more than about twice maxBytes: this file and one old one.
 */
export function openLogFile(dir: string, maxBytes = 5_000_000): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  rotateIfLarge(dir, maxBytes);
  const file = path.join(dir, LOG);
  createLogFile(file);
  return file;
}

/**
 * Check the log's size every so often while the app runs, which can be
 * weeks. Past maxBytes it rotates, and dest starts writing to a new file.
 */
export function keepLogSmall(
  dir: string,
  dest: { reopen(): void },
  maxBytes = 5_000_000,
  everyMs = 60_000,
): NodeJS.Timeout {
  return setInterval(() => {
    try {
      if (!rotateIfLarge(dir, maxBytes)) return;
      createLogFile(path.join(dir, LOG));
      dest.reopen();
    } catch {
      // Logging must never take the app down; try again next time.
    }
  }, everyMs).unref();
}
