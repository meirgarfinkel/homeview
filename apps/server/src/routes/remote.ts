import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError, PairCodeResponse, RemoteStatus } from '@kasa/shared';
import type { RemoteAccess } from '../remote/remoteAccess.js';
import { isLocalRequest, isRemote } from '../security/remoteRequest.js';

/**
 * The away-from-home controls. The onRequest hook in app.ts already requires
 * a session and a same-origin request, and the remote gate refuses all of
 * these from away. Each route still checks who is asking.
 */

export interface RemoteRouteDeps {
  remote: RemoteAccess;
  /** Setup is complete and there is a viewer password. */
  ready: boolean;
  isAuthenticated(req: FastifyRequest): boolean;
}

const localOnly: ApiError = {
  error: 'local-only',
  message: 'Only the computer running HomeView can do this.',
};

const notAvailable: ApiError = {
  error: 'not-available',
  message: 'This is only available in the HomeView app.',
};

const needsPassword: ApiError = {
  error: 'needs-password',
  message: 'Set up HomeView and choose a password first.',
};

const remoteOff: ApiError = {
  error: 'remote-off',
  message: 'Away from home is off. Turn it on in HomeView on your computer.',
};

const noLink: ApiError = {
  error: 'no-link',
  message: 'There is nothing to open right now.',
};

const notFound: ApiError = { error: 'not_found', message: 'Not found' };

const enableSchema = {
  body: {
    type: 'object',
    required: ['on'],
    additionalProperties: false,
    properties: { on: { type: 'boolean' } },
  },
} as const;

const deviceSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
  },
} as const;

export async function registerRemoteRoutes(
  app: FastifyInstance,
  deps: RemoteRouteDeps,
): Promise<void> {
  const { remote } = deps;

  /** Replies 403 unless the request is from this computer and signed in. */
  const refuseUnlessLocal = (req: FastifyRequest, reply: FastifyReply) =>
    isLocalRequest(req) && deps.isAuthenticated(req) ? undefined : reply.code(403).send(localOnly);

  app.get('/api/remote', async (req, reply): Promise<RemoteStatus | FastifyReply> => {
    return refuseUnlessLocal(req, reply) ?? remote.status();
  });

  app.post<{ Body: { on: boolean } }>(
    '/api/remote/enable',
    { schema: enableSchema },
    async (req, reply) => {
      const refused = refuseUnlessLocal(req, reply);
      if (refused) return refused;
      const { on } = req.body;
      if (on && !remote.available) return reply.code(409).send(notAvailable);
      if (on && !deps.ready) return reply.code(409).send(needsPassword);
      await remote.setEnabled(on);
      req.log.info({ on }, on ? 'Turned remote access on' : 'Turned remote access off');
      return reply.code(204).send();
    },
  );

  app.post('/api/remote/open-link', async (req, reply) => {
    const refused = refuseUnlessLocal(req, reply);
    if (refused) return refused;
    return remote.openLink() ? reply.code(204).send() : reply.code(409).send(noLink);
  });

  app.post('/api/remote/sign-out', async (req, reply) => {
    const refused = refuseUnlessLocal(req, reply);
    if (refused) return refused;
    await remote.signOut();
    req.log.info('Signed out of Tailscale');
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>(
    '/api/remote/devices/:id',
    { schema: deviceSchema },
    async (req, reply) => {
      const refused = refuseUnlessLocal(req, reply);
      if (refused) return refused;
      if (!remote.devices.remove(req.params.id)) return reply.code(404).send(notFound);
      req.log.info({ device: req.params.id }, 'Removed a paired device');
      return reply.code(204).send();
    },
  );

  // This computer, or a phone signed in at home. Never from away.
  app.post('/api/remote/pair-code', async (req, reply) => {
    if (isRemote(req) || !deps.isAuthenticated(req)) return reply.code(403).send(localOnly);
    if (remote.status().phase !== 'on') return reply.code(409).send(remoteOff);
    const { code, expiresAt } = remote.pairing.create();
    const url = remote.pairUrl(code);
    if (!url) return reply.code(409).send(remoteOff);
    const body: PairCodeResponse = { url, expiresAt: expiresAt.toISOString() };
    return body;
  });
}
