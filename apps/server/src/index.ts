import os from 'node:os';
import { buildApp, clientAllowlist } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { loadEnvFile } from './env.js';
import { Camera, CameraLocateError, locateCamera } from './kasa/camera.js';
import { CameraWatcher } from './kasa/cameraWatcher.js';
import { syncTimeZone } from './kasa/timeZone.js';
import { listenHttpsWithRedirect } from './listen.js';
import { createLogger } from './logger.js';
import { LiveHub } from './media/liveHub.js';
import { loadOrCreateSecret } from './security/dataDir.js';
import { createIpAllowlist, isPrivateAddress } from './security/network.js';
import { loadOrCreateCertificate, readTlsFiles } from './security/tlsCert.js';

async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const { host, device } = await locateCamera(config.camera, logger);
  const camera = new Camera(host, config, logger, device);
  const hub = new LiveHub({
    source: camera.source,
    logger: logger.child({ component: 'hub' }),
    idleTimeoutMs: config.idleDisconnectMs,
  });

  // Keep sessions valid across restarts without asking the user for a secret.
  if (config.viewerPassword && !config.sessionSecret) {
    config.sessionSecret = loadOrCreateSecret(config.dataDir, 'session-secret');
  }

  let tls: { key: string; cert: string } | undefined;
  if (config.https.enabled) {
    const material =
      config.https.certFile && config.https.keyFile
        ? readTlsFiles(config.https.certFile, config.https.keyFile)
        : await loadOrCreateCertificate(config.dataDir);
    tls = material;
    logger.info(
      { fingerprint: material.fingerprint, selfSigned: material.generated },
      material.generated
        ? 'Using a self-signed HTTPS certificate; browsers will ask you to accept it once'
        : 'Using HTTPS certificate from TLS_CERT_FILE',
    );
  } else {
    logger.warn(
      'HTTPS is disabled; video and the page password travel unencrypted on your network',
    );
  }

  const allowed = clientAllowlist(config);
  logger.info({ networks: allowed }, 'Accepting viewers from these networks');
  if (!config.viewerPassword) logger.warn('No VIEWER_PASSWORD: anyone on those networks can watch');

  const app = await buildApp({ config, camera, hub, logger, ...(tls ? { tls } : {}) });
  let closeServer: () => Promise<void>;
  if (tls) {
    const listener = await listenHttpsWithRedirect(app, {
      host: config.host,
      port: config.port,
      allowClient: createIpAllowlist(allowed),
    });
    closeServer = listener.close;
  } else {
    await app.listen({ host: config.host, port: config.port });
    closeServer = () => app.close();
  }
  const scheme = tls ? 'https' : 'http';
  const shown = config.host === '0.0.0.0' ? lanAddress() : config.host;
  logger.info(
    { camera: host, url: `${scheme}://${shown}:${config.port}` },
    'Kasa monitor is running',
  );

  // Check credentials early so a typo shows up in the log right away.
  camera.info(0).then(
    (info) => logger.info({ alias: info.alias, model: info.model }, 'Camera credentials OK'),
    (err: Error) => logger.error({ err: err.message }, 'Could not query the camera'),
  );

  // Follow the camera if its address changes, unless KASA_HOST pins it.
  let watcher: CameraWatcher | undefined;
  if (!config.camera.host && device) {
    watcher = new CameraWatcher({
      camera,
      device,
      apiPort: config.camera.apiPort,
      pinnedSha256: config.camera.certSha256,
      allowPublicHost: config.camera.allowPublicHost,
      logger: logger.child({ component: 'locate' }),
    });
    watcher.start();
  }

  // Keep the camera's clock (and its on-screen timestamp) in this time zone.
  const zone = config.camera.timeZone;
  if (zone) {
    const sync = () =>
      syncTimeZone(camera.linkie, zone, logger).catch((err: Error) =>
        logger.warn({ err: err.message }, "Could not check the camera's time zone"),
      );
    void sync();
    setInterval(() => void sync(), 60 * 60 * 1000).unref();
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 5000).unref();
    watcher?.stop();
    await camera.ptz.dispose();
    hub.close();
    await closeServer();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function lanAddress(): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (
        a.family === 'IPv4' &&
        !a.internal &&
        isPrivateAddress(a.address) &&
        !a.address.startsWith('172.')
      ) {
        return a.address;
      }
    }
  }
  return 'localhost';
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError || err instanceof CameraLocateError) {
    console.error(`\n${err.message}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
