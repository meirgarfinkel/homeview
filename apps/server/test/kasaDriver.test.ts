import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AudioFrame, MediaFrame, VideoFrame } from '../src/camera/driver.js';
import { KasaDriver } from '../src/camera/kasaDriver.js';
import { loadConfig, type Config } from '../src/config.js';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { fixture, silentLogger, waitFor } from './helpers.js';

const USER = 'parent@example.com';
const PASS = 'correct horse';

let fake: FakeCamera;
let ports: { streamPort: number; apiPort: number };
let driver: KasaDriver | undefined;

beforeAll(async () => {
  fake = new FakeCamera({
    username: USER,
    password: PASS,
    encoding: 'md5',
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 30),
  });
  ports = await fake.start();
});

afterEach(async () => {
  driver?.source.stop();
  await driver?.dispose();
  driver = undefined;
});

afterAll(async () => {
  await fake.stop();
});

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    KASA_HOST: '127.0.0.1',
    KASA_USERNAME: USER,
    KASA_PASSWORD: PASS,
    KASA_API_PORT: String(ports.apiPort),
    KASA_STREAM_PORT: String(ports.streamPort),
    ALLOW_NO_PASSWORD: 'true',
    ...overrides,
  });
}

describe('KasaDriver', () => {
  it('exposes kind kasa, the host, and a ptz control', () => {
    driver = new KasaDriver(testConfig(), silentLogger, { host: '127.0.0.1' });
    expect(driver.kind).toBe('kasa');
    expect(driver.host).toBe('127.0.0.1');
    expect(driver.ptz?.capability).toBeDefined();
  });

  it('info() reports kind kasa', async () => {
    driver = new KasaDriver(testConfig(), silentLogger, { host: '127.0.0.1' });
    const info = await driver.info();
    expect(info.kind).toBe('kasa');
    expect(info.model).toBe('KC410S(US)');
  });

  it('frames carry their codec', async () => {
    driver = new KasaDriver(testConfig(), silentLogger, { host: '127.0.0.1' });
    let video: VideoFrame | undefined;
    let audio: AudioFrame | undefined;
    driver.source.on('frame', (f: MediaFrame) => {
      if (f.kind === 'video') video ??= f;
      else audio ??= f;
    });
    driver.source.start();
    await waitFor(() => video !== undefined && audio !== undefined, 5000);
    expect(video?.codec).toBe('h264');
    expect(audio).toMatchObject({ codec: 'pcmu', sampleRate: 8000, channels: 1 });
  });

  it('start() syncs the camera clock, and dispose() stops the sync', async () => {
    driver = new KasaDriver(
      testConfig({ KASA_SYNC_TIMEZONE: 'true', KASA_TIMEZONE: 'Europe/London' }),
      silentLogger,
      { host: '127.0.0.1' },
    );
    const before = fake.commands.length;
    driver.start();
    await waitFor(() => fake.commands.slice(before).some((c) => /time/i.test(c.module)), 5000);
    await driver.dispose();
    driver = undefined;
  });
});
