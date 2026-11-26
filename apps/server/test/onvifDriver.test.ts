import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaFrame } from '../src/camera/driver.js';
import { OnvifDriver, type OnvifCameraConfig } from '../src/camera/onvifDriver.js';
import { startFakeOnvif, type FakeOnvif, type FakeOnvifOptions } from '../src/dev/fakeOnvif.js';
import { startFakeRtsp, type FakeRtsp } from '../src/dev/fakeRtsp.js';
import { silentLogger, waitFor } from './helpers.js';
import { BASE_FAKE } from './onvif/fixtures.js';

const USER = BASE_FAKE.username;
const PASS = BASE_FAKE.password;

let onvifs: FakeOnvif[] = [];
let rtsps: FakeRtsp[] = [];
let driver: OnvifDriver | undefined;

afterEach(async () => {
  driver?.source.stop();
  await driver?.dispose();
  driver = undefined;
  await Promise.all([...onvifs, ...rtsps].map((f) => f.close()));
  onvifs = [];
  rtsps = [];
});

async function rtsp(path: string, video: 'h264' | 'h265', host = '127.0.0.1', port?: number) {
  const f = await startFakeRtsp({
    video,
    username: USER,
    password: PASS,
    auth: 'digest',
    path,
    host,
    ...(port ? { port } : {}),
  });
  rtsps.push(f);
  return f;
}

async function onvif(opts: Partial<FakeOnvifOptions>) {
  const f = await startFakeOnvif({ ...BASE_FAKE, ...opts });
  onvifs.push(f);
  return f;
}

function configFor(f: FakeOnvif, extra: Partial<OnvifCameraConfig> = {}): OnvifCameraConfig {
  const url = new URL(f.deviceUrl);
  return {
    host: url.hostname,
    onvifPort: Number(url.port),
    username: USER,
    password: PASS,
    identity: { endpointId: BASE_FAKE.endpointId, serial: BASE_FAKE.serial, mac: BASE_FAKE.mac },
    ...extra,
  };
}

function collect(d: OnvifDriver): MediaFrame[] {
  const frames: MediaFrame[] = [];
  d.source.on('frame', (f) => frames.push(f));
  return frames;
}

async function freeUdpPort(): Promise<number> {
  const s = dgram.createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', () => r()));
  const { port } = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('OnvifDriver', () => {
  it('goes live with the picked profile', async () => {
    const main = await rtsp('/main', 'h264');
    const mid = await rtsp('/mid', 'h265', '127.0.0.1');
    const f = await onvif({
      profiles: [
        { token: 'main', name: 'Main', codec: 'h264', width: 3840, height: 2160, hasPtz: true },
        { token: 'mid', name: 'Mid', codec: 'h265', width: 1920, height: 1080, hasPtz: true },
      ],
      streamUri: mid.url,
    });
    driver = await OnvifDriver.create(configFor(f), {
      allowPublicHost: false,
      logger: silentLogger,
    });
    const frames = collect(driver);
    driver.source.start();
    await waitFor(() => frames.some((fr) => fr.kind === 'video'));
    expect(frames.find((fr) => fr.kind === 'video')).toMatchObject({ codec: 'h265' });
    expect(mid.lastPath).toBe('/mid');
    expect(main.connections).toBe(0);
    expect(driver.profileToken).toBe('mid');
  });

  it('uses a saved profileToken over the pick rule', async () => {
    const f = await onvif({
      profiles: [
        { token: 'main', name: 'Main', codec: 'h264', width: 1920, height: 1080, hasPtz: true },
        { token: 'sub', name: 'Sub', codec: 'h264', width: 640, height: 360, hasPtz: true },
      ],
    });
    driver = await OnvifDriver.create(configFor(f, { profileToken: 'sub' }), {
      allowPublicHost: false,
      logger: silentLogger,
    });
    expect(driver.profileToken).toBe('sub');
  });

  it('info() reports kind onvif, model and resolution', async () => {
    const f = await onvif({});
    driver = await OnvifDriver.create(configFor(f), {
      allowPublicHost: false,
      logger: silentLogger,
    });
    expect(await driver.info()).toEqual({
      kind: 'onvif',
      alias: 'FC-1',
      model: 'FC-1',
      firmware: '1.0',
      host: '127.0.0.1',
      resolution: '1920x1080',
    });
    expect(driver.ptz?.capability).toBe('supported');
  });

  it('an rtspUrl-only camera plays and has no ptz', async () => {
    const r = await rtsp('/live', 'h264');
    driver = await OnvifDriver.create(
      {
        host: '127.0.0.1',
        onvifPort: 0,
        username: USER,
        password: PASS,
        rtspUrl: r.url,
        identity: {},
      },
      { allowPublicHost: false, logger: silentLogger },
    );
    expect(driver.ptz).toBeUndefined();
    const frames = collect(driver);
    driver.source.start();
    await waitFor(() => frames.some((fr) => fr.kind === 'video'));
    expect((await driver.info()).kind).toBe('onvif');
  });

  it('follows the camera to a new port/host by endpointId', async () => {
    const r1 = await rtsp('/main', 'h264');
    const f1 = await onvif({ streamUri: r1.url });
    const discoveryPort = await freeUdpPort();
    driver = await OnvifDriver.create(configFor(f1), {
      allowPublicHost: false,
      logger: silentLogger,
      discovery: { targets: ['127.0.0.2'], port: discoveryPort, timeoutMs: 300 },
      followIntervalMs: 100,
    });
    const frames = collect(driver);
    driver.source.start();
    driver.start();
    await waitFor(() => frames.length > 0);

    // The camera gets a new address: everything moves to 127.0.0.2.
    await f1.close();
    await r1.close();
    const r2 = await rtsp('/main', 'h264', '127.0.0.2', r1.port);
    await onvif({ host: '127.0.0.2', discoveryPort, streamUri: r2.url });

    await waitFor(() => driver!.host === '127.0.0.2', 8000);
    const before = frames.length;
    await waitFor(() => frames.length > before && r2.connections > 0, 8000);
  });

  it('follows by serial when there is no endpointId', async () => {
    const r1 = await rtsp('/main', 'h264');
    const f1 = await onvif({ streamUri: r1.url });
    const discoveryPort = await freeUdpPort();
    driver = await OnvifDriver.create(
      { ...configFor(f1), identity: { serial: BASE_FAKE.serial } },
      {
        allowPublicHost: false,
        logger: silentLogger,
        discovery: { targets: ['127.0.0.2'], port: discoveryPort, timeoutMs: 300 },
        followIntervalMs: 100,
      },
    );
    driver.start();
    await f1.close();
    await onvif({
      host: '127.0.0.2',
      discoveryPort,
      streamUri: r1.url,
      endpointId: 'urn:uuid:99999999-0000-0000-0000-000000000000',
    });
    await waitFor(() => driver!.host === '127.0.0.2', 8000);
  });

  it('following signs in only to the device with the camera id', async () => {
    const r1 = await rtsp('/main', 'h264');
    const f1 = await onvif({ streamUri: r1.url });
    const discoveryPort = await freeUdpPort();
    driver = await OnvifDriver.create(configFor(f1), {
      allowPublicHost: false,
      logger: silentLogger,
      discovery: { targets: ['127.0.0.3', '127.0.0.2'], port: discoveryPort, timeoutMs: 300 },
      followIntervalMs: 100,
    });
    driver.start();
    await f1.close();
    // Another ONVIF device on the network with the same login, and the camera at its new address.
    const decoy = await onvif({
      host: '127.0.0.3',
      discoveryPort,
      endpointId: 'urn:uuid:dddddddd-0000-0000-0000-000000000000',
      serial: 'OTHER',
      mac: '02:00:00:00:00:99',
    });
    await onvif({ host: '127.0.0.2', discoveryPort, streamUri: r1.url });
    await waitFor(() => driver!.host === '127.0.0.2', 8000);
    expect(decoy.wsSecurityAttempts).toBe(0);
  });

  it('reports where it followed the camera to', async () => {
    const r1 = await rtsp('/main', 'h264');
    const f1 = await onvif({ streamUri: r1.url });
    const discoveryPort = await freeUdpPort();
    const moved: unknown[] = [];
    driver = await OnvifDriver.create(configFor(f1), {
      allowPublicHost: false,
      logger: silentLogger,
      discovery: { targets: ['127.0.0.2'], port: discoveryPort, timeoutMs: 300 },
      followIntervalMs: 100,
      onMoved: (place) => moved.push(place),
    });
    driver.start();
    await f1.close();
    const f2 = await onvif({ host: '127.0.0.2', discoveryPort, streamUri: r1.url });
    await waitFor(() => moved.length > 0, 8000);
    expect(moved).toEqual([
      {
        host: '127.0.0.2',
        onvifPort: Number(new URL(f2.deviceUrl).port),
        endpointId: BASE_FAKE.endpointId,
      },
    ]);
  });
});
