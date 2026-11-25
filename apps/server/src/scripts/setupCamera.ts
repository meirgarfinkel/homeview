/**
 * Set up a new or factory-reset Kasa camera without the phone app.
 *   pnpm setup-camera
 *
 * Phase 1 joins this computer to the camera's setup Wi-Fi and sends it your
 * home Wi-Fi details. Phase 2 rejoins your home Wi-Fi, finds the camera
 * there, and finishes setup (optionally linking your TP-Link account).
 *
 * Optional environment:
 *   SETUP_LOGIN=user:password  try this login first on the reset camera
 *   KASA_USERNAME / KASA_PASSWORD  your TP-Link account, for linking
 */
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { findRepoRoot, loadEnvFile } from '../env.js';
import { discover, isCamera, type DiscoveredDevice } from '../kasa/discovery.js';
import { LinkieError } from '../kasa/linkieClient.js';
import {
  defaultSetupLogins,
  findWorkingLogin,
  finishSetup,
  getCloudInfo,
  joinWifi,
  scanWifi,
  type LoginCandidate,
  type WifiNetwork,
} from '../kasa/setup.js';
import { updateEnvFile } from '../setup/envFile.js';
import * as nm from '../setup/nmcli.js';

/** Addresses the Kasa app expects a camera to use on its setup network. */
const SETUP_ADDRESSES = ['192.168.191.1', '192.168.0.1', '192.168.0.10'];

// Testing knobs, used to rehearse the flow against `pnpm dev:fake-camera`.
const testTargets = process.env['SETUP_TEST_TARGETS']?.split(',').filter(Boolean);
const discoveryPort = Number(process.env['SETUP_TEST_DISCOVERY_PORT']) || undefined;
const apiPort = Number(process.env['KASA_API_PORT']) || 10443;
const manualWifi = process.env['SETUP_MANUAL_WIFI'] === '1' || testTargets !== undefined;

loadEnvFile();

// ---------- prompts ----------

let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stdout.write(chunk, encoding);
    done();
  },
});
const rl = readline.createInterface({ input: process.stdin, output, terminal: true });

const say = (text = '') => console.log(text);
const ask = async (q: string, fallback = '') =>
  (await rl.question(fallback ? `${q} [${fallback}] ` : `${q} `)).trim() || fallback;
async function askHidden(q: string): Promise<string> {
  process.stdout.write(`${q} `);
  muted = true;
  try {
    return await rl.question('');
  } finally {
    muted = false;
    process.stdout.write('\n');
  }
}
async function confirm(q: string, yesDefault = true): Promise<boolean> {
  const a = (await ask(`${q} (${yesDefault ? 'Y/n' : 'y/N'})`)).toLowerCase();
  return a === '' ? yesDefault : a.startsWith('y');
}
async function choose<T>(items: T[], label: (t: T) => string, q: string): Promise<T | undefined> {
  items.forEach((item, i) => say(`  ${String(i + 1).padStart(2)}. ${label(item)}`));
  const a = await ask(q);
  const n = Number(a);
  return Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : undefined;
}

class Abort extends Error {}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- steps ----------

async function waitForCamera(
  match: (d: DiscoveredDevice) => boolean,
  seconds: number,
  targets?: string[],
): Promise<DiscoveredDevice | undefined> {
  const deadline = Date.now() + seconds * 1000;
  const extra = testTargets ?? targets;
  while (Date.now() < deadline) {
    if (!testTargets) {
      const found = (await discover({ timeoutMs: 2500 })).filter(isCamera).find(match);
      if (found) return found;
    }
    if (extra) {
      const direct = (await discover({ timeoutMs: 1500, targets: extra, port: discoveryPort }))
        .filter(isCamera)
        .find(match);
      if (direct) return direct;
    }
    process.stdout.write('.');
  }
  return undefined;
}

/**
 * Logins to try. The account login is left out while on the camera's open
 * setup network, where a look-alike network could collect it.
 */
function setupLogins(includeAccount: boolean): LoginCandidate[] {
  const list: LoginCandidate[] = [];
  const override = process.env['SETUP_LOGIN'];
  if (override?.includes(':')) {
    const i = override.indexOf(':');
    list.push({
      label: 'SETUP_LOGIN',
      username: override.slice(0, i),
      password: override.slice(i + 1),
    });
  }
  return [...list, ...defaultSetupLogins(includeAccount ? account() : undefined)];
}

function account() {
  const username = process.env['KASA_USERNAME'] ?? '';
  const password = process.env['KASA_PASSWORD'] ?? '';
  return username && password ? { username, password } : undefined;
}

async function joinCameraNetwork(useNmcli: boolean): Promise<void> {
  say('\nStep 2: join the camera’s setup Wi-Fi.');
  if (!useNmcli) {
    say('Join the camera’s Wi-Fi network on this computer now (usually named like Kasa_…).');
    await ask('Press Enter once connected.');
    return;
  }
  say('Scanning for Wi-Fi networks…');
  const all = await nm.listWifi();
  const likely = all.filter((n) => nm.looksLikeCameraNetwork(n.ssid));
  const list = likely.length > 0 ? likely : all;
  if (likely.length === 0) say('No network looks like a camera; showing all of them.');
  const pick = await choose(
    list,
    (n) => `${n.ssid}  (signal ${n.signal}%${n.security ? `, ${n.security}` : ', open'})`,
    'Which one is the camera?',
  );
  if (!pick) throw new Abort('No network chosen.');
  const password = pick.security ? await askHidden('Its Wi-Fi password:') : undefined;
  say(`Joining ${pick.ssid}…`);
  await nm.joinSetupNetwork(pick.ssid, password);
  await wait(3000);
}

async function returnHome(useNmcli: boolean, homeProfile: string | undefined): Promise<void> {
  if (useNmcli && homeProfile) {
    say(`\nRejoining ${homeProfile}…`);
    try {
      await nm.reconnect(homeProfile);
    } finally {
      await nm.deleteSetupProfile();
    }
    await wait(3000);
  } else {
    say('\nReconnect this computer to your home Wi-Fi now.');
    await ask('Press Enter once connected.');
  }
}

function describeNetwork(n: WifiNetwork): string {
  const signal = n.rssi === undefined ? '' : `${n.rssi} dBm`;
  return `${n.ssid}  (${[n.band, signal, n.open ? 'open' : n.wpaMode].filter(Boolean).join(', ')})`;
}

async function main(): Promise<void> {
  say('Kasa camera setup, without the phone app\n');
  say('This puts a new or factory-reset camera on your Wi-Fi. During setup this');
  say('computer briefly leaves your home Wi-Fi, so the monitor page goes offline.');

  const acct = account();
  say('\nStep 1: how should the camera be set up?');
  say('  1. Link it to your TP-Link account (works with the Kasa app too)');
  say('  2. Local only: never linked to any account');
  const bind = (await ask('Choose 1 or 2:', acct ? '1' : '2')) !== '2';
  if (bind && !acct) {
    throw new Abort('Linking needs KASA_USERNAME and KASA_PASSWORD in .env.');
  }

  const useNmcli = !manualWifi && (await nm.nmcliAvailable());
  const homeProfile = useNmcli ? await nm.activeWifiConnection() : undefined;
  if (useNmcli && !homeProfile) {
    say('\nThis computer isn’t on Wi-Fi, so it can’t switch networks by itself.');
    say('You’ll be asked to switch networks by hand instead.');
  }
  const autoSwitch = useNmcli && homeProfile !== undefined;

  say('\nNow factory-reset the camera with its reset button (see its manual for how');
  say('long to hold it). This erases its settings: if it is your working monitor, it');
  say('stays offline until setup finishes. Wait until it is ready for setup.');
  await ask('Press Enter when the camera is in setup mode.');

  await joinCameraNetwork(autoSwitch);
  let onCameraNetwork = true;
  try {
    say('Looking for the camera');
    const cam = await waitForCamera(() => true, 30, SETUP_ADDRESSES);
    say('');
    if (!cam) throw new Abort('No camera answered on this network.');
    say(`Found ${cam.model || 'a camera'} at ${cam.host}.`);

    const login = await findWorkingLogin({ host: cam.host, apiPort }, setupLogins(false));
    if (!login) {
      throw new Abort(
        'The camera rejected every setup login tried. Set SETUP_LOGIN=user:password to try another.',
      );
    }
    say(`Logged in with: ${login.candidate.label} (${login.credentials.resolvedEncoding}).`);
    const cloud = await getCloudInfo(login.client);
    if (cloud.bound) say('Note: the camera says it is already linked to an account.');

    say('\nStep 3: choose your home Wi-Fi (the camera only sees 2.4 GHz networks).');
    const networks = await scanWifi(login.client);
    let home = await choose(networks, describeNetwork, 'Number, or Enter to type a name:');
    if (!home) {
      const ssid = await ask('Wi-Fi name:');
      if (!ssid) throw new Abort('No Wi-Fi chosen.');
      home = { ssid, band: '2G', rssi: undefined, wpaMode: '', encryption: '', open: false };
    }
    const passphrase = home.open ? '' : await askHidden(`Password for ${home.ssid}:`);
    const alias = await ask('Camera name:', cam.alias || 'nursery');

    say(`\nThe camera will join "${home.ssid}"${bind ? ' and be linked to your account' : ''}.`);
    if (!(await confirm('Go ahead?'))) throw new Abort('Stopped before changing anything.');

    const joined = await joinWifi(login.client, {
      ssid: home.ssid,
      passphrase,
      band: home.band,
      wpaMode: home.wpaMode,
      encryption: home.encryption,
    });
    say('Wi-Fi details sent. The camera is switching networks.');
    say(`(Camera accepted: ${JSON.stringify(joined.accepted)} after ${joined.attempts} tries.)`);

    await returnHome(autoSwitch, homeProfile);
    onCameraNetwork = false;

    say('Waiting for the camera to join your home network (up to 2 minutes)');
    const sameCamera = (d: DiscoveredDevice) =>
      (cam.deviceId !== '' && d.deviceId === cam.deviceId) || (cam.mac !== '' && d.mac === cam.mac);
    const onHome = await waitForCamera(sameCamera, 120, []);
    say('');
    if (!onHome) {
      throw new Abort(
        'The camera didn’t show up. Check the Wi-Fi password and that the network is 2.4 GHz, then reset and try again.',
      );
    }
    say(`The camera is on your network at ${onHome.host}.`);

    const homeLogin = await findWorkingLogin({ host: onHome.host, apiPort }, [login.candidate]);
    if (!homeLogin) throw new Abort('The camera stopped accepting the setup login.');
    try {
      const result = await finishSetup(homeLogin.client, {
        alias,
        ...(bind && acct ? { bindAccount: acct } : {}),
      });
      if (result.bound) say(`Linked to your account (password sent as ${result.bindPassword}).`);
    } catch (err) {
      if (err instanceof LinkieError) {
        say(`\nLinking to your account failed: ${err.message}`);
        say('The camera is on your Wi-Fi and works locally with the setup login.');
      } else {
        throw err;
      }
    }

    const finalLogin = await findWorkingLogin({ host: onHome.host, apiPort }, setupLogins(true));
    if (!finalLogin) throw new Abort('Setup finished but no known login works now.');
    say(`Camera login is now: ${finalLogin.candidate.label}.`);

    const envPath = process.env['ENV_FILE'] ?? path.join(findRepoRoot() ?? process.cwd(), '.env');
    const values: Record<string, string> = { KASA_HOST: onHome.host };
    if (finalLogin.candidate.label !== 'your Kasa account') {
      values['KASA_USERNAME'] = finalLogin.candidate.username;
      values['KASA_PASSWORD'] = finalLogin.candidate.password;
    }
    say(`\nSave ${Object.keys(values).join(', ')} to ${envPath}?`);
    if (values['KASA_USERNAME']) say('This replaces the Kasa login currently saved there.');
    if (await confirm('Save?')) {
      updateEnvFile(envPath, values);
      say('Saved. Restart the monitor: systemctl --user restart kasa-monitor');
    }
    say('\nDone. Tip: give the camera a fixed address in your router so it never moves.');
  } finally {
    if (onCameraNetwork) await returnHome(autoSwitch, homeProfile).catch(() => undefined);
  }
}

main()
  .catch((err: unknown) => {
    say(`\n${err instanceof Abort ? err.message : `Setup failed: ${(err as Error).message}`}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
