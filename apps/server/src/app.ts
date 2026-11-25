import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { CameraInfo } from '@kasa/shared';
import { viewerCheck, type Config } from './config.js';
import type { PtzController } from './kasa/ptz.js';
import type { LiveHub } from './media/liveHub.js';
import { loggerOptions, type Logger } from './logger.js';
import { notSetUp, registerApiRoutes } from './routes/api.js';
import { registerLiveRoute } from './routes/live.js';
import { registerRemotePairRoute } from './routes/remotePair.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSetupRoutes, type OnboardingSlot, type SetupDeps } from './routes/setup.js';
import type { WifiSwitcher } from './setup/wifiSwitcher.js';
import { DEVICE_COOKIE, type DeviceStore } from './remote/devices.js';
import type { PairingCodes } from './remote/pairing.js';
import {
  createHostAllowlist,
  createIpAllowlist,
  hostnameOf,
  isSameOrigin,
  localNetworkCidrs,
} from './security/network.js';
import { isLocalRequest, isRemote } from './security/remoteRequest.js';
import { parseCookies, SESSION_COOKIE, SessionManager } from './security/session.js';
import type { SettingsStore } from './settings/store.js';

export interface CameraService {
  info(): Promise<CameraInfo>;
  readonly ptz: PtzController;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The paired device behind a remote request that got past the gate. */
    remoteDeviceId: string | undefined;
  }
}

/** What the gate needs to check requests that came through the tunnel. */
export interface RemoteGateDeps {
  /** The secret the tunnel helper sends. Undefined while the tunnel isn't running. */
  secret(): string | undefined;
  /** The public host name, from the helper's ready event. */
  host(): string | undefined;
  devices: DeviceStore;
  pairing: PairingCodes;
}

/** Things only the desktop app can do, offered to the setup and settings pages. */
export interface ServerHooks {
  getAutostart?(): boolean;
  setAutostart?(on: boolean): void;
  quit?(): void;
}

export interface AppDeps {
  config: Config;
  /** Where the setup routes save. Without it there are no setup routes. */
  settings?: SettingsStore;
  /** Missing before setup is complete, or while the camera can't be found. */
  camera?: CameraService;
  hub?: LiveHub;
  /** Why the camera is missing when setup is complete. */
  cameraError?: string;
  /** Use an existing logger (tests pass a silent one). */
  logger?: Logger;
  /** Serve HTTPS with this key pair. */
  tls?: { key: string; cert: string };
  /**
   * Re-read settings and rebuild the app on the same port. Safe to await in a
   * route handler: it resolves once the new app is built, and the switch to it
   * starts after that, so the handler can still reply. It rejects if the new
   * settings can't be loaded, and the old app keeps running.
   */
  reload?: () => Promise<void>;
  hooks?: ServerHooks;
  /** True inside the desktop app. Defaults to config.desktop. */
  desktop?: boolean;
  /** The address other devices on the network use, if there is one. */
  lanUrl?: () => string | undefined;
  /** Where the onboarding job lives, so it survives a rebuild. Default: one per app. */
  onboarding?: OnboardingSlot;
  /** Gets the Wi-Fi switcher for a camera setup. Default: the real one. */
  createSwitcher?: () => Promise<WifiSwitcher>;
  /** Replaces parts of the onboarding job's options. For tests. */
  onboardingOverrides?: SetupDeps['onboardingOverrides'];
  /** Remote access. Without it, requests from the remote listener are refused. */
  remote?: RemoteGateDeps;
}

/** Client networks allowed by default: this machine and its real LAN. */
export function clientAllowlist(config: Config): string[] {
  return config.allowedCidrs ?? localNetworkCidrs();
}

/** Routes reachable without a session. The pair route answers only remote requests. */
const PUBLIC_API = new Set([
  '/api/health',
  '/api/session',
  '/api/login',
  '/api/logout',
  '/api/remote/pair',
]);

/** What other computers may reach before setup is complete. */
const BEFORE_SETUP_API = new Set(['/api/health', '/api/session']);

/** Setup routes: this computer only, and no session needed. */
const SETUP_API = /^\/api\/setup(\/|$)/;

const localOnly = {
  error: 'local-only',
  message: 'Only the computer running Kasa Home can do this.',
};

/** Routes that talk to the camera or its stream. */
const CAMERA_API = /^\/api\/(camera|status|live|ptz)(\/|$)/;

/** Routes a remote request may use without a paired device. */
const REMOTE_OPEN_API = new Set(['/api/health', '/api/remote/pair']);

/** Routes a paired device may use without a session. */
const REMOTE_NO_SESSION_API = new Set(['/api/session', '/api/login', '/api/logout']);

/** Never from away: setup, settings, the desktop app and the remote access controls. */
const REMOTE_FORBIDDEN_API = /^\/api\/(setup|settings|app|remote)(\/|$)/;

const remoteLocalOnly = {
  error: 'local-only',
  message: "This can't be done from away. Use Kasa Home at home.",
};

const deviceNotPaired = {
  error: 'device-not-paired',
  message:
    "This phone isn't set up to watch from away. At home, scan the code in Kasa Home on your computer.",
};

const forbidden = { error: 'forbidden', message: 'Forbidden' };

function sameSecret(given: string | string[] | undefined, want: string | undefined): boolean {
  if (typeof given !== 'string' || !want) return false;
  const digest = (v: string) => createHash('sha256').update(v, 'utf8').digest();
  return timingSafeEqual(digest(given), digest(want));
}

/**
 * Lets a request from the tunnel through only if it came from our helper,
 * for our host name, and from a paired device. Returns the reply when it
 * refuses, or undefined to let the request go on.
 */
function remoteGate(
  req: FastifyRequest,
  reply: FastifyReply,
  remote: RemoteGateDeps | undefined,
  ready: boolean,
  isAuthenticated: (req: FastifyRequest) => boolean,
): FastifyReply | undefined {
  if (!remote || !sameSecret(req.headers['x-kasa-tunnel'], remote.secret())) {
    req.log.warn('Blocked remote request without the tunnel secret');
    return reply.code(403).send(forbidden);
  }
  const host = remote.host();
  if (!host) {
    return reply
      .code(503)
      .send({ error: 'remote-starting', message: 'Remote access is still starting' });
  }
  if (hostnameOf(req.headers.host ?? '') !== host.toLowerCase()) {
    req.log.warn({ host: req.headers.host }, 'Blocked remote request with unexpected Host header');
    return reply.code(403).send(forbidden);
  }
  const url = req.url.split('?', 1)[0]!;
  // The route that matched, too, in case the router decoded something the raw URL hides.
  const route = req.routeOptions.url ?? '';
  const isApi = url.startsWith('/api/') || route.startsWith('/api/');
  if (isApi && !ready && url !== '/api/health') return reply.code(403).send(notSetUp);
  const isWebSocket = req.headers.upgrade?.toLowerCase() === 'websocket';
  const isMutation = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  if ((isWebSocket || isMutation) && !isSameOrigin(req.headers.origin, req.headers.host)) {
    req.log.warn({ origin: req.headers.origin }, 'Blocked cross-origin remote request');
    return reply.code(403).send({ error: 'forbidden_origin', message: 'Cross-origin request' });
  }
  if (!isApi) return undefined;
  if (REMOTE_OPEN_API.has(url)) return undefined;
  if (REMOTE_FORBIDDEN_API.test(url) || REMOTE_FORBIDDEN_API.test(route)) {
    return reply.code(403).send(remoteLocalOnly);
  }
  const device = remote.devices.find(parseCookies(req.headers.cookie)[DEVICE_COOKIE]);
  if (!device) return reply.code(401).send(deviceNotPaired);
  remote.devices.touch(device.id);
  req.remoteDeviceId = device.id;
  if (!REMOTE_NO_SESSION_API.has(url) && !isAuthenticated(req)) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Sign in required' });
  }
  return undefined;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: loggerOptions(config.logLevel) }),
    ...(deps.tls
      ? { https: { key: deps.tls.key, cert: deps.tls.cert, minVersion: 'TLSv1.2' as const } }
      : {}),
    trustProxy: false,
    bodyLimit: 16 * 1024,
  });

  const allowIp = createIpAllowlist(clientAllowlist(config));
  const allowHost = createHostAllowlist(config.allowedHosts);
  const check = viewerCheck(config);
  const sessions = check ? new SessionManager(check, config.sessionSecret) : undefined;

  // Fail closed: without a viewer password only ALLOW_NO_PASSWORD opens the page.
  const openAccess = !sessions && config.allowNoPassword;
  const isAuthenticated = (req: FastifyRequest) =>
    sessions ? sessions.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE]) : openAccess;

  // Register first: its onRequest hook marks upgrade requests, so a refused
  // upgrade gets its socket closed after the error response.
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 4 * 1024 },
  });
  app.decorateRequest('remoteDeviceId', undefined);

  // Remote access needs a finished setup and a real password, never ALLOW_NO_PASSWORD.
  const remoteReady = config.setupComplete && sessions !== undefined;

  app.addHook('onRequest', async (req, reply) => {
    // Remote requests skip the IP allowlist and every check for this computer.
    if (isRemote(req)) return remoteGate(req, reply, deps.remote, remoteReady, isAuthenticated);
    if (!allowIp(req.ip)) {
      req.log.warn({ ip: req.ip }, 'Blocked request from outside the local network');
      return reply.code(403).send({ error: 'forbidden', message: 'Local network only' });
    }
    if (!allowHost(req.headers.host ?? '')) {
      req.log.warn({ host: req.headers.host }, 'Blocked request with unexpected Host header');
      return reply.code(403).send({
        error: 'forbidden_host',
        message: 'Unrecognised Host header. Use the IP address, or add the name to ALLOWED_HOSTS.',
      });
    }
    const isWebSocket = req.headers.upgrade?.toLowerCase() === 'websocket';
    const isMutation = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if ((isWebSocket || isMutation) && !isSameOrigin(req.headers.origin, req.headers.host)) {
      req.log.warn({ origin: req.headers.origin }, 'Blocked cross-origin request');
      return reply.code(403).send({ error: 'forbidden_origin', message: 'Cross-origin request' });
    }
    const url = req.url.split('?', 1)[0]!;
    // The socket's address, never a header: trustProxy is off.
    if (url.startsWith('/api/') && !isLocalRequest(req)) {
      // Nobody else may use Kasa Home until this computer has chosen a password.
      if (!config.setupComplete && !BEFORE_SETUP_API.has(url)) {
        return reply.code(403).send(notSetUp);
      }
      if (SETUP_API.test(url)) return reply.code(403).send(localOnly);
    }
    if (url.startsWith('/api/') && !PUBLIC_API.has(url) && !SETUP_API.test(url)) {
      // Before setup there is no camera behind these routes, so saying so reveals nothing.
      if (!deps.camera && !config.setupComplete && CAMERA_API.test(url)) {
        return reply.code(503).send(notSetUp);
      }
      if (!isAuthenticated(req)) {
        return reply.code(401).send({ error: 'unauthorized', message: 'Sign in required' });
      }
    }
    return undefined;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const host = req.headers.host ?? '';
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        // Remote pages are HTTPS for the browser, so they only need wss.
        `connect-src 'self' ${req.protocol === 'https' || isRemote(req) ? '' : `ws://${host} `}wss://${host}`,
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join('; '),
    );
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    // No HSTS: a self-signed certificate plus HSTS can lock users out of the page.
    return payload;
  });

  await registerApiRoutes(app, { ...deps, sessions, openAccess, isAuthenticated });
  if (deps.settings) {
    await registerSetupRoutes(app, {
      config,
      settings: deps.settings,
      ...(deps.reload ? { reload: deps.reload } : {}),
      isAuthenticated,
      onboarding: deps.onboarding ?? {},
      ...(deps.createSwitcher ? { createSwitcher: deps.createSwitcher } : {}),
      ...(deps.onboardingOverrides ? { onboardingOverrides: deps.onboardingOverrides } : {}),
    });
  }
  if (deps.settings) {
    await registerSettingsRoutes(app, {
      config,
      settings: deps.settings,
      ...(deps.reload ? { reload: deps.reload } : {}),
      ...(deps.hooks ? { hooks: deps.hooks } : {}),
      desktop: deps.desktop ?? config.desktop,
    });
  }
  if (deps.remote) {
    await registerRemotePairRoute(app, { remote: deps.remote, sessions });
  }
  if (deps.hub) {
    await registerLiveRoute(app, deps.hub, deps.remote?.devices);
  }
  await registerStatic(app, config.staticDir);

  return app;
}

async function registerStatic(app: FastifyInstance, root: string): Promise<void> {
  const index = path.join(root, 'index.html');
  if (!existsSync(index)) {
    app.log.warn({ root }, 'Web UI not built (run `pnpm build`); serving the API only');
    app.setNotFoundHandler((_req, reply) => {
      void reply.code(404).send({ error: 'not_found', message: 'Not found' });
    });
    return;
  }
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    index: false,
    setHeaders: (res, filePath) => {
      // Vite fingerprints everything under /assets, so it can be cached forever.
      const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
      res.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  // Single-page app: unknown non-API GETs get index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: 'Not found' });
  });
}
