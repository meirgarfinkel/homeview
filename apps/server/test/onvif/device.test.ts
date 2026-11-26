import { afterEach, describe, expect, it } from 'vitest';
import { startFakeOnvif, type FakeOnvif } from '../../src/dev/fakeOnvif.js';
import { OnvifDevice } from '../../src/onvif/device.js';
import { silentLogger } from '../helpers.js';
import { BASE_FAKE } from './fixtures.js';

let fake: FakeOnvif | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const connect = (deviceUrl: string) =>
  OnvifDevice.connect({
    deviceUrl,
    username: BASE_FAKE.username,
    password: BASE_FAKE.password,
    allowPublicHost: false,
    logger: silentLogger,
  });

describe('OnvifDevice', () => {
  it('reads info, MAC, profiles and a stream URI', async () => {
    fake = await startFakeOnvif({
      ...BASE_FAKE,
      profiles: [
        { token: 'main', name: 'Main', codec: 'h265', width: 2560, height: 1440, hasPtz: true },
        { token: 'sub', name: 'Sub', codec: 'h264', width: 640, height: 360, hasPtz: true },
        { token: 'mjpeg', name: 'Snap', codec: 'other', width: 640, height: 360, hasPtz: false },
      ],
    });
    const d = await connect(fake.deviceUrl);
    expect(await d.info()).toMatchObject({
      manufacturer: 'FakeCam',
      model: 'FC-1',
      serial: 'SN-1',
    });
    expect(await d.macAddress()).toBe('00:11:22:33:44:55');
    expect(await d.profiles()).toEqual([
      { token: 'main', name: 'Main', codec: 'h265', width: 2560, height: 1440, hasPtz: true },
      { token: 'sub', name: 'Sub', codec: 'h264', width: 640, height: 360, hasPtz: true },
      { token: 'mjpeg', name: 'Snap', codec: 'other', width: 640, height: 360, hasPtz: false },
    ]);
    expect(await d.streamUri('main')).toBe('rtsp://127.0.0.1:554/main');
    expect(d.hasPtz).toBe(true);
  });

  it('the stream URI points at the known host', async () => {
    fake = await startFakeOnvif({
      ...BASE_FAKE,
      streamUri: 'rtsp://192.168.1.250:8554/h265Preview_01_main',
    });
    const d = await connect(fake.deviceUrl);
    expect(await d.streamUri('main')).toBe('rtsp://127.0.0.1:8554/h265Preview_01_main');
  });

  it('service addresses on another host are rewritten to the known host', async () => {
    fake = await startFakeOnvif({ ...BASE_FAKE, serviceHost: '192.168.1.250' });
    const d = await connect(fake.deviceUrl);
    await expect(d.profiles()).resolves.toHaveLength(1);
  });

  it('ptz moves are sent with the profile token', async () => {
    fake = await startFakeOnvif({ ...BASE_FAKE, presets: ['Crib', 'Door'] });
    const d = await connect(fake.deviceUrl);
    await d.continuousMove('main', 0.5, 0);
    await d.stop('main');
    await expect(d.relativeMove('main', 0.1, 0)).rejects.toThrow();
    expect(await d.presets('main')).toEqual([
      { token: 'p1', name: 'Crib' },
      { token: 'p2', name: 'Door' },
    ]);
    await d.gotoPreset('main', 'p2');
    expect(fake.moves).toEqual(['ContinuousMove main 0.5 0', 'Stop main', 'GotoPreset main p2']);
  });

  it('a camera without PTZ says so', async () => {
    fake = await startFakeOnvif({ ...BASE_FAKE, ptz: false });
    const d = await connect(fake.deviceUrl);
    expect(d.hasPtz).toBe(false);
  });
});
