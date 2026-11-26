import dgram from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { LIVE_WS_PATH } from '@kasa/shared';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { startFakeOnvif } from '../src/dev/fakeOnvif.js';
import { startFakeRtsp } from '../src/dev/fakeRtsp.js';
import { BASE_FAKE } from './onvif/fixtures.js';
import { hashPassword } from '../src/security/passwordHash.js';
import { CLOSE_GRACE_MS } from '../src/listen.js';
import { lanAddress, startServer, type RunningServer } from '../src/server.js';
import type * as ApiModule from '../src/routes/api.js';
import { SettingsStore } from '../src/settings/store.js';
import { fixture, silentLogger, waitFor, within } from './helpers.js';
import { TEST_PAGE_MARKER } from './setup/staticDir.js';

// Test only: add a route that awaits deps.reload(), as the setup routes will.
vi.mock('../src/routes/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof ApiModule>();
  return {
    ...real,
    registerApiRoutes: async (...args: Parameters<typeof real.registerApiRoutes>) => {
      const [app, deps] = args;
      app.get('/api/test-reload', async () => {
        await deps.reload?.();
        return { reloaded: true };
      });
      await real.registerApiRoutes(...args);
    },
  };
});

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
    // Another program may hold taken + 1 too, so any of the next ports will do.
    expect(s.port).toBeGreaterThan(taken);
    expect(s.port).toBeLessThanOrEqual(taken + 9);
    expect(s.localUrl).toBe(`http://localhost:${s.port}`);
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

describe('a standard (ONVIF) camera', () => {
  it('an onvif settings file starts an OnvifDriver against the fakes and /api/status reports live', async () => {
    const rtsp = await startFakeRtsp({
      video: 'h264',
      username: BASE_FAKE.username,
      password: BASE_FAKE.password,
      auth: 'digest',
      path: '/main',
    });
    const onvif = await startFakeOnvif({ ...BASE_FAKE, streamUri: rtsp.url });
    const settings = new SettingsStore(tmp());
    settings.save({
      viewerPasswordHash: await hashPassword('lullaby-time'),
      camera: {
        kind: 'onvif',
        username: BASE_FAKE.username,
        password: BASE_FAKE.password,
        localOnly: false,
        onvif: {
          host: '127.0.0.1',
          onvifPort: Number(new URL(onvif.deviceUrl).port),
          identity: { endpointId: BASE_FAKE.endpointId },
        },
      },
    });
    const s = await start({ ...quiet, KASA_DISCOVERY_TARGETS: '127.0.0.1' }, settings);
    try {
      expect(s.setupComplete()).toBe(true);
      const login = await post(s, '/api/login', { password: 'lullaby-time' });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

      const camera = await fetch(`${s.localUrl}/api/camera`, { headers: { cookie } });
      expect(camera.status).toBe(200);
      expect(await camera.json()).toMatchObject({
        kind: 'onvif',
        model: 'FC-1',
        resolution: '1920x1080',
      });

      const ws = new WebSocket(`${s.localUrl.replace('http', 'ws')}${LIVE_WS_PATH}`, {
        origin: s.localUrl,
        headers: { cookie },
      });
      ws.on('error', () => undefined);
      let state = '';
      for (let i = 0; i < 80 && state !== 'live'; i++) {
        const status = (await fetch(`${s.localUrl}/api/status`, { headers: { cookie } }).then((r) =>
          r.json(),
        )) as { stream: { state: string } };
        state = status.stream.state;
        if (state !== 'live') await new Promise((r) => setTimeout(r, 100));
      }
      expect(state).toBe('live');
      expect(rtsp.connections).toBeGreaterThan(0);
      ws.terminate();
    } finally {
      await s.stop();
      await onvif.close();
      await rtsp.close();
    }
  });
});

describe('a standard camera that moved while Kasa Home was off', () => {
  it('is found by its id at start, and its new address is saved', async () => {
    const udp = dgram.createSocket('udp4');
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
    const discoveryPort = udp.address().port;
    await new Promise<void>((r) => udp.close(() => r()));
    const rtsp = await startFakeRtsp({
      video: 'h264',
      username: BASE_FAKE.username,
      password: BASE_FAKE.password,
      auth: 'digest',
      path: '/main',
      host: '127.0.0.2',
    });
    const onvif = await startFakeOnvif({
      ...BASE_FAKE,
      host: '127.0.0.2',
      discoveryPort,
      streamUri: rtsp.url,
    });
    const onvifPort = Number(new URL(onvif.deviceUrl).port);
    const settings = new SettingsStore(tmp());
    settings.save({
      viewerPasswordHash: await hashPassword('lullaby-time'),
      camera: {
        kind: 'onvif',
        username: BASE_FAKE.username,
        password: BASE_FAKE.password,
        localOnly: false,
        // Where it was before: nothing answers there now.
        onvif: { host: '127.0.0.1', onvifPort, identity: { endpointId: BASE_FAKE.endpointId } },
      },
    });
    const s = await start(
      {
        ...quiet,
        KASA_DISCOVERY_TARGETS: '127.0.0.2',
        ONVIF_DISCOVERY_PORT: String(discoveryPort),
      },
      settings,
    );
    try {
      const login = await post(s, '/api/login', { password: 'lullaby-time' });
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      const camera = await fetch(`${s.localUrl}/api/camera`, { headers: { cookie } });
      expect(camera.status).toBe(200);
      expect(await camera.json()).toMatchObject({ kind: 'onvif', host: '127.0.0.2' });
      expect(settings.load().camera?.onvif).toMatchObject({ host: '127.0.0.2', onvifPort });
    } finally {
      await s.stop();
      await onvif.close();
      await rtsp.close();
    }
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

  const iface = (address: string) =>
    ({ address, family: 'IPv4', internal: false }) as os.NetworkInterfaceInfo;

  it('keeps a home network in the 172.16-31 range', () => {
    expect(lanAddress({ docker0: [iface('172.17.0.1')], wlan0: [iface('172.20.10.4')] })).toBe(
      '172.20.10.4',
    );
  });

  it('skips Windows virtual machine, WSL and VPN adapters', () => {
    expect(
      lanAddress({
        'vEthernet (WSL)': [iface('172.28.112.1')],
        'vEthernet (Default Switch)': [iface('172.24.64.1')],
        'VMware Network Adapter VMnet8': [iface('192.168.200.1')],
        'VirtualBox Host-Only Network': [iface('192.168.56.1')],
        'OpenVPN TAP-Windows6': [iface('10.8.0.2')],
        'Wi-Fi': [iface('192.168.1.20')],
      }),
    ).toBe('192.168.1.20');
  });

  it('skips macOS VM bridges and tunnels', () => {
    expect(
      lanAddress({
        bridge100: [iface('192.168.64.1')],
        utun3: [iface('198.51.100.2')],
        en0: [iface('10.0.1.7')],
      }),
    ).toBe('10.0.1.7');
  });
});

describe('rebuilding while clients are connected', () => {
  it('lets a route await deps.reload() and still answer', async () => {
    const settings = new SettingsStore(tmp());
    const s = await start({ ...quiet, ...fakeEnv, ALLOW_NO_PASSWORD: 'true' }, settings);
    expect(s.setupComplete()).toBe(false);
    settings.save({ camera: { username: USER, password: PASS, localOnly: false } });
    const res = await within(fetch(`${s.localUrl}/api/test-reload`), 5000, 'the response');
    expect(await res.json()).toEqual({ reloaded: true });
    // The switch to the new app happens after the reply.
    await waitFor(() => s.setupComplete());
    expect((await fetch(`${s.localUrl}/api/camera`)).status).toBe(200);
    await within(s.stop(), 5000, 'stop()');
  });

  /**
   * Request /api/health over new connections, a few at a time, until stopped.
   * Collects anything that is not a 200: a refused or reset connection too.
   */
  function keepRequesting(port: number, secure: boolean, keepAlive: boolean) {
    const agent = keepAlive
      ? new (secure ? https : http).Agent({ keepAlive: true, rejectUnauthorized: false })
      : false;
    let running = true;
    let ok = 0;
    const failures: string[] = [];
    const one = () =>
      new Promise<void>((resolve) => {
        const options = { host: '127.0.0.1', port, path: '/api/health', agent };
        const done = (res: http.IncomingMessage) => {
          res.resume();
          res.on('end', () => {
            if (res.statusCode === 200) ok++;
            else failures.push(`status ${res.statusCode}`);
            resolve();
          });
        };
        const req = secure
          ? https.get({ ...options, rejectUnauthorized: false }, done)
          : http.get(options, done);
        req.on('error', (err: NodeJS.ErrnoException) => {
          failures.push(err.code ?? err.message);
          resolve();
        });
      });
    const loops = Array.from({ length: 4 }, async () => {
      while (running) await one();
    });
    return {
      stop: async () => {
        running = false;
        await Promise.all(loops);
        if (agent) agent.destroy();
        return { ok, failures };
      },
    };
  }

  for (const secure of [false, true]) {
    for (const keepAlive of [false, true]) {
      const name = `${secure ? 'HTTPS' : 'HTTP'}, ${keepAlive ? 'keep-alive' : 'new connections'}`;
      it(`answers every request while it rebuilds (${name})`, async () => {
        const s = await start({ ...quiet, HTTPS: String(secure), ALLOW_NO_PASSWORD: 'true' });
        try {
          const requests = keepRequesting(s.port, secure, keepAlive);
          for (let i = 0; i < 3; i++) await within(s.reload(), 5000, 'reload()');
          const { ok, failures } = await requests.stop();
          expect(failures).toEqual([]);
          expect(ok).toBeGreaterThan(0);
        } finally {
          await within(s.stop(), 5000, 'stop()');
        }
      });
    }
  }

  it('sends a request on a kept-alive connection to the rebuilt app', async () => {
    const settings = new SettingsStore(tmp());
    const s = await start({ ...quiet, ...fakeEnv, ALLOW_NO_PASSWORD: 'true' }, settings);
    const agent = new http.Agent({ keepAlive: true });
    const session = () =>
      new Promise<{ setupComplete: boolean; reused: boolean }>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${s.port}/api/session`, { agent }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () =>
            resolve({
              ...(JSON.parse(body) as { setupComplete: boolean }),
              reused: req.reusedSocket,
            }),
          );
        });
        req.on('error', reject);
      });
    try {
      expect(await session()).toMatchObject({ setupComplete: false, reused: false });
      settings.save({ camera: { username: USER, password: PASS, localOnly: false } });
      await within(s.reload(), 5000, 'reload()');
      expect(await session()).toMatchObject({ setupComplete: true, reused: true });
    } finally {
      agent.destroy();
      await within(s.stop(), 5000, 'stop()');
    }
  });

  it('serves the web app in these tests, so reloads are tested with static files', async () => {
    const s = await start({ ...quiet, ALLOW_NO_PASSWORD: 'true' });
    try {
      expect(await fetch(`${s.localUrl}/`).then((r) => r.text())).toContain(TEST_PAGE_MARKER);
      const asset = await fetch(`${s.localUrl}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toContain('immutable');
    } finally {
      await s.stop();
    }
  });

  describe('with HTTPS on', () => {
    let dataDir: string;
    beforeAll(() => {
      dataDir = tmp();
    });

    /** A set-up server on HTTPS with one keep-alive request done and a live WebSocket open. */
    async function connected() {
      const s = await startServer({
        env: {
          ...quiet,
          ...fakeEnv,
          HTTPS: 'true',
          KASA_USERNAME: USER,
          KASA_PASSWORD: PASS,
          ALLOW_NO_PASSWORD: 'true',
        },
        settings: new SettingsStore(tmp()),
        dataDir,
        logger: silentLogger,
      });
      const base = `https://127.0.0.1:${s.port}`;
      const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });
      const status = await new Promise<number | undefined>((resolve, reject) => {
        https
          .get(`${base}/api/health`, { agent }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          })
          .on('error', reject);
      });
      expect(status).toBe(200);
      const ws = new WebSocket(`wss://127.0.0.1:${s.port}${LIVE_WS_PATH}`, {
        origin: base,
        rejectUnauthorized: false,
      });
      ws.on('error', () => undefined);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('unexpected-response', () => reject(new Error('live socket refused')));
      });
      const cleanup = () => {
        agent.destroy();
        ws.terminate();
      };
      return { s, cleanup };
    }

    it('reload() finishes with a keep-alive connection and a live WebSocket open', async () => {
      const { s, cleanup } = await connected();
      const port = s.port;
      try {
        await within(s.reload(), 5000, 'reload()');
        expect(s.port).toBe(port);
      } finally {
        cleanup();
        await s.stop();
      }
    });

    it('stop() finishes with a keep-alive connection and a live WebSocket open', async () => {
      const { s, cleanup } = await connected();
      try {
        await within(s.stop(), 5000, 'stop()');
      } finally {
        cleanup();
      }
    });

    /** The same, but as this computer sees it: plain HTTP and ws://localhost. */
    async function connectedLocally() {
      const { s, cleanup: closeHttps } = await connected();
      const agent = new http.Agent({ keepAlive: true });
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http
          .get(`${s.localUrl}/api/session`, { agent }, (r) => {
            r.resume();
            r.on('end', () => resolve(r));
          })
          .on('error', reject);
      });
      expect(res.statusCode).toBe(200);
      const ws = new WebSocket(`ws://localhost:${s.port}${LIVE_WS_PATH}`, {
        origin: s.localUrl,
      });
      ws.on('error', () => undefined);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('unexpected-response', () => reject(new Error('live socket refused')));
      });
      const cleanup = () => {
        closeHttps();
        agent.destroy();
        ws.terminate();
      };
      return { s, res, cleanup };
    }

    it('serves this computer over plain HTTP, including the live WebSocket', async () => {
      const { s, res, cleanup } = await connectedLocally();
      try {
        expect(s.localUrl).toBe(`http://localhost:${s.port}`);
        expect(String(res.headers['content-security-policy'])).toContain(
          `ws://localhost:${s.port}`,
        );
      } finally {
        cleanup();
        await s.stop();
      }
    });

    // The computer may join another network during camera setup, so the
    // rebuild after it works out the allowed networks again.
    it.skipIf(!lanAddress())('lets in a new network after a reload', async () => {
      const lan = lanAddress()!;
      const real = os.networkInterfaces();
      const loopbackOnly = { lo: real.lo ?? [] };
      const spy = vi.spyOn(os, 'networkInterfaces').mockReturnValue(loopbackOnly);
      const s = await startServer({
        env: {
          ...quiet,
          ...fakeEnv,
          HOST: '0.0.0.0',
          HTTPS: 'true',
          KASA_USERNAME: USER,
          KASA_PASSWORD: PASS,
          ALLOW_NO_PASSWORD: 'true',
        },
        settings: new SettingsStore(tmp()),
        dataDir,
        logger: silentLogger,
      });
      const health = () =>
        new Promise<number | undefined>((resolve, reject) => {
          https
            .get(
              {
                host: lan,
                port: s.port,
                path: '/api/health',
                agent: false,
                rejectUnauthorized: false,
              },
              (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
              },
            )
            .on('error', reject);
        });
      try {
        // Only loopback counts as local, so this computer's LAN address is turned away.
        await expect(health()).rejects.toThrow();
        spy.mockReturnValue(real);
        await within(s.reload(), 5000, 'reload()');
        expect(await health()).toBe(200);
      } finally {
        spy.mockRestore();
        await s.stop();
      }
    });

    // Connecting to this machine's own LAN address arrives from that address,
    // not loopback, so it stands in for another computer.
    it.skipIf(!lanAddress())('still sends other computers to HTTPS', async () => {
      const lan = lanAddress()!;
      const s = await startServer({
        env: {
          ...quiet,
          ...fakeEnv,
          HOST: '0.0.0.0',
          HTTPS: 'true',
          KASA_USERNAME: USER,
          KASA_PASSWORD: PASS,
          ALLOW_NO_PASSWORD: 'true',
        },
        settings: new SettingsStore(tmp()),
        dataDir,
        logger: silentLogger,
      });
      try {
        const res = await fetch(`http://${lan}:${s.port}/api/health`, { redirect: 'manual' });
        expect(res.status).toBe(308);
        expect(res.headers.get('location')).toBe(`https://${lan}:${s.port}/api/health`);
      } finally {
        await s.stop();
      }
    });

    it('marks the session cookie Secure only on HTTPS', async () => {
      const s = await startServer({
        env: {
          ...quiet,
          ...fakeEnv,
          HTTPS: 'true',
          KASA_USERNAME: USER,
          KASA_PASSWORD: PASS,
          VIEWER_PASSWORD: 'long enough',
        },
        settings: new SettingsStore(tmp()),
        dataDir,
        logger: silentLogger,
      });
      const login = (base: string) =>
        new Promise<string>((resolve, reject) => {
          const body = JSON.stringify({ password: 'long enough' });
          const req = (base.startsWith('https') ? https : http).request(
            `${base}/api/login`,
            {
              method: 'POST',
              rejectUnauthorized: false,
              headers: { 'content-type': 'application/json', origin: base },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve(String(res.headers['set-cookie'])));
            },
          );
          req.on('error', reject);
          req.end(body);
        });
      try {
        const plain = await login(s.localUrl);
        expect(plain).toContain('HttpOnly');
        expect(plain).not.toContain('Secure');
        expect(await login(`https://localhost:${s.port}`)).toContain('Secure');
      } finally {
        await s.stop();
      }
    });

    it('reload() finishes with a plain-HTTP keep-alive and ws://localhost open', async () => {
      const { s, cleanup } = await connectedLocally();
      try {
        await within(s.reload(), 5000, 'reload()');
      } finally {
        cleanup();
        await s.stop();
      }
    });

    it('stop() finishes with a plain-HTTP keep-alive and ws://localhost open', async () => {
      const { s, cleanup } = await connectedLocally();
      try {
        const started = Date.now();
        await within(s.stop(), 5000, 'stop()');
        // Idle plain-HTTP connections are closed at once, not left for the
        // force-close after the grace period.
        expect(Date.now() - started).toBeLessThan(CLOSE_GRACE_MS);
      } finally {
        cleanup();
      }
    });
  });
});
