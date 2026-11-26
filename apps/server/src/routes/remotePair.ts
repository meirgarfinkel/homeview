import type { FastifyInstance } from 'fastify';
import type { RemoteGateDeps } from '../app.js';
import { deviceName } from '../remote/deviceName.js';
import { deviceCookie } from '../remote/devices.js';
import { clientIp, isRemote } from '../security/remoteRequest.js';
import { sessionCookie, type SessionManager } from '../security/session.js';
import { notSetUp } from './api.js';

const rateLimited = { error: 'rate_limited', message: 'Too many attempts. Try again later.' };

const badCode = {
  error: 'bad-code',
  message:
    "This code didn't work. It may have been used or expired. Make a new one in Kasa Home on your computer.",
};

/**
 * A phone away from home trades a pairing code for a device cookie and a
 * session. Only through the tunnel: anywhere else the route doesn't exist.
 */
export async function registerRemotePairRoute(
  app: FastifyInstance,
  deps: { remote: RemoteGateDeps; sessions: SessionManager | undefined },
): Promise<void> {
  const { remote, sessions } = deps;

  app.post<{ Body: { code: string } }>(
    '/api/remote/pair',
    {
      schema: {
        body: {
          type: 'object',
          required: ['code'],
          additionalProperties: false,
          properties: { code: { type: 'string', minLength: 16, maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      if (!isRemote(req)) return reply.code(404).send({ error: 'not_found', message: 'Not found' });
      // The gate already refuses this without a password. Check again rather than trust it.
      if (!sessions) return reply.code(403).send(notSetUp);
      const ip = clientIp(req);
      if (!remote.pairAttempts.hit(ip)) {
        req.log.warn({ ip }, 'Too many pairing attempts');
        return reply.code(429).send(rateLimited);
      }
      if (!remote.pairing.consume(req.body.code)) {
        req.log.warn({ ip }, 'Pairing with a bad code');
        return reply.code(401).send(badCode);
      }
      const { device, token } = remote.devices.add(deviceName(req.headers['user-agent']));
      const session = sessions.issue();
      req.log.info(
        { device: device.id, name: device.name, ip },
        'Paired a device for remote access',
      );
      return reply
        .header('Set-Cookie', [
          deviceCookie(token),
          sessionCookie(session.token, session.expires, true),
        ])
        .code(200)
        .send({ ok: true });
    },
  );
}
