import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { LIVE_WS_PATH, type StreamState } from '@kasa/shared';
import { buildApp, type CameraService, type RemoteGateDeps } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { listenHttp, type DualListener } from '../src/listen.js';
import { LiveHub, type FrameSource } from '../src/media/liveHub.js';
import { DeviceStore } from '../src/remote/devices.js';
import { PairingCodes } from '../src/remote/pairing.js';
import type { Settings } from '../src/settings/store.js';
import { TEST_PAGE_MARKER } from './setup/staticDir.js';
import { silentLogger, waitFor } from './helpers.js';

const SECRET = 's3cret';
const HOST = 'kasa-home.example.ts.net';
const VIEWER = 'lullaby-time';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

class StillSource extends EventEmitter implements FrameSource {
  readonly state: StreamState = 'idle';
  start(): void {}
  stop(): void {}
}

const camera = {
  info: async () => ({ model: 'fake' }),
  ptz: { capability: { supported: false } },
} as unknown as CameraService;

interface Running {
  listener: DualListener;
  app: FastifyInstance;
  hub: LiveHub;
  remote: RemoteGateDeps & { hostName: string | undefined; secretValue: string | undefined };
  port: number;
}

const running: Running[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.hub.close();
    await r.listener.close();
  }
});

async function start(
  opts: {
    remote?: boolean;
    env?: Record<string, string>;
    settings?: Settings;
    noCamera?: boolean;
  } = {},
): Promise<Running> {
  const dir = mkdtempSync(path.join(tmpdir(), 'kasa-remote-'));
  dirs.push(dir);
  const config = loadConfig(
    {
      VIEWER_PASSWORD: VIEWER,
      KASA_HOST: '127.0.0.1',
      KASA_USERNAME: 'parent@example.com',
      KASA_PASSWORD: 'correct horse',
      ALLOWED_CIDRS: '127.0.0.0/8',
      DATA_DIR: dir,
      ...opts.env,
    },
    opts.settings,
  );
  const remote = {
    secretValue: SECRET as string | undefined,
    hostName: HOST as string | undefined,
    secret() {
      return this.secretValue;
    },
    host() {
      return this.hostName;
    },
    devices: new DeviceStore(dir, silentLogger),
    pairing: new PairingCodes(),
  };
  const hub = new LiveHub({ source: new StillSource(), logger: silentLogger, idleTimeoutMs: 0 });
  const app = await buildApp({
    config,
    ...(opts.noCamera ? {} : { camera, hub }),
    logger: silentLogger,
    remote,
  });
  const listener = await listenHttp(app, {
    host: '127.0.0.1',
    port: 0,
    ...(opts.remote === false ? {} : { remote: true }),
  });
  const r = { listener, app, hub, remote, port: listener.address().port };
  running.push(r);
  return r;
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json(): Record<string, unknown>;
}

function call(
  r: Running,
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string | undefined>;
    body?: unknown;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) if (v !== undefined) headers[k] = v;
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  if (payload) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: r.port, path: url, method: opts.method ?? 'GET', headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body) as Record<string, unknown>,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** Headers the tunnel helper adds, plus any cookies. */
function tunnel(cookie?: string, ip = '203.0.113.7'): Record<string, string | undefined> {
  return { host: HOST, 'x-kasa-tunnel': SECRET, 'x-forwarded-for': ip, cookie };
}

function cookieValues(res: Answer): string {
  return (res.headers['set-cookie'] ?? []).map((c) => c.split(';', 1)[0]).join('; ');
}

/** Pair one phone and return its cookies (device and session). */
async function pair(r: Running, ip?: string): Promise<{ cookie: string; res: Answer }> {
  const { code } = r.remote.pairing.create();
  const res = await call(r, '/api/remote/pair', {
    method: 'POST',
    headers: { ...tunnel(undefined, ip), 'user-agent': IPHONE },
    body: { code },
  });
  expect(res.status).toBe(200);
  return { cookie: cookieValues(res), res };
}

describe('the remote gate', () => {
  let r: Running;
  beforeEach(async () => {
    r = await start();
  });

  it('refuses requests without the right tunnel secret', async () => {
    expect((await call(r, '/api/health', { headers: { host: HOST } })).status).toBe(403);
    const wrong = await call(r, '/api/health', {
      headers: { ...tunnel(), 'x-kasa-tunnel': 'nope' },
    });
    expect(wrong.status).toBe(403);
    r.remote.secretValue = undefined;
    expect((await call(r, '/api/health', { headers: tunnel() })).status).toBe(403);
  });

  it('refuses other host names, and waits until the host name is known', async () => {
    const evil = await call(r, '/api/health', { headers: { ...tunnel(), host: 'evil.example' } });
    expect(evil.status).toBe(403);
    r.remote.hostName = undefined;
    expect((await call(r, '/api/health', { headers: tunnel() })).status).toBe(503);
  });

  it('asks an unpaired phone to pair, but serves health and the page', async () => {
    const session = await call(r, '/api/session', { headers: tunnel() });
    expect(session.status).toBe(401);
    expect(session.json()).toEqual({
      error: 'device-not-paired',
      message:
        "This phone isn't set up to watch from away. At home, scan the code in Kasa Home on your computer.",
    });
    expect((await call(r, '/api/health', { headers: tunnel() })).status).toBe(200);
    const page = await call(r, '/', { headers: tunnel() });
    expect(page.status).toBe(200);
    expect(page.body).toContain(TEST_PAGE_MARKER);
    expect(page.headers['content-security-policy']).toContain(`connect-src 'self' wss://${HOST}`);
    expect(page.headers['content-security-policy']).not.toContain('ws://');
  });

  it('pairs a phone with a fresh code, once', async () => {
    const { code } = r.remote.pairing.create();
    const first = await call(r, '/api/remote/pair', {
      method: 'POST',
      headers: { ...tunnel(), 'user-agent': IPHONE },
      body: { code },
    });
    expect(first.status).toBe(200);
    const cookies = first.headers['set-cookie'] ?? [];
    const device = cookies.find((c) => c.startsWith('kasa_device='));
    const session = cookies.find((c) => c.startsWith('kasa_session='));
    expect(device).toMatch(/; HttpOnly; Secure; SameSite=Strict/);
    expect(session).toMatch(/; Secure/);
    expect(r.remote.devices.list().map((d) => d.name)).toEqual(['iPhone']);

    const again = await call(r, '/api/remote/pair', {
      method: 'POST',
      headers: tunnel(),
      body: { code },
    });
    expect(again.status).toBe(401);
    expect(again.json()).toMatchObject({ error: 'bad-code' });
  });

  it('limits pairing attempts per address', async () => {
    const attempt = (ip: string) =>
      call(r, '/api/remote/pair', {
        method: 'POST',
        headers: tunnel(undefined, ip),
        body: { code: 'x'.repeat(22) },
      });
    for (let i = 0; i < 10; i++) expect((await attempt('198.51.100.1')).status).toBe(401);
    expect((await attempt('198.51.100.1')).status).toBe(429);
    expect((await attempt('198.51.100.2')).status).toBe(401);
  });

  it('limits pairing attempts overall', async () => {
    const attempt = (i: number) =>
      call(r, '/api/remote/pair', {
        method: 'POST',
        headers: tunnel(undefined, `198.51.100.${i}`),
        body: { code: 'x'.repeat(22) },
      });
    for (let i = 0; i < 30; i++) expect((await attempt(i)).status).toBe(401);
    expect((await attempt(31)).status).toBe(429);
  });

  it('lets a paired phone see the session, and asks it to sign in for the camera', async () => {
    const { code } = r.remote.pairing.create();
    const device = r.remote.devices.add('iPhone');
    expect(code).toBeTruthy();
    const cookie = `kasa_device=${device.token}`;
    const session = await call(r, '/api/session', { headers: tunnel(cookie) });
    expect(session.status).toBe(200);
    const body = session.json();
    expect(body).toMatchObject({ remote: true, local: false, authenticated: false });
    expect(body).not.toHaveProperty('lanUrl');
    const status = await call(r, '/api/status', { headers: tunnel(cookie) });
    expect(status.status).toBe(401);
    expect(status.json()).toMatchObject({ error: 'unauthorized' });
    expect(r.remote.devices.list()[0]!.lastSeenAt).toBeDefined();
  });

  it('signs a paired phone in with Secure cookies', async () => {
    const device = r.remote.devices.add('iPhone');
    const login = await call(r, '/api/login', {
      method: 'POST',
      headers: tunnel(`kasa_device=${device.token}`),
      body: { password: VIEWER },
    });
    expect(login.status).toBe(204);
    expect(login.headers['set-cookie']?.[0]).toMatch(/^kasa_session=.*; Secure/);
    const logout = await call(r, '/api/logout', {
      method: 'POST',
      headers: tunnel(`kasa_device=${device.token}`),
    });
    expect(logout.headers['set-cookie']?.[0]).toMatch(/; Secure/);
  });

  it('lets a paired, signed-in phone watch', async () => {
    const { cookie } = await pair(r);
    const status = await call(r, '/api/status', { headers: tunnel(cookie) });
    expect(status.status).toBe(200);
  });

  it('never lets a remote request act as this computer', async () => {
    const { cookie } = await pair(r);
    const localOnly = {
      error: 'local-only',
      message: "This can't be done from away. Use Kasa Home at home.",
    };
    const tries: [string, string][] = [
      ['GET', '/api/setup/status'],
      ['GET', '/api/settings'],
      ['PUT', '/api/settings/viewer-password'],
      ['POST', '/api/app/quit'],
      ['GET', '/api/remote/devices'],
      ['POST', '/api/remote/pair-code'],
    ];
    for (const [method, url] of tries) {
      const body = method === 'GET' ? undefined : {};
      const res = await call(r, url, { method, headers: tunnel(cookie), body });
      expect([url, res.status]).toEqual([url, 403]);
      expect(res.json()).toEqual(localOnly);
    }
    // An encoded path doesn't reach the settings route either.
    expect((await call(r, '/api/%73ettings', { headers: tunnel(cookie) })).status).toBe(404);
  });

  it('refuses cross-origin changes', async () => {
    const { code } = r.remote.pairing.create();
    const res = await call(r, '/api/remote/pair', {
      method: 'POST',
      headers: { ...tunnel(), origin: 'https://evil.example' },
      body: { code },
    });
    expect(res.status).toBe(403);
    const same = await call(r, '/api/remote/pair', {
      method: 'POST',
      headers: { ...tunnel(), origin: `https://${HOST}` },
      body: { code },
    });
    expect(same.status).toBe(200);
  });

  it('closes the live view of a removed phone, and refuses it after that', async () => {
    const { cookie } = await pair(r);
    const id = r.remote.devices.list()[0]!.id;
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}${LIVE_WS_PATH}`, {
      headers: { ...tunnel(cookie), origin: `https://${HOST}` } as Record<string, string>,
    });
    ws.on('error', () => undefined);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    await waitFor(() => r.hub.viewerCount === 1);
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    expect(r.remote.devices.remove(id)).toBe(true);
    expect(await closed).toBe(4401);
    await waitFor(() => r.hub.viewerCount === 0);
    expect(r.remote.devices.listenerCount('removed')).toBe(0);

    const next = await call(r, '/api/session', { headers: tunnel(cookie) });
    expect(next.status).toBe(401);
    expect(next.json()).toMatchObject({ error: 'device-not-paired' });
  });

  it('unsubscribes a live view that closes on its own', async () => {
    const { cookie } = await pair(r);
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}${LIVE_WS_PATH}`, {
      headers: tunnel(cookie) as Record<string, string>,
    });
    ws.on('error', () => undefined);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    await waitFor(() => r.remote.devices.listenerCount('removed') === 1);
    ws.close();
    await waitFor(() => r.remote.devices.listenerCount('removed') === 0);
  });
});

describe('the remote gate before setup', () => {
  it('refuses everything but health when setup is not complete', async () => {
    const r = await start({
      env: { VIEWER_PASSWORD: '', KASA_USERNAME: '', KASA_PASSWORD: '' },
      settings: {},
      noCamera: true,
    });
    const device = r.remote.devices.add('iPhone');
    for (const url of ['/api/session', '/api/status', '/api/login']) {
      const res = await call(r, url, { headers: tunnel(`kasa_device=${device.token}`) });
      expect([url, res.status, res.json().error]).toEqual([url, 403, 'not-set-up']);
    }
    const { code } = r.remote.pairing.create();
    const res = await call(r, '/api/remote/pair', {
      method: 'POST',
      headers: tunnel(),
      body: { code },
    });
    expect(res.status).toBe(403);
    expect((await call(r, '/api/health', { headers: tunnel() })).status).toBe(200);
  });

  it('refuses everything but health without a viewer password', async () => {
    const r = await start({ env: { VIEWER_PASSWORD: '', ALLOW_NO_PASSWORD: 'true' } });
    const device = r.remote.devices.add('iPhone');
    const res = await call(r, '/api/status', { headers: tunnel(`kasa_device=${device.token}`) });
    expect(res.status).toBe(403);
    expect(res.json()).toMatchObject({ error: 'not-set-up' });
    expect((await call(r, '/api/health', { headers: tunnel() })).status).toBe(200);
  });
});

describe('the normal listener', () => {
  it('has no pair route, and ignores the tunnel headers', async () => {
    const r = await start({ remote: false });
    const { code } = r.remote.pairing.create();
    const res = await call(r, '/api/remote/pair', {
      method: 'POST',
      headers: { ...tunnel(), host: '127.0.0.1' },
      body: { code },
    });
    expect(res.status).toBe(404);
    const session = await call(r, '/api/session', { headers: { ...tunnel(), host: '127.0.0.1' } });
    expect(session.status).toBe(200);
    expect(session.json()).toMatchObject({ local: true });
    expect(session.json()).not.toHaveProperty('remote');
  });
});
