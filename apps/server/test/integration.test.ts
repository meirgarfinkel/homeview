import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { BinaryKind, LIVE_WS_PATH } from '@kasa/shared';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { Camera } from '../src/kasa/camera.js';
import { CameraSource } from '../src/kasa/cameraSource.js';
import { CameraCredentials } from '../src/kasa/credentials.js';
import { CameraAuthError, LinkieClient } from '../src/kasa/linkieClient.js';
import { LiveHub } from '../src/media/liveHub.js';
import { fixture, silentLogger, waitFor } from './helpers.js';

const USER = 'parent@example.com';
const PASS = 'correct horse';

let fake: FakeCamera;
let ports: { streamPort: number; apiPort: number };

beforeAll(async () => {
  fake = new FakeCamera({
    username: USER,
    password: PASS,
    encoding: 'md5',
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 30),
  });
  ports = await fake.start();
});

afterAll(async () => {
  await fake.stop();
});

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    KASA_HOST: '127.0.0.1',
    KASA_USERNAME: USER,
    KASA_PASSWORD: PASS,
    KASA_API_PORT: String(ports.apiPort),
    KASA_STREAM_PORT: String(ports.streamPort),
    IDLE_DISCONNECT_SECONDS: '0',
    ALLOW_NO_PASSWORD: 'true',
    ALLOWED_CIDRS: '127.0.0.0/8,10.0.0.0/8,192.168.0.0/16',
    ...overrides,
  });
}

describe('LinkieClient against the fake camera', () => {
  it('discovers the password encoding and reads sysinfo', async () => {
    const credentials = new CameraCredentials(USER, PASS);
    credentials.applyCipherOptions([0]); // wrong hint: base64 first, md5 should still win
    const client = new LinkieClient({ host: '127.0.0.1', port: ports.apiPort, credentials });
    const info = await client.getSysinfo();
    expect(info.model).toBe('KC410S(US)');
    expect(credentials.resolvedEncoding).toBe('md5');
  });

  it('reports bad credentials as CameraAuthError', async () => {
    const credentials = new CameraCredentials(USER, 'wrong');
    const client = new LinkieClient({ host: '127.0.0.1', port: ports.apiPort, credentials });
    await expect(client.getSysinfo()).rejects.toBeInstanceOf(CameraAuthError);
  });

  it('rejects a mismatched certificate pin before sending credentials', async () => {
    const credentials = new CameraCredentials(USER, PASS);
    const client = new LinkieClient({
      host: '127.0.0.1',
      port: ports.apiPort,
      credentials,
      tls: { pinnedSha256: 'AA'.repeat(32) },
    });
    await expect(client.getSysinfo()).rejects.toThrow(/fingerprint/);
    expect(credentials.resolvedEncoding).toBeUndefined();
  });
});

describe('CameraSource against the fake camera', () => {
  it('streams video and audio frames with timestamps', async () => {
    const credentials = new CameraCredentials(USER, PASS);
    const source = new CameraSource({
      host: '127.0.0.1',
      port: ports.streamPort,
      path: '/https/stream/mixed?video=H264&audio=G711',
      credentials,
      logger: silentLogger,
    });
    const kinds = new Set<string>();
    let lastVideoTs = -1;
    let monotonic = true;
    source.on('frame', (f) => {
      kinds.add(f.kind);
      if (f.kind === 'video') {
        if (f.timestamp < lastVideoTs) monotonic = false;
        lastVideoTs = f.timestamp;
      }
    });
    source.start();
    await waitFor(() => kinds.has('video') && kinds.has('audio'));
    expect(source.state).toBe('live');
    expect(monotonic).toBe(true);
    source.stop();
    expect(source.state).toBe('idle');
  });

  it('reconnects after the camera drops the connection', async () => {
    const source = new CameraSource({
      host: '127.0.0.1',
      port: ports.streamPort,
      path: '/https/stream/mixed',
      credentials: new CameraCredentials(USER, PASS),
      logger: silentLogger,
    });
    let connects = 0;
    source.on('connected', () => connects++);
    source.start();
    await waitFor(() => connects === 1);
    fake.dropStreams();
    await waitFor(() => connects === 2, 8000);
    source.stop();
  });

  it('surfaces wrong credentials as an error state', async () => {
    const source = new CameraSource({
      host: '127.0.0.1',
      port: ports.streamPort,
      path: '/https/stream/mixed',
      credentials: new CameraCredentials(USER, 'nope'),
      logger: silentLogger,
    });
    const states: string[] = [];
    source.on('state', (s) => states.push(s));
    source.start();
    await waitFor(() => states.includes('error'));
    expect(states).not.toContain('live');
    source.stop();
  });
});

describe('HTTP app end to end', () => {
  let app: FastifyInstance;
  let camera: Camera;
  let hub: LiveHub;

  beforeAll(async () => {
    const config = testConfig();
    camera = new Camera('127.0.0.1', config, silentLogger);
    hub = new LiveHub({ source: camera.source, logger: silentLogger, idleTimeoutMs: 0 });
    app = await buildApp({ config, camera, hub, logger: silentLogger });
    await app.ready();
  });

  afterAll(async () => {
    hub.close();
    await app.close();
  });

  const local = { remoteAddress: '192.168.1.50', headers: { host: '192.168.1.10:8080' } };

  it('blocks clients outside the local network', async () => {
    const res = await app.inject({
      url: '/api/health',
      remoteAddress: '8.8.8.8',
      headers: local.headers,
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks DNS-rebinding hostnames', async () => {
    const res = await app.inject({
      url: '/api/health',
      remoteAddress: '192.168.1.50',
      headers: { host: 'attacker.example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks cross-origin mutations before they reach the camera', async () => {
    fake.commands.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: '/api/ptz/move',
      ...local,
      headers: { ...local.headers, origin: 'http://evil.example.com' },
      payload: { direction: 'left' },
    });
    expect(res.statusCode).toBe(403);
    expect(fake.commands).toEqual([]);
  });

  it('sets security headers', async () => {
    const res = await app.inject({ url: '/api/health', ...local });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns camera info', async () => {
    const res = await app.inject({ url: '/api/camera', ...local });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      alias: 'fake nursery',
      model: 'KC410S(US)',
      cameraOn: true,
    });
  });

  it('steps and stops the camera with the commands the Kasa app uses', async () => {
    fake.commands.length = 0;
    const move = await app.inject({
      method: 'POST',
      url: '/api/ptz/move',
      ...local,
      payload: { direction: 'left' },
    });
    expect(move.statusCode).toBe(204);
    const stop = await app.inject({ method: 'POST', url: '/api/ptz/stop', ...local, payload: {} });
    expect(stop.statusCode).toBe(204);
    expect(fake.commands.map(({ module, method, args }) => ({ module, method, args }))).toEqual([
      {
        module: 'smartlife.cam.ipcamera.ptz',
        method: 'set_move',
        args: { direction: 'left', speed: 2 },
      },
      { module: 'smartlife.cam.ipcamera.ptz', method: 'set_stop', args: {} },
    ]);
    const status = await app.inject({ url: '/api/status', ...local });
    expect(status.json().ptz).toBe('supported');
  });

  it('holds a direction with one set_target toward the edge, then stops', async () => {
    fake.commands.length = 0;
    const hold = await app.inject({
      method: 'POST',
      url: '/api/ptz/move',
      ...local,
      payload: { direction: 'up', mode: 'hold' },
    });
    expect(hold.statusCode).toBe(204);
    await app.inject({ method: 'POST', url: '/api/ptz/stop', ...local, payload: {} });
    const sent = fake.commands.map((c) => c.method);
    expect(sent).toEqual(['get_position', 'set_target', 'set_stop']);
    expect(fake.commands[1]?.args).toMatchObject({ y: 99_999 });
  });

  it.each([{ direction: 'sideways' }, { direction: 'up', mode: 'forever' }, {}])(
    'rejects bad PTZ input %j without touching the camera',
    async (payload) => {
      fake.commands.length = 0;
      const res = await app.inject({ method: 'POST', url: '/api/ptz/move', ...local, payload });
      expect(res.statusCode).toBe(400);
      expect(fake.commands).toEqual([]);
    },
  );

  it('lists presets and goes to one', async () => {
    const list = await app.inject({ url: '/api/ptz/presets', ...local });
    expect(list.json()).toEqual([
      { index: 1, name: 'Crib' },
      { index: 2, name: 'Door' },
    ]);
    fake.commands.length = 0;
    const go = await app.inject({
      method: 'POST',
      url: '/api/ptz/presets/2/go',
      ...local,
      payload: {},
    });
    expect(go.statusCode).toBe(204);
    expect(fake.commands.map(({ module, method, args }) => ({ module, method, args }))).toEqual([
      { module: 'smartlife.cam.ipcamera.ptz', method: 'set_run_to_preset', args: { index: 2 } },
    ]);
  });

  it('rejects a WebSocket from a foreign origin', async () => {
    const res = await app.inject({
      url: LIVE_WS_PATH,
      ...local,
      headers: {
        ...local.headers,
        origin: 'http://evil.example.com',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('streams init segment, video and audio over the WebSocket', async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as { port: number };
    const ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_WS_PATH}`, {
      origin: `http://127.0.0.1:${port}`,
    });
    const kinds = new Set<number>();
    let codec: { video: { width: number } } | undefined;
    ws.on('message', (data: Buffer, isBinary) => {
      if (isBinary) kinds.add(data[0]!);
      else {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'codec') codec = msg;
      }
    });
    await waitFor(
      () =>
        kinds.has(BinaryKind.VideoInit) &&
        kinds.has(BinaryKind.VideoFragment) &&
        kinds.has(BinaryKind.Audio),
      8000,
    );
    expect(codec?.video.width).toBe(320);
    expect(hub.viewerCount).toBe(1);
    ws.terminate();
    await waitFor(() => hub.viewerCount === 0);
  });
});

describe('viewer password', () => {
  let app: FastifyInstance;
  let hub: LiveHub;

  beforeAll(async () => {
    const config = testConfig({ VIEWER_PASSWORD: 'lullaby-time', SESSION_SECRET: 's'.repeat(32) });
    const camera = new Camera('127.0.0.1', config, silentLogger);
    hub = new LiveHub({ source: camera.source, logger: silentLogger });
    app = await buildApp({ config, camera, hub, logger: silentLogger });
  });

  afterAll(async () => {
    hub.close();
    await app.close();
  });

  const base = { remoteAddress: '10.0.0.5', headers: { host: '192.168.1.20:8080' } };

  it('requires a session for the API', async () => {
    expect((await app.inject({ url: '/api/camera', ...base })).statusCode).toBe(401);
    const session = await app.inject({ url: '/api/session', ...base });
    expect(session.json()).toEqual({
      authRequired: true,
      authenticated: false,
      setupComplete: true,
      local: false,
      desktop: false,
    });
  });

  it('logs in with the right password and sets an HttpOnly cookie', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/login',
      ...base,
      payload: { password: 'x' },
    });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({
      method: 'POST',
      url: '/api/login',
      ...base,
      payload: { password: 'lullaby-time' },
    });
    expect(good.statusCode).toBe(204);
    const cookie = String(good.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const token = cookie.split(';')[0]!;
    const res = await app.inject({
      url: '/api/status',
      ...base,
      headers: { ...base.headers, cookie: token },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rate-limits password guessing', async () => {
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/api/login',
        remoteAddress: '10.0.0.99',
        headers: base.headers,
        payload: { password: 'guess' },
      });
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await attempt()).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

describe('no viewer password and no ALLOW_NO_PASSWORD', () => {
  it('fails closed even when handed a camera', async () => {
    const env: Record<string, string> = {
      KASA_HOST: '127.0.0.1',
      KASA_USERNAME: USER,
      KASA_PASSWORD: PASS,
      KASA_API_PORT: String(ports.apiPort),
      KASA_STREAM_PORT: String(ports.streamPort),
      ALLOWED_CIDRS: '127.0.0.0/8,10.0.0.0/8',
    };
    const config = loadConfig(env, {});
    const camera = new Camera('127.0.0.1', config, silentLogger);
    const hub = new LiveHub({ source: camera.source, logger: silentLogger });
    const app = await buildApp({ config, camera, hub, logger: silentLogger });
    const base = { remoteAddress: '10.0.0.5', headers: { host: '192.168.1.20:8080' } };
    fake.commands.length = 0;
    expect((await app.inject({ url: '/api/camera', ...base })).statusCode).toBe(401);
    const move = await app.inject({
      method: 'POST',
      url: '/api/ptz/move',
      ...base,
      payload: { direction: 'left' },
    });
    expect(move.statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/login',
      ...base,
      payload: { password: 'anything' },
    });
    expect(login.statusCode).toBe(503);
    expect(fake.commands).toEqual([]);
    hub.close();
    await app.close();
  });
});
