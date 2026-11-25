import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import type os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { LIVE_WS_PATH } from '@kasa/shared';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { hashPassword } from '../src/security/passwordHash.js';
import { CLOSE_GRACE_MS } from '../src/listen.js';
import { lanAddress, startServer, type RunningServer } from '../src/server.js';
import type * as ApiModule from '../src/routes/api.js';
import { SettingsStore } from '../src/settings/store.js';
import { fixture, silentLogger, waitFor } from './helpers.js';
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

/** Reject if the promise is still pending after ms. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} still pending after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
