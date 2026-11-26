import { rmSync } from 'node:fs';

/**
 * Delete a temporary folder, best effort. On Windows a file the app still
 * holds open (its log, Chromium's own files) makes the delete fail; the
 * folder is in the system temp area, so leaving it is harmless, while
 * throwing would keep the app from exiting.
 */
export function removeTempDir(dir: string, rm: typeof rmSync = rmSync): void {
  try {
    rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Left for the system to clean up.
  }
}
