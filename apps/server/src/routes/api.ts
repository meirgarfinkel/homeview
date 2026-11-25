import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  PTZ_DIRECTIONS,
  type ApiError,
  type PtzDirection,
  type SessionResponse,
  type StatusResponse,
} from '@kasa/shared';
import type { AppDeps } from '../app.js';
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
  isAuthenticated(req: FastifyRequest): boolean;
}

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
  const secure = Boolean(deps.tls);
  const limiter = new LoginRateLimiter();

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/session', async (req): Promise<SessionResponse> => ({
    authRequired: Boolean(sessions),
    authenticated: deps.isAuthenticated(req),
  }));

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
      if (!sessions) return reply.code(204).send();
      if (!limiter.hit(req.ip)) {
        return reply
          .code(429)
          .send({ error: 'rate_limited', message: 'Too many attempts. Try again later.' });
      }
      if (!sessions.checkPassword(req.body.password)) {
        req.log.warn({ ip: req.ip }, 'Failed viewer login');
        return reply.code(401).send({ error: 'bad_password', message: 'Wrong password' });
      }
      limiter.reset(req.ip);
      const { token, expires } = sessions.issue();
      return reply
        .header('Set-Cookie', sessionCookie(token, expires, secure))
        .code(204)
        .send();
    },
  );

  app.post('/api/logout', async (_req, reply) =>
    reply.header('Set-Cookie', clearedSessionCookie(secure)).code(204).send(),
  );

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

  app.post<{ Body: { direction: PtzDirection } }>(
    '/api/ptz/move',
    {
      schema: {
        body: {
          type: 'object',
          required: ['direction'],
          additionalProperties: false,
          properties: { direction: { type: 'string', enum: [...PTZ_DIRECTIONS] } },
        },
      },
    },
    async (req, reply) => {
      try {
        await camera.ptz.move(req.body.direction);
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
