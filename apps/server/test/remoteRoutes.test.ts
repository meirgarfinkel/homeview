import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PairCodeResponse, RemoteStatus, SessionResponse } from '@kasa/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { RemoteAccess } from '../src/remote/remoteAccess.js';
import { writePrivateFile } from '../src/security/dataDir.js';
import { startServer, type RunningServer } from '../src/server.js';
import { SettingsStore } from '../src/settings/store.js';
import { fixture, silentLogger, waitFor } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fakeTunnel.mjs', import.meta.url));
const HOST = 'kasa-home.example.ts.net';
const VIEWER = 'lullaby-time';
const USER = 'parent@example.com';
const PASS = 'correct horse';
const LAN_PHONE = '192.168.1.20';
const SIGN_IN = 'https://login.tailscale.com/a/abc123';

const READY = { event: { type: 'ready', url: `https://${HOST}` } };
const LOGIN = { event: { type: 'login', url: SIGN_IN } };

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kasa-remote-routes-'));
  dirs.push(dir);
  return dir;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  delete process.env['FAKE_TUNNEL_SCRIPT'];
  delete process.env['FAKE_TUNNEL_RECORD'];
});
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Plays this script the next time the fake helper starts. */
function script(...steps: unknown[]): void {
  process.env['FAKE_TUNNEL_SCRIPT'] = JSON.stringify(steps);
}

interface Built {
  app: FastifyInstance;
  remote: RemoteAccess;
  dataDir: string;
  opened: string[];
}

async function build(
  opts: { env?: Record<string, string>; tunnel?: boolean; setUp?: boolean } = {},
): Promise<Built> {
  const dataDir = tmp();
  const env = {
    ALLOWED_CIDRS: '127.0.0.0/8,192.168.0.0/16',
    DATA_DIR: dataDir,
    ...(opts.setUp === false
      ? {}
      : {
          VIEWER_PASSWORD: VIEWER,
          KASA_HOST: '127.0.0.1',
          KASA_USERNAME: USER,
          KASA_PASSWORD: PASS,
        }),
    ...opts.env,
  };
  const config = loadConfig(env, opts.setUp === false ? {} : undefined);
  const opened: string[] = [];
  const remote = new RemoteAccess({
    dataDir,
    ...(opts.tunnel === false
      ? {}
      : {
          tunnel: { command: process.execPath, args: [FAKE], logger: silentLogger, backoffMs: [] },
        }),
    logger: silentLogger,
    openExternal: (url) => opened.push(url),
  });
  remote.attach(4321);
  const app = await buildApp({ config, logger: silentLogger, remote });
  cleanups.push(async () => {
    await remote.stop();
    await app.close();
  });
  return { app, remote, dataDir, opened };
}

interface Answer {
  status: number;
  json<T = Record<string, unknown>>(): T;
  headers: Record<string, unknown>;
}

async function call(
  b: Built,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  opts: { cookie?: string; ip?: string; body?: unknown } = {},
): Promise<Answer> {
  const res = await b.app.inject({
    method,
    url,
    remoteAddress: opts.ip ?? '127.0.0.1',
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
  return { status: res.statusCode, json: <T>() => res.json<T>(), headers: res.headers };
}

async function signIn(b: Built, ip = '127.0.0.1'): Promise<string> {
  const res = await b.app.inject({
    method: 'POST',
    url: '/api/login',
    remoteAddress: ip,
    payload: { password: VIEWER },
  });
  expect(res.statusCode).toBe(204);
  const cookie = res.headers['set-cookie'];
  return (Array.isArray(cookie) ? cookie[0]! : cookie!).split(';', 1)[0]!;
}

async function turnOn(b: Built, cookie: string): Promise<void> {
  script(READY);
  expect((await call(b, 'POST', '/api/remote/enable', { cookie, body: { on: true } })).status).toBe(
    204,
  );
  await waitFor(() => b.remote.status().phase === 'on');
}

const localOnly = {
  error: 'local-only',
  message: 'Only the computer running Kasa Home can do this.',
};

describe('the remote access controls', () => {
  it('GET /api/remote gives the status to this computer', async () => {
    const b = await build();
    const cookie = await signIn(b);
    const res = await call(b, 'GET', '/api/remote', { cookie });
    expect(res.status).toBe(200);
    expect(res.json<RemoteStatus>()).toEqual({
      available: true,
      enabled: false,
      phase: 'off',
      devices: [],
    });
  });

  it('refuses every control to other devices, even signed in', async () => {
    const b = await build();
    const cookie = await signIn(b, LAN_PHONE);
    const tries: [method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown][] = [
      ['GET', '/api/remote'],
      ['POST', '/api/remote/enable', { on: true }],
      ['POST', '/api/remote/open-link'],
      ['POST', '/api/remote/sign-out'],
      ['DELETE', '/api/remote/devices/some-id'],
    ];
    for (const [method, url, body] of tries) {
      const res = await call(b, method, url, { cookie, ip: LAN_PHONE, body });
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.json()).toEqual(localOnly);
    }
    expect(b.remote.status().enabled).toBe(false);
  });

  it('needs a session from this computer too', async () => {
    const b = await build();
    expect((await call(b, 'GET', '/api/remote')).status).toBe(401);
  });

  it('turns remote access on and off', async () => {
    const b = await build();
    const cookie = await signIn(b);
    await turnOn(b, cookie);
    const on = (await call(b, 'GET', '/api/remote', { cookie })).json<RemoteStatus>();
    expect(on).toMatchObject({ enabled: true, phase: 'on', url: `https://${HOST}` });
    const saved = JSON.parse(readFileSync(path.join(b.dataDir, 'remote.json'), 'utf8')) as {
      enabled: boolean;
    };
    expect(saved.enabled).toBe(true);

    const off = await call(b, 'POST', '/api/remote/enable', { cookie, body: { on: false } });
    expect(off.status).toBe(204);
    expect(b.remote.status()).toMatchObject({ enabled: false, phase: 'off' });
    expect(b.remote.status().url).toBeUndefined();
  });

  it('refuses to turn on without a viewer password', async () => {
    const b = await build({ env: { ALLOW_NO_PASSWORD: 'true' }, setUp: false });
    const res = await call(b, 'POST', '/api/remote/enable', { body: { on: true } });
    expect(res.status).toBe(409);
    expect(res.json()).toEqual({
      error: 'needs-password',
      message: 'Set up Kasa Home and choose a password first.',
    });
    expect(b.remote.status()).toMatchObject({ enabled: false, phase: 'off' });
  });

  it('refuses to turn on when set up with open access', async () => {
    const b = await build({
      env: {
        ALLOW_NO_PASSWORD: 'true',
        KASA_HOST: '127.0.0.1',
        KASA_USERNAME: USER,
        KASA_PASSWORD: PASS,
      },
      setUp: false,
    });
    const res = await call(b, 'POST', '/api/remote/enable', { body: { on: true } });
    expect(res.status).toBe(409);
    expect(res.json()).toMatchObject({ error: 'needs-password' });
  });

  it('refuses to turn on outside the desktop app', async () => {
    const b = await build({ tunnel: false });
    const cookie = await signIn(b);
    const status = await call(b, 'GET', '/api/remote', { cookie });
    expect(status.json()).toMatchObject({ available: false, phase: 'off' });
    const res = await call(b, 'POST', '/api/remote/enable', { cookie, body: { on: true } });
    expect(res.status).toBe(409);
    expect(res.json()).toEqual({
      error: 'not-available',
      message: 'This is only available in the Kasa Home app.',
    });
    expect(b.remote.status().enabled).toBe(false);
  });

  it('opens the sign-in link in the browser', async () => {
    const b = await build();
    const cookie = await signIn(b);
    script(LOGIN);
    await call(b, 'POST', '/api/remote/enable', { cookie, body: { on: true } });
    await waitFor(() => b.remote.status().phase === 'sign-in');
    const res = await call(b, 'POST', '/api/remote/open-link', { cookie });
    expect(res.status).toBe(204);
    expect(b.opened).toEqual([SIGN_IN]);
  });

  it('never opens a link that is not a Tailscale sign-in page', async () => {
    const b = await build();
    const cookie = await signIn(b);
    script(
      { event: { type: 'login', url: 'https://login.tailscale.com.evil.example/a/abc' } },
      { waitMs: 100 },
      { event: { type: 'enable', url: 'http://login.tailscale.com/f/funnel' } },
    );
    await call(b, 'POST', '/api/remote/enable', { cookie, body: { on: true } });
    await waitFor(() => b.remote.status().phase === 'sign-in');
    expect((await call(b, 'POST', '/api/remote/open-link', { cookie })).status).toBe(409);
    await waitFor(() => b.remote.status().phase === 'approve');
    expect((await call(b, 'POST', '/api/remote/open-link', { cookie })).status).toBe(409);
    expect(b.opened).toEqual([]);
  });

  it('has no link to open while off', async () => {
    const b = await build();
    const cookie = await signIn(b);
    expect((await call(b, 'POST', '/api/remote/open-link', { cookie })).status).toBe(409);
  });

  it('signs out of Tailscale', async () => {
    const b = await build();
    const cookie = await signIn(b);
    await turnOn(b, cookie);
    const state = path.join(b.dataDir, 'tunnel');
    expect(existsSync(state)).toBe(true);
    expect((await call(b, 'POST', '/api/remote/sign-out', { cookie })).status).toBe(204);
    expect(b.remote.status()).toMatchObject({ enabled: false, phase: 'off' });
    expect(existsSync(state)).toBe(false);
  });

  it('removes a paired device', async () => {
    const b = await build();
    const cookie = await signIn(b);
    const { device } = b.remote.devices.add('iPhone');
    const res = await call(b, 'DELETE', `/api/remote/devices/${device.id}`, { cookie });
    expect(res.status).toBe(204);
    expect(b.remote.status().devices).toEqual([]);
    const again = await call(b, 'DELETE', `/api/remote/devices/${device.id}`, { cookie });
    expect(again.status).toBe(404);
  });

  describe('pair-code', () => {
    it('is refused while remote access is off', async () => {
      const b = await build();
      const cookie = await signIn(b);
      const res = await call(b, 'POST', '/api/remote/pair-code', { cookie });
      expect(res.status).toBe(409);
      expect(res.json()).toMatchObject({ error: 'remote-off' });
    });

    it('gives this computer a pairing address', async () => {
      const b = await build();
      const cookie = await signIn(b);
      await turnOn(b, cookie);
      const res = await call(b, 'POST', '/api/remote/pair-code', { cookie });
      expect(res.status).toBe(200);
      const body = res.json<PairCodeResponse>();
      expect(body.url).toMatch(/^https:\/\/kasa-home\.example\.ts\.net\/pair#[A-Za-z0-9_-]{22}$/);
      const left = new Date(body.expiresAt).getTime() - Date.now();
      expect(left).toBeGreaterThan(9 * 60_000);
      expect(left).toBeLessThanOrEqual(10 * 60_000);
      expect(b.remote.pairing.consume(body.url.split('#')[1]!)).toBe(true);
    });

    it('gives a phone signed in at home a pairing address', async () => {
      const b = await build();
      await turnOn(b, await signIn(b));
      const phone = await signIn(b, LAN_PHONE);
      const res = await call(b, 'POST', '/api/remote/pair-code', { cookie: phone, ip: LAN_PHONE });
      expect(res.status).toBe(200);
      expect(res.json<PairCodeResponse>().url).toMatch(/\/pair#/);
    });

    it('needs a session', async () => {
      const b = await build();
      await turnOn(b, await signIn(b));
      const res = await call(b, 'POST', '/api/remote/pair-code', { ip: LAN_PHONE });
      expect(res.status).toBe(401);
    });
  });

  it('tells the session whether remote access is on', async () => {
    const b = await build();
    const cookie = await signIn(b, LAN_PHONE);
    const before = (await call(b, 'GET', '/api/session', { cookie, ip: LAN_PHONE })).json();
    expect(before).not.toHaveProperty('remoteOn');
    await turnOn(b, await signIn(b));
    const after = await call(b, 'GET', '/api/session', { cookie, ip: LAN_PHONE });
    expect(after.json<SessionResponse>()).toMatchObject({ remoteOn: true, local: false });
    expect(after.json()).not.toHaveProperty('remote');
  });
});

describe('the server with remote access', () => {
  let fake: FakeCamera;
  let cameraEnv: Record<string, string>;

  beforeAll(async () => {
    fake = new FakeCamera({
      username: USER,
      password: PASS,
      encoding: 'md5',
      video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 30),
    });
    const ports = await fake.start();
    cameraEnv = {
      PORT: '0',
      HOST: '127.0.0.1',
      HTTPS: 'false',
      LOG_LEVEL: 'silent',
      VIEWER_PASSWORD: VIEWER,
      KASA_USERNAME: USER,
      KASA_PASSWORD: PASS,
      KASA_HOST: '127.0.0.1',
      KASA_API_PORT: String(ports.apiPort),
      KASA_STREAM_PORT: String(ports.streamPort),
      KASA_SYNC_TIMEZONE: 'false',
    };
  });
  afterAll(async () => {
    await fake.stop();
  });

  interface Start {
    pid: number;
    argv: string[];
    secret: string;
  }

  /** Starts the server with remote access left on, and the fake helper as its tunnel. */
  async function startWithRemoteOn(): Promise<{
    server: RunningServer;
    starts: () => Start[];
  }> {
    const dataDir = tmp();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writePrivateFile(
      path.join(dataDir, 'remote.json'),
      JSON.stringify({ enabled: true, devices: [] }),
    );
    const record = path.join(dataDir, 'starts.jsonl');
    process.env['FAKE_TUNNEL_RECORD'] = record;
    script(READY);
    const server = await startServer({
      env: cameraEnv,
      settings: new SettingsStore(tmp()),
      dataDir,
      logger: silentLogger,
      tunnel: { command: process.execPath, args: [FAKE] },
    });
    cleanups.push(() => server.stop());
    const starts = () =>
      existsSync(record)
        ? readFileSync(record, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as Start)
        : [];
    return { server, starts };
  }

  /** A request the way the helper sends it to the remote listener. */
  function throughTunnel(start: Start, url: string): Promise<{ status: number; body: string }> {
    const port = Number(start.argv[start.argv.indexOf('--target') + 1]!.split(':')[1]);
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port,
          path: url,
          headers: { host: HOST, 'x-kasa-tunnel': start.secret, 'x-forwarded-for': '203.0.113.7' },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
    });
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('starts the tunnel when remote access was left on', async () => {
    const { server, starts } = await startWithRemoteOn();
    await waitFor(() => starts().length === 1);
    const [start] = starts() as [Start];
    const target = start.argv[start.argv.indexOf('--target') + 1];
    expect(target).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(target).not.toBe(`127.0.0.1:${server.port}`);
  });

  it('keeps the remote listener and the tunnel through a reload, and ends both on stop', async () => {
    const { server, starts } = await startWithRemoteOn();
    await waitFor(() => starts().length === 1);
    const [start] = starts() as [Start];
    // Until the helper says it's ready, the remote listener answers 503.
    let before = await throughTunnel(start, '/api/health');
    for (let i = 0; i < 100 && before.status === 503; i++) {
      await new Promise((r) => setTimeout(r, 20));
      before = await throughTunnel(start, '/api/health');
    }
    expect(before).toEqual({ status: 200, body: '{"ok":true}' });
    await server.reload();
    const after = await throughTunnel(start, '/api/health');
    expect(after).toEqual({ status: 200, body: '{"ok":true}' });
    expect(starts()).toHaveLength(1);
    expect(alive(start.pid)).toBe(true);

    await server.stop();
    expect(alive(start.pid)).toBe(false);
    await expect(throughTunnel(start, '/api/health')).rejects.toThrow();
  });

  it('answers with available false and binds no remote listener without the helper', async () => {
    process.env['FAKE_TUNNEL_RECORD'] = path.join(tmp(), 'starts.jsonl');
    const server = await startServer({
      env: cameraEnv,
      settings: new SettingsStore(tmp()),
      dataDir: tmp(),
      logger: silentLogger,
    });
    cleanups.push(() => server.stop());
    const login = await fetch(`${server.localUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: VIEWER }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!;
    const res = await fetch(`${server.localUrl}/api/remote`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: false, enabled: false, phase: 'off' });
  });
});
