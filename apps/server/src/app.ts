import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { CameraInfo } from '@kasa/shared';
import { viewerCheck, type Config } from './config.js';
import type { PtzController } from './kasa/ptz.js';
import type { LiveHub } from './media/liveHub.js';
import { loggerOptions, type Logger } from './logger.js';
import { registerApiRoutes } from './routes/api.js';
import { registerLiveRoute } from './routes/live.js';
import {
  createHostAllowlist,
  createIpAllowlist,
  isSameOrigin,
  localNetworkCidrs,
} from './security/network.js';
import { parseCookies, SESSION_COOKIE, SessionManager } from './security/session.js';

export interface CameraService {
  info(): Promise<CameraInfo>;
  readonly ptz: PtzController;
}

export interface AppDeps {
  config: Config;
  camera: CameraService;
  hub: LiveHub;
  /** Use an existing logger (tests pass a silent one). */
  logger?: Logger;
  /** Serve HTTPS with this key pair. */
  tls?: { key: string; cert: string };
}

/** Client networks allowed by default: this machine and its real LAN. */
export function clientAllowlist(config: Config): string[] {
  return config.allowedCidrs ?? localNetworkCidrs();
}

/** Routes reachable without a session when VIEWER_PASSWORD is set. */
const PUBLIC_API = new Set(['/api/health', '/api/session', '/api/login', '/api/logout']);

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

  const isAuthenticated = (req: FastifyRequest) =>
    !sessions || sessions.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE]);

  app.addHook('onRequest', async (req, reply) => {
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
    if (url.startsWith('/api/') && !PUBLIC_API.has(url) && !isAuthenticated(req)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Sign in required' });
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
        `connect-src 'self' ${deps.tls ? '' : `ws://${host} `}wss://${host}`,
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

  await app.register(fastifyWebsocket, {
    options: { maxPayload: 4 * 1024 },
  });

  await registerApiRoutes(app, { ...deps, sessions, isAuthenticated });
  await registerLiveRoute(app, deps.hub);
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
