import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '@kasa/shared';
import { buildApp, type ServerHooks } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { SettingsStore } from '../src/settings/store.js';
import { silentLogger, waitFor } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function build(hooks?: ServerHooks) {
  const dir = mkdtempSync(path.join(tmpdir(), 'homeview-update-routes-'));
  dirs.push(dir);
  const settings = new SettingsStore(dir);
  settings.save({ camera: { username: 'a@example.com', password: 'x', localOnly: false } });
  const config = loadConfig(
    {
      PORT: '0',
      HOST: '127.0.0.1',
      HTTPS: 'false',
      LOG_LEVEL: 'silent',
      KASA_SYNC_TIMEZONE: 'false',
      ALLOW_NO_PASSWORD: 'true',
      ALLOWED_CIDRS: '127.0.0.0/8,192.0.2.0/24',
    },
    settings.load(),
  );
  config.dataDir = dir;
  return buildApp({
    config,
    settings,
    logger: silentLogger,
    reload: async () => {},
    ...(hooks ? { hooks } : {}),
  });
}

const local = { remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:8090' } };
const lan = { remoteAddress: '192.0.2.50', headers: { host: '192.0.2.10:8090' } };

describe('update routes', () => {
  it('report the status from the desktop app', async () => {
    const status: UpdateStatus = { state: 'ready', version: '0.2.0' };
    const app = await build({ updateStatus: () => status });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/app/update', ...local });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(status);
    } finally {
      await app.close();
    }
  });

  it('install answers 202, then installs once', async () => {
    const installUpdate = vi.fn();
    const app = await build({ installUpdate });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/app/update/install', ...local });
      expect(res.statusCode).toBe(202);
      await waitFor(() => installUpdate.mock.calls.length > 0);
      expect(installUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('check answers with what it found', async () => {
    const app = await build({ checkForUpdates: async () => 'up-to-date' });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/app/update/check', ...local });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ result: 'up-to-date' });
    } finally {
      await app.close();
    }
  });

  it('refuse other computers on the network', async () => {
    const installUpdate = vi.fn();
    const app = await build({
      updateStatus: () => ({ state: 'none' }),
      installUpdate,
      checkForUpdates: async () => 'up-to-date',
    });
    try {
      for (const [method, url] of [
        ['GET', '/api/app/update'],
        ['POST', '/api/app/update/install'],
        ['POST', '/api/app/update/check'],
      ] as const) {
        const res = await app.inject({ method, url, ...lan });
        expect([url, res.statusCode]).toEqual([url, 403]);
      }
      expect(installUpdate).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('answer 404 outside the desktop app', async () => {
    const app = await build();
    try {
      for (const [method, url] of [
        ['GET', '/api/app/update'],
        ['POST', '/api/app/update/install'],
        ['POST', '/api/app/update/check'],
      ] as const) {
        const res = await app.inject({ method, url, ...local });
        expect([url, res.statusCode]).toEqual([url, 404]);
        expect(res.json()).toMatchObject({ error: 'not-available' });
      }
    } finally {
      await app.close();
    }
  });
});
