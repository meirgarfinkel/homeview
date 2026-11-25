import { mkdtempSync, rmSync } from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import type os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { LIVE_WS_PATH } from '@kasa/shared';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { hashPassword } from '../src/security/passwordHash.js';
import { lanAddress, startServer, type RunningServer } from '../src/server.js';
import { SettingsStore } from '../src/settings/store.js';
import { fixture, silentLogger } from './helpers.js';

const USER = 'parent@example.com';
const PASS = 'correct horse';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kasa-server-'));
  dirs.push(dir);
  return dir;
}

let fake: FakeCamera;
let fakeEnv: Record<string, string>;

beforeAll(async () => {
  fake = new FakeCamera({
    username: USER,
    password: PASS,
    encoding: 'md5',
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 30),
  });
  const ports = await fake.start();
  fakeEnv = {
    KASA_HOST: '127.0.0.1',
    KASA_API_PORT: String(ports.apiPort),
    KASA_STREAM_PORT: String(ports.streamPort),
    KASA_SYNC_TIMEZONE: 'false',
  };
});

afterAll(async () => {
  await fake.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const quiet = { PORT: '0', HOST: '127.0.0.1', HTTPS: 'false', LOG_LEVEL: 'silent' };

async function start(
  env: Record<string, string>,
  settings = new SettingsStore(tmp()),
  desktop = false,
): Promise<RunningServer> {
  return startServer({ env, settings, dataDir: tmp(), logger: silentLogger, desktop });
}

function post(s: RunningServer, url: string, body: unknown, cookie?: string) {
  return fetch(`${s.localUrl}${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: s.localUrl,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('startServer', () => {
  it('starts with no settings and serves the setup state', async () => {
    const s = await startServer({
      env: { PORT: '0', HTTPS: 'false', LOG_LEVEL: 'silent' },
      settings: new SettingsStore(tmp()),
      dataDir: tmp(),
      desktop: true,
    });
    const res = await fetch(`${s.localUrl}/api/session`).then((r) => r.json());
    expect(res).toMatchObject({ setupComplete: false, local: true, desktop: true });
    expect(s.setupComplete()).toBe(false);
    const camera = await fetch(`${s.localUrl}/api/camera`);
    expect(camera.status).toBe(503);
    expect(await camera.json()).toMatchObject({ error: 'not-set-up' });
    await s.stop();
  });

  it('moves to the next port when the first is taken', async () => {
    const blocker = net.createServer().listen(0);
    await new Promise((r) => blocker.once('listening', r));
    const taken = (blocker.address() as AddressInfo).port;
    const s = await startServer({
      env: { PORT: String(taken), HTTPS: 'false', LOG_LEVEL: 'silent' },
      settings: new SettingsStore(tmp()),
      dataDir: tmp(),
    });
    expect(s.port).toBe(taken + 1);
    expect(s.localUrl).toBe(`http://localhost:${taken + 1}`);
    await s.stop();
    blocker.close();
  });

  it('reload() picks up a saved camera login without changing port', async () => {
    const settings = new SettingsStore(tmp());
    const s = await start({ ...quiet, ...fakeEnv }, settings);
    const port = s.port;
    expect(s.setupComplete()).toBe(false);

    settings.save({
      viewerPasswordHash: await hashPassword('lullaby-time'),
      camera: { username: USER, password: PASS, localOnly: false },
    });
    await s.reload();
    expect(s.port).toBe(port);
    expect(s.setupComplete()).toBe(true);

    expect((await fetch(`${s.localUrl}/api/camera`)).status).toBe(401);
    const login = await post(s, '/api/login', { password: 'lullaby-time' });
    expect(login.status).toBe(204);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const camera = await fetch(`${s.localUrl}/api/camera`, { headers: { cookie } });
    expect(camera.status).toBe(200);
    expect(await camera.json()).toMatchObject({ alias: 'fake nursery' });
    await s.stop();
  });

  it('starts with the camera offline when it cannot be located, behind the password', async () => {
    const s = await start({
      ...quiet,
      KASA_HOST: '8.8.8.8',
      KASA_USERNAME: USER,
      KASA_PASSWORD: PASS,
      VIEWER_PASSWORD: 'lullaby-time',
    });
    expect(s.setupComplete()).toBe(true);
    expect((await fetch(`${s.localUrl}/api/camera`)).status).toBe(401);
    const login = await post(s, '/api/login', { password: 'lullaby-time' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const camera = await fetch(`${s.localUrl}/api/camera`, { headers: { cookie } });
    expect(camera.status).toBe(503);
    expect(await camera.json()).toMatchObject({ error: 'camera-offline' });
    await s.stop();
  });
});

describe('access before setup is complete', () => {
  it('never reaches the camera with no settings', async () => {
    const s = await start({ ...quiet, ...fakeEnv });
    fake.commands.length = 0;
    expect((await fetch(`${s.localUrl}/api/camera`)).status).not.toBe(200);
    expect((await fetch(`${s.localUrl}/api/status`)).status).not.toBe(200);
    expect((await fetch(`${s.localUrl}/api/ptz/presets`)).status).not.toBe(200);
    const move = await post(s, '/api/ptz/move', { direction: 'left' });
    expect(move.status).toBeGreaterThanOrEqual(400);
    expect(fake.commands).toEqual([]);
    const ws = new WebSocket(`${s.localUrl.replace('http', 'ws')}${LIVE_WS_PATH}`, {
      origin: s.localUrl,
    });
    ws.on('error', () => undefined);
    const status = await new Promise<number | undefined>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('open', () => resolve(101));
    });
    ws.terminate();
    expect(status).toBe(503);
    await s.stop();
  });

  it('never reaches the camera when only the camera login is saved', async () => {
    const settings = new SettingsStore(tmp());
    settings.save({ camera: { username: USER, password: PASS, localOnly: false } });
    const s = await start({ ...quiet, ...fakeEnv }, settings);
    expect(s.setupComplete()).toBe(false);
    fake.commands.length = 0;
    expect((await fetch(`${s.localUrl}/api/camera`)).status).not.toBe(200);
    const move = await post(s, '/api/ptz/move', { direction: 'left' });
    expect(move.status).toBeGreaterThanOrEqual(400);
    const go = await post(s, '/api/ptz/presets/1/go', {});
    expect(go.status).toBeGreaterThanOrEqual(400);
    expect(fake.commands).toEqual([]);
    const session = await fetch(`${s.localUrl}/api/session`).then((r) => r.json());
    expect(session).toMatchObject({ authRequired: true, authenticated: false });
    await s.stop();
  });
});

describe('lanAddress', () => {
  it('reports no LAN address when only loopback exists', () => {
    expect(
      lanAddress({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
      }),
    ).toBeUndefined();
  });

  it('picks the private address of a real interface', () => {
    const iface = (address: string) =>
      ({ address, family: 'IPv4', internal: false }) as os.NetworkInterfaceInfo;
    expect(
      lanAddress({
        docker0: [iface('172.17.0.1')],
        wlan0: [iface('192.168.1.20')],
      }),
    ).toBe('192.168.1.20');
  });
});
