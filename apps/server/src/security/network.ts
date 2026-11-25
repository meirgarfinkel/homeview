import net from 'node:net';
import os from 'node:os';

/**
 * Network guards that keep the app reachable only from the local network.
 *
 * 1. Client IP allowlist: loopback + private/link-local ranges by default.
 * 2. Host header allowlist: blocks DNS-rebinding, where a web page on the
 *    internet points its own hostname at this machine's LAN IP and then
 *    reads responses as same-origin.
 * 3. Origin check for WebSockets and state-changing requests (CSRF/CSWSH).
 */

export const PRIVATE_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
];

function parseCidr(cidr: string): { address: string; prefix: number; type: 'ipv4' | 'ipv6' } {
  const [address, prefixRaw] = cidr.trim().split('/');
  const version = net.isIP(address ?? '');
  if (!address || version === 0) throw new Error(`Invalid CIDR "${cidr}"`);
  const max = version === 4 ? 32 : 128;
  const prefix = prefixRaw === undefined ? max : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    throw new Error(`Invalid CIDR prefix in "${cidr}"`);
  }
  return { address, prefix, type: version === 4 ? 'ipv4' : 'ipv6' };
}

/** "::ffff:10.0.0.5" -> "10.0.0.5"; strips IPv6 zone ids. */
export function normalizeIp(ip: string | undefined): string {
  const unzoned = (ip ?? '').split('%', 1)[0]!;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(unzoned);
  return mapped ? mapped[1]! : unzoned;
}

/** True for a connection from this computer (127.0.0.0/8 or ::1). */
export function isLoopback(ip: string | undefined): boolean {
  const addr = normalizeIp(ip);
  return addr === '::1' || (net.isIPv4(addr) && addr.startsWith('127.'));
}

export function createIpAllowlist(
  cidrs: readonly string[] = PRIVATE_CIDRS,
): (ip: string | undefined) => boolean {
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const { address, prefix, type } = parseCidr(cidr);
    list.addSubnet(address, prefix, type);
  }
  return (ip: string | undefined) => {
    const addr = normalizeIp(ip);
    const version = net.isIP(addr);
    if (version === 0) return false;
    return list.check(addr, version === 4 ? 'ipv4' : 'ipv6');
  };
}

/**
 * Interfaces created by containers, VMs and VPNs rather than the home LAN.
 * Linux and macOS names start with a short prefix (docker0, virbr0, utun3,
 * bridge100); Windows names the connection after the adapter
 * ("vEthernet (WSL)", "VMware Network Adapter VMnet8").
 */
export const VIRTUAL_INTERFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|cni|flannel|podman|tun|tap|wg|utun|bridge|zt|tailscale)|vethernet|hyper-v|wsl|vmware|virtualbox|tap-windows|openvpn|wireguard|zerotier|tailscale|nordlynx|hamachi|bluetooth/i;

type InterfaceMap = ReturnType<typeof os.networkInterfaces>;

/**
 * Default client allowlist: loopback plus the private subnets this machine
 * is actually on (e.g. 10.0.0.0/24), skipping container/VM bridges and any
 * public IPv6 prefixes. Narrower than "all private ranges".
 */
export function localNetworkCidrs(interfaces: InterfaceMap = os.networkInterfaces()): string[] {
  const out = new Set(['127.0.0.0/8', '::1/128']);
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.internal || !a.cidr) continue;
      if (a.address.toLowerCase().startsWith('fe80:')) continue; // link-local: not routable LAN identity
      if (!isPrivateAddress(a.address)) continue;
      out.add(a.cidr);
    }
  }
  return [...out];
}

const isPrivate = createIpAllowlist(PRIVATE_CIDRS);
export function isPrivateAddress(ip: string): boolean {
  return isPrivate(ip);
}

/** Hostname part of a Host header value ("[::1]:8080" -> "::1"). */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  const colon = h.lastIndexOf(':');
  // Bare IPv6 without brackets has several colons; leave it alone.
  if (colon !== -1 && h.indexOf(':') === colon) return h.slice(0, colon);
  return h;
}

export function createHostAllowlist(extraHosts: readonly string[] = []): (host: string) => boolean {
  const allowed = new Set(
    ['localhost', os.hostname(), ...extraHosts].map((h) => h.trim().toLowerCase()).filter(Boolean),
  );
  return (hostHeader: string) => {
    const name = hostnameOf(hostHeader);
    if (!name) return false;
    // An IP literal can't be rebound, so any IP is fine (the IP allowlist
    // already restricts who can connect).
    if (net.isIP(name)) return true;
    if (allowed.has(name)) return true;
    // mDNS names on the LAN, e.g. "nursery-pc.local".
    if (name.endsWith('.local') || name.endsWith('.localhost')) return true;
    return false;
  };
}

/**
 * True if the Origin header (when present) points at the same host the
 * request was sent to. Browsers always send Origin on WebSocket handshakes
 * and cross-origin POSTs; non-browser clients usually omit it.
 */
export function isSameOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!hostHeader) return false;
  try {
    return new URL(origin).host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}
