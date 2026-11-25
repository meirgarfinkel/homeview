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
import { createLogger } from '../logger.js';
import { updateEnvFile } from '../setup/envFile.js';
import * as nm from '../setup/nmcli.js';
import {
  Onboarding,
  OnboardingError as Abort,
  SETUP_ADDRESSES,
  type OnboardingPhase,
  type OnboardingStatus,
} from '../setup/onboarding.js';
import { createWifiSwitcher, manualSwitcher, type WifiSwitcher } from '../setup/wifiSwitcher.js';
import type { Settings } from '../settings/store.js';

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

// ---------- steps ----------

function setupLogin() {
  const override = process.env['SETUP_LOGIN'];
  if (!override?.includes(':')) return [];
  const i = override.indexOf(':');
  return [
    { label: 'SETUP_LOGIN', username: override.slice(0, i), password: override.slice(i + 1) },
  ];
}

function account() {
  const username = process.env['KASA_USERNAME'] ?? '';
  const password = process.env['KASA_PASSWORD'] ?? '';
  return username && password ? { username, password } : undefined;
}

/** nmcli when it can switch networks, otherwise asks the person to switch by hand. */
async function terminalSwitcher(): Promise<WifiSwitcher> {
  const auto = manualWifi
    ? manualSwitcher()
    : await createWifiSwitcher({
        onNote: say,
        onNotOnWifi() {
          say('\nThis computer isn’t on Wi-Fi, so it can’t switch networks by itself.');
          say('You’ll be asked to switch networks by hand instead.');
        },
        async pickNetwork(all) {
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
          return { ssid: pick.ssid, password };
        },
      });
  if (auto.auto) {
    return {
      auto: true,
      async joinCameraNetwork() {
        say('\nStep 2: join the camera’s setup Wi-Fi.');
        return auto.joinCameraNetwork();
      },
      returnHome: () => auto.returnHome(),
    };
  }
  return {
    auto: false,
    async joinCameraNetwork() {
      say('\nStep 2: join the camera’s setup Wi-Fi.');
      say('Join the camera’s Wi-Fi network on this computer now (usually named like Kasa_…).');
      await ask('Press Enter once connected.');
      return undefined;
    },
    async returnHome() {
      say('\nReconnect this computer to your home Wi-Fi now.');
      await ask('Press Enter once connected.');
    },
  };
}

type Network = NonNullable<OnboardingStatus['networks']>[number];

function describeNetwork(n: Network): string {
  const signal = n.signal === undefined ? '' : `${n.signal} dBm`;
  return `${n.ssid}  (${[n.band, signal, n.open ? 'open' : n.security].filter(Boolean).join(', ')})`;
}

/** Resolves with the status once the job reaches one of these phases (or fails). */
function reach(job: Onboarding, phases: OnboardingPhase[]): Promise<OnboardingStatus> {
  return new Promise((resolve) => {
    const check = () => {
      const s = job.status();
      if (phases.includes(s.phase) || s.phase === 'failed') {
        clearInterval(timer);
        resolve(s);
      }
    };
    const timer = setInterval(check, 100);
    check();
  });
}

function orThrow(s: OnboardingStatus): OnboardingStatus {
  if (s.phase === 'failed') throw new Abort(s.error?.message ?? 'Setup failed.');
  return s;
}

async function main(): Promise<void> {
  say('Kasa camera setup, without the phone app\n');
  say('This puts a new or factory-reset camera on your Wi-Fi. During setup this');
  say('computer briefly leaves your home Wi-Fi, so the Kasa Home page goes offline.');

  const acct = account();
  say('\nStep 1: how should the camera be set up?');
  say('  1. Link it to your TP-Link account (works with the Kasa app too)');
  say('  2. Local only: never linked to any account');
  const bind = (await ask('Choose 1 or 2:', acct ? '1' : '2')) !== '2';
  if (bind && !acct) {
    throw new Abort('Linking needs KASA_USERNAME and KASA_PASSWORD in .env.');
  }

  const switcher = await terminalSwitcher();
  let saved: NonNullable<Settings['camera']> | undefined;
  let dots = false;
  const job = new Onboarding({
    mode: bind ? 'account' : 'local',
    ...(bind && acct ? { account: acct } : {}),
    switcher,
    setupAddresses: testTargets ?? SETUP_ADDRESSES,
    apiPort,
    discovery: { ...(testTargets ? { targets: testTargets } : {}), port: discoveryPort },
    // The person has already said they joined the camera's Wi-Fi, so look for 30 s as before.
    timeouts: { cameraWifiMs: 30_000 },
    extraLogins: setupLogin(),
    timeZone: process.env['KASA_TIMEZONE'],
    logger: createLogger('silent'),
    onSaved: (camera) => (saved = camera),
    onEvent(e) {
      if (e.type === 'tick') {
        process.stdout.write('.');
        dots = true;
      } else if (e.type === 'note') {
        if (dots) say('');
        dots = false;
        say(e.text);
      }
    },
  });

  say('\nNow factory-reset the camera with its reset button (see its manual for how');
  say('long to hold it). This erases its settings: if it is your working monitor, it');
  say('stays offline until setup finishes. Wait until it is ready for setup.');
  await ask('Press Enter when the camera is in setup mode.');
  job.answer({ type: 'camera-reset' });

  const ready = orThrow(await reach(job, ['choose-wifi']));
  if (dots) say('');
  dots = false;
  say('\nStep 3: choose your home Wi-Fi (the camera only sees 2.4 GHz networks).');
  let home = await choose(
    ready.networks ?? [],
    describeNetwork,
    'Number, or Enter to type a name:',
  );
  if (!home) {
    const ssid = await ask('Wi-Fi name:');
    if (!ssid) {
      await stop(job, switcher);
      throw new Abort('No Wi-Fi chosen.');
    }
    home = { ssid, open: false };
  }
  const passphrase = home.open ? '' : await askHidden(`Password for ${home.ssid}:`);
  const alias = await ask('Camera name:', ready.camera?.alias || 'nursery');

  say(`\nThe camera will join "${home.ssid}"${bind ? ' and be linked to your account' : ''}.`);
  if (!(await confirm('Go ahead?'))) {
    await stop(job, switcher);
    throw new Abort('Stopped before changing anything.');
  }
  job.answer({ type: 'wifi', ssid: home.ssid, passphrase, alias });
  orThrow(await reach(job, ['done']));

  const camera = saved!;
  const envPath = process.env['ENV_FILE'] ?? path.join(findRepoRoot() ?? process.cwd(), '.env');
  // Kasa Home finds the camera by itself and follows it if its address
  // changes, so no address is saved. An old pinned KASA_HOST is cleared.
  const values: Record<string, string> = {};
  if (process.env['KASA_HOST']) values['KASA_HOST'] = '';
  const isAccount = acct && camera.username === acct.username && camera.password === acct.password;
  if (!isAccount) {
    values['KASA_USERNAME'] = camera.username;
    values['KASA_PASSWORD'] = camera.password;
  }
  if (Object.keys(values).length > 0) {
    const what = Object.keys(values)
      .map((k) => (values[k] === '' ? `clear ${k}` : `set ${k}`))
      .join(', ');
    say(`\nUpdate ${envPath} (${what})?`);
    if (values['KASA_USERNAME']) say('This replaces the Kasa login currently saved there.');
    if (await confirm('Save?')) {
      updateEnvFile(envPath, values);
      say('Saved.');
    }
  }
  say('\nDone. Restart Kasa Home so it picks up the camera (it finds it automatically).');
}

/** Stop the job; cancel() only switches back by itself with nmcli. */
async function stop(job: Onboarding, switcher: WifiSwitcher): Promise<void> {
  await job.cancel();
  if (!switcher.auto) await switcher.returnHome();
}

main()
  .catch((err: unknown) => {
    say(`\n${err instanceof Abort ? err.message : `Setup failed: ${(err as Error).message}`}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
