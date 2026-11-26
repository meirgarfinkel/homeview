import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { LIVE_WS_PATH, type RemoteStatus, type StreamState } from '@kasa/shared';
import { buildApp, type CameraService } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { listenHttp, type DualListener } from '../src/listen.js';
import { LiveHub, type FrameSource } from '../src/media/liveHub.js';
import { RemoteAccess } from '../src/remote/remoteAccess.js';
import { SettingsStore, type Settings } from '../src/settings/store.js';
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
  remote: FixedRemote;
  port: number;
  /** How many times the desktop app's quit hook ran. */
  quits: number;
  /** Builds a new app with the same remote access and swaps it in, like a reload. */
  reload(): Promise<void>;
}

/** Remote access as if the helper were running, with a secret and host the test can change. */
class FixedRemote extends RemoteAccess {
  secretValue: string | undefined = SECRET;
  hostName: string | undefined = HOST;
  /** Reports the tunnel as on, so the pair-code route would hand out codes. */
  on = false;
  override status(): RemoteStatus {
    return this.on ? { ...super.status(), phase: 'on', url: `https://${HOST}` } : super.status();
  }
  override pairUrl(code: string): string | undefined {
    return this.on ? `https://${HOST}/pair#${code}` : super.pairUrl(code);
  }
  override secret(): string | undefined {
    return this.secretValue;
  }
  override host(): string | undefined {
    return this.hostName;
  }
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
  const remote = new FixedRemote({ dataDir: dir, logger: silentLogger });
  const hub = new LiveHub({ source: new StillSource(), logger: silentLogger, idleTimeoutMs: 0 });
  const counts = { quits: 0 };
  // The settings and setup routes, and the quit hook, so the gate has real routes to guard.
  const settings = new SettingsStore(path.join(dir, 'settings'));
  const build = () =>
    buildApp({
      config,
      ...(opts.noCamera ? {} : { camera, hub }),
      logger: silentLogger,
      remote,
      settings,
      hooks: { quit: () => void counts.quits++ },
      desktop: true,
    });
  const app = await build();
  const listener = await listenHttp(app, {
    host: '127.0.0.1',
    port: 0,
    ...(opts.remote === false ? {} : { remote: true }),
  });
  const r = {
    listener,
    app,
    hub,
    remote,
    port: listener.address().port,
    get quits() {
      return counts.quits;
    },
    reload: async () => listener.swap(await build()),
  };
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

  it('keeps counting pairing attempts through a reload', async () => {
    const attempt = () =>
      call(r, '/api/remote/pair', {
        method: 'POST',
        headers: tunnel(undefined, '198.51.100.1'),
        body: { code: 'x'.repeat(22) },
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    await r.reload();
    expect((await attempt()).status).toBe(429);
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
      ['POST', '/api/setup/onvif/scan'],
      ['POST', '/api/setup/onvif/check'],
      ['POST', '/api/setup/onvif/save'],
      ['POST', '/api/setup/kasa-camera'],
      ['POST', '/api/settings/camera-profile'],
    ];
    for (const [method, url] of tries) {
      const body = method === 'GET' ? undefined : {};
      const res = await call(r, url, { method, headers: tunnel(cookie), body });
      expect([url, res.status]).toEqual([url, 403]);
      expect(res.json()).toEqual(localOnly);
    }
    expect(r.quits).toBe(0);
  });

  it('never makes a pairing code through the tunnel, even while remote access is on', async () => {
    r.remote.on = true;
    const { cookie } = await pair(r);
    for (const headers of [tunnel(), tunnel(cookie)]) {
      const res = await call(r, '/api/remote/pair-code', { method: 'POST', headers, body: {} });
      expect(res.status).toBe(403);
      expect(res.json()).toMatchObject({ error: 'local-only' });
      expect(res.body).not.toContain('/pair#');
    }
  });

  it('checks the route a percent-encoded path reaches, not the raw path', async () => {
    // The router decodes paths before it matches, so these reach real routes.
    const { cookie } = await pair(r);
    const tries: [string, string][] = [
      ['GET', '/api/%73ettings'],
      ['GET', '/%61pi/settings'],
      ['GET', '/%61pi/setup/onboarding'],
      ['POST', '/%61pi/app/quit'],
      ['POST', '/api/%61pp/quit'],
    ];
    for (const [method, url] of tries) {
      const body = method === 'GET' ? undefined : {};
      const res = await call(r, url, { method, headers: tunnel(cookie), body });
      expect([url, res.status, res.json().error]).toEqual([url, 403, 'local-only']);
    }
    expect(r.quits).toBe(0);
    for (const url of ['/%61pi/status', '/api/%73tatus']) {
      const res = await call(r, url, { headers: tunnel() });
      expect([url, res.status, res.json().error]).toEqual([url, 401, 'device-not-paired']);
    }
    // A paired phone that hasn't signed in still needs a session behind an encoded path.
    const device = r.remote.devices.add('iPhone');
    const res = await call(r, '/%61pi/status', { headers: tunnel(`kasa_device=${device.token}`) });
    expect([res.status, res.json().error]).toEqual([401, 'unauthorized']);
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

describe('the normal listener with percent-encoded paths', () => {
  const local = (cookie?: string): Record<string, string> =>
    cookie ? { host: '127.0.0.1', cookie } : { host: '127.0.0.1' };

  async function signIn(r: Running): Promise<string> {
    const res = await call(r, '/api/login', {
      method: 'POST',
      headers: local(),
      body: { password: VIEWER },
    });
    expect(res.status).toBe(204);
    return cookieValues(res);
  }

  function openLive(r: Running, url: string, cookie?: string): Promise<number> {
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}${url}`, {
      headers: local(cookie),
    });
    ws.on('error', () => undefined);
    return new Promise<number>((resolve) => {
      ws.once('open', () => {
        ws.close();
        resolve(101);
      });
      ws.once('unexpected-response', (_req, res) => {
        ws.terminate();
        resolve(res.statusCode ?? 0);
      });
    });
  }

  it('needs a session for the route an encoded path reaches', async () => {
    const r = await start({ remote: false });
    for (const url of ['/%61pi/status', '/%61pi/settings', '/api/%73ettings', '/api/%73tatus']) {
      const res = await call(r, url, { headers: local() });
      expect([url, res.status, res.json().error]).toEqual([url, 401, 'unauthorized']);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(await openLive(r, '/%61pi/live')).toBe(401);
    const quit = await call(r, '/%61pi/app/quit', { method: 'POST', headers: local(), body: {} });
    expect(quit.status).toBe(401);
    expect(r.quits).toBe(0);

    const cookie = await signIn(r);
    for (const url of ['/%61pi/status', '/%61pi/settings', '/api/%73ettings']) {
      expect([url, (await call(r, url, { headers: local(cookie) })).status]).toEqual([url, 200]);
    }
    expect(await openLive(r, '/%61pi/live', cookie)).toBe(101);
  });
});
