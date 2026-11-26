/**
 * Check that HomeView can talk to the camera, without starting the server.
 *   pnpm probe
 *
 * Prints the camera details, which password encoding worked, the camera's
 * TLS fingerprint (for KASA_CERT_SHA256), a few seconds of stream stats and
 * the pan/tilt position. Never moves the camera.
 */
import tls from 'node:tls';
import { loadConfig } from '../config.js';
import { Camera, locateCamera } from '../kasa/camera.js';
import { peerFingerprint, cameraTlsOptions } from '../kasa/tls.js';
import { createLogger } from '../logger.js';
import { loadEnvFile } from '../env.js';

loadEnvFile();
const config = loadConfig({ ALLOW_NO_PASSWORD: 'true', ...process.env });
if (!config.camera.username || !config.camera.password) {
  console.error(
    'No camera login yet. Set KASA_USERNAME and KASA_PASSWORD in .env, or finish setup in the app.',
  );
  process.exit(1);
}
const logger = createLogger('warn');
const step = (label: string, value: unknown) =>
  console.log(`${label.padEnd(20)} ${typeof value === 'string' ? value : JSON.stringify(value)}`);

const { host, device } = await locateCamera(config.camera, logger);
step('Camera address', host);

const fingerprint = await new Promise<string>((resolve, reject) => {
  const socket = tls.connect({ ...cameraTlsOptions, host, port: config.camera.apiPort }, () => {
    resolve(peerFingerprint(socket));
    socket.end();
  });
  socket.on('error', reject);
});
step('TLS fingerprint', fingerprint);

const camera = new Camera(host, config, logger, device);
const info = await camera.info(0);
step('Camera', `${info.alias} (${info.model}, firmware ${info.firmware})`);
step('Password encoding', camera.credentials.resolvedEncoding ?? 'unknown');

try {
  const position = await camera.linkie.call('ptz', 'get_position');
  step('Pan/tilt position', { x: position['x'], y: position['y'] });
} catch (err) {
  step('Pan/tilt', `not available (${(err as Error).message})`);
}

let video = 0;
let audio = 0;
let bytes = 0;
camera.source.on('frame', (f) => {
  if (f.kind === 'video') video++;
  else audio++;
  bytes += f.data.length;
});
camera.source.on('state', (s, detail) => detail && step('Stream', `${s}: ${detail}`));
camera.source.start();
await new Promise((r) => setTimeout(r, 5000));
camera.source.stop();
step(
  'Stream (5 s)',
  `${video} video frames, ${audio} audio packets, ${Math.round((bytes * 8) / 5 / 1000)} kb/s`,
);
process.exit(video > 0 ? 0 : 1);
