import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  PTZ_DIRECTIONS,
  PTZ_MOVE_MODES,
  type ApiError,
  type PtzDirection,
  type PtzMoveMode,
  type SessionResponse,
  type StatusResponse,
  LIVE_WS_PATH,
} from '@kasa/shared';
import type { AppDeps, CameraService } from '../app.js';
import type { LiveHub } from '../media/liveHub.js';
import { clientIp, isLocalRequest, isRemote, secureCookies } from '../security/remoteRequest.js';
import { CameraAuthError, LinkieError } from '../kasa/linkieClient.js';
import { CameraHttpError } from '../kasa/httpClient.js';
import { PtzUnsupportedError } from '../kasa/ptz.js';
import {
  clearedSessionCookie,
  LoginRateLimiter,
  sessionCookie,
  type SessionManager,
} from '../security/session.js';

interface ApiDeps extends AppDeps {
  sessions: SessionManager | undefined;
  /** ALLOW_NO_PASSWORD with no viewer password: everyone counts as signed in. */
  openAccess: boolean;
  isAuthenticated(req: FastifyRequest): boolean;
}

export const notSetUp: ApiError = {
  error: 'not-set-up',
  message: "Kasa Home isn't set up yet. Finish setup on the computer running it.",
};

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const body = (error: string, message: string): ApiError => ({ error, message });
  if (err instanceof PtzUnsupportedError) {
    return reply.code(501).send(body('ptz_unsupported', err.message));
  }
  if (err instanceof CameraAuthError) {
    return reply.code(502).send(body('camera_auth', err.message));
  }
  if (err instanceof CameraHttpError) {
    const code = err.code === 'timeout' ? 504 : 502;
    return reply.code(code).send(body('camera_unreachable', `Camera unreachable: ${err.message}`));
  }
  if (err instanceof LinkieError) {
    return reply.code(502).send(body('camera_error', err.message));
  }
  reply.log.error({ err }, 'Unhandled API error');
  return reply.code(500).send(body('internal', 'Internal error'));
}

export async function registerApiRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { camera, hub, sessions } = deps;
  const limiter = new LoginRateLimiter();

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/session', async (req): Promise<SessionResponse> => {
    const local = isLocalRequest(req);
    // Only this computer gets the phone address. req.ip is the socket peer (trustProxy is off).
    const lanUrl = local ? deps.lanUrl?.() : undefined;
    return {
      authRequired: !deps.openAccess,
      authenticated: deps.isAuthenticated(req),
      setupComplete: deps.config.setupComplete,
      local,
      desktop: deps.desktop ?? deps.config.desktop,
      ...(isRemote(req) ? { remote: true } : {}),
      ...(lanUrl ? { lanUrl } : {}),
    };
  });

  app.post<{ Body: { password: string } }>(
    '/api/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['password'],
          additionalProperties: false,
          properties: { password: { type: 'string', minLength: 1, maxLength: 256 } },
        },
      },
    },
    async (req, reply) => {
      if (!sessions)
        return deps.openAccess ? reply.code(204).send() : reply.code(503).send(notSetUp);
      const ip = clientIp(req);
      if (!limiter.hit(ip)) {
        return reply
          .code(429)
          .send({ error: 'rate_limited', message: 'Too many attempts. Try again later.' });
      }
      if (!(await sessions.checkPassword(req.body.password))) {
        req.log.warn({ ip }, 'Failed viewer login');
        return reply.code(401).send({ error: 'bad_password', message: 'Wrong password' });
      }
      limiter.reset(ip);
      const { token, expires } = sessions.issue();
      return reply
        .header('Set-Cookie', sessionCookie(token, expires, secureCookies(req)))
        .code(204)
        .send();
    },
  );

  app.post('/api/logout', async (req, reply) =>
    reply
      .header('Set-Cookie', clearedSessionCookie(secureCookies(req)))
      .code(204)
      .send(),
  );

  if (camera && hub) {
    registerCameraRoutes(app, camera, hub);
    return;
  }
  // No camera yet: every camera route answers 503 with the reason.
  const unavailable: ApiError = deps.config.setupComplete
    ? { error: 'camera-offline', message: deps.cameraError ?? 'The camera is offline' }
    : notSetUp;
  for (const url of ['/api/status', '/api/camera', '/api/ptz/*', LIVE_WS_PATH]) {
    app.route({
      method: ['GET', 'POST'],
      url,
      handler: (_req, reply) => reply.code(503).send(unavailable),
    });
  }
}

function registerCameraRoutes(app: FastifyInstance, camera: CameraService, hub: LiveHub): void {
  app.get('/api/status', async (): Promise<StatusResponse> => ({
    stream: hub.stats(),
    ptz: camera.ptz.capability,
  }));

  app.get('/api/camera', async (_req, reply) => {
    try {
      return await camera.info();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: { direction: PtzDirection; mode?: PtzMoveMode } }>(
    '/api/ptz/move',
    {
      schema: {
        body: {
          type: 'object',
          required: ['direction'],
          additionalProperties: false,
          properties: {
            direction: { type: 'string', enum: [...PTZ_DIRECTIONS] },
            mode: { type: 'string', enum: [...PTZ_MOVE_MODES] },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { direction, mode = 'step' } = req.body;
        await (mode === 'hold' ? camera.ptz.hold(direction) : camera.ptz.step(direction));
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post('/api/ptz/stop', async (_req, reply) => {
    try {
      await camera.ptz.stop();
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/ptz/presets', async (_req, reply) => {
    try {
      return await camera.ptz.presets();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { index: number } }>(
    '/api/ptz/presets/:index/go',
    {
      schema: {
        params: {
          type: 'object',
          required: ['index'],
          properties: { index: { type: 'integer', minimum: 0, maximum: 1000 } },
        },
      },
    },
    async (req, reply) => {
      try {
        await camera.ptz.goToPreset(req.params.index);
        return reply.code(204).send();
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
