import {
  discover,
  isCamera,
  type DiscoverOptions,
  type DiscoveredDevice,
} from '../kasa/discovery.js';
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
  type WorkingLogin,
} from '../kasa/setup.js';
import { cameraTimeZone, hostTimeZone } from '../kasa/timeZone.js';
import type { Logger } from '../logger.js';
import type { Settings } from '../settings/store.js';
import type { WifiSwitcher } from './wifiSwitcher.js';

export type { WifiSwitcher } from './wifiSwitcher.js';

/**
 * Puts a new or factory-reset camera on the home Wi-Fi, step by step, so a
 * terminal or a web page can drive it. The steps are the ones the Kasa app
 * takes; see kasa/setup.ts for the camera commands.
 *
 * The job runs by itself between answers. `status()` says what it is doing
 * or waiting for, and `answer()` moves it on when it waits for the person.
 */

/** Addresses the Kasa app expects a camera to use on its setup network. */
export const SETUP_ADDRESSES = ['192.168.191.1', '192.168.0.1', '192.168.0.10'];

export type OnboardingPhase =
  | 'reset-camera' // waiting for the parent to say the camera is reset
  | 'join-camera-wifi' // auto: switching; manual: waiting to see the camera at 192.168.0.10
  | 'scanning' // asking the camera for networks
  | 'choose-wifi' // waiting for { ssid, passphrase, alias }
  | 'sending' // set_uplink
  | 'return-home' // auto: switching back; manual: waiting to be on home Wi-Fi
  | 'waiting-for-camera' // up to 120 s for the camera to appear by device ID
  | 'finishing' // alias, clock, on-video time, account link
  | 'done'
  | 'failed';

export interface OnboardingNetwork {
  ssid: string;
  /** RSSI in dBm. */
  signal?: number;
  open: boolean;
  band?: string;
  /** The camera's name for the security, such as WPA2_PSK. */
  security?: string;
}

export interface OnboardingStatus {
  phase: OnboardingPhase;
  autoWifi: boolean;
  networks?: OnboardingNetwork[]; // in choose-wifi
  cameraNetwork?: string; // e.g. Kasa_Cam_1A2B, when known
  /** The camera found on its setup network. */
  camera?: { model: string; host: string; alias: string };
  error?: { message: string; retryFrom: OnboardingPhase }; // in failed
  result?: { alias: string; host: string; linked: boolean; warnings: string[] }; // in done
}

export type OnboardingAnswer =
  | { type: 'camera-reset' }
  | { type: 'wifi'; ssid: string; passphrase: string; alias: string }
  | { type: 'retry' };

/** Progress for a terminal: phase changes, lines worth showing, and one tick per poll. */
export type OnboardingEvent =
  { type: 'status'; status: OnboardingStatus } | { type: 'note'; text: string } | { type: 'tick' };

export interface OnboardingOptions {
  mode: 'account' | 'local';
  account?: { username: string; password: string };
  switcher: WifiSwitcher;
  setupAddresses?: string[];
  apiPort?: number;
  /** With `targets`, every search probes those addresses instead of broadcasting. */
  discovery?: DiscoverOptions;
  timeouts?: Partial<{
    cameraWifiMs: number;
    homeMs: number;
    /** Time between searches (default 2 s). */
    pollMs: number;
    /** How long the camera scans for Wi-Fi (default 4 s). */
    scanSettleMs: number;
  }>;
  /** Logins tried before the usual setup ones. */
  extraLogins?: LoginCandidate[];
  /** IANA zone for the camera's clock (default: this computer's). */
  timeZone?: string;
  onSaved(camera: NonNullable<Settings['camera']>): void;
  onEvent?(event: OnboardingEvent): void;
  logger: Logger;
}

/** A failure whose message is meant for the person as it is. */
export class OnboardingError extends Error {}

/** An answer that doesn't fit what the job is waiting for. */
export class OnboardingStateError extends Error {}

/** Thrown inside a run that was cancelled or replaced. */
class Stale extends Error {}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Onboarding {
  private state: OnboardingStatus;
  /** Bumped by every new run and by cancel(), so an old run stops at its next step. */
  private gen = 0;
  private onCameraNetwork = false;
  private retryFrom: OnboardingPhase = 'reset-camera';
  private cam: DiscoveredDevice | undefined;
  private login: WorkingLogin | undefined;
  private networks: WifiNetwork[] = [];
  private wifi: { ssid: string; passphrase: string; alias: string } | undefined;

  constructor(private readonly opts: OnboardingOptions) {
    if (opts.mode === 'account' && !(opts.account?.username && opts.account.password)) {
      throw new Error('Linking needs the TP-Link account email and password.');
    }
    this.state = { phase: 'reset-camera', autoWifi: opts.switcher.auto };
  }

  status(): OnboardingStatus {
    return structuredClone(this.state);
  }

  answer(a: OnboardingAnswer): void {
    const phase = this.state.phase;
    const expect = (wanted: OnboardingPhase) => {
      if (phase !== wanted) {
        throw new OnboardingStateError(`Setup isn't waiting for that now (it is at ${phase}).`);
      }
    };
    if (a.type === 'camera-reset') {
      expect('reset-camera');
      this.run((gen) => this.joinAndScan(gen));
    } else if (a.type === 'wifi') {
      expect('choose-wifi');
      if (!a.ssid) throw new OnboardingStateError('Choose a Wi-Fi network.');
      this.wifi = { ssid: a.ssid, passphrase: a.passphrase, alias: a.alias.trim() };
      this.run((gen) => this.sendAndFinish(gen));
    } else {
      expect('failed');
      const from = this.state.error?.retryFrom ?? 'reset-camera';
      if (from === 'join-camera-wifi') {
        this.run((gen) => this.joinAndScan(gen));
      } else if (from === 'waiting-for-camera') {
        this.run((gen) => this.waitAndFinish(gen));
      } else {
        this.cam = undefined;
        this.login = undefined;
        this.state = { phase: 'reset-camera', autoWifi: this.opts.switcher.auto };
        this.emit({ type: 'status', status: this.status() });
      }
    }
  }

  async cancel(): Promise<void> {
    if (this.state.phase === 'done' || this.state.phase === 'failed') return;
    this.gen++;
    this.set('failed', { error: { message: 'Setup was cancelled.', retryFrom: 'reset-camera' } });
    await this.afterStop();
  }

  // ---------- runs ----------

  private run(step: (gen: number) => Promise<void>): void {
    const gen = ++this.gen;
    void step(gen).catch((err: unknown) => this.fail(gen, err));
  }

  private async fail(gen: number, err: unknown): Promise<void> {
    if (gen !== this.gen) {
      // Cancelled while a step was in flight, which may have joined the camera's network.
      await this.afterStop();
      return;
    }
    const message =
      err instanceof OnboardingError ? err.message : `Setup failed: ${(err as Error).message}`;
    this.opts.logger.warn({ err, phase: this.state.phase }, 'camera onboarding failed');
    await this.leaveCameraNetwork().catch((e: unknown) =>
      this.opts.logger.warn({ err: e }, 'could not return to the home Wi-Fi'),
    );
    if (gen === this.gen) this.set('failed', { error: { message, retryFrom: this.retryFrom } });
  }

  /** After cancel: only the automatic switcher can take the computer home. */
  private async afterStop(): Promise<void> {
    if (!this.opts.switcher.auto) {
      this.onCameraNetwork = false;
      return;
    }
    await this.leaveCameraNetwork().catch((err: unknown) =>
      this.opts.logger.warn({ err }, 'could not return to the home Wi-Fi'),
    );
  }

  private async leaveCameraNetwork(): Promise<void> {
    if (!this.onCameraNetwork) return;
    this.onCameraNetwork = false;
    await this.opts.switcher.returnHome();
  }

  private check(gen: number): void {
    if (gen !== this.gen) throw new Stale('cancelled');
  }

  private async joinAndScan(gen: number): Promise<void> {
    this.retryFrom = 'join-camera-wifi';
    this.set('join-camera-wifi');
    const network = await this.opts.switcher.joinCameraNetwork();
    this.onCameraNetwork = true;
    this.check(gen);
    if (network) this.set('join-camera-wifi', { cameraNetwork: network });

    this.note('Looking for the camera');
    const d = this.opts.discovery ?? {};
    const setupAddresses = this.opts.setupAddresses ?? SETUP_ADDRESSES;
    const cam = await this.search(gen, () => true, this.timeout('cameraWifiMs'), [
      ...(d.targets ? [] : [{ timeoutMs: d.timeoutMs ?? 2500, port: d.port }]),
      { timeoutMs: d.timeoutMs ?? 1500, targets: setupAddresses, port: d.port },
    ]);
    if (!cam) throw new OnboardingError('No camera answered on this network.');
    this.note(`Found ${cam.model || 'a camera'} at ${cam.host}.`);
    this.cam = cam;
    this.set('join-camera-wifi', {
      camera: { model: cam.model, host: cam.host, alias: cam.alias },
    });

    const login = await findWorkingLogin(this.target(cam.host), this.logins(false));
    this.check(gen);
    if (!login) {
      throw new OnboardingError(
        'The camera rejected every setup login tried. Set SETUP_LOGIN=user:password to try another.',
      );
    }
    this.login = login;
    this.note(`Logged in with: ${login.candidate.label} (${login.credentials.resolvedEncoding}).`);
    const cloud = await getCloudInfo(login.client);
    if (cloud.bound) this.note('Note: the camera says it is already linked to an account.');

    this.check(gen);
    this.set('scanning');
    this.networks = await scanWifi(login.client, { settleMs: this.opts.timeouts?.scanSettleMs });
    this.check(gen);
    this.set('choose-wifi', {
      networks: this.networks.map((n) => ({
        ssid: n.ssid,
        ...(n.rssi !== undefined ? { signal: n.rssi } : {}),
        open: n.open,
        band: n.band,
        security: n.wpaMode,
      })),
    });
  }

  private async sendAndFinish(gen: number): Promise<void> {
    const login = this.login!;
    const wifi = this.wifi!;
    this.retryFrom = 'join-camera-wifi';
    this.set('sending');
    const scanned = this.networks.find((n) => n.ssid === wifi.ssid);
    const joined = await joinWifi(login.client, {
      ssid: wifi.ssid,
      passphrase: wifi.passphrase,
      band: scanned?.band,
      wpaMode: scanned?.wpaMode,
      encryption: scanned?.encryption,
    });
    // The camera has left its setup network; starting over needs a reset.
    this.retryFrom = 'reset-camera';
    this.note('Wi-Fi details sent. The camera is switching networks.');
    this.note(
      `(Camera accepted: ${JSON.stringify(joined.accepted)} after ${joined.attempts} tries.)`,
    );
    this.check(gen);

    this.set('return-home');
    await this.leaveCameraNetwork();
    this.check(gen);
    await this.waitAndFinish(gen);
  }

  private async waitAndFinish(gen: number): Promise<void> {
    const cam = this.cam!;
    const login = this.login!;
    const wifi = this.wifi!;
    this.retryFrom = 'reset-camera';
    this.set('waiting-for-camera');
    this.note('Waiting for the camera to join your home network (up to 2 minutes)');
    const sameCamera = (d: DiscoveredDevice) =>
      (cam.deviceId !== '' && d.deviceId === cam.deviceId) || (cam.mac !== '' && d.mac === cam.mac);
    const d = this.opts.discovery ?? {};
    const onHome = await this.search(gen, sameCamera, this.timeout('homeMs'), [
      { ...d, timeoutMs: d.timeoutMs ?? 2500 },
    ]);
    if (!onHome) {
      throw new OnboardingError(
        "The camera didn't show up. Check the Wi-Fi password and that the network is 2.4 GHz, then reset and try again.",
      );
    }
    this.note(`The camera is on your network at ${onHome.host}.`);

    this.retryFrom = 'waiting-for-camera';
    this.set('finishing');
    const target = this.target(onHome.host);
    const homeLogin = await findWorkingLogin(target, [login.candidate]);
    this.check(gen);
    if (!homeLogin) throw new OnboardingError('The camera stopped accepting the setup login.');
    const alias = wifi.alias || cam.alias || 'nursery';
    const zone = this.opts.timeZone || hostTimeZone();
    const account = this.opts.mode === 'account' ? this.opts.account : undefined;
    const warnings: string[] = [];
    let linked = false;
    try {
      const result = await finishSetup(homeLogin.client, {
        alias,
        timeZone: cameraTimeZone(zone),
        showTime: true,
        ...(account ? { bindAccount: account } : {}),
      });
      if (result.timeZoneSet) {
        this.note(`Camera clock set to ${zone}, with the time shown on the video.`);
      }
      for (const w of result.warnings) this.note(`Skipped ${w}`);
      warnings.push(...result.warnings);
      linked = result.bound;
      if (result.bound) {
        this.note(`Linked to your account (password sent as ${result.bindPassword}).`);
      }
    } catch (err) {
      if (!(err instanceof LinkieError)) throw err;
      this.note(`\nLinking to your account failed: ${err.message}`);
      this.note('The camera is on your Wi-Fi and works locally with the setup login.');
      warnings.push(`Linking to your account failed: ${err.message}`);
    }

    const finalLogin = await findWorkingLogin(target, this.logins(true));
    this.check(gen);
    if (!finalLogin) throw new OnboardingError('Setup finished but no known login works now.');
    this.note(`Camera login is now: ${finalLogin.candidate.label}.`);
    this.opts.onSaved({
      username: finalLogin.candidate.username,
      password: finalLogin.candidate.password,
      alias,
      localOnly: !linked,
    });
    this.set('done', { result: { alias, host: onHome.host, linked, warnings } });
  }

  // ---------- helpers ----------

  /** Probe with each option in turn, round after round, until a camera matches or time runs out. */
  private async search(
    gen: number,
    match: (d: DiscoveredDevice) => boolean,
    ms: number,
    probes: DiscoverOptions[],
  ): Promise<DiscoveredDevice | undefined> {
    const deadline = Date.now() + ms;
    const pollMs = this.opts.timeouts?.pollMs ?? 2000;
    while (Date.now() < deadline) {
      const started = Date.now();
      for (const probe of probes) {
        const found = (await discover(probe)).filter(isCamera).find(match);
        this.check(gen);
        if (found) return found;
      }
      this.emit({ type: 'tick' });
      await wait(Math.max(0, Math.min(pollMs - (Date.now() - started), deadline - Date.now())));
      this.check(gen);
    }
    return undefined;
  }

  private timeout(which: 'cameraWifiMs' | 'homeMs'): number {
    const given = this.opts.timeouts?.[which];
    if (given !== undefined) return given;
    if (which === 'homeMs') return 120_000;
    // nmcli has already joined; by hand it can take a while.
    return this.opts.switcher.auto ? 30_000 : 10 * 60_000;
  }

  private target(host: string) {
    return { host, apiPort: this.opts.apiPort ?? 10443, logger: this.opts.logger };
  }

  /**
   * Logins to try. The account login is left out while on the camera's open
   * setup network, where a look-alike network could collect it.
   */
  private logins(includeAccount: boolean): LoginCandidate[] {
    const account = this.opts.mode === 'account' ? this.opts.account : undefined;
    return [
      ...(this.opts.extraLogins ?? []),
      ...defaultSetupLogins(includeAccount ? account : undefined),
    ];
  }

  /** Change phase. Facts about the camera stay; per-phase fields are replaced. */
  private set(
    phase: OnboardingPhase,
    extra: Partial<Omit<OnboardingStatus, 'phase' | 'autoWifi'>> = {},
  ): void {
    const { phase: prev, cameraNetwork, camera } = this.state;
    this.state = {
      phase,
      autoWifi: this.opts.switcher.auto,
      ...(cameraNetwork ? { cameraNetwork } : {}),
      ...(camera ? { camera } : {}),
      ...extra,
    };
    if (phase !== prev) this.opts.logger.info({ phase }, 'camera onboarding');
    this.emit({ type: 'status', status: this.status() });
  }

  private note(text: string): void {
    this.emit({ type: 'note', text });
  }

  private emit(event: OnboardingEvent): void {
    try {
      this.opts.onEvent?.(event);
    } catch (err) {
      this.opts.logger.warn({ err }, 'onboarding event handler threw');
    }
  }
}
