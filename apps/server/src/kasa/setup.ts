import { CameraCredentials, encodePassword, type PasswordEncodingSetting } from './credentials.js';
import { CameraAuthError, LinkieClient, LinkieError } from './linkieClient.js';
import type { CameraTimeZone } from './timeZone.js';
import type { CameraTlsConfig } from './tls.js';
import type { Logger } from '../logger.js';

/**
 * Setting up a Kasa camera without the phone app.
 *
 * The camera can't reach the internet while it broadcasts its own setup
 * Wi-Fi, so setup runs in two phases, as the Kasa app does:
 *
 *   1. On the camera's setup network: log in, scan Wi-Fi, send the home
 *      network's details (`wireless.set_uplink`). The camera then leaves its
 *      setup network and joins yours.
 *   2. On the home network: find the camera again, optionally link it to a
 *      TP-Link account (`cloud.set_bind`), and mark setup as done.
 *
 * Command names and fields come from the Kasa app's command list. The whole
 * flow was verified on a factory-reset KC410S: setup login admin/admin,
 * key_index left out of set_uplink, set_bind with the password as typed.
 * Fallbacks remain for other models. See docs/PROTOCOL.md.
 */

export interface LoginCandidate {
  /** Shown to the user, never contains the password. */
  label: string;
  username: string;
  password: string;
  encoding?: PasswordEncodingSetting;
}

/**
 * Logins to try on a camera that isn't linked to an account yet (a reset
 * KC410S accepts admin/admin). Kept short on purpose: the camera might
 * rate-limit or lock out repeated failures.
 */
export function defaultSetupLogins(account?: { username: string; password: string }) {
  const list: LoginCandidate[] = [
    { label: 'admin / admin', username: 'admin', password: 'admin' },
    { label: 'admin / (blank)', username: 'admin', password: '' },
  ];
  if (account?.username) {
    list.push({ label: 'your Kasa account', ...account });
  }
  return list;
}

export interface SetupTarget {
  host: string;
  apiPort?: number;
  tls?: CameraTlsConfig;
  logger?: Logger;
}

export interface WorkingLogin {
  candidate: LoginCandidate;
  client: LinkieClient;
  credentials: CameraCredentials;
}

/** Try each login in turn; return the first the camera accepts. */
export async function findWorkingLogin(
  target: SetupTarget,
  candidates: LoginCandidate[],
): Promise<WorkingLogin | undefined> {
  for (const candidate of candidates) {
    const credentials = new CameraCredentials(
      candidate.username,
      candidate.password,
      candidate.encoding ?? 'auto',
    );
    const client = new LinkieClient({
      host: target.host,
      port: target.apiPort ?? 10443,
      credentials,
      tls: target.tls,
      logger: target.logger,
    });
    try {
      await client.call('cloud', 'get_info');
      return { candidate, client, credentials };
    } catch (err) {
      if (err instanceof CameraAuthError) continue;
      throw err;
    }
  }
  return undefined;
}

export interface CloudInfo {
  bound: boolean;
  username: string;
  cloudConnected: boolean;
}

export async function getCloudInfo(client: LinkieClient): Promise<CloudInfo> {
  const info = await client.call('cloud', 'get_info');
  return {
    bound: info['binded'] === true,
    username: typeof info['username'] === 'string' ? info['username'] : '',
    cloudConnected: info['cld_connection'] === true,
  };
}

export interface WifiNetwork {
  ssid: string;
  band: string;
  rssi: number | undefined;
  /** Values as the camera reports them; passed back unchanged to set_uplink. */
  wpaMode: string;
  encryption: string;
  open: boolean;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}

export function parseApList(reply: Record<string, unknown>): WifiNetwork[] {
  const list = Array.isArray(reply['ap_info']) ? reply['ap_info'] : [];
  const seen = new Map<string, WifiNetwork>();
  for (const raw of list as Record<string, unknown>[]) {
    const ssid = str(raw['ssid']);
    if (!ssid) continue;
    const wpaMode = str(raw['wpa_mode'], str(raw['auth']));
    const rssi = typeof raw['rssi'] === 'number' ? raw['rssi'] : undefined;
    const network: WifiNetwork = {
      ssid,
      band: str(raw['band'], '2G'),
      rssi,
      wpaMode,
      encryption: str(raw['encryption']),
      open: /^(none|open)?$/i.test(wpaMode),
    };
    const prev = seen.get(ssid);
    if (!prev || (rssi ?? -999) > (prev.rssi ?? -999)) seen.set(ssid, network);
  }
  return [...seen.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask the camera to scan, then read the results. */
export async function scanWifi(
  client: LinkieClient,
  opts: { band?: string; settleMs?: number } = {},
): Promise<WifiNetwork[]> {
  const band = opts.band ?? '2G';
  try {
    await client.call('wireless', 'set_start_scan', { band, scan_type: 'normal' });
    await wait(opts.settleMs ?? 4000);
  } catch (err) {
    // Some firmware scans as part of get_ap_list instead.
    if (!(err instanceof LinkieError)) throw err;
  }
  const reply = await client.call('wireless', 'get_ap_list', { band, scan: true });
  return parseApList(reply);
}

export interface HomeWifi {
  ssid: string;
  passphrase: string;
  band?: string;
  wpaMode?: string;
  encryption?: string;
}

/**
 * Send the home Wi-Fi details. After this succeeds the camera drops its
 * setup network, so nothing else can be sent on it.
 */
/** err_code the camera uses for "The parameter [name] error." */
const PARAMETER_ERROR = -31006;

/** Field-level fallbacks, tried in order when the camera rejects that field. */
const KEY_INDEX_OPTIONS: (string | number | undefined)[] = [undefined, '1', 1];

export interface JoinResult {
  /** The exact fields the camera accepted (passphrase removed), for the notes. */
  accepted: Record<string, unknown>;
  attempts: number;
}

/**
 * Send the home Wi-Fi details. After this succeeds the camera drops its
 * setup network, so nothing else can be sent on it.
 *
 * The app's exact field values aren't confirmed, so when the camera rejects
 * one field by name (err_code -31006 "The parameter [x] error."), only that
 * field is adjusted and the command resent. A rejected command changes
 * nothing on the camera.
 *
 * Known: a KC410S on fw 2.3.27 rejects `key_index: "0"` (WEP-only field).
 */
export async function joinWifi(client: LinkieClient, wifi: HomeWifi): Promise<JoinResult> {
  const open = !wifi.passphrase;
  const args: Record<string, unknown> = {
    ssid: wifi.ssid,
    passphrase: wifi.passphrase,
    band: wifi.band ?? '2G',
    wpa_mode: wifi.wpaMode || (open ? 'NONE' : 'WPA2_PSK'),
    encryption: wifi.encryption || (open ? 'NONE' : 'AES'),
    apply: true,
  };
  let keyIndex = 0;
  let applySeparately = false;

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      await client.call('wireless', 'set_uplink', args);
      if (applySeparately) await client.call('wireless', 'set_apply_changes', { delay: 1 });
      const accepted = { ...args };
      delete accepted['passphrase'];
      return { accepted, attempts: attempt };
    } catch (err) {
      const field =
        err instanceof LinkieError && err.errCode === PARAMETER_ERROR
          ? /\[(\w+)\]/.exec(err.message)?.[1]
          : undefined;
      if (field === 'key_index' && keyIndex + 1 < KEY_INDEX_OPTIONS.length) {
        keyIndex++;
        args['key_index'] = KEY_INDEX_OPTIONS[keyIndex];
      } else if (field === 'apply' && !applySeparately) {
        delete args['apply'];
        applySeparately = true;
      } else {
        throw err;
      }
    }
  }
  throw new Error('The camera kept rejecting the Wi-Fi settings');
}

export interface FinishOptions {
  alias?: string;
  /** Set the camera's clock to this zone (the Kasa app does this during setup). */
  timeZone?: CameraTimeZone;
  /** Turn on the time stamped on the video (off after a factory reset). */
  showTime?: boolean;
  /** Link to this TP-Link account. Omit for local-only use. */
  bindAccount?: { username: string; password: string };
}

export interface FinishResult {
  aliasSet: boolean;
  bound: boolean;
  /** How the account password was sent to `set_bind`, when linking worked. */
  bindPassword?: 'plain' | 'md5';
  timeZoneSet?: boolean;
  timeShown?: boolean;
  /** Optional settings the camera refused; setup still succeeded. */
  warnings: string[];
}

/**
 * Phase 2, on the home network: name it, mark setup done, then optionally
 * link the account. Linking goes last because it changes the login the
 * camera accepts, which would lock out this client for any later command.
 */
export async function finishSetup(
  client: LinkieClient,
  opts: FinishOptions,
): Promise<FinishResult> {
  let aliasSet = false;
  const warnings: string[] = [];
  if (opts.alias) {
    await client.call('system', 'set_alias', { value: opts.alias });
    aliasSet = true;
  }
  // Nice-to-haves: other models may not support them, so they never fail setup.
  const optional = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch (err) {
      if (!(err instanceof LinkieError)) throw err;
      warnings.push(`${what}: ${err.message}`);
      return false;
    }
  };
  const extras: Pick<FinishResult, 'timeZoneSet' | 'timeShown'> = {};
  if (opts.timeZone) {
    const tz = opts.timeZone;
    extras.timeZoneSet = await optional('time zone', () =>
      client.call('dateTime', 'set_time_zone', { ...tz }),
    );
  }
  if (opts.showTime) {
    extras.timeShown = await optional('on-screen time', () =>
      client.call('OSD', 'set_time_is_enable', { value: 'on' }),
    );
  }
  await client.call('system', 'set_onboarding_status', { value: 'done' });
  const base = { aliasSet, ...extras, warnings };
  if (!opts.bindAccount) return { ...base, bound: false };

  // A KC410S takes the password as typed. MD5 hex (the camera's own login
  // format) is kept as a fallback for other models.
  const { username, password } = opts.bindAccount;
  let lastError: unknown;
  for (const [form, value] of [
    ['plain', password],
    ['md5', encodePassword(password, 'md5')],
  ] as const) {
    try {
      await client.call('cloud', 'set_bind', { username, password: value });
      return { ...base, bound: true, bindPassword: form };
    } catch (err) {
      if (!(err instanceof LinkieError)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
