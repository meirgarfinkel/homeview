import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { locateCamera } from '../src/kasa/camera.js';
import { fixture, silentLogger } from './helpers.js';

function newFake(alias: string): FakeCamera {
  return new FakeCamera({
    username: 'parent@example.com',
    password: 'pw',
    encoding: 'md5',
    alias,
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 15),
  });
}

let one: FakeCamera;
let discoveryPort: number;
beforeAll(async () => {
  // Renamed in the Kasa app after HomeView saved "nursery".
  one = newFake('Baby room');
  discoveryPort = (await one.start('127.0.0.1', 0, 0, 0)).discoveryPort!;
});
afterAll(async () => {
  await one.stop();
});

function cameraConfig(targets: string, alias = 'nursery') {
  return loadConfig(
    {
      KASA_DISCOVERY_TARGETS: targets,
      KASA_DISCOVERY_PORT: String(discoveryPort),
    },
    { camera: { username: 'parent@example.com', password: 'pw', alias, localOnly: false } },
  ).camera;
}

describe('locateCamera', () => {
  it('uses the only camera that answers, even when it was renamed', async () => {
    const found = await locateCamera(cameraConfig('127.0.0.1'), silentLogger);
    expect(found.host).toBe('127.0.0.1');
    expect(found.device?.alias).toBe('Baby room');
  });

  it.skipIf(process.platform !== 'linux')(
    'still needs the saved name when several cameras answer',
    async () => {
      const two = newFake('Playroom');
      await two.start('127.0.0.2', 0, 0, discoveryPort);
      try {
        await expect(
          locateCamera(cameraConfig('127.0.0.1,127.0.0.2'), silentLogger),
        ).rejects.toThrow(/No camera named "nursery"/);
        const picked = await locateCamera(
          cameraConfig('127.0.0.1,127.0.0.2', 'playroom'),
          silentLogger,
        );
        expect(picked.host).toBe('127.0.0.2');
      } finally {
        await two.stop();
      }
    },
  );
});
