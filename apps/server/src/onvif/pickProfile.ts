import type { OnvifProfile } from './device.js';

const MAX_HEIGHT = 1080;

/**
 * The stream to watch: the main (first) profile if it is 1080p or smaller,
 * else the largest profile that is, else the smallest one. On equal size,
 * H.264 wins (more browsers play it). Only H.264 and H.265 profiles count.
 */
export function pickProfile(profiles: readonly OnvifProfile[]): OnvifProfile | undefined {
  const playable = profiles.filter((p) => p.codec === 'h264' || p.codec === 'h265');
  if (playable.length === 0) return undefined;
  const main = profiles[0];
  if (main && playable.includes(main) && main.height <= MAX_HEIGHT) return main;
  const area = (p: OnvifProfile) => p.width * p.height;
  const h264First = (a: OnvifProfile, b: OnvifProfile) =>
    (a.codec === 'h264' ? 0 : 1) - (b.codec === 'h264' ? 0 : 1);
  const fitting = playable.filter((p) => p.height <= MAX_HEIGHT);
  if (fitting.length > 0) {
    return [...fitting].sort((a, b) => area(b) - area(a) || h264First(a, b))[0];
  }
  return [...playable].sort((a, b) => area(a) - area(b) || h264First(a, b))[0];
}

/**
 * The camera's stream address with the host replaced by the address we know
 * the camera by. Port and path stay; credentials go. Cameras often report an
 * old or internal address, and the server never connects where a camera says.
 */
export function rewriteStreamHost(uri: string, knownHost: string): string {
  const url = new URL(uri);
  if (url.protocol !== 'rtsp:') throw new Error(`Not an RTSP address: ${url.protocol}`);
  const port = url.port || '554';
  const host = knownHost.includes(':') && !knownHost.startsWith('[') ? `[${knownHost}]` : knownHost;
  return `rtsp://${host}:${port}${url.pathname}${url.search}`;
}
