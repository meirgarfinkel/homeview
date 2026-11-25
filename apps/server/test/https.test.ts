import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import type os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ConfigError, loadConfig } from '../src/config.js';
import { listenHttpsWithRedirect, type DualListener } from '../src/listen.js';
import { loadOrCreateSecret } from '../src/security/dataDir.js';
import { localNetworkCidrs } from '../src/security/network.js';
import { loadOrCreateCertificate } from '../src/security/tlsCert.js';

const base = { KASA_USERNAME: 'u@example.com', KASA_PASSWORD: 'p' };
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kasa-data-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('config', () => {
  it('refuses to start without a viewer password', () => {
    expect(() => loadConfig(base)).toThrow(ConfigError);
    expect(() => loadConfig(base)).toThrow(/VIEWER_PASSWORD/);
  });

  it('accepts a password, or an explicit opt-out', () => {
    expect(loadConfig({ ...base, VIEWER_PASSWORD: 'long enough' }).viewer).toEqual({
      kind: 'plain',
      password: 'long enough',
    });
    expect(loadConfig({ ...base, ALLOW_NO_PASSWORD: 'true' }).viewer).toBeUndefined();
  });

  it('rejects short passwords and half-configured TLS', () => {
    expect(() => loadConfig({ ...base, VIEWER_PASSWORD: 'short' })).toThrow(/8 characters/);
    expect(() =>
      loadConfig({ ...base, ALLOW_NO_PASSWORD: 'true', TLS_CERT_FILE: '/x.crt' }),
    ).toThrow(/TLS_KEY_FILE/);
  });

  it('enables HTTPS by default', () => {
    expect(loadConfig({ ...base, ALLOW_NO_PASSWORD: 'true' }).https.enabled).toBe(true);
  });
});

describe('generated secrets', () => {
  it('creates a persistent owner-only session secret', () => {
    const a = loadOrCreateSecret(dir, 'session-secret');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateSecret(dir, 'session-secret')).toBe(a);
    expect(statSync(path.join(dir, 'session-secret')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('creates a certificate for localhost and reuses it', async () => {
    const first = await loadOrCreateCertificate(dir);
    expect(first.renewed).toBe(true);
    const x509 = new X509Certificate(first.cert);
    expect(x509.subjectAltName).toContain('DNS:localhost');
    expect(x509.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(statSync(path.join(dir, 'tls', 'server.key')).mode & 0o777).toBe(0o600);
    const second = await loadOrCreateCertificate(dir);
    expect(second.renewed).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});

describe('localNetworkCidrs', () => {
  it('keeps the real LAN, drops container bridges and public IPv6', () => {
    const iface = (address: string, cidr: string, family: 'IPv4' | 'IPv6' = 'IPv4') => ({
      address,
      cidr,
      family,
      netmask: '',
      mac: '00:00:00:00:00:00',
      internal: false,
      ...(family === 'IPv6' ? { scopeid: 0 } : {}),
    });
    const cidrs = localNetworkCidrs({
      wlp0s20f3: [
        iface('192.168.1.20', '192.168.1.20/24'),
        iface('2a06:c701::1', '2a06:c701::1/64', 'IPv6'),
        iface('fe80::1', 'fe80::1/64', 'IPv6'),
      ],
      docker0: [iface('172.17.0.1', '172.17.0.1/16')],
      'br-7122010b4b18': [iface('172.19.0.1', '172.19.0.1/16')],
    } as unknown as ReturnType<typeof os.networkInterfaces>);
    expect(cidrs).toEqual(['127.0.0.0/8', '::1/128', '192.168.1.20/24']);
  });
});

describe('HTTPS listener with HTTP redirect', () => {
  let listener: DualListener;
  let port: number;
  // Every test client connects from 127.0.0.1, so this listener treats
  // them as another computer on the network.
  let remoteListener: DualListener;
  let remotePort: number;

  async function listen(isLocalClient?: (ip: string | undefined) => boolean) {
    const tls = await loadOrCreateCertificate(dir);
    const app: FastifyInstance = Fastify({ https: { key: tls.key, cert: tls.cert } });
    app.get('/hello', async () => ({ hi: true }));
    return listenHttpsWithRedirect(app, {
      host: '127.0.0.1',
      port: 0,
      allowClient: (ip) => ip === '127.0.0.1',
      ...(isLocalClient ? { isLocalClient } : {}),
    });
  }

  beforeAll(async () => {
    listener = await listen();
    port = listener.address().port;
    remoteListener = await listen(() => false);
    remotePort = remoteListener.address().port;
  });
  afterAll(async () => {
    await listener.close();
    await remoteListener.close();
  });

  const raw = (data: string, to = port) =>
    new Promise<string>((resolve, reject) => {
      const sock = net.connect(to, '127.0.0.1', () => sock.write(data));
      let out = '';
      sock.on('data', (d) => {
        out += d.toString();
        // A served response keeps the connection open; stop once it is complete.
        const [head, body] = out.split('\r\n\r\n', 2);
        const length = /\r\ncontent-length: (\d+)/i.exec(head ?? '')?.[1];
        if (body !== undefined && length !== undefined && body.length >= Number(length)) {
          sock.destroy();
          resolve(out);
        }
      });
      sock.on('end', () => resolve(out));
      sock.on('close', () => resolve(out));
      sock.on('error', reject);
    });
  const fromAnotherComputer = (data: string) => raw(data, remotePort);

  it('serves HTTPS', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get({ host: '127.0.0.1', port, path: '/hello', rejectUnauthorized: false }, (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => resolve(b));
        })
        .on('error', reject);
    });
    expect(JSON.parse(body)).toEqual({ hi: true });
  });

  it('serves plain HTTP to this computer instead of redirecting', async () => {
    const res = await raw('GET /hello HTTP/1.1\r\nHost: localhost\r\n\r\n');
    expect(res).toMatch(/^HTTP\/1\.1 200/);
    expect(res).toContain('{"hi":true}');
  });

  it('redirects plain HTTP to the same host over HTTPS', async () => {
    const res = await fromAnotherComputer(
      'GET /some/page?x=1 HTTP/1.1\r\nHost: 192.168.1.20:8090\r\n\r\n',
    );
    expect(res).toMatch(/^HTTP\/1\.1 308/);
    expect(res).toContain(`Location: https://192.168.1.20:${remotePort}/some/page?x=1\r\n`);
  });

  it.each(['evil.com/"><script>', 'a b', 'x\u0000y', ''])(
    'refuses to echo a Host header that is not a plain hostname (%j)',
    async (host) => {
      const res = await fromAnotherComputer(`GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
      expect(res).toMatch(/^HTTP\/1\.1 400/);
      expect(res).not.toContain('Location');
    },
  );

  it('never redirects to a host taken from the request line', async () => {
    const res = await fromAnotherComputer(
      'GET http://evil.com/x HTTP/1.1\r\nHost: 192.168.1.20\r\n\r\n',
    );
    expect(res).toContain(`Location: https://192.168.1.20:${remotePort}/\r\n`);
  });
});
