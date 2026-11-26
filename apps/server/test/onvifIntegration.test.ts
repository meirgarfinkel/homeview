import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BinaryKind, LIVE_WS_PATH, type CodecMessage } from '@kasa/shared';
import { startDevOnvifCamera, type DevOnvifCamera } from '../src/dev/devOnvifCamera.js';
import { startServer, type RunningServer } from '../src/server.js';
import { SettingsStore } from '../src/settings/store.js';
import { silentLogger, waitFor } from './helpers.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'kasa-onvif-e2e-'));
  dirs.push(d);
  return d;
};

let cam: DevOnvifCamera | undefined;
let server: RunningServer | undefined;

afterAll(async () => {
  await server?.stop();
  await cam?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('a standard camera from setup to live view', () => {
  it('sets up through the routes, streams H.265 + AAC and pans', async () => {
    cam = await startDevOnvifCamera({
      password: 'e2e-pass',
      ports: { onvif: 0, rtsp: 0, discovery: 0 },
    });
    server = await startServer({
      env: {
        PORT: '0',
        HOST: '127.0.0.1',
        HTTPS: 'false',
        LOG_LEVEL: 'silent',
        KASA_DISCOVERY_TARGETS: '127.0.0.1',
        ONVIF_DISCOVERY_PORT: String(cam.discoveryPort),
      },
      settings: new SettingsStore(tmp()),
      dataDir: tmp(),
      logger: silentLogger,
    });
    const s = server;
    let cookie = '';
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`${s.localUrl}${url}`, {
        method,
        headers: {
          origin: s.localUrl,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';', 1)[0]!;
      const text = await res.text();
      expect(text).not.toContain('e2e-pass');
      return {
        status: res.status,
        body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      };
    };

    expect((await call('POST', '/api/setup/password', { password: 'lullaby-time' })).status).toBe(
      204,
    );

    const scan = await call('POST', '/api/setup/onvif/scan', {});
    const found = (
      scan.body['cameras'] as { endpointId: string; host: string; port: number }[]
    )[0]!;
    expect(found).toMatchObject({ host: '127.0.0.1', port: cam.onvifPort });

    const login = { host: found.host, port: found.port, username: 'admin', password: 'e2e-pass' };
    const check = await call('POST', '/api/setup/onvif/check', login);
    expect(check.status).toBe(200);
    expect(check.body['picked']).toBe('main');

    const save = await call('POST', '/api/setup/onvif/save', {
      ...login,
      endpointId: found.endpointId,
    });
    expect(save.status).toBe(200);
    await waitFor(() => s.setupComplete(), 8000);

    // The page signs in with the password chosen at the start.
    expect((await call('POST', '/api/login', { password: 'lullaby-time' })).status).toBe(204);

    const ws = new WebSocket(`${s.localUrl.replace('http', 'ws')}${LIVE_WS_PATH}`, {
      origin: s.localUrl,
      headers: { cookie },
    });
    const kinds = new Set<number>();
    let codec: CodecMessage | undefined;
    ws.on('message', (data: Buffer, isBinary) => {
      if (isBinary) kinds.add(data[0]!);
      else {
        const msg = JSON.parse(data.toString()) as { type: string };
        if (msg.type === 'codec') codec = msg as CodecMessage;
      }
    });
    await waitFor(
      () =>
        kinds.has(BinaryKind.VideoInit) &&
        kinds.has(BinaryKind.VideoFragment) &&
        kinds.has(BinaryKind.Audio) &&
        Boolean(codec?.audio),
      10_000,
    );
    expect(codec?.video.mimeType).toContain('hvc1');
    expect(codec?.audio?.codec).toBe('aac');
    ws.terminate();

    expect((await call('POST', '/api/ptz/move', { direction: 'right', mode: 'hold' })).status).toBe(
      204,
    );
    expect((await call('POST', '/api/ptz/stop', {})).status).toBe(204);
    expect(cam.moves).toEqual(['ContinuousMove main 0.5 0', 'Stop main']);

    const presets = await fetch(`${s.localUrl}/api/ptz/presets`, { headers: { cookie } }).then(
      (r) => r.json(),
    );
    expect(presets).toEqual([
      { index: 0, name: 'Crib' },
      { index: 1, name: 'Door' },
    ]);
  });
});
