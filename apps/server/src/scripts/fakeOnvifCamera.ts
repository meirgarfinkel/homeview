/**
 * Run a simulated standard (ONVIF) camera for UI development:
 *   pnpm dev:fake-onvif
 * Then start the server with the variables it prints and pick
 * "Another brand" in setup.
 */
import { startDevOnvifCamera } from '../dev/devOnvifCamera.js';

const password = process.env['FAKE_ONVIF_PASSWORD'] ?? 'fake-onvif';
const camera = await startDevOnvifCamera({
  password,
  ports: { onvif: 18080, rtsp: 18554, discovery: 13702 },
});

console.log(`Fake ONVIF camera running (ONVIF :${camera.onvifPort}, RTSP :${camera.rtspPort}, discovery :${camera.discoveryPort}).
Sign in with admin / ${password}. Start the server with:

  KASA_DISCOVERY_TARGETS=127.0.0.1 ONVIF_DISCOVERY_PORT=${camera.discoveryPort} pnpm dev

Or type its address in setup: 127.0.0.1:${camera.onvifPort}
`);

const stop = () => void camera.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
