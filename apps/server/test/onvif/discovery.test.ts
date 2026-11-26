import { afterEach, describe, expect, it } from 'vitest';
import { startFakeOnvif, type FakeOnvif } from '../../src/dev/fakeOnvif.js';
import { discoverOnvif } from '../../src/onvif/discovery.js';
import { silentLogger } from '../helpers.js';
import { BASE_FAKE } from './fixtures.js';

let fakes: FakeOnvif[] = [];

afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
});

describe('discoverOnvif', () => {
  it('returns endpoint id, host and decoded name', async () => {
    const fake = await startFakeOnvif({ ...BASE_FAKE, discoveryPort: 0, name: 'Nursery Cam' });
    fakes.push(fake);
    const found = await discoverOnvif({
      targets: ['127.0.0.1'],
      port: fake.discoveryPort!,
      timeoutMs: 500,
      logger: silentLogger,
    });
    expect(found).toEqual([
      {
        endpointId: BASE_FAKE.endpointId,
        xaddr: fake.deviceUrl,
        host: '127.0.0.1',
        name: 'Nursery Cam',
        hardware: 'FC-1',
      },
    ]);
  });

  it('drops a public xaddr', async () => {
    const fake = await startFakeOnvif({
      ...BASE_FAKE,
      discoveryPort: 0,
      advertiseXaddr: 'http://8.8.8.8/onvif/device_service',
    });
    fakes.push(fake);
    const found = await discoverOnvif({
      targets: ['127.0.0.1'],
      port: fake.discoveryPort!,
      timeoutMs: 400,
      logger: silentLogger,
    });
    expect(found).toEqual([]);
  });

  it('deduplicates repeated matches', async () => {
    const fake = await startFakeOnvif({ ...BASE_FAKE, discoveryPort: 0, repeatMatches: 3 });
    fakes.push(fake);
    const found = await discoverOnvif({
      targets: ['127.0.0.1'],
      port: fake.discoveryPort!,
      timeoutMs: 400,
      logger: silentLogger,
    });
    expect(found).toHaveLength(1);
  });
});
