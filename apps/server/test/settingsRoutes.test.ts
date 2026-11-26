import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SettingsResponse } from '@kasa/shared';
import { buildApp, type ServerHooks } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { hashPassword } from '../src/security/passwordHash.js';
import { startServer, type RunningServer } from '../src/server.js';
import { SettingsStore } from '../src/settings/store.js';
import { fixture, silentLogger, waitFor } from './helpers.js';

const USER = 'parent@example.com';
const PASS = 'correct horse';
const VIEWER = 'lullaby-time';
const NEW_VIEWER = 'a-better-lullaby';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kasa-settings-'));
  dirs.push(dir);
  return dir;
}

let fake: FakeCamera;
let env: Record<string, string>;

beforeAll(async () => {
  fake = new FakeCamera({
    username: USER,
    password: PASS,
    encoding: 'md5',
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 30),
  });
  const ports = await fake.start('127.0.0.1', 0, 0, 0);
  env = {
    PORT: '0',
    HOST: '127.0.0.1',
    HTTPS: 'false',
    LOG_LEVEL: 'silent',
    KASA_API_PORT: String(ports.apiPort),
    KASA_STREAM_PORT: String(ports.streamPort),
    KASA_SYNC_TIMEZONE: 'false',
    KASA_DISCOVERY_TARGETS: '127.0.0.1',
    KASA_DISCOVERY_PORT: String(ports.discoveryPort!),
  };
});

const running: RunningServer[] = [];
afterAll(async () => {
  for (const s of running) await s.stop();
  await fake.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function completeSettings(): Promise<SettingsStore> {
  const settings = new SettingsStore(tmp());
  settings.save({
    viewerPasswordHash: await hashPassword(VIEWER),
    camera: { username: USER, password: PASS, alias: 'fake nursery', localOnly: false },
  });
  return settings;
}

async function start(
  settings: SettingsStore,
  opts: { env?: Record<string, string>; hooks?: ServerHooks; desktop?: boolean } = {},
): Promise<RunningServer> {
  const s = await startServer({
    env: { ...env, ...opts.env },
    settings,
    dataDir: tmp(),
    logger: silentLogger,
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.desktop ? { desktop: true } : {}),
  });
  running.push(s);
  return s;
}

function send(
  s: RunningServer,
  method: string,
  url: string,
  body?: unknown,
  opts: { cookie?: string; origin?: string } = {},
) {
  return fetch(`${s.localUrl}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      origin: opts.origin ?? s.localUrl,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function cookieOf(res: Response): string {
  const header = res.headers.get('set-cookie');
  expect(header).toBeTruthy();
  return header!.split(';', 1)[0]!;
}

async function login(s: RunningServer, password = VIEWER): Promise<string> {
  const res = await send(s, 'POST', '/api/login', { password });
  expect(res.status).toBe(204);
  return cookieOf(res);
}

describe('GET /api/settings', () => {
  it('needs a session', async () => {
    const s = await start(await completeSettings());
    expect((await send(s, 'GET', '/api/settings')).status).toBe(401);
  });

  it('describes the settings and never returns a password', async () => {
    const settings = await completeSettings();
    const s = await start(settings);
    const cookie = await login(s);
    const res = await send(s, 'GET', '/api/settings', undefined, { cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PASS);
    expect(text).not.toContain('scrypt');
    expect(JSON.parse(text) as SettingsResponse).toEqual({
      camera: { kind: 'kasa', username: USER, alias: 'fake nursery', localOnly: false },
      local: true,
      desktop: false,
      autostart: null,
      version: null,
      managedByEnv: [],
    });
  });

  it('reports autostart from the hook and settings from the environment', async () => {
    const s = await start(await completeSettings(), {
      env: { KASA_USERNAME: USER, KASA_PASSWORD: PASS },
      hooks: { getAutostart: () => true, setAutostart: () => {}, appVersion: () => '0.1.1' },
      desktop: true,
    });
    const cookie = await login(s);
    const body = (await (
      await send(s, 'GET', '/api/settings', undefined, { cookie })
    ).json()) as SettingsResponse;
    expect(body).toMatchObject({
      desktop: true,
      autostart: true,
      version: '0.1.1',
      managedByEnv: ['camera'],
    });
  });

  it('names the viewer password when the environment sets it', async () => {
    const s = await start(await completeSettings(), { env: { VIEWER_PASSWORD: VIEWER } });
    const cookie = await login(s);
    const body = (await (
      await send(s, 'GET', '/api/settings', undefined, { cookie })
    ).json()) as SettingsResponse;
    expect(body.managedByEnv).toEqual(['viewerPassword']);
  });
});

describe('PUT /api/settings/viewer-password', () => {
  it('refuses a wrong current password and keeps the hash', async () => {
    const settings = await completeSettings();
    const before = settings.load().viewerPasswordHash;
    const s = await start(settings);
    const cookie = await login(s);
    const res = await send(
      s,
      'PUT',
      '/api/settings/viewer-password',
      { current: 'not-it-at-all', password: NEW_VIEWER },
      { cookie },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'wrong-password' });
    expect(settings.load().viewerPasswordHash).toBe(before);
  });

  it('refuses a short new password', async () => {
    const settings = await completeSettings();
    const before = settings.load().viewerPasswordHash;
    const s = await start(settings);
    const cookie = await login(s);
    const res = await send(
      s,
      'PUT',
      '/api/settings/viewer-password',
      { current: VIEWER, password: 'short' },
      { cookie },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'password-too-short' });
    expect(settings.load().viewerPasswordHash).toBe(before);
  });

  it('keeps the caller signed in and signs out older cookies', async () => {
    const settings = await completeSettings();
    const s = await start(settings);
    const old = await login(s);
    const res = await send(
      s,
      'PUT',
      '/api/settings/viewer-password',
      { current: VIEWER, password: NEW_VIEWER },
      { cookie: old },
    );
    expect(res.status).toBe(204);
    const fresh = cookieOf(res);
    expect(settings.load().viewerPasswordHash).toMatch(/^scrypt\$/);
    // The reply comes once the new settings are in use: no waiting needed.
    expect((await send(s, 'GET', '/api/settings', undefined, { cookie: old })).status).toBe(401);
    expect((await send(s, 'GET', '/api/settings', undefined, { cookie: fresh })).status).toBe(200);
    expect((await send(s, 'POST', '/api/login', { password: NEW_VIEWER })).status).toBe(204);
  });

  it('refuses a cross-site request and keeps the hash', async () => {
    const settings = await completeSettings();
    const before = settings.load().viewerPasswordHash;
    const s = await start(settings);
    const cookie = await login(s);
    const res = await send(
      s,
      'PUT',
      '/api/settings/viewer-password',
      { current: VIEWER, password: NEW_VIEWER },
      { cookie, origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
    expect(settings.load().viewerPasswordHash).toBe(before);
  });

  it('answers 409 when the environment sets the password', async () => {
    const settings = await completeSettings();
    const before = settings.load().viewerPasswordHash;
    const s = await start(settings, { env: { VIEWER_PASSWORD: VIEWER } });
    const cookie = await login(s);
    const res = await send(
      s,
      'PUT',
      '/api/settings/viewer-password',
      { current: VIEWER, password: NEW_VIEWER },
      { cookie },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'password-from-env' });
    expect(settings.load().viewerPasswordHash).toBe(before);
  });
});

describe('PUT /api/settings/camera', () => {
  it('saves a working login and keeps the alias choice', async () => {
    const settings = await completeSettings();
    const s = await start(settings);
    const cookie = await login(s);
    const res = await send(
      s,
      'PUT',
      '/api/settings/camera',
      { username: USER, password: PASS },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ saved: { host: '127.0.0.1' } });
    expect(settings.load().camera).toMatchObject({ username: USER, password: PASS });
  });

  it('uses the setup messages for a wrong login and changes nothing', async () => {
    const settings = await completeSettings();
    const s = await start(settings);
    const cookie = await login(s);
    const res = await send(
      s,
      'PUT',
      '/api/settings/camera',
      { username: USER, password: 'nope' },
      { cookie },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'wrong-login' });
    expect(settings.load().camera?.password).toBe(PASS);
  });

  it('answers 409 when the environment sets the login', async () => {
    const settings = await completeSettings();
    const s = await start(settings, { env: { KASA_USERNAME: USER, KASA_PASSWORD: PASS } });
    const cookie = await login(s);
    const res = await send(
      s,
      'PUT',
      '/api/settings/camera',
      { username: USER, password: PASS },
      { cookie },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'camera-from-env' });
  });

  it('refuses a cross-site request', async () => {
    const settings = await completeSettings();
    const s = await start(settings);
    const cookie = await login(s);
    const res = await send(
      s,
      'PUT',
      '/api/settings/camera',
      { username: USER, password: 'x' },
      { cookie, origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
  });
});

describe('app routes', () => {
  it('answer 404 without the hooks', async () => {
    const s = await start(await completeSettings());
    const cookie = await login(s);
    const a = await send(s, 'PUT', '/api/app/autostart', { enabled: true }, { cookie });
    expect(a.status).toBe(404);
    const q = await send(s, 'POST', '/api/app/quit', undefined, { cookie });
    expect(q.status).toBe(404);
  });

  it('turn autostart on and quit once after replying', async () => {
    const setAutostart = vi.fn();
    const quit = vi.fn();
    const s = await start(await completeSettings(), { hooks: { setAutostart, quit } });
    const cookie = await login(s);
    const a = await send(s, 'PUT', '/api/app/autostart', { enabled: true }, { cookie });
    expect(a.status).toBe(204);
    expect(setAutostart).toHaveBeenCalledWith(true);
    const q = await send(s, 'POST', '/api/app/quit', undefined, { cookie });
    expect(q.status).toBe(204);
    await waitFor(() => quit.mock.calls.length > 0);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('refuse other computers', async () => {
    const settings = new SettingsStore(tmp());
    settings.save({
      camera: { username: USER, password: PASS, localOnly: false },
    });
    const config = loadConfig(
      { ...env, ALLOW_NO_PASSWORD: 'true', ALLOWED_CIDRS: '127.0.0.0/8,192.168.0.0/16' },
      settings.load(),
    );
    config.dataDir = tmp();
    const setAutostart = vi.fn();
    const quit = vi.fn();
    const app = await buildApp({
      config,
      settings,
      logger: silentLogger,
      reload: async () => {},
      hooks: { setAutostart, quit },
    });
    try {
      const headers = { host: '192.168.1.10:8090' };
      const a = await app.inject({
        method: 'PUT',
        url: '/api/app/autostart',
        remoteAddress: '192.168.1.50',
        headers,
        payload: { enabled: true },
      });
      expect(a.statusCode).toBe(403);
      const q = await app.inject({
        method: 'POST',
        url: '/api/app/quit',
        remoteAddress: '192.168.1.50',
        headers,
      });
      expect(q.statusCode).toBe(403);
      expect(setAutostart).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/session lanUrl', () => {
  it('gives the phone address to this computer only', async () => {
    const settings = new SettingsStore(tmp());
    settings.save({ camera: { username: USER, password: PASS, localOnly: false } });
    const config = loadConfig(
      { ...env, ALLOW_NO_PASSWORD: 'true', ALLOWED_CIDRS: '127.0.0.0/8,192.168.0.0/16' },
      settings.load(),
    );
    config.dataDir = tmp();
    const lanUrl = 'https://192.168.1.10:8090';
    const app = await buildApp({
      config,
      settings,
      logger: silentLogger,
      reload: async () => {},
      lanUrl: () => lanUrl,
    });
    try {
      const headers = { host: '192.168.1.10:8090' };
      const local = await app.inject({ url: '/api/session', remoteAddress: '127.0.0.1', headers });
      expect(local.json()).toMatchObject({ local: true, lanUrl });
      // A forged forwarding header changes nothing: only the socket peer counts.
      const other = await app.inject({
        url: '/api/session',
        remoteAddress: '192.168.1.50',
        headers: { ...headers, 'x-forwarded-for': '127.0.0.1' },
      });
      expect(other.json()).toMatchObject({ local: false });
      expect(other.json()).not.toHaveProperty('lanUrl');
    } finally {
      await app.close();
    }
  });

  it('leaves lanUrl out when the computer has no LAN address', async () => {
    const settings = new SettingsStore(tmp());
    settings.save({ camera: { username: USER, password: PASS, localOnly: false } });
    const config = loadConfig({ ...env, ALLOW_NO_PASSWORD: 'true' }, settings.load());
    config.dataDir = tmp();
    const app = await buildApp({
      config,
      settings,
      logger: silentLogger,
      reload: async () => {},
      lanUrl: () => undefined,
    });
    try {
      const res = await app.inject({
        url: '/api/session',
        remoteAddress: '127.0.0.1',
        headers: { host: 'localhost:8090' },
      });
      expect(res.json()).not.toHaveProperty('lanUrl');
    } finally {
      await app.close();
    }
  });
});
