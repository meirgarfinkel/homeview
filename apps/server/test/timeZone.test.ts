import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import { CameraCredentials } from '../src/kasa/credentials.js';
import { LinkieClient } from '../src/kasa/linkieClient.js';
import { cameraTimeZone, isValidTimeZone, syncTimeZone } from '../src/kasa/timeZone.js';
import { fixture, silentLogger } from './helpers.js';

describe('camera time zone format', () => {
  const at = (iso: string) => new Date(iso);
  it.each([
    ['Asia/Jerusalem', '2026-01-15T12:00:00Z', 'UTC+2:00'],
    ['Asia/Jerusalem', '2026-07-15T12:00:00Z', 'UTC+3:00'],
    ['America/New_York', '2026-01-15T12:00:00Z', 'UTC-5:00'],
    ['America/New_York', '2026-07-15T12:00:00Z', 'UTC-4:00'],
    ['Europe/London', '2026-01-15T12:00:00Z', 'UTC+0:00'],
    ['Asia/Kolkata', '2026-01-15T12:00:00Z', 'UTC+5:30'],
    ['Asia/Kathmandu', '2026-01-15T12:00:00Z', 'UTC+5:45'],
    ['Pacific/Auckland', '2026-01-15T12:00:00Z', 'UTC+13:00'],
    ['UTC', '2026-01-15T12:00:00Z', 'UTC+0:00'],
  ])('%s at %s is %s', (zone, when, expected) => {
    expect(cameraTimeZone(zone, at(when))).toEqual({ timezone: expected, area: zone });
  });

  it('validates IANA names', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('syncTimeZone', () => {
  let fake: FakeCamera;
  let linkie: LinkieClient;
  beforeEach(async () => {
    fake = new FakeCamera({
      username: 'a@example.com',
      password: 'pw',
      encoding: 'md5',
      video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 15),
    });
    const { apiPort } = await fake.start();
    linkie = new LinkieClient({
      host: '127.0.0.1',
      port: apiPort,
      credentials: new CameraCredentials('a@example.com', 'pw'),
    });
  });
  afterEach(() => fake.stop());

  it('sets the zone once, then leaves it alone', async () => {
    expect(await syncTimeZone(linkie, 'America/Chicago', silentLogger)).toBe('updated');
    expect(fake.timeZone.area).toBe('America/Chicago');
    expect(fake.timeZone.timezone).toMatch(/^UTC-[56]:00$/);
    expect(await syncTimeZone(linkie, 'America/Chicago', silentLogger)).toBe('unchanged');
    expect(fake.commands.filter((c) => c.method === 'set_time_zone')).toHaveLength(1);
  });
});
