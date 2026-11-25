import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../src/dev/fakeCamera.js';
import {
  defaultSetupLogins,
  findWorkingLogin,
  finishSetup,
  getCloudInfo,
  joinWifi,
  parseApList,
  scanWifi,
} from '../src/kasa/setup.js';
import { fixture, silentLogger } from './helpers.js';

const ACCOUNT = { username: 'parent@example.com', password: 'kasa-account-pw' };

let fake: FakeCamera;
let apiPort: number;

beforeEach(async () => {
  fake = new FakeCamera({
    ...ACCOUNT,
    encoding: 'md5',
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 15),
    setupMode: {
      login: { username: 'admin', password: 'admin', encoding: 'base64' },
      networks: [
        { ssid: 'Neighbours', rssi: -80, wpa_mode: 'WPA2_PSK', encryption: 'AES' },
        { ssid: 'HomeNet', rssi: -60, wpa_mode: 'WPA2_PSK', encryption: 'AES' },
        { ssid: 'HomeNet', rssi: -75, wpa_mode: 'WPA2_PSK', encryption: 'AES' },
        { ssid: 'Cafe', rssi: -70, wpa_mode: 'NONE', encryption: 'NONE' },
      ],
    },
  });
  ({ apiPort } = await fake.start());
});

afterEach(async () => {
  await fake.stop();
});

const target = () => ({ host: '127.0.0.1', apiPort, logger: silentLogger });

async function cameraRejecting(field: string) {
  const cam = new FakeCamera({
    ...ACCOUNT,
    encoding: 'md5',
    video: new LoopingFrameProducer(accessUnits(fixture('stream-320x180.h264')), 15),
    setupMode: {
      login: { username: 'admin', password: 'admin', encoding: 'md5' },
      rejectUplinkField: field,
    },
  });
  const ports = await cam.start();
  return { cam, target: { host: '127.0.0.1', apiPort: ports.apiPort, logger: silentLogger } };
}

describe('camera setup without the app', () => {
  it('finds the setup login and reports which one worked', async () => {
    const login = await findWorkingLogin(target(), defaultSetupLogins(ACCOUNT));
    expect(login?.candidate.label).toBe('admin / admin');
    expect(login?.credentials.resolvedEncoding).toBe('base64');
  });

  it('returns undefined when no login works', async () => {
    const login = await findWorkingLogin(target(), [
      { label: 'wrong', username: 'admin', password: 'nope' },
    ]);
    expect(login).toBeUndefined();
  });

  it('runs the full flow: scan, join Wi-Fi, finish and link the account', async () => {
    const login = (await findWorkingLogin(target(), defaultSetupLogins()))!;
    expect(await getCloudInfo(login.client)).toMatchObject({ bound: false });

    const networks = await scanWifi(login.client, { settleMs: 0 });
    expect(networks.map((n) => n.ssid)).toEqual(['HomeNet', 'Cafe', 'Neighbours']);
    const home = networks[0]!;

    await joinWifi(login.client, { ...home, passphrase: 'wifi-secret' });
    expect(fake.uplink).toEqual({
      ssid: 'HomeNet',
      passphrase: 'wifi-secret',
      band: '2G',
      wpa_mode: 'WPA2_PSK',
      encryption: 'AES',
    });

    const result = await finishSetup(login.client, { alias: 'nursery', bindAccount: ACCOUNT });
    expect(result).toEqual({ aliasSet: true, bound: true, bindPassword: 'plain' });
    expect(fake.alias).toBe('nursery');
    expect(fake.onboardingStatus).toBe('done');
    expect(fake.bound).toBe(true);

    // Linked: the account login now works and the setup login doesn't.
    const after = await findWorkingLogin(target(), defaultSetupLogins(ACCOUNT));
    expect(after?.candidate.label).toBe('your Kasa account');
    expect(await getCloudInfo(after!.client)).toMatchObject({
      bound: true,
      username: ACCOUNT.username,
    });

    // Linking went last, after everything that needs the setup login.
    const order = fake.commands.map((c) => c.method);
    expect(order.indexOf('set_bind')).toBeGreaterThan(order.indexOf('set_onboarding_status'));
  });

  it('can finish local-only, without linking an account', async () => {
    const login = (await findWorkingLogin(target(), defaultSetupLogins()))!;
    expect(await finishSetup(login.client, {})).toEqual({ aliasSet: false, bound: false });
    expect(fake.bound).toBe(false);
    expect(fake.onboardingStatus).toBe('done');
    expect(fake.commands.some((c) => c.method === 'set_bind')).toBe(false);
  });

  it('surfaces a rejected account link as an error', async () => {
    const login = (await findWorkingLogin(target(), defaultSetupLogins()))!;
    await expect(
      finishSetup(login.client, { bindAccount: { ...ACCOUNT, password: 'wrong' } }),
    ).rejects.toThrow(/err_code -20601/);
    expect(fake.bound).toBe(false);
  });

  it('leaves out key_index, which a real KC410S rejects as "0"', async () => {
    const login = (await findWorkingLogin(target(), defaultSetupLogins()))!;
    const result = await joinWifi(login.client, { ssid: 'HomeNet', passphrase: 'wifi-secret' });
    expect(result.attempts).toBe(1);
    expect(result.accepted).not.toHaveProperty('key_index');
    expect(result.accepted).not.toHaveProperty('passphrase');
    expect(fake.uplink?.ssid).toBe('HomeNet');
  });

  it('sends open networks without a passphrase as NONE', async () => {
    const login = (await findWorkingLogin(target(), defaultSetupLogins()))!;
    await joinWifi(login.client, { ssid: 'Cafe', passphrase: '' });
    expect(fake.uplink).toMatchObject({ wpa_mode: 'NONE', encryption: 'NONE' });
  });
});

describe('set_uplink fallbacks', () => {
  it('sends apply separately when the camera rejects the apply field', async () => {
    const { cam, target: t } = await cameraRejecting('apply');
    try {
      const login = (await findWorkingLogin(t, defaultSetupLogins()))!;
      const result = await joinWifi(login.client, { ssid: 'HomeNet', passphrase: 'pw-123456' });
      expect(result).toMatchObject({ attempts: 2 });
      expect(result.accepted).not.toHaveProperty('apply');
      const methods = cam.commands.map((c) => c.method);
      expect(methods.slice(-1)).toEqual(['set_apply_changes']);
    } finally {
      await cam.stop();
    }
  });

  it('does not retry errors unrelated to a field', async () => {
    const { cam, target: t } = await cameraRejecting('ssid');
    try {
      const login = (await findWorkingLogin(t, defaultSetupLogins()))!;
      await expect(joinWifi(login.client, { ssid: 'HomeNet', passphrase: 'x' })).rejects.toThrow(
        /\[ssid\]/,
      );
      expect(cam.commands.filter((c) => c.method === 'set_uplink')).toHaveLength(1);
    } finally {
      await cam.stop();
    }
  });
});

describe('parseApList', () => {
  it('drops empty SSIDs, keeps the strongest duplicate and tolerates odd fields', () => {
    const list = parseApList({
      ap_info: [
        { ssid: '', rssi: -10 },
        { ssid: 'A', rssi: -70, auth: 'WPA2_PSK' },
        { ssid: 'A', rssi: -50, wpa_mode: 'WPA2_PSK', encryption: 'AES', band: '2G' },
        { ssid: 'B', wpa_mode: '' },
      ],
    });
    expect(list).toEqual([
      { ssid: 'A', band: '2G', rssi: -50, wpaMode: 'WPA2_PSK', encryption: 'AES', open: false },
      { ssid: 'B', band: '2G', rssi: undefined, wpaMode: '', encryption: '', open: true },
    ]);
  });

  it('handles a reply with no list', () => {
    expect(parseApList({})).toEqual([]);
  });
});
