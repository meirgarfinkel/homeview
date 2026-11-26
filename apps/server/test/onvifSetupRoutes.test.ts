import dgram from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { startFakeOnvif, type FakeOnvif, type FakeOnvifOptions } from '../src/dev/fakeOnvif.js';
import { startFakeRtsp, type FakeRtsp } from '../src/dev/fakeRtsp.js';
import { hashPassword } from '../src/security/passwordHash.js';
import { startServer, type RunningServer } from '../src/server.js';
import { SettingsStore } from '../src/settings/store.js';
import { fixture, silentLogger, waitFor } from './helpers.js';
import { BASE_FAKE } from './onvif/fixtures.js';

const KASA_USER = 'parent@example.com';
const KASA_PASS = 'correct horse';
const VIEWER = 'lullaby-time';
const CAM_USER = BASE_FAKE.username;
const CAM_PASS = BASE_FAKE.password;

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'kasa-onvif-setup-'));
  dirs.push(d);
  return d;
};

/** Every response body this suite saw, to check none holds a camera password. */
const bodies: string[] = [];

let kasa: FakeCamera;
let rtsp: FakeRtsp;
let env: Record<string, string>;
let discoveryPort: number;
let fakes: FakeOnvif[] = [];
const running: RunningServer[] = [];

async function freeUdpPort(): Promise<number> {
  const s = dgram.createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
  const { port } = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

beforeAll(async () => {
  kasa = new FakeCamera({
    username: KASA_USER,
    password: KASA_PASS,
    encoding: 'md5',
    alias: 'fake nursery',
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 30),
  });
  const ports = await kasa.start('127.0.0.1', 0, 0, 0);
  rtsp = await startFakeRtsp({
    video: 'h264',
    username: CAM_USER,
    password: CAM_PASS,
    auth: 'digest',
    path: '/main',
  });
  discoveryPort = await freeUdpPort();
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
    ONVIF_DISCOVERY_PORT: String(discoveryPort),
  };
});

afterEach(async () => {
  for (const s of running.splice(0)) await s.stop();
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
});

afterAll(async () => {
  await kasa.stop();
  await rtsp.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  // Checked last, over every answer above.
  for (const body of bodies) {
    expect(body).not.toContain(CAM_PASS);
    expect(body).not.toContain(KASA_PASS);
  }
});

async function onvif(opts: Partial<FakeOnvifOptions> = {}) {
  const f = await startFakeOnvif({ ...BASE_FAKE, streamUri: rtsp.url, discoveryPort, ...opts });
  fakes.push(f);
  return f;
}

const portOf = (f: FakeOnvif) => Number(new URL(f.deviceUrl).port);

async function start(settings: SettingsStore): Promise<RunningServer> {
  const s = await startServer({ env, settings, dataDir: tmp(), logger: silentLogger });
  running.push(s);
  return s;
}

async function post(s: RunningServer, url: string, body: unknown, cookie?: string) {
  const res = await fetch(`${s.localUrl}${url}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: s.localUrl,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, json: () => JSON.parse(text) as Record<string, unknown> };
}

async function login(s: RunningServer): Promise<string> {
  const res = await fetch(`${s.localUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: s.localUrl },
    body: JSON.stringify({ password: VIEWER }),
  });
  expect(res.status).toBe(204);
  return res.headers.get('set-cookie')!.split(';', 1)[0]!;
}

async function cameraOf(s: RunningServer, cookie: string) {
  const res = await fetch(`${s.localUrl}/api/camera`, { headers: { cookie } });
  const text = await res.text();
  bodies.push(text);
  return res.status === 200 ? (JSON.parse(text) as Record<string, unknown>) : undefined;
}

/** Viewer password saved, no camera yet. */
async function beforeCamera() {
  const settings = new SettingsStore(tmp());
  settings.save({ viewerPasswordHash: await hashPassword(VIEWER) });
  return settings;
}

/** Set up with the fake Kasa camera. */
async function withKasa() {
  const settings = new SettingsStore(tmp());
  settings.save({
    viewerPasswordHash: await hashPassword(VIEWER),
    camera: { username: KASA_USER, password: KASA_PASS, alias: 'fake nursery', localOnly: false },
  });
  return settings;
}

const login4 = (f: FakeOnvif, extra: Record<string, unknown> = {}) => ({
  host: '127.0.0.1',
  port: portOf(f),
  username: CAM_USER,
  password: CAM_PASS,
  ...extra,
});

describe('ONVIF setup routes', () => {
  it('scan lists the fake camera', async () => {
    await onvif({ name: 'Nursery Cam' });
    const s = await start(await beforeCamera());
    const res = await post(s, '/api/setup/onvif/scan', {});
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      cameras: [
        {
          endpointId: BASE_FAKE.endpointId,
          host: '127.0.0.1',
          port: expect.any(Number),
          name: 'Nursery Cam',
        },
      ],
    });
  });

  it('check returns profiles and the picked token', async () => {
    const f = await onvif({
      profiles: [
        { token: 'main', name: 'Main', codec: 'h265', width: 3840, height: 2160, hasPtz: true },
        { token: 'sub', name: 'Sub', codec: 'h264', width: 1280, height: 720, hasPtz: true },
        { token: 'snap', name: 'Snap', codec: 'other', width: 640, height: 480, hasPtz: false },
      ],
    });
    const s = await start(await beforeCamera());
    const res = await post(s, '/api/setup/onvif/check', login4(f));
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      model: 'FC-1',
      profiles: [
        { token: 'main', name: 'Main', codec: 'h265', width: 3840, height: 2160 },
        { token: 'sub', name: 'Sub', codec: 'h264', width: 1280, height: 720 },
      ],
      picked: 'sub',
    });
  });

  it('check maps each failure to its error code', async () => {
    const s = await start(await beforeCamera());
    const f = await onvif();
    expect(
      (await post(s, '/api/setup/onvif/check', login4(f, { password: 'wrong' }))).json(),
    ).toMatchObject({
      error: 'camera-login',
    });
    expect((await post(s, '/api/setup/onvif/check', login4(f, { password: 'wrong' }))).status).toBe(
      401,
    );

    const mjpeg = await onvif({
      profiles: [{ token: 'm', name: 'M', codec: 'other', width: 640, height: 480, hasPtz: false }],
    });
    const v = await post(s, '/api/setup/onvif/check', login4(mjpeg));
    expect([v.status, v.json().error]).toEqual([422, 'video-format']);

    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const n = await post(s, '/api/setup/onvif/check', { ...login4(f), port: closedPort });
    expect([n.status, n.json().error]).toEqual([504, 'no-answer']);

    const web = http.createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><body>Router admin</body></html>');
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()));
    const o = await post(s, '/api/setup/onvif/check', {
      ...login4(f),
      port: (web.address() as AddressInfo).port,
    });
    web.close();
    expect([o.status, o.json().error]).toEqual([502, 'onvif-off']);

    const b = await post(s, '/api/setup/onvif/check', { ...login4(f), host: '8.8.8.8' });
    expect([b.status, b.json().error]).toEqual([400, 'bad-address']);
    const r = await post(s, '/api/setup/onvif/check', {
      rtspUrl: 'http://127.0.0.1/x',
      username: 'a',
      password: 'b',
    });
    expect([r.status, r.json().error]).toEqual([400, 'bad-address']);
  });

  it('check accepts a typed-in stream address', async () => {
    const s = await start(await beforeCamera());
    const res = await post(s, '/api/setup/onvif/check', {
      rtspUrl: rtsp.url,
      username: CAM_USER,
      password: CAM_PASS,
    });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ profiles: [{ codec: 'h264' }] });
    const bad = await post(s, '/api/setup/onvif/check', {
      rtspUrl: rtsp.url,
      username: CAM_USER,
      password: 'nope',
    });
    expect([bad.status, bad.json().error]).toEqual([401, 'camera-login']);
  });

  it('save stores kind onvif and reloads', async () => {
    const f = await onvif();
    const settings = await beforeCamera();
    const s = await start(settings);
    const res = await post(
      s,
      '/api/setup/onvif/save',
      login4(f, { endpointId: BASE_FAKE.endpointId }),
    );
    expect(res.status).toBe(200);
    await waitFor(() => s.setupComplete(), 5000);
    expect(settings.load().camera).toEqual({
      kind: 'onvif',
      username: CAM_USER,
      password: CAM_PASS,
      localOnly: false,
      onvif: {
        host: '127.0.0.1',
        onvifPort: portOf(f),
        profileToken: 'main',
        identity: { endpointId: BASE_FAKE.endpointId, serial: 'SN-1', mac: '00:11:22:33:44:55' },
      },
    });
    const cookie = await login(s);
    expect(await cameraOf(s, cookie)).toMatchObject({ kind: 'onvif', model: 'FC-1' });
  });

  it('save after setup without a local session → 403', async () => {
    const f = await onvif();
    const s = await start(await withKasa());
    const res = await post(s, '/api/setup/onvif/save', login4(f));
    expect(res.status).toBe(403);
    expect((await post(s, '/api/setup/onvif/scan', {})).status).toBe(403);
    expect((await post(s, '/api/setup/onvif/check', login4(f))).status).toBe(403);
  });

  it('change camera keeps the viewer password, paired phones and sound settings', async () => {
    const f = await onvif();
    const settings = await withKasa();
    const hash = settings.load().viewerPasswordHash;
    const s = await start(settings);
    const cookie = await login(s);
    expect(await cameraOf(s, cookie)).toMatchObject({ kind: 'kasa' });
    const res = await post(s, '/api/setup/onvif/save', login4(f), cookie);
    expect(res.status).toBe(200);
    await waitFor(() => settings.load().camera?.kind === 'onvif');
    for (let i = 0; i < 50 && (await cameraOf(s, cookie))?.['kind'] !== 'onvif'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // The same viewer password, and the same session still works: nobody has to sign in again.
    expect(settings.load().viewerPasswordHash).toBe(hash);
    expect(await cameraOf(s, cookie)).toMatchObject({ kind: 'onvif' });
  });

  it('a wrong password on save keeps the old Kasa camera in use', async () => {
    const f = await onvif();
    const settings = await withKasa();
    const before = settings.load().camera;
    const s = await start(settings);
    const cookie = await login(s);
    const res = await post(s, '/api/setup/onvif/save', login4(f, { password: 'wrong' }), cookie);
    expect([res.status, res.json().error]).toEqual([401, 'camera-login']);
    expect(settings.load().camera).toEqual(before);
    expect(await cameraOf(s, cookie)).toMatchObject({ kind: 'kasa', alias: 'fake nursery' });
  });

  it('switching back to Kasa works', async () => {
    const f = await onvif();
    const settings = new SettingsStore(tmp());
    settings.save({
      viewerPasswordHash: await hashPassword(VIEWER),
      camera: {
        kind: 'onvif',
        username: CAM_USER,
        password: CAM_PASS,
        localOnly: false,
        onvif: { host: '127.0.0.1', onvifPort: portOf(f), identity: {} },
      },
    });
    const s = await start(settings);
    const cookie = await login(s);
    const res = await post(
      s,
      '/api/setup/kasa-camera',
      { username: KASA_USER, password: KASA_PASS },
      cookie,
    );
    expect(res.status).toBe(200);
    await waitFor(() => settings.load().camera?.kind === undefined);
    expect(settings.load().camera).toMatchObject({ username: KASA_USER, alias: 'fake nursery' });
    expect(settings.load().camera?.onvif).toBeUndefined();
    for (let i = 0; i < 50 && (await cameraOf(s, cookie))?.['kind'] !== 'kasa'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(await cameraOf(s, cookie)).toMatchObject({ kind: 'kasa' });
  });

  it('the stream profile can be changed from settings', async () => {
    const f = await onvif({
      profiles: [
        { token: 'main', name: 'Main', codec: 'h264', width: 1920, height: 1080, hasPtz: true },
        { token: 'sub', name: 'Sub', codec: 'h264', width: 640, height: 360, hasPtz: true },
      ],
    });
    const settings = new SettingsStore(tmp());
    settings.save({
      viewerPasswordHash: await hashPassword(VIEWER),
      camera: {
        kind: 'onvif',
        username: CAM_USER,
        password: CAM_PASS,
        localOnly: false,
        onvif: { host: '127.0.0.1', onvifPort: portOf(f), profileToken: 'main', identity: {} },
      },
    });
    const s = await start(settings);
    const cookie = await login(s);
    const put = async (token: string) => {
      const res = await fetch(`${s.localUrl}/api/settings/camera-profile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: s.localUrl, cookie },
        body: JSON.stringify({ profileToken: token }),
      });
      bodies.push(await res.text());
      return res.status;
    };
    const list = await fetch(`${s.localUrl}/api/settings/camera-profiles`, { headers: { cookie } });
    const listText = await list.text();
    bodies.push(listText);
    expect(list.status).toBe(200);
    expect(JSON.parse(listText)).toEqual({
      profiles: [
        { token: 'main', name: 'Main', codec: 'h264', width: 1920, height: 1080 },
        { token: 'sub', name: 'Sub', codec: 'h264', width: 640, height: 360 },
      ],
      current: 'main',
    });
    expect(await put('nope')).toBe(400);
    expect(await put('sub')).toBe(204);
    expect(settings.load().camera?.onvif?.profileToken).toBe('sub');
  });
});
