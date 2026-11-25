/**
 * List Kasa devices on the local network (no credentials needed).
 *   pnpm discover
 */
import { discover, isCamera } from '../kasa/discovery.js';

const devices = await discover({ timeoutMs: 3000 });
if (devices.length === 0) {
  console.log('No Kasa devices answered. Is this computer on the same network as the camera?');
  process.exit(1);
}
for (const d of devices.sort((a, b) => a.host.localeCompare(b.host))) {
  const kind = isCamera(d) ? 'camera' : 'device';
  console.log(`${d.host.padEnd(16)} ${kind.padEnd(7)} ${d.model.padEnd(14)} ${d.alias}`);
}
