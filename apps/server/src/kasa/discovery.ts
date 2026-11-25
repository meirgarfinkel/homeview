import dgram from 'node:dgram';
import os from 'node:os';
import { decryptJson, encryptJson } from './cipher.js';
import type { CameraSysinfo } from './linkieClient.js';

/**
 * Kasa LAN discovery: broadcast an XOR-obfuscated `get_sysinfo` to UDP 9999.
 * Cameras answer without authentication, which also tells us the password
 * encoding they expect (`c_opt`) before we send any credentials.
 */

export const DISCOVERY_PORT = 9999;

export interface DiscoveredDevice {
  host: string;
  alias: string;
  model: string;
  type: string;
  mac: string;
  deviceId: string;
  sysinfo: CameraSysinfo;
}

interface SysinfoReply {
  system?: { get_sysinfo?: { system?: CameraSysinfo } & CameraSysinfo };
}

function parseReply(host: string, msg: Buffer): DiscoveredDevice | undefined {
  let reply: SysinfoReply;
  try {
    reply = decryptJson<SysinfoReply>(msg);
  } catch {
    return undefined;
  }
  const info = reply.system?.get_sysinfo;
  // Cameras nest the fields one level deeper than plugs and bulbs.
  const sys = (info?.system ?? info) as CameraSysinfo | undefined;
  if (!sys) return undefined;
  return {
    host,
    alias: String(sys.alias ?? ''),
    model: String(sys.model ?? ''),
    type: String(sys.type ?? (sys as { mic_type?: string }).mic_type ?? ''),
    mac: String(sys.mac ?? (sys as { mic_mac?: string }).mic_mac ?? ''),
    deviceId: String(sys.deviceId ?? ''),
    sysinfo: sys,
  };
}

/** Directed broadcast addresses for every IPv4 LAN interface, plus 255.255.255.255. */
export function broadcastAddresses(): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((octet, i) => (octet & mask[i]!) | (~mask[i]! & 255)).join('.'));
    }
  }
  return [...out];
}

export interface DiscoverOptions {
  timeoutMs?: number;
  /** Send to these addresses instead of broadcasting (unicast probe). */
  targets?: string[];
  port?: number;
}

export async function discover(opts: DiscoverOptions = {}): Promise<DiscoveredDevice[]> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const port = opts.port ?? DISCOVERY_PORT;
  const targets = opts.targets ?? broadcastAddresses();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const found = new Map<string, DiscoveredDevice>();

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, () => {
      socket.removeListener('error', reject);
      resolve();
    });
  });
  socket.setBroadcast(true);
  socket.on('message', (msg, rinfo) => {
    const device = parseReply(rinfo.address, msg);
    if (device) found.set(rinfo.address, device);
  });
  socket.on('error', () => undefined);

  const probe = encryptJson({ system: { get_sysinfo: {} } });
  const send = () => {
    for (const target of targets) socket.send(probe, port, target, () => undefined);
  };
  // UDP is lossy; send twice.
  send();
  const resend = setTimeout(send, Math.min(500, timeoutMs / 2));

  await new Promise((r) => setTimeout(r, timeoutMs));
  clearTimeout(resend);
  socket.close();
  return [...found.values()];
}

export function isCamera(device: DiscoveredDevice): boolean {
  return /IPCAMERA/i.test(device.type);
}
