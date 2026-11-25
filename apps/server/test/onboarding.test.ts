import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessUnits,
  FakeCamera,
  LoopingFrameProducer,
  type FakeCameraOptions,
} from '../src/dev/fakeCamera.js';
import { Onboarding, OnboardingError, OnboardingStateError } from '../src/setup/onboarding.js';
import { createWifiSwitcher, type WifiSwitcher } from '../src/setup/wifiSwitcher.js';
import { fixture, silentLogger, waitFor } from './helpers.js';

const ACCOUNT = { username: 'parent@example.com', password: 'kasa-account-pw' };

const NETWORKS = [
  { ssid: 'Neighbours', rssi: -80, wpa_mode: 'WPA2_PSK', encryption: 'AES' },
  { ssid: 'HomeNet', rssi: -60, wpa_mode: 'WPA2_PSK', encryption: 'AES' },
  { ssid: 'Cafe', rssi: -70, wpa_mode: 'NONE', encryption: 'NONE' },
];

let fake: FakeCamera;
let fakeTargets: {
  setupAddresses: string[];
  apiPort: number;
  discovery: { targets: string[]; port: number; timeoutMs: number };
  timeouts: { cameraWifiMs: number; homeMs: number; pollMs: number; scanSettleMs: number };
  timeZone: string;
  logger: typeof silentLogger;
};

async function startFake(setup: Partial<NonNullable<FakeCameraOptions['setupMode']>> = {}) {
  fake = new FakeCamera({
    ...ACCOUNT,
    encoding: 'md5',
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 15),
    setupMode: {
      login: { username: 'admin', password: 'admin', encoding: 'base64' },
      networks: NETWORKS,
      ...setup,
    },
  });
  const ports = await fake.start('127.0.0.1', 0, 0, 0);
  fakeTargets = {
    setupAddresses: ['127.0.0.1'],
    apiPort: ports.apiPort,
    discovery: { targets: ['127.0.0.1'], port: ports.discoveryPort!, timeoutMs: 100 },
    timeouts: { cameraWifiMs: 3000, homeMs: 3000, pollMs: 50, scanSettleMs: 0 },
    timeZone: 'Asia/Tokyo',
    logger: silentLogger,
  };
}

function testSwitcher(): WifiSwitcher & { returnHome: ReturnType<typeof vi.fn> } {
  return {
    auto: true,
    joinCameraNetwork: async () => 'Kasa_Cam_TEST',
    returnHome: vi.fn(async () => {}),
  };
}

beforeEach(async () => {
  await startFake();
});

afterEach(async () => {
  await fake.stop();
});

describe('Onboarding', () => {
  it('walks a reset camera onto the home Wi-Fi and links the account', async () => {
    const saved = vi.fn();
    const switcher = testSwitcher();
    const job = new Onboarding({
      mode: 'account',
      account: ACCOUNT,
      switcher,
      onSaved: saved,
      ...fakeTargets,
    });
    expect(job.status()).toEqual({ phase: 'reset-camera', autoWifi: true });
    job.answer({ type: 'camera-reset' });
    await waitFor(() => job.status().phase === 'choose-wifi');
    expect(job.status().cameraNetwork).toBe('Kasa_Cam_TEST');
    expect(job.status().networks?.map((n) => n.ssid)).toEqual(['HomeNet', 'Cafe', 'Neighbours']);
    expect(job.status().networks?.[1]).toMatchObject({ ssid: 'Cafe', signal: -70, open: true });
    job.answer({ type: 'wifi', ssid: 'HomeNet', passphrase: 'wifi-secret', alias: 'nursery' });
    await waitFor(() => job.status().phase === 'done', 10_000);
    expect(fake.uplink?.ssid).toBe('HomeNet');
    expect(fake.uplink?.passphrase).toBe('wifi-secret');
    expect(fake.bound).toBe(true);
    expect(fake.alias).toBe('nursery');
    expect(fake.onboardingStatus).toBe('done');
    expect(fake.timeZone.area).toBe('Asia/Tokyo');
    expect(saved).toHaveBeenCalledWith({ ...ACCOUNT, alias: 'nursery', localOnly: false });
    expect(job.status().result).toEqual({
      alias: 'nursery',
      host: '127.0.0.1',
      linked: true,
      warnings: [],
    });
    expect(switcher.returnHome).toHaveBeenCalledTimes(1);
  });

  it('local only: never links, saves the setup login', async () => {
    const saved = vi.fn();
    const job = new Onboarding({
      mode: 'local',
      switcher: testSwitcher(),
      onSaved: saved,
      ...fakeTargets,
    });
    job.answer({ type: 'camera-reset' });
    await waitFor(() => job.status().phase === 'choose-wifi');
    job.answer({ type: 'wifi', ssid: 'Cafe', passphrase: '', alias: 'hall' });
    await waitFor(() => job.status().phase === 'done', 10_000);
    expect(fake.bound).toBe(false);
    expect(fake.commands.some((c) => c.method === 'set_bind')).toBe(false);
    expect(fake.uplink).toMatchObject({ ssid: 'Cafe', wpa_mode: 'NONE' });
    expect(saved).toHaveBeenCalledWith({
      username: 'admin',
      password: 'admin',
      alias: 'hall',
      localOnly: true,
    });
    expect(job.status().result?.linked).toBe(false);
  });

  it('fails with a retry point when the camera never appears on the home network', async () => {
    await fake.stop();
    await startFake({ ignoreUplink: true });
    const saved = vi.fn();
    const job = new Onboarding({
      mode: 'account',
      account: ACCOUNT,
      switcher: testSwitcher(),
      onSaved: saved,
      ...fakeTargets,
      timeouts: { ...fakeTargets.timeouts, homeMs: 500 },
    });
    job.answer({ type: 'camera-reset' });
    await waitFor(() => job.status().phase === 'choose-wifi');
    job.answer({ type: 'wifi', ssid: 'HomeNet', passphrase: 'wrong', alias: 'nursery' });
    await waitFor(() => job.status().phase === 'failed', 5000);
    expect(job.status().error?.retryFrom).toBe('reset-camera');
    expect(job.status().error?.message).toMatch(/2\.4 GHz/);
    expect(saved).not.toHaveBeenCalled();

    job.answer({ type: 'retry' });
    expect(job.status().phase).toBe('reset-camera');
    expect(job.status().error).toBeUndefined();
  });

  it('fails when no camera answers on its Wi-Fi, and can retry from joining', async () => {
    const switcher = testSwitcher();
    const job = new Onboarding({
      mode: 'local',
      switcher,
      onSaved: () => {},
      ...fakeTargets,
      discovery: { ...fakeTargets.discovery, port: 9 },
      timeouts: { ...fakeTargets.timeouts, cameraWifiMs: 300 },
    });
    job.answer({ type: 'camera-reset' });
    await waitFor(() => job.status().phase === 'failed');
    expect(job.status().error).toEqual({
      message: 'No camera answered on this network.',
      retryFrom: 'join-camera-wifi',
    });
    expect(switcher.returnHome).toHaveBeenCalledTimes(1);
  });

  it('rejects an answer that does not fit the phase', () => {
    const job = new Onboarding({
      mode: 'local',
      switcher: testSwitcher(),
      onSaved: () => {},
      ...fakeTargets,
    });
    expect(() =>
      job.answer({ type: 'wifi', ssid: 'HomeNet', passphrase: 'x', alias: 'nursery' }),
    ).toThrow(OnboardingStateError);
    expect(() => job.answer({ type: 'retry' })).toThrow(OnboardingStateError);
    expect(job.status().phase).toBe('reset-camera');
  });

  it('cancel() sends the computer back to home Wi-Fi', async () => {
    const switcher = testSwitcher();
    const job = new Onboarding({
      mode: 'local',
      switcher,
      onSaved: () => {},
      ...fakeTargets,
    });
    job.answer({ type: 'camera-reset' });
    await waitFor(() => job.status().phase === 'choose-wifi');
    await job.cancel();
    expect(switcher.returnHome).toHaveBeenCalledTimes(1);
    expect(job.status().phase).toBe('failed');
    expect(job.status().error?.retryFrom).toBe('reset-camera');
    expect(() =>
      job.answer({ type: 'wifi', ssid: 'HomeNet', passphrase: 'x', alias: 'nursery' }),
    ).toThrow(OnboardingStateError);
    expect(fake.uplink).toBeUndefined();
  });

  it('cancel() with the manual switcher only stops the job', async () => {
    const switcher = { ...testSwitcher(), auto: false };
    const job = new Onboarding({
      mode: 'local',
      switcher,
      onSaved: () => {},
      ...fakeTargets,
    });
    expect(job.status().autoWifi).toBe(false);
    job.answer({ type: 'camera-reset' });
    await waitFor(() => job.status().phase === 'choose-wifi');
    await job.cancel();
    expect(switcher.returnHome).not.toHaveBeenCalled();
    expect(job.status().phase).toBe('failed');
  });

  describe('cancel while a step is in flight', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /** An auto switcher whose joins wait until the test settles them. */
    function heldSwitcher() {
      const joins: { resolve(ssid: string): void; reject(err: Error): void }[] = [];
      return {
        joins,
        auto: true as const,
        joinCameraNetwork: vi.fn(
          () =>
            new Promise<string | undefined>((resolve, reject) => joins.push({ resolve, reject })),
        ),
        returnHome: vi.fn(async () => {}),
      };
    }

    it('an old send that fails late does not take a newer run off the camera Wi-Fi', async () => {
      await fake.stop();
      await startFake({ rejectUplinkField: 'ssid', uplinkReplyMs: 600 });
      const switcher = testSwitcher();
      const job = new Onboarding({ mode: 'local', switcher, onSaved: () => {}, ...fakeTargets });
      job.answer({ type: 'camera-reset' });
      await waitFor(() => job.status().phase === 'choose-wifi');
      job.answer({ type: 'wifi', ssid: 'HomeNet', passphrase: 'x', alias: 'nursery' });
      await waitFor(() => fake.commands.some((c) => c.method === 'set_uplink'));
      expect(job.status().phase).toBe('sending');
      await job.cancel();
      expect(switcher.returnHome).toHaveBeenCalledTimes(1);

      job.answer({ type: 'retry' });
      job.answer({ type: 'camera-reset' });
      await waitFor(() => job.status().phase === 'choose-wifi');
      // The old set_uplink is rejected now, long after the cancel.
      await sleep(900);
      expect(switcher.returnHome).toHaveBeenCalledTimes(1);
      expect(job.status().phase).toBe('choose-wifi');

      // The new run still owns the camera Wi-Fi, so its cancel takes the computer home.
      await job.cancel();
      expect(switcher.returnHome).toHaveBeenCalledTimes(2);
    });

    it("an old send that succeeds late does not change the newer run's retry point", async () => {
      await fake.stop();
      await startFake({ uplinkReplyMs: 400 });
      const switcher = heldSwitcher();
      const job = new Onboarding({ mode: 'local', switcher, onSaved: () => {}, ...fakeTargets });
      job.answer({ type: 'camera-reset' });
      switcher.joins[0]!.resolve('Kasa_Cam_TEST');
      await waitFor(() => job.status().phase === 'choose-wifi');
      job.answer({ type: 'wifi', ssid: 'HomeNet', passphrase: 'x', alias: 'nursery' });
      await waitFor(() => fake.commands.some((c) => c.method === 'set_uplink'));
      await job.cancel();

      job.answer({ type: 'retry' });
      job.answer({ type: 'camera-reset' });
      await waitFor(() => switcher.joins.length === 2);
      // The old set_uplink is accepted while the new run is still joining.
      await sleep(700);
      switcher.joins[1]!.reject(new OnboardingError('Could not join the camera Wi-Fi.'));
      await waitFor(() => job.status().phase === 'failed');
      expect(job.status().error).toEqual({
        message: 'Could not join the camera Wi-Fi.',
        retryFrom: 'join-camera-wifi',
      });
    });

    it('a join that finishes after the cancel still goes back home', async () => {
      const switcher = heldSwitcher();
      const job = new Onboarding({ mode: 'local', switcher, onSaved: () => {}, ...fakeTargets });
      job.answer({ type: 'camera-reset' });
      await waitFor(() => switcher.joins.length === 1);
      await job.cancel();
      expect(switcher.returnHome).not.toHaveBeenCalled();
      switcher.joins[0]!.resolve('Kasa_Cam_TEST');
      await waitFor(() => switcher.returnHome.mock.calls.length === 1);
      await sleep(100);
      expect(switcher.returnHome).toHaveBeenCalledTimes(1);
      expect(job.status().phase).toBe('failed');
    });

    it('a cancel before finishing starts sends nothing to the camera', async () => {
      const job: Onboarding = new Onboarding({
        mode: 'account',
        account: ACCOUNT,
        switcher: testSwitcher(),
        onSaved: () => {},
        ...fakeTargets,
        onEvent(e) {
          if (e.type === 'status' && e.status.phase === 'finishing') void job.cancel();
        },
      });
      job.answer({ type: 'camera-reset' });
      await waitFor(() => job.status().phase === 'choose-wifi');
      job.answer({ type: 'wifi', ssid: 'HomeNet', passphrase: 'x', alias: 'nursery' });
      await waitFor(() => job.status().phase === 'failed');
      await sleep(300);
      expect(fake.bound).toBe(false);
      const methods = fake.commands.map((c) => c.method);
      expect(methods).not.toContain('set_alias');
      expect(methods).not.toContain('set_bind');
    });
  });

  it('needs the account to link one', () => {
    expect(
      () =>
        new Onboarding({
          mode: 'account',
          switcher: testSwitcher(),
          onSaved: () => {},
          ...fakeTargets,
        }),
    ).toThrow(/account/);
  });
});

describe('createWifiSwitcher', () => {
  it('uses the manual switcher when KASA_WIFI_SWITCH=manual', async () => {
    vi.stubEnv('KASA_WIFI_SWITCH', 'manual');
    try {
      const switcher = await createWifiSwitcher();
      expect(switcher.auto).toBe(false);
      expect(await switcher.joinCameraNetwork()).toBeUndefined();
      await switcher.returnHome();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
