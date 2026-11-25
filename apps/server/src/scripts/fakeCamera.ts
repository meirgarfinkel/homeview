/**
 * Run a simulated Kasa camera for UI development without real hardware.
 *   pnpm dev:fake-camera
 * Then start the server with the variables it prints.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { accessUnits, FakeCamera, LoopingFrameProducer } from '../dev/fakeCamera.js';

const username = process.env['FAKE_CAMERA_USER'] ?? 'dev@example.com';
const password = process.env['FAKE_CAMERA_PASSWORD'] ?? 'dev-password';
const video = readFileSync(
  fileURLToPath(new URL('../../test/fixtures/stream-320x180.h264', import.meta.url)),
);

const camera = new FakeCamera({
  username,
  password,
  encoding: 'md5',
  video: new LoopingFrameProducer(accessUnits(video), 15),
  alias: 'fake nursery',
  maxStreams: 4,
});
const { streamPort, apiPort } = await camera.start('127.0.0.1', 19443, 10443);

console.log(`Fake camera running (stream :${streamPort}, api :${apiPort}). Start the server with:

  KASA_HOST=127.0.0.1 KASA_USERNAME=${username} KASA_PASSWORD=${password} VIEWER_PASSWORD=dev-viewer pnpm dev
`);

const stop = () => void camera.stop().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
