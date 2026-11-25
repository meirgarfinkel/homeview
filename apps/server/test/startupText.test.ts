import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PortsInUseError, startServer } from '../src/server.js';
import { SettingsStore } from '../src/settings/store.js';
import { notSetUpText, terminalErrorText } from '../src/startupText.js';

const dir = mkdtempSync(path.join(tmpdir(), 'kasa-startup-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('when every port is taken', () => {
  it('says so without terminal advice, and pnpm start adds the PORT hint', async () => {
    // The last ten ports. One another program already holds counts as taken too.
    const first = 65526;
    const blockers: net.Server[] = [];
    for (let port = first; port <= 65535; port++) {
      const b = net.createServer();
      await new Promise<void>((resolve) => {
        b.once('error', () => resolve());
        b.listen(port, '127.0.0.1', () => {
          blockers.push(b);
          resolve();
        });
      });
    }
    try {
      const err = await startServer({
        env: { PORT: String(first), HOST: '127.0.0.1', HTTPS: 'false', LOG_LEVEL: 'silent' },
        settings: new SettingsStore(dir),
        dataDir: dir,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PortsInUseError);
      const message = (err as Error).message;
      // The desktop app shows this in a dialog.
      expect(message).toBe('Ports 65526 to 65535 are in use. Close the program using them.');
      expect(message).not.toMatch(/PORT|\.env/);
      expect(terminalErrorText(err)).toMatch(/set PORT in \.env to a free port/);
    } finally {
      for (const b of blockers) b.close();
    }
  });
});

describe('notSetUpText', () => {
  it('names both ways forward', () => {
    const text = notSetUpText('http://localhost:8090');
    expect(text).toContain('http://localhost:8090');
    expect(text).toMatch(/VIEWER_PASSWORD/);
    expect(text).toMatch(/KASA_USERNAME and KASA_PASSWORD/);
    expect(text.split('\n')).toHaveLength(1);
  });
});
