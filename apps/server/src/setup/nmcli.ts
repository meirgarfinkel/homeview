import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Moves this computer between Wi-Fi networks during camera setup, using
 * NetworkManager's `nmcli`. Arguments go straight to execFile (no shell), so
 * network names with odd characters can't inject commands.
 */

const run = promisify(execFile);

/** Name of the temporary profile used to join the camera's setup network. */
export const SETUP_PROFILE = 'kasa-camera-setup';

/** Split one line of `nmcli -t` output: fields are ':'-separated, with '\:' and '\\' escaped. */
export function splitTerse(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (ch === ':') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

export interface VisibleNetwork {
  ssid: string;
  signal: number;
  security: string;
}

export function parseWifiList(stdout: string): VisibleNetwork[] {
  const best = new Map<string, VisibleNetwork>();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [ssid = '', signal = '0', security = ''] = splitTerse(line);
    if (!ssid) continue;
    const net = { ssid, signal: Number(signal) || 0, security };
    const prev = best.get(ssid);
    if (!prev || net.signal > prev.signal) best.set(ssid, net);
  }
  return [...best.values()].sort((a, b) => b.signal - a.signal);
}

/** Setup networks seen so far are named like "Kasa_Camera_XXXX" or "TP-LINK_…"; unconfirmed. */
export function looksLikeCameraNetwork(ssid: string): boolean {
  return /kasa|tp-?link|camera|\bcam\b|^kc\d/i.test(ssid);
}

export async function nmcliAvailable(): Promise<boolean> {
  try {
    await run('nmcli', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/** The active Wi-Fi connection profile, so it can be restored afterwards. */
export async function activeWifiConnection(): Promise<string | undefined> {
  const { stdout } = await run('nmcli', [
    '-t',
    '-f',
    'NAME,TYPE',
    'connection',
    'show',
    '--active',
  ]);
  for (const line of stdout.split('\n')) {
    const [name, type] = splitTerse(line);
    if (name && type === '802-11-wireless' && name !== SETUP_PROFILE) return name;
  }
  return undefined;
}

export async function listWifi(): Promise<VisibleNetwork[]> {
  const { stdout } = await run(
    'nmcli',
    ['-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'],
    { timeout: 30_000 },
  );
  return parseWifiList(stdout);
}

export async function joinSetupNetwork(ssid: string, password?: string): Promise<void> {
  await deleteSetupProfile();
  const args = ['device', 'wifi', 'connect', ssid];
  if (password) args.push('password', password);
  args.push('name', SETUP_PROFILE);
  await run('nmcli', args, { timeout: 60_000 });
}

export async function reconnect(profile: string): Promise<void> {
  await run('nmcli', ['connection', 'up', profile], { timeout: 60_000 });
}

/** Remove the temporary profile so this computer never auto-joins the camera's network. */
export async function deleteSetupProfile(): Promise<void> {
  try {
    await run('nmcli', ['connection', 'delete', SETUP_PROFILE]);
  } catch {
    // Not there: nothing to do.
  }
}
