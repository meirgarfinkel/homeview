import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  accessUnits,
  FakeCamera,
  fakeCameraCertificate,
  LoopingFrameProducer,
} from '../src/dev/fakeCamera.js';
import { Camera } from '../src/kasa/camera.js';
import { CameraWatcher } from '../src/kasa/cameraWatcher.js';
import { discover } from '../src/kasa/discovery.js';
import { fixture, silentLogger } from './helpers.js';

const ACCOUNT = { username: 'parent@example.com', password: 'kasa-account-pw' };
const running: FakeCamera[] = [];

async function cameraAt(
  host: string,
  ports: { api: number; stream: number; discovery: number },
  tls: { key: string; cert: string },
) {
  const cam = new FakeCamera({
    ...ACCOUNT,
    encoding: 'md5',
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 15),
    tls,
  });
  const got = await cam.start(host, ports.stream, ports.api, ports.discovery);
  running.push(cam);
  return { cam, ...got };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((c) => c.stop()));
});

describe('following the camera to a new address', () => {
  it('switches to the new IP only when the certificate matches', async () => {
    const cert = await fakeCameraCertificate();
    const first = await cameraAt('127.0.0.1', { api: 0, stream: 0, discovery: 0 }, cert);
    const ports = { api: first.apiPort, stream: first.streamPort, discovery: first.discoveryPort! };
    const [device] = await discover({ targets: ['127.0.0.1'], port: ports.discovery });
    expect(device?.deviceId).toBeTruthy();

    const config = loadConfig({
      KASA_USERNAME: ACCOUNT.username,
      KASA_PASSWORD: ACCOUNT.password,
      KASA_API_PORT: String(ports.api),
      KASA_STREAM_PORT: String(ports.stream),
      ALLOW_NO_PASSWORD: 'true',
    });
    const camera = new Camera('127.0.0.1', config, silentLogger, device);
    const watcher = new CameraWatcher({
      camera,
      device: device!,
      apiPort: ports.api,
      logger: silentLogger,
      discoveryPort: ports.discovery,
      discoveryTargets: ['127.0.0.1', '127.0.0.2', '127.0.0.3'],
      discoverTimeoutMs: 400,
    });

    // Still where it was: learns the certificate, changes nothing.
    expect(await watcher.check(true)).toBe('unchanged');

    // An impostor elsewhere with the same device ID but its own certificate.
    await first.cam.stop();
    running.splice(running.indexOf(first.cam), 1);
    await cameraAt('127.0.0.3', ports, await fakeCameraCertificate());
    expect(await watcher.check(true)).toBe('rejected');
    expect(camera.host).toBe('127.0.0.1');
    await Promise.all(running.splice(0).map((c) => c.stop()));

    // The real camera, same certificate, new address.
    await cameraAt('127.0.0.2', ports, cert);
    expect(await watcher.check(true)).toBe('moved');
    expect(camera.host).toBe('127.0.0.2');
    expect(camera.linkie.host).toBe('127.0.0.2');
    expect((await camera.info(0)).host).toBe('127.0.0.2');
  });

  it('reports not-found when the camera is off', async () => {
    const cert = await fakeCameraCertificate();
    const { cam, apiPort, discoveryPort } = await cameraAt(
      '127.0.0.1',
      { api: 0, stream: 0, discovery: 0 },
      cert,
    );
    const [device] = await discover({ targets: ['127.0.0.1'], port: discoveryPort! });
    const config = loadConfig({
      KASA_USERNAME: ACCOUNT.username,
      KASA_PASSWORD: ACCOUNT.password,
      KASA_API_PORT: String(apiPort),
      ALLOW_NO_PASSWORD: 'true',
    });
    const camera = new Camera('127.0.0.1', config, silentLogger, device);
    await cam.stop();
    running.length = 0;
    const watcher = new CameraWatcher({
      camera,
      device: device!,
      apiPort,
      logger: silentLogger,
      discoveryPort: discoveryPort!,
      discoveryTargets: ['127.0.0.1'],
      discoverTimeoutMs: 300,
    });
    expect(await watcher.check(true)).toBe('not-found');
    expect(camera.host).toBe('127.0.0.1');
  });
});
