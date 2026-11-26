import { afterEach, describe, expect, it } from 'vitest';
import { OnvifPtz } from '../src/camera/onvifPtz.js';
import { startFakeOnvif, type FakeOnvif } from '../src/dev/fakeOnvif.js';
import { LinkieError } from '../src/kasa/linkieClient.js';
import { OnvifDevice } from '../src/onvif/device.js';
import { silentLogger, waitFor } from './helpers.js';
import { BASE_FAKE } from './onvif/fixtures.js';

let fake: FakeOnvif | undefined;
let ptz: OnvifPtz | undefined;

afterEach(async () => {
  await ptz?.dispose();
  ptz = undefined;
  await fake?.close();
  fake = undefined;
});

async function setup(
  opts: Partial<typeof BASE_FAKE> & { relativeMove?: boolean; presets?: string[] } = {},
) {
  fake = await startFakeOnvif({ ...BASE_FAKE, ...opts });
  const device = await OnvifDevice.connect({
    deviceUrl: fake.deviceUrl,
    username: BASE_FAKE.username,
    password: BASE_FAKE.password,
    allowPublicHost: false,
    logger: silentLogger,
  });
  ptz = new OnvifPtz({ device: () => device, profileToken: 'main', logger: silentLogger });
  return fake;
}

describe('OnvifPtz', () => {
  it('hold sends ContinuousMove then Stop on stop()', async () => {
    const f = await setup();
    expect(ptz!.capability).toBe('supported');
    await ptz!.hold('right');
    await ptz!.hold('right');
    await ptz!.stop();
    expect(f.moves).toEqual(['ContinuousMove main 0.5 0', 'Stop main']);
  });

  it('a hold that is not repeated stops by itself', async () => {
    const f = await setup();
    await ptz!.hold('up');
    await waitFor(() => f.moves.includes('Stop main'), 3000);
    expect(f.moves[0]).toBe('ContinuousMove main 0 0.5');
  });

  it('step uses RelativeMove when supported, else a short ContinuousMove and Stop', async () => {
    let f = await setup({ relativeMove: true });
    await ptz!.step('left');
    expect(f.moves).toEqual(['RelativeMove main -0.1 0']);
    await ptz!.dispose();
    await fake!.close();

    f = await setup();
    const started = Date.now();
    await ptz!.step('down');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(f.moves).toEqual(['ContinuousMove main 0 -0.5', 'Stop main']);
  });

  it('presets keep camera order and goToPreset uses that token', async () => {
    const f = await setup({ presets: ['Crib', 'Door', 'Window'] });
    expect(await ptz!.presets()).toEqual([
      { index: 0, name: 'Crib' },
      { index: 1, name: 'Door' },
      { index: 2, name: 'Window' },
    ]);
    await ptz!.goToPreset(2);
    expect(f.moves).toEqual(['GotoPreset main p3']);
  });

  it('goToPreset out of range throws', async () => {
    await setup({ presets: ['Crib'] });
    await expect(ptz!.goToPreset(5)).rejects.toBeInstanceOf(LinkieError);
  });
});
