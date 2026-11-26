import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, vi } from 'vitest';
import type * as ConfigModule from '../../src/config.js';

/**
 * Every server test serves a small built web app, as the desktop app always
 * does. Without this the tests would serve static files only when someone
 * had run the web build, and bugs that need them would hide.
 */
export const TEST_PAGE_MARKER = 'homeview-test-page';

const root = mkdtempSync(path.join(tmpdir(), 'kasa-static-'));
mkdirSync(path.join(root, 'assets'));
writeFileSync(
  path.join(root, 'index.html'),
  `<!doctype html><title>${TEST_PAGE_MARKER}</title><script type="module" src="/assets/app.js"></script>`,
);
writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("kasa home");\n');
writeFileSync(path.join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

afterAll(() => rmSync(root, { recursive: true, force: true }));

// Use it unless a test sets STATIC_DIR or passes staticDir itself.
vi.mock('../../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModule>();
  return {
    ...real,
    loadConfig: (...args: Parameters<typeof real.loadConfig>) => {
      const config = real.loadConfig(...args);
      if (!(args[0] ?? process.env).STATIC_DIR) config.staticDir = root;
      return config;
    },
  };
});
