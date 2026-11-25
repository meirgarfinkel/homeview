import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OnboardingStatus, SetupExistingResult } from '@kasa/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { hashPassword } from '../src/security/passwordHash.js';
import { startServer, type RunningServer } from '../src/server.js';
import type { WifiSwitcher } from '../src/setup/wifiSwitcher.js';
import { SettingsStore } from '../src/settings/store.js';
import { fixture, silentLogger, waitFor } from './helpers.js';

const USER = 'parent@example.com';
const PASS = 'correct horse';
const VIEWER = 'lullaby-time';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kasa-setup-'));
  dirs.push(dir);
  return dir;
}

function newFake(alias?: string): FakeCamera {
  return new FakeCamera({
    username: USER,
    password: PASS,
    encoding: 'md5',
    ...(alias ? { alias } : {}),
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 30),
  });
}

let fake: FakeCamera;
let ports: { apiPort: number; streamPort: number; discoveryPort: number };
let env: Record<string, string>;

beforeAll(async () => {
  fake = newFake();
  const started = await fake.start('127.0.0.1', 0, 0, 0);
  ports = { ...started, discoveryPort: started.discoveryPort! };
  env = {
    PORT: '0',
    HOST: '127.0.0.1',
    HTTPS: 'false',
    LOG_LEVEL: 'silent',
    KASA_API_PORT: String(ports.apiPort),
    KASA_STREAM_PORT: String(ports.streamPort),
    KASA_SYNC_TIMEZONE: 'false',
    KASA_DISCOVERY_TARGETS: '127.0.0.1',
    KASA_DISCOVERY_PORT: String(ports.discoveryPort),
  };
});

afterAll(async () => {
  await fake.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const running: RunningServer[] = [];
afterAll(async () => {
  for (const s of running) await s.stop();
});

async function start(
  settings = new SettingsStore(tmp()),
  extra: Record<string, string> = {},
): Promise<RunningServer> {
  const s = await startServer({
    env: { ...env, ...extra },
    settings,
    dataDir: tmp(),
    logger: silentLogger,
  });
  running.push(s);
  return s;
}

/** Settings for a finished setup: a viewer password and the fake camera's login. */
async function completeSettings(): Promise<SettingsStore> {
  const settings = new SettingsStore(tmp());
  settings.save({
    viewerPasswordHash: await hashPassword(VIEWER),
    camera: { username: USER, password: PASS, alias: 'fake nursery', localOnly: false },
  });
  return settings;
}

function post(
  s: RunningServer,
  url: string,
  body: unknown,
  opts: { cookie?: string; origin?: string } = {},
) {
  return fetch(`${s.localUrl}${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: opts.origin ?? s.localUrl,
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(s: RunningServer, url: string, cookie?: string) {
  return fetch(`${s.localUrl}${url}`, { headers: cookie ? { cookie } : {} });
}

function cookieOf(res: Response): string {
  const header = res.headers.get('set-cookie');
  expect(header).toBeTruthy();
  return header!.split(';', 1)[0]!;
}

async function login(s: RunningServer, password: string): Promise<string> {
  const res = await post(s, '/api/login', { password });
  expect(res.status).toBe(204);
  return cookieOf(res);
}

/** An app built directly, so requests can come from another computer's address. */
async function injectable(settings: SettingsStore) {
  const config = loadConfig(
    { ...env, ALLOWED_CIDRS: '127.0.0.0/8,192.168.0.0/16' },
    settings.load(),
  );
  config.dataDir = tmp();
  const app = await buildApp({ config, settings, logger: silentLogger, reload: async () => {} });
  const fromLan = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      remoteAddress: '192.168.1.50',
      headers: { host: '192.168.1.10:8090' },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  return { app, fromLan };
}

describe('setup gate', () => {
  it('refuses setup to anyone but this computer', async () => {
    const settings = new SettingsStore(tmp());
    const { app, fromLan } = await injectable(settings);
    try {
      const res = await fromLan('POST', '/api/setup/password', { password: VIEWER });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'not-set-up' });
      const camera = await fromLan('POST', '/api/setup/existing-camera', {
        username: USER,
        password: PASS,
      });
      expect(camera.statusCode).toBe(403);
      expect(settings.load()).toEqual({});
    } finally {
      await app.close();
    }
  });

  it('answers only health and session to other computers before setup', async () => {
    const { app, fromLan } = await injectable(new SettingsStore(tmp()));
    try {
      expect((await fromLan('GET', '/api/health')).statusCode).toBe(200);
      const session = await fromLan('GET', '/api/session');
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ setupComplete: false, local: false });
      for (const url of ['/api/camera', '/api/status', '/api/ptz/presets', '/api/live']) {
        const res = await fromLan('GET', url);
        expect(res.statusCode, url).toBe(403);
        expect(res.json(), url).toMatchObject({ error: 'not-set-up' });
      }
      const loginRes = await fromLan('POST', '/api/login', { password: VIEWER });
      expect(loginRes.statusCode).toBe(403);
      expect(loginRes.json()).toMatchObject({ error: 'not-set-up' });
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/setup/password', () => {
  it('saves a hashed viewer password and signs this computer in', async () => {
    const settings = new SettingsStore(tmp());
    const s = await start(settings);
    const res = await post(s, '/api/setup/password', { password: VIEWER });
    expect(res.status).toBe(204);
    const cookie = cookieOf(res);
    const hash = settings.load().viewerPasswordHash;
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain(VIEWER);

    const camera = await post(s, '/api/setup/existing-camera', { username: USER, password: PASS });
    expect(camera.status).toBe(200);
    await waitFor(() => s.setupComplete(), 10_000);
    const status = await get(s, '/api/status', cookie);
    expect(status.status).toBe(200);
  });

  it('rejects a short viewer password', async () => {
    const settings = new SettingsStore(tmp());
    const s = await start(settings);
    const res = await post(s, '/api/setup/password', { password: 'short' });
    expect(res.status).toBe(400);
    expect(settings.load().viewerPasswordHash).toBeUndefined();
  });
});

describe('POST /api/setup/existing-camera', () => {
  it('connects an existing camera and finishes setup', async () => {
    const settings = new SettingsStore(tmp());
    const s = await start(settings);
    const cookie = cookieOf(await post(s, '/api/setup/password', { password: VIEWER }));
    const res = await post(s, '/api/setup/existing-camera', { username: USER, password: PASS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SetupExistingResult;
    expect(body).toEqual({
      saved: { alias: 'fake nursery', model: 'KC410S(US)', host: '127.0.0.1' },
    });
    expect(settings.load().camera).toEqual({
      username: USER,
      password: PASS,
      alias: 'fake nursery',
      localOnly: false,
    });
    await waitFor(() => s.setupComplete(), 10_000);
    const session = await get(s, '/api/session', cookie).then((r) => r.json());
    expect(session).toMatchObject({ setupComplete: true, authenticated: true });
    const camera = await get(s, '/api/camera', cookie);
    expect(camera.status).toBe(200);
    expect(await camera.json()).toMatchObject({ alias: 'fake nursery' });
  });

  it('reports a wrong Kasa password and saves nothing', async () => {
    const settings = new SettingsStore(tmp());
    const s = await start(settings);
    const res = await post(s, '/api/setup/existing-camera', {
      username: USER,
      password: 'not the password',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'wrong-login',
      message:
        'The camera did not accept that email and password. Check they are the ones you use in the Kasa app.',
    });
    expect(settings.load().camera).toBeUndefined();
  });

  it('reports when no camera answers', async () => {
    const gone = newFake();
    const { discoveryPort } = await gone.start('127.0.0.1', 0, 0, 0);
    await gone.stop();
    const settings = new SettingsStore(tmp());
    const s = await start(settings, { KASA_DISCOVERY_PORT: String(discoveryPort) });
    const res = await post(s, '/api/setup/existing-camera', { username: USER, password: PASS });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: 'no-camera',
      message:
        'No Kasa camera answered on this network. Check it is plugged in and on the same Wi-Fi as this computer.',
    });
    expect(settings.load().camera).toBeUndefined();
  });

  it('asks which camera when several accept the login, then saves the chosen one', async () => {
    // A second camera on another loopback address, same ports.
    const second = newFake('fake playroom');
    await second.start('127.0.0.2', 0, ports.apiPort, ports.discoveryPort);
    try {
      const settings = new SettingsStore(tmp());
      const s = await start(settings, { KASA_DISCOVERY_TARGETS: '127.0.0.1,127.0.0.2' });
      const res = await post(s, '/api/setup/existing-camera', { username: USER, password: PASS });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choose: { alias: string; host: string }[] };
      expect(body.choose.map((c) => c.alias).sort()).toEqual(['fake nursery', 'fake playroom']);
      expect(settings.load().camera).toBeUndefined();

      const chosen = await post(s, '/api/setup/existing-camera', {
        username: USER,
        password: PASS,
        alias: 'fake playroom',
      });
      expect(chosen.status).toBe(200);
      expect(await chosen.json()).toEqual({
        saved: { alias: 'fake playroom', model: 'KC410S(US)', host: '127.0.0.2' },
      });
      expect(settings.load().camera?.alias).toBe('fake playroom');
    } finally {
      await second.stop();
    }
  });
});

describe('POST /api/setup/reset-password', () => {
  it('lets this computer reset a forgotten viewer password, nobody else', async () => {
    const settings = await completeSettings();
    const { app, fromLan } = await injectable(settings);
    try {
      const res = await fromLan('POST', '/api/setup/reset-password', { password: 'new password' });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }

    const s = await start(settings);
    expect(s.setupComplete()).toBe(true);
    const oldCookie = await login(s, VIEWER);
    expect((await get(s, '/api/status', oldCookie)).status).toBe(200);

    const reset = await post(s, '/api/setup/reset-password', { password: 'new password' });
    expect(reset.status).toBe(204);
    const newCookie = cookieOf(reset);
    // The old cookie stops working once the new settings are in use.
    for (let i = 0; i < 100; i++) {
      if ((await get(s, '/api/status', oldCookie)).status === 401) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect((await get(s, '/api/status', oldCookie)).status).toBe(401);
    expect((await get(s, '/api/status', newCookie)).status).toBe(200);
    expect((await post(s, '/api/login', { password: VIEWER })).status).toBe(401);
    expect((await post(s, '/api/login', { password: 'new password' })).status).toBe(204);
  });

  it('refuses a reset sent from another website', async () => {
    const settings = await completeSettings();
    const before = settings.load().viewerPasswordHash;
    const s = await start(settings);
    const res = await post(
      s,
      '/api/setup/reset-password',
      { password: 'new password' },
      { origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
    expect(settings.load().viewerPasswordHash).toBe(before);
  });
});

describe('after setup is complete', () => {
  it('closes the setup endpoints once setup is complete', async () => {
    const settings = await completeSettings();
    const before = settings.load();
    const s = await start(settings);
    const password = await post(s, '/api/setup/password', { password: 'another password' });
    expect(password.status).toBe(409);
    const camera = await post(s, '/api/setup/existing-camera', { username: USER, password: PASS });
    expect(camera.status).toBe(409);
    expect(settings.load()).toEqual(before);
  });
});

describe('camera onboarding routes', () => {
  const NETWORKS = [{ ssid: 'HomeNet', rssi: -60, wpa_mode: 'WPA2_PSK', encryption: 'AES' }];
  const quick = {
    timeouts: { cameraWifiMs: 3000, homeMs: 3000, pollMs: 50, scanSettleMs: 0 },
    timeZone: 'Asia/Tokyo',
    discovery: { timeoutMs: 100 },
  };

  let setupFake: FakeCamera;
  let setupEnv: Record<string, string>;
  const switcher = (): WifiSwitcher & { returnHome: ReturnType<typeof vi.fn> } => ({
    auto: true,
    joinCameraNetwork: async () => 'Kasa_Cam_TEST',
    returnHome: vi.fn(async () => {}),
  });

  async function startSetupFake(login = { username: 'admin', password: 'admin' }) {
    const f = new FakeCamera({
      username: USER,
      password: PASS,
      encoding: 'md5',
      video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 30),
      setupMode: { login: { ...login, encoding: 'base64' }, networks: NETWORKS },
    });
    const p = await f.start('127.0.0.1', 0, 0, 0);
    return {
      f,
      env: {
        ...env,
        KASA_API_PORT: String(p.apiPort),
        KASA_STREAM_PORT: String(p.streamPort),
        KASA_DISCOVERY_PORT: String(p.discoveryPort),
      },
    };
  }

  beforeAll(async () => {
    const started = await startSetupFake();
    setupFake = started.f;
    setupEnv = started.env;
  });
  afterAll(async () => {
    await setupFake.stop();
  });

  async function startOnboardable(settings = new SettingsStore(tmp()), e = setupEnv) {
    const sw = switcher();
    const s = await startServer({
      env: e,
      settings,
      dataDir: tmp(),
      logger: silentLogger,
      createSwitcher: async () => sw,
      onboardingOverrides: quick,
    });
    running.push(s);
    return { s, sw };
  }

  const send = (s: RunningServer, method: string, url: string, body?: unknown, cookie?: string) =>
    fetch(`${s.localUrl}${url}`, {
      method,
      headers: {
        origin: s.localUrl,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const status = async (s: RunningServer, cookie?: string) =>
    (await (
      await send(s, 'GET', '/api/setup/onboarding', undefined, cookie)
    ).json()) as OnboardingStatus;

  const waitForPhase = async (s: RunningServer, phase: string, cookie?: string) => {
    const end = Date.now() + 15_000;
    while ((await status(s, cookie)).phase !== phase) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${phase}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('runs a camera through the routes and finishes setup', async () => {
    const settings = new SettingsStore(tmp());
    const { s, sw } = await startOnboardable(settings);
    expect((await send(s, 'GET', '/api/setup/onboarding')).status).toBe(404);

    const pw = await post(s, '/api/setup/password', { password: VIEWER });
    const cookie = cookieOf(pw);
    const hash = settings.load().viewerPasswordHash;

    const started = await post(s, '/api/setup/onboarding', { mode: 'local' }, { cookie });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ phase: 'reset-camera', autoWifi: true });
    await post(s, '/api/setup/onboarding/answer', { type: 'camera-reset' }, { cookie });
    await waitForPhase(s, 'choose-wifi', cookie);
    const chosen = await post(
      s,
      '/api/setup/onboarding/answer',
      { type: 'wifi', ssid: 'HomeNet', passphrase: 'wifi-secret', alias: 'nursery' },
      { cookie },
    );
    expect(chosen.status).toBe(200);
    await waitForPhase(s, 'done', cookie);

    expect(settings.load().camera).toMatchObject({ alias: 'nursery', localOnly: true });
    expect(settings.load().viewerPasswordHash).toBe(hash);
    expect(sw.returnHome).toHaveBeenCalled();
    await waitFor(() => s.setupComplete(), 10_000);
    const session = await get(s, '/api/session', cookie).then((r) => r.json());
    expect(session).toMatchObject({ setupComplete: true, authenticated: true });
  });

  it('refuses a computer that is not this one', async () => {
    const settings = new SettingsStore(tmp());
    const { app, fromLan } = await injectable(settings);
    try {
      const res = await fromLan('POST', '/api/setup/onboarding', { mode: 'local' });
      expect(res.statusCode).toBe(403);
      expect((await fromLan('GET', '/api/setup/onboarding')).statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('needs account details to link before setup, and rejects a bad mode', async () => {
    const { s } = await startOnboardable();
    expect((await post(s, '/api/setup/onboarding', { mode: 'account' })).status).toBe(400);
    expect((await post(s, '/api/setup/onboarding', { mode: 'other' })).status).toBe(400);
    expect((await send(s, 'GET', '/api/setup/onboarding')).status).toBe(404);
  });

  it('says 409 wrong-step for an answer the job is not waiting for', async () => {
    const { s } = await startOnboardable();
    await post(s, '/api/setup/onboarding', { mode: 'local' });
    const res = await post(s, '/api/setup/onboarding/answer', {
      type: 'wifi',
      ssid: 'HomeNet',
      passphrase: 'x',
      alias: 'a',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'wrong-step' });
    const none = await post(s, '/api/setup/onboarding/answer', { type: 'retry' });
    expect(none.status).toBe(409);
  });

  it('answers 409 when a job is already running, and 404 for an answer with no job', async () => {
    const { s } = await startOnboardable();
    expect((await post(s, '/api/setup/onboarding/answer', { type: 'camera-reset' })).status).toBe(
      404,
    );
    expect((await post(s, '/api/setup/onboarding', { mode: 'local' })).status).toBe(202);
    expect((await post(s, '/api/setup/onboarding', { mode: 'local' })).status).toBe(409);
  });

  it('cancels with DELETE and then allows a new job', async () => {
    const { s } = await startOnboardable();
    await post(s, '/api/setup/onboarding', { mode: 'local' });
    const del = await send(s, 'DELETE', '/api/setup/onboarding');
    expect(del.status).toBe(204);
    expect(await status(s)).toMatchObject({ phase: 'failed' });
    expect((await post(s, '/api/setup/onboarding', { mode: 'local' })).status).toBe(202);
  });

  it('keeps the job across a reload', async () => {
    const { s } = await startOnboardable();
    await post(s, '/api/setup/onboarding', { mode: 'local' });
    await post(s, '/api/setup/onboarding/answer', { type: 'camera-reset' });
    await waitForPhase(s, 'choose-wifi');
    await s.reload();
    // A kept-alive connection from before the reload may have been closed.
    const after = await status(s).catch(() => status(s));
    expect(after).toMatchObject({ phase: 'choose-wifi' });
  });

  it('after setup, needs a session; and refuses other websites', async () => {
    const settings = await completeSettings();
    const { s } = await startOnboardable(settings);
    expect((await send(s, 'GET', '/api/setup/onboarding')).status).toBe(401);
    expect((await post(s, '/api/setup/onboarding', { mode: 'local' })).status).toBe(401);
    const cookie = await login(s, VIEWER);
    expect((await send(s, 'GET', '/api/setup/onboarding', undefined, cookie)).status).toBe(404);
    const cross = await post(
      s,
      '/api/setup/onboarding',
      { mode: 'local' },
      { cookie, origin: 'https://evil.example' },
    );
    expect(cross.status).toBe(403);
    const crossDelete = await fetch(`${s.localUrl}/api/setup/onboarding`, {
      method: 'DELETE',
      headers: { origin: 'https://evil.example', cookie },
    });
    expect(crossDelete.status).toBe(403);
    // The saved camera login is the default account.
    const ok = await post(s, '/api/setup/onboarding', { mode: 'account' }, { cookie });
    expect(ok.status).toBe(202);
  });

  it('words a failed login for the page, with no setting names', async () => {
    const other = await startSetupFake({ username: 'someone', password: 'else' });
    try {
      const { s } = await startOnboardable(new SettingsStore(tmp()), other.env);
      await post(s, '/api/setup/onboarding', { mode: 'local' });
      await post(s, '/api/setup/onboarding/answer', { type: 'camera-reset' });
      await waitForPhase(s, 'failed');
      const failed = await status(s);
      expect(failed.error?.message).toMatch(/setup login/);
      expect(JSON.stringify(failed)).not.toMatch(/SETUP_LOGIN|environment|terminal|Enter/);
    } finally {
      await other.f.stop();
    }
  });
});
