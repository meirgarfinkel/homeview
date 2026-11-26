import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, clientAllowlist, type ServerHooks } from './app.js';
import { loadConfig, resolveDataDir, type Config } from './config.js';
import { createDriver, locate, type Located } from './camera/createDriver.js';
import type { CameraDriver } from './camera/driver.js';
import type { DiscoveredDevice } from './kasa/discovery.js';
import { listenHttp, listenHttpsWithRedirect, type DualListener } from './listen.js';
import { createLogger, type Logger } from './logger.js';
import { LiveHub } from './media/liveHub.js';
import { RemoteAccess } from './remote/remoteAccess.js';
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
  /** The tunnel helper. Without it, remote access is not available. */
  tunnel?: { command: string; args?: string[] };
  /** Opens a link in the system browser. Defaults to hooks.openExternal. */
  openExternal?: (url: string) => void;
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

/** This computer's address on the home network: a private IPv4 on an interface that isn't a container, VM or VPN one. */
export function lanAddress(
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): string | undefined {
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (VIRTUAL_INTERFACE.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateAddress(a.address)) return a.address;
    }
  }
  return undefined;
}

/** One build of the app: its camera and timers. A reload replaces it. */
interface Instance {
  config: Config;
  camera: CameraDriver | undefined;
  /** What discovery said about the camera, kept so a reload can reuse it. */
  device: DiscoveredDevice | undefined;
  hub: LiveHub | undefined;
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
  const openExternal = opts.openExternal ?? opts.hooks?.openExternal?.bind(opts.hooks);
  /** Remote access and its helper. They live here too, so a reload never restarts the helper. */
  const remote = new RemoteAccess({
    dataDir: firstConfig.dataDir,
    ...(opts.tunnel
      ? { tunnel: { ...opts.tunnel, logger: logger.child({ component: 'tunnel' }) } }
      : {}),
    logger,
    ...(openExternal ? { openExternal } : {}),
  });
  /** The listener the tunnel helper talks to. Bound once, like the main one. */
  let remoteListener: DualListener | undefined;
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
          located = await locate(config, logger);
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
    const config = readConfig();
    const next = await prepare(config, located ?? sameCameraAsNow(config));
    if (onPrepared) {
      onPrepared();
      await new Promise((r) => setImmediate(r));
    }
    const previous = current;
    await next.swapInto(listener);
    if (previous) await disposeInstance(previous);
    next.started();
  };

  /**
   * Where the current camera is, when the new settings point at the same
   * camera with the same login (a viewer password change, say). The reload
   * then skips a network search that would hold up the reply for seconds.
   */
  const sameCameraAsNow = (config: Config): Located | undefined => {
    if (!current?.camera || !config.setupComplete) return undefined;
    if (JSON.stringify(current.config.camera) !== JSON.stringify(config.camera)) return undefined;
    return { host: current.camera.host, ...(current.device ? { device: current.device } : {}) };
  };

  /** Everything up to listening, so a reload can fail without taking the old server down. */
  const prepare = async (config: Config, located?: Located) => {
    let camera: CameraDriver | undefined;
    let hub: LiveHub | undefined;
    let cameraError: string | undefined;
    let device: DiscoveredDevice | undefined;
    if (config.setupComplete) {
      try {
        const found = located ?? (await locate(config, logger));
        device = found.device;
        camera = createDriver(config, logger, found);
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
      remote,
      createSwitcher: opts.createSwitcher ?? (() => createWifiSwitcher()),
      ...(opts.onboardingOverrides ? { onboardingOverrides: opts.onboardingOverrides } : {}),
    });

    // Plugins load here, so a broken build fails the reload, not the swap.
    try {
      await app.ready();
    } catch (err) {
      hub?.close();
      await camera?.dispose();
      await app.close().catch(() => undefined);
      throw err;
    }

    const instance = (port: number): Instance => ({
      config,
      camera,
      device,
      hub,
      secure: tls !== undefined,
      port,
    });
    const running = (port: number) => {
      logger.info(
        { ...(camera ? { camera: camera.host } : {}), url: lanUrl() ?? localUrlFor(port) },
        'Kasa Home is running',
      );
    };
    return {
      /** The first start: bind the first free port. */
      listen: async (ports: number[]): Promise<{ listener: DualListener; port: number }> => {
        const bound = await listenOnFirstFree(app, config, ports, tls);
        const port = bound.address().port;
        if (remote.available) {
          try {
            remoteListener = await listenHttp(app, { host: '127.0.0.1', port: 0, remote: true });
          } catch (err) {
            await bound.close();
            throw err;
          }
          remote.attach(remoteListener.address().port);
        }
        current = instance(port);
        running(port);
        camera?.start();
        return { listener: bound, port };
      },
      /** A reload: take over the listener's requests from the current app. */
      swapInto: async (into: DualListener): Promise<void> => {
        // Both listeners switch at once. Each closes the old app once its own
        // requests finish; closing an app twice is safe.
        await Promise.all([
          into.swap(app, {
            // The computer may have joined another network since the last build.
            ...(tls ? { allowClient: createIpAllowlist(allowed) } : {}),
            onSwitched: () => {
              current = instance(boundPort);
            },
          }),
          remoteListener?.swap(app),
        ]);
      },
      /** After the old instance is gone: log and start the camera tasks. */
      started: () => {
        running(boundPort);
        camera?.start();
      },
    };
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
        try {
          await Promise.all([listener.close(), remoteListener?.close()]);
        } finally {
          // The helper doesn't watch this process, so it must always be ended here.
          await remote.stop();
        }
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
  await instance.camera?.dispose();
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
  throw new PortsInUseError(`${range} in use. Close the program using them.`);
}
