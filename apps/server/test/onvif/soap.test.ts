import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeOnvif, type FakeOnvif } from '../../src/dev/fakeOnvif.js';
import {
  OnvifAuthError,
  OnvifUnreachableError,
  passwordDigest,
  SoapClient,
} from '../../src/onvif/soap.js';
import { silentLogger } from '../helpers.js';
import { BASE_FAKE } from './fixtures.js';

const USER = BASE_FAKE.username;
const PASS = BASE_FAKE.password;
const DEVICE_INFO = '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>';

let fake: FakeOnvif | undefined;
let server: http.Server | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

function client(deviceUrl: string, password = PASS, timeoutMs?: number) {
  return new SoapClient({
    deviceUrl,
    username: USER,
    password,
    allowPublicHost: false,
    logger: silentLogger,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

/** A server that answers every POST with `body` and `status`. */
async function rawServer(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/onvif/device_service`;
}

describe('SoapClient', () => {
  it('PasswordDigest matches the ONVIF spec example', () => {
    const nonce = Buffer.from('LKqI6G/AikKCQrN0zqZFlg==', 'base64');
    expect(passwordDigest(nonce, '2010-09-16T07:50:45Z', 'userpassword')).toBe(
      'tuOSpGlFlIXsozq4HFNeeGeFLEI=',
    );
  });

  it('signs in with WS-Security', async () => {
    fake = await startFakeOnvif(BASE_FAKE);
    const body = await client(fake.deviceUrl).call(fake.deviceUrl, DEVICE_INFO);
    expect(JSON.stringify(body)).toContain('FakeCam');
  });

  it('a camera clock 3 years ahead still accepts the request', async () => {
    fake = await startFakeOnvif({ ...BASE_FAKE, clockSkewMs: 3 * 365 * 86_400_000 });
    await expect(client(fake.deviceUrl).call(fake.deviceUrl, DEVICE_INFO)).resolves.toBeDefined();
  });

  it('falls back to HTTP Digest and remembers it', async () => {
    fake = await startFakeOnvif({ ...BASE_FAKE, auth: 'digest' });
    const c = client(fake.deviceUrl);
    await c.call(fake.deviceUrl, DEVICE_INFO);
    const before = fake.wsSecurityAttempts;
    await c.call(fake.deviceUrl, DEVICE_INFO);
    expect(fake.wsSecurityAttempts).toBe(before);
  });

  it('a wrong password gives OnvifAuthError', async () => {
    fake = await startFakeOnvif(BASE_FAKE);
    await expect(
      client(fake.deviceUrl, 'wrong').call(fake.deviceUrl, DEVICE_INFO),
    ).rejects.toBeInstanceOf(OnvifAuthError);
  });

  it('the password is not in any error message', async () => {
    fake = await startFakeOnvif({ ...BASE_FAKE, auth: 'digest' });
    const err = await client(fake.deviceUrl, `${PASS}x`)
      .call(fake.deviceUrl, DEVICE_INFO)
      .catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(PASS);
  });

  it('rejects a DOCTYPE answer', async () => {
    const url = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><Envelope><Body>&a;</Body></Envelope>',
      );
    });
    await expect(client(url).call(url, DEVICE_INFO)).rejects.toThrow(/DOCTYPE/);
  });

  it('rejects an answer over 256 KiB', async () => {
    const url = await rawServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/soap+xml' });
      res.end(`<Envelope><Body>${'x'.repeat(300 * 1024)}</Body></Envelope>`);
    });
    await expect(client(url).call(url, DEVICE_INFO)).rejects.toThrow(/too large/);
  });

  it('a redirect is an error', async () => {
    const url = await rawServer((_req, res) => {
      res.writeHead(302, { Location: 'http://192.0.2.1/elsewhere' });
      res.end();
    });
    await expect(client(url).call(url, DEVICE_INFO)).rejects.toThrow(/redirect/i);
  });

  it('times out when the camera never answers', async () => {
    const url = await rawServer(() => undefined);
    await expect(client(url, PASS, 200).call(url, DEVICE_INFO)).rejects.toBeInstanceOf(
      OnvifUnreachableError,
    );
  });

  it('refuses a public device address', async () => {
    await expect(
      client('http://8.8.8.8/onvif/device_service').call(
        'http://8.8.8.8/onvif/device_service',
        DEVICE_INFO,
      ),
    ).rejects.toThrow(/not a local-network address/);
  });
});
