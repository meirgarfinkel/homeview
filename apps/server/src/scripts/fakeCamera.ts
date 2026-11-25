/**
 * Run a simulated Kasa camera for UI development without real hardware.
 *   pnpm dev:fake-camera
 * Then start the server with the variables it prints.
 *
 * FAKE_CAMERA_SETUP=1 starts it like a factory-reset camera (login
 * admin/admin, not linked) to rehearse `pnpm setup-camera`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../dev/fakeCamera.js';

const username = process.env['FAKE_CAMERA_USER'] ?? 'dev@example.com';
const password = process.env['FAKE_CAMERA_PASSWORD'] ?? 'dev-password';
const video = readFileSync(
  fileURLToPath(new URL('../../test/fixtures/stream-320x180.h264', import.meta.url)),
);

const setupMode = process.env['FAKE_CAMERA_SETUP'] === '1';
const camera = new FakeCamera({
  username,
  password,
  encoding: 'md5',
  video: new LoopingFrameProducer(accessUnits(video), 15),
  alias: 'fake nursery',
  maxStreams: 4,
  ...(setupMode
    ? {
        setupMode: {
          login: { username: 'admin', password: 'admin', encoding: 'md5' as const },
          networks: [
            { ssid: 'HomeNet', rssi: -55, wpa_mode: 'WPA2_PSK', encryption: 'AES' },
            { ssid: 'Neighbours', rssi: -78, wpa_mode: 'WPA2_PSK', encryption: 'AES' },
          ],
        },
      }
    : {}),
});
const ports = await camera.start('127.0.0.1', 19443, 10443, setupMode ? 19999 : undefined);

if (setupMode) {
  console.log(`Fake reset camera running (api :${ports.apiPort}, discovery :${ports.discoveryPort}).
Rehearse setup with:

  SETUP_TEST_TARGETS=127.0.0.1 SETUP_TEST_DISCOVERY_PORT=${ports.discoveryPort} \\
  KASA_API_PORT=${ports.apiPort} KASA_USERNAME=${username} KASA_PASSWORD=${password} \\
  ENV_FILE=/tmp/kasa-setup-rehearsal.env pnpm setup-camera
`);
} else {
  console.log(`Fake camera running (stream :${ports.streamPort}, api :${ports.apiPort}). Start the server with:

  KASA_HOST=127.0.0.1 KASA_USERNAME=${username} KASA_PASSWORD=${password} VIEWER_PASSWORD=dev-viewer pnpm dev
`);
}

const stop = () => void camera.stop().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
