import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type CameraService } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LiveHub } from '../src/media/liveHub.js';
import { OnvifAuthError, OnvifFaultError, OnvifUnreachableError } from '../src/onvif/soap.js';
import { silentLogger } from './helpers.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function appWhosePtzThrows(err: Error) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kasa-errors-'));
  dirs.push(dir);
  const config = loadConfig({
    KASA_HOST: '127.0.0.1',
    KASA_USERNAME: 'parent@example.com',
    KASA_PASSWORD: 'correct horse',
    ALLOWED_CIDRS: '127.0.0.0/8',
    DATA_DIR: dir,
    ALLOW_NO_PASSWORD: 'true',
  });
  const fail = () => Promise.reject(err);
  const camera = {
    info: fail,
    ptz: {
      capability: 'supported',
      step: fail,
      hold: fail,
      stop: fail,
      presets: fail,
      goToPreset: fail,
    },
  } as unknown as CameraService;
  const source = Object.assign(new EventEmitter(), {
    state: 'idle' as const,
    start() {},
    stop() {},
  });
  const hub = new LiveHub({ source, logger: silentLogger, idleTimeoutMs: 0 });
  return buildApp({ config, camera, hub, logger: silentLogger });
}

describe('API answers for standard-camera errors', () => {
  it.each([
    [new OnvifAuthError(), 502, 'camera_auth'],
    [
      new OnvifUnreachableError('No answer from the camera at 192.0.2.4'),
      504,
      'camera_unreachable',
    ],
    [new OnvifFaultError('ActionNotSupported', 'no'), 502, 'camera_error'],
  ])('%s → %i %s', async (err, status, code) => {
    const app = await appWhosePtzThrows(err);
    const res = await app.inject({
      method: 'POST',
      url: '/api/ptz/move',
      payload: { direction: 'left' },
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: code });
    await app.close();
  });
});
