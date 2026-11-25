import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, clientAllowlist, type ServerHooks } from './app.js';
import { loadConfig, resolveDataDir, type Config } from './config.js';
import { Camera, locateCamera } from './kasa/camera.js';
import { CameraWatcher } from './kasa/cameraWatcher.js';
import type { DiscoveredDevice } from './kasa/discovery.js';
import { syncTimeZone } from './kasa/timeZone.js';
import { listenHttp, listenHttpsWithRedirect, type DualListener } from './listen.js';
import { createLogger, type Logger } from './logger.js';
import { LiveHub } from './media/liveHub.js';
import { loadOrCreateSecret } from './security/dataDir.js';
import {
  createIpAllowlist,
  isLoopback,
  isPrivateAddress,
  VIRTUAL_INTERFACE,
} from './security/network.js';
import { loadOrCreateCertificate, readTlsFiles } from './security/tlsCert.js';
import type { OnboardingSlot, SetupDeps } from './routes/setup.js';
import { SettingsStore } from './settings/store.js';
import { createWifiSwitcher, type WifiSwitcher } from './setup/wifiSwitcher.js';

export type { ServerHooks } from './app.js';

export interface StartServerOptions {
  /** Defaults to process.env. The desktop app passes {} plus its own values. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to a store in the data dir. */
  settings?: SettingsStore;
  dataDir?: string;
  staticDir?: string;
  logger?: Logger;
  hooks?: ServerHooks;
  desktop?: boolean;
  /** Gets the Wi-Fi switcher for a camera setup. Tests pass a fake one. */
  createSwitcher?: () => Promise<WifiSwitcher>;
  /** Replaces parts of the onboarding job's options. For tests. */
  onboardingOverrides?: SetupDeps['onboardingOverrides'];
}

export interface RunningServer {
  port: number;
  /** http://localhost:<port>, for this computer. */
  localUrl: string;
  /** The address other devices use, or undefined when there is no LAN address. */
  readonly lanUrl: string | undefined;
  setupComplete(): boolean;
  /** Re-read settings and rebuild the camera and app on the same port. */
  reload(): Promise<void>;
  stop(): Promise<void>;
}

export class PortsInUseError extends Error {
  override name = 'PortsInUseError';
}

/** How many ports to try, starting at the configured one. */
const PORT_ATTEMPTS = 10;
const CAMERA_RETRY_MS = 30_000;

/** This computer's address on the home network, skipping container and VPN interfaces. */
export function lanAddress(
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): string | undefined {
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
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
  return undefined;
}

type Located = { host: string; device?: DiscoveredDevice };

/** One build of the app: its camera and timers. A reload replaces it. */
interface Instance {
  config: Config;
  camera: Camera | undefined;
  hub: LiveHub | undefined;
  watcher: CameraWatcher | undefined;
  timers: NodeJS.Timeout[];
  secure: boolean;
  port: number;
}

export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const env = opts.env ?? process.env;
  const settings = opts.settings ?? new SettingsStore(opts.dataDir ?? resolveDataDir(env));

  const readConfig = (): Config => {
    const config = loadConfig(env, settings.load());
    if (opts.dataDir) config.dataDir = path.resolve(opts.dataDir);
    if (opts.staticDir) config.staticDir = path.resolve(opts.staticDir);
    config.desktop = opts.desktop ?? false;
    return config;
  };

  const firstConfig = readConfig();
  const logger = opts.logger ?? createLogger(firstConfig.logLevel);

  /** The camera setup job. It lives here so it survives a reload. */
  const onboarding: OnboardingSlot = {};
  let current: Instance | undefined;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  /** The port from the first start. Reloads keep it. */
  let boundPort = 0;

  // Reloads, camera retries and stop run one at a time.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  const lanUrl = (): string | undefined => {
    if (!current) return undefined;
    const { host } = current.config;
    const address = host === '0.0.0.0' || host === '::' ? lanAddress() : host;
    if (!address || isLoopback(address)) return undefined;
    return `${current.secure ? 'https' : 'http'}://${address}:${current.port}`;
  };

  const scheduleCameraRetry = (config: Config) => {
    clearTimeout(retry);
    retry = setTimeout(() => {
      void serial(async () => {
        if (stopped || current?.camera) return;
        let located: Located;
        try {
          located = await locateCamera(config.camera, logger);
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'Camera still not found; trying again soon');
          scheduleCameraRetry(config);
          return;
        }
        logger.info({ camera: located.host }, 'Found the camera again');
        await replace(located);
      }).catch((err: Error) =>
        logger.error({ err: err.message }, 'Could not restart with the camera'),
      );
    }, CAMERA_RETRY_MS);
    retry.unref();
  };

  /**
   * Build a new instance, then swap it in behind the listener. onPrepared
   * runs once the new settings are loaded and the new app is ready. The swap
   * waits a turn after it so a route handler can send its reply first. The
   * port and its connections stay open: requests go to the new app at once,
   * and the old one closes once its open requests finish.
   */
  const replace = async (located?: Located, onPrepared?: () => void): Promise<void> => {
    const next = await prepare(readConfig(), located);
    if (onPrepared) {
      onPrepared();
      await new Promise((r) => setImmediate(r));
    }
    const previous = current;
    await next.swapInto(listener);
    if (previous) await disposeInstance(previous);
    next.started();
  };

  /** Everything up to listening, so a reload can fail without taking the old server down. */
  const prepare = async (config: Config, located?: Located) => {
    let camera: Camera | undefined;
    let hub: LiveHub | undefined;
    let cameraError: string | undefined;
    let device: DiscoveredDevice | undefined;
    if (config.setupComplete) {
      try {
        const found = located ?? (await locateCamera(config.camera, logger));
        device = found.device;
        camera = new Camera(found.host, config, logger, device);
        hub = new LiveHub({
          source: camera.source,
          logger: logger.child({ component: 'hub' }),
          idleTimeoutMs: config.idleDisconnectMs,
        });
      } catch (err) {
        cameraError = (err as Error).message;
        logger.error({ err: cameraError }, 'Could not find the camera; trying again every 30 s');
        scheduleCameraRetry(config);
      }
    } else {
      logger.info('Kasa Home is not set up yet');
    }

    // Keep sessions valid across restarts without asking the user for a secret.
    if (config.viewer && !config.sessionSecret) {
      config.sessionSecret = loadOrCreateSecret(config.dataDir, 'session-secret');
    }

    const tls = await loadTls(config, logger);
    const allowed = clientAllowlist(config);
    logger.info({ networks: allowed }, 'Accepting viewers from these networks');
    if (config.allowNoPassword && !config.viewer) {
      logger.warn('No VIEWER_PASSWORD: anyone on those networks can watch');
    }

    const app = await buildApp({
      config,
      settings,
      ...(camera ? { camera } : {}),
      ...(hub ? { hub } : {}),
      ...(cameraError ? { cameraError } : {}),
      logger,
      ...(tls ? { tls } : {}),
      reload: reloadFromRoute,
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
      desktop: config.desktop,
      lanUrl,
      onboarding,
      createSwitcher: opts.createSwitcher ?? (() => createWifiSwitcher()),
      ...(opts.onboardingOverrides ? { onboardingOverrides: opts.onboardingOverrides } : {}),
    });

    // Plugins load here, so a broken build fails the reload, not the swap.
    try {
      await app.ready();
    } catch (err) {
      hub?.close();
      await camera?.ptz.dispose();
      await app.close().catch(() => undefined);
      throw err;
    }

    const instance = (port: number): Instance => ({
      config,
      camera,
      hub,
      watcher: undefined,
      timers: [],
      secure: tls !== undefined,
      port,
    });
    const running = (port: number) => {
      logger.info(
        { ...(camera ? { camera: camera.host } : {}), url: lanUrl() ?? localUrlFor(port) },
        'Kasa Home is running',
      );
    };
    let next: Instance | undefined;
    return {
      /** The first start: bind the first free port. */
      listen: async (ports: number[]): Promise<{ listener: DualListener; port: number }> => {
        const bound = await listenOnFirstFree(app, config, ports, tls);
        const port = bound.address().port;
        current = next = instance(port);
        running(port);
        if (camera) startCameraTasks(next, camera, device);
        return { listener: bound, port };
      },
      /** A reload: take over the listener's requests from the current app. */
      swapInto: async (into: DualListener): Promise<void> => {
        await into.swap(app, () => {
          current = next = instance(boundPort);
        });
      },
      /** After the old instance is gone: log and start the camera tasks. */
      started: () => {
        running(boundPort);
        if (camera && next) startCameraTasks(next, camera, device);
      },
    };
  };

  const startCameraTasks = (instance: Instance, camera: Camera, device?: DiscoveredDevice) => {
    const { config } = instance;
    // Check credentials early so a typo shows up in the log right away.
    camera.info(0).then(
      (info) => logger.info({ alias: info.alias, model: info.model }, 'Camera credentials OK'),
      (err: Error) => logger.error({ err: err.message }, 'Could not query the camera'),
    );

    // Follow the camera if its address changes, unless KASA_HOST pins it.
    if (!config.camera.host && device) {
      instance.watcher = new CameraWatcher({
        camera,
        device,
        apiPort: config.camera.apiPort,
        pinnedSha256: config.camera.certSha256,
        allowPublicHost: config.camera.allowPublicHost,
        ...(config.camera.discoveryPort ? { discoveryPort: config.camera.discoveryPort } : {}),
        ...(config.camera.discoveryTargets
          ? { discoveryTargets: config.camera.discoveryTargets }
          : {}),
        logger: logger.child({ component: 'locate' }),
      });
      instance.watcher.start();
    }

    // Keep the camera's clock (and its on-screen timestamp) in this time zone.
    const zone = config.camera.timeZone;
    if (zone) {
      const sync = () =>
        syncTimeZone(camera.linkie, zone, logger).catch((err: Error) =>
          logger.warn({ err: err.message }, "Could not check the camera's time zone"),
        );
      void sync();
      instance.timers.push(setInterval(() => void sync(), 60 * 60 * 1000).unref());
    }
  };

  // For route handlers: resolves when the new app is ready, before the swap,
  // because the swap closes the old app and waits for the handler's request.
  function reloadFromRoute(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      serial(async () => {
        if (stopped) throw new Error('The server is stopped');
        clearTimeout(retry);
        await replace(undefined, resolve);
      }).catch((err: Error) => {
        logger.error({ err: err.message }, 'Could not reload the settings');
        reject(err);
      });
    });
  }

  const first = await prepare(firstConfig);
  const start = firstConfig.port;
  const ports =
    start === 0
      ? [0]
      : Array.from({ length: PORT_ATTEMPTS }, (_, i) => start + i).filter((p) => p <= 65535);
  const bound = await first.listen(ports);
  /** Bound once, here. Reloads swap the app behind it. */
  const listener = bound.listener;
  boundPort = bound.port;

  const running: RunningServer = {
    port: boundPort,
    localUrl: localUrlFor(boundPort),
    get lanUrl() {
      return lanUrl();
    },
    setupComplete: () => current?.config.setupComplete ?? false,
    reload: () =>
      serial(async () => {
        if (stopped) throw new Error('The server is stopped');
        clearTimeout(retry);
        await replace();
      }),
    stop: () =>
      serial(async () => {
        if (stopped) return;
        stopped = true;
        logger.info('Shutting down');
        clearTimeout(retry);
        await onboarding.job?.cancel().catch(() => undefined);
        await listener.close();
        if (current) await disposeInstance(current);
        current = undefined;
      }),
  };
  return running;
}

function localUrlFor(port: number): string {
  return `http://localhost:${port}`;
}

/** Stop an instance's camera work. Its app is closed by the listener. */
async function disposeInstance(instance: Instance): Promise<void> {
  for (const timer of instance.timers) clearInterval(timer);
  instance.watcher?.stop();
  await instance.camera?.ptz.dispose();
  instance.hub?.close();
}

async function loadTls(
  config: Config,
  logger: Logger,
): Promise<{ key: string; cert: string } | undefined> {
  if (!config.https.enabled) {
    logger.warn(
      'HTTPS is disabled; video and the page password travel unencrypted on your network',
    );
    return undefined;
  }
  const material =
    config.https.certFile && config.https.keyFile
      ? readTlsFiles(config.https.certFile, config.https.keyFile)
      : await loadOrCreateCertificate(config.dataDir);
  logger.info(
    { fingerprint: material.fingerprint, selfSigned: material.generated },
    material.generated
      ? 'Using a self-signed HTTPS certificate; browsers will ask you to accept it once'
      : 'Using HTTPS certificate from TLS_CERT_FILE',
  );
  return { key: material.key, cert: material.cert };
}

/**
 * Listen on the first port in the list that is free. The listener keeps the
 * HTTPS key pair it starts with. Reloads can't change it: it comes from the
 * environment and the data folder, which stay the same while the server runs.
 */
async function listenOnFirstFree(
  app: FastifyInstance,
  config: Config,
  ports: number[],
  tls: { key: string; cert: string } | undefined,
): Promise<DualListener> {
  for (const port of ports) {
    try {
      if (tls) {
        return await listenHttpsWithRedirect(app, {
          host: config.host,
          port,
          tls,
          allowClient: createIpAllowlist(clientAllowlist(config)),
        });
      }
      return await listenHttp(app, { host: config.host, port });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      app.log.warn({ port }, 'Port in use; trying the next one');
    }
  }
  await app.close();
  const range =
    ports.length > 1 ? `Ports ${ports[0]} to ${ports.at(-1)} are` : `Port ${ports[0]} is`;
  throw new PortsInUseError(
    `${range} in use. Close the program using them, or set PORT to a free port.`,
  );
}
