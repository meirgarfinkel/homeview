import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { app } from 'electron';
import { pino } from 'pino';
import { startServer, type RunningServer } from '../../server/src/server.js';
import { SettingsStore } from '../../server/src/settings/store.js';
import { openLogFile } from './logs.js';
import { safeStorageProtector } from './protector.js';
import { removeTempDir } from './tempDir.js';

/**
 * Check that the built app can run the server: start it on a fresh data
 * folder and a free port, and ask it for its health and session. Prints
 * SELF-TEST OK and returns 0, or prints the error and returns 1. Also runs
 * the tunnel helper with --version, never with a secret.
 */
export async function runSelfTest(staticDir: string, tunnel: string | undefined): Promise<number> {
  const dir = mkdtempSync(path.join(tmpdir(), 'kasa-home-self-test-'));
  app.setPath('userData', dir);
  let server: RunningServer | undefined;
  try {
    await app.whenReady();
    if (!tunnel) throw new Error('The tunnel helper is missing');
    const { stdout } = await promisify(execFile)(tunnel, ['--version'], { timeout: 10_000 });
    if (!stdout.startsWith('kasa-tunnel ')) {
      throw new Error(`The tunnel helper printed ${JSON.stringify(stdout)} for --version`);
    }
    const logger = pino(
      { level: 'info' },
      pino.destination({ dest: openLogFile(dir), sync: true }),
    );
    server = await startServer({
      // PORT 0 takes any free port, so a running Kasa Home is left alone.
      env: { LOG_LEVEL: 'info', PORT: '0', HOST: '127.0.0.1' },
      settings: new SettingsStore(dir, safeStorageProtector()),
      dataDir: dir,
      staticDir,
      logger,
      desktop: true,
    });

    const health = await fetch(`${server.localUrl}/api/health`);
    if (health.status !== 200) throw new Error(`/api/health answered ${health.status}`);
    const session = (await (await fetch(`${server.localUrl}/api/session`)).json()) as {
      setupComplete?: unknown;
    };
    if (session.setupComplete !== false) {
      throw new Error(`/api/session gave setupComplete ${String(session.setupComplete)}`);
    }
    const page = await fetch(`${server.localUrl}/`);
    if (page.status !== 200) throw new Error(`The web page answered ${page.status}`);

    console.log('SELF-TEST OK');
    return 0;
  } catch (err) {
    console.error('SELF-TEST FAILED:', err);
    return 1;
  } finally {
    await server?.stop().catch(() => undefined);
    removeTempDir(dir);
  }
}
