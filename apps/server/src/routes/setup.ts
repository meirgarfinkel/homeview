import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError, SetupCamera, SetupExistingResult } from '@kasa/shared';
import type { Config } from '../config.js';
import { discoverCameras } from '../kasa/camera.js';
import type { DiscoveredDevice } from '../kasa/discovery.js';
import { findWorkingLogin } from '../kasa/setup.js';
import { loadOrCreateSecret } from '../security/dataDir.js';
import { hashPassword } from '../security/passwordHash.js';
import { passwordCheckFromHash, sessionCookie, SessionManager } from '../security/session.js';
import type { SettingsStore } from '../settings/store.js';

/**
 * First-run setup in the browser. The onRequest hook in app.ts lets only
 * this computer (loopback) reach these routes and skips the session check
 * for them, so the parent can set up and reset a forgotten password.
 */

export interface SetupDeps {
  config: Config;
  settings: SettingsStore;
  reload?: () => Promise<void>;
}

export const MIN_VIEWER_PASSWORD = 8;

const alreadySetUp: ApiError = {
  error: 'already-set-up',
  message: 'Kasa Home is already set up.',
};

const passwordFromEnv: ApiError = {
  error: 'password-from-env',
  message: 'The viewer password comes from VIEWER_PASSWORD, so change it there.',
};

const tooShort: ApiError = {
  error: 'password-too-short',
  message: `Choose a password with at least ${MIN_VIEWER_PASSWORD} characters.`,
};

const noCamera: ApiError = {
  error: 'no-camera',
  message:
    'No Kasa camera answered on this network. Check it is plugged in and on the same Wi-Fi as this computer.',
};

const wrongLogin: ApiError = {
  error: 'wrong-login',
  message:
    'The camera did not accept that email and password. Check they are the ones you use in the Kasa app.',
};

const unreachable: ApiError = {
  error: 'camera-unreachable',
  message: 'A Kasa camera answered but would not take a login. Wait a minute and try again.',
};

const passwordSchema = {
  body: {
    type: 'object',
    required: ['password'],
    additionalProperties: false,
    properties: { password: { type: 'string', minLength: 1, maxLength: 256 } },
  },
} as const;

const existingSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 1, maxLength: 256 },
      password: { type: 'string', minLength: 1, maxLength: 256 },
      alias: { type: 'string', minLength: 1, maxLength: 256 },
    },
  },
} as const;

function toSetupCamera(d: DiscoveredDevice): SetupCamera {
  return { alias: d.alias, model: d.model, host: d.host };
}

export async function registerSetupRoutes(app: FastifyInstance, deps: SetupDeps): Promise<void> {
  const { config, settings } = deps;

  /** Rebuild with the new settings once this reply has gone out (or the client left). */
  const reloadAfterReply = (reply: FastifyReply) => {
    reply.raw.once('close', () => {
      deps
        .reload?.()
        .catch((err: Error) =>
          reply.log.error({ err: err.message }, 'Could not apply the new settings'),
        );
    });
  };

  /**
   * A session cookie for the new password. The rebuilt app uses the same
   * secret and binds sessions to the same hash, so the cookie stays valid.
   */
  const cookieFor = (req: FastifyRequest, hash: string): string => {
    const secret = config.sessionSecret ?? loadOrCreateSecret(config.dataDir, 'session-secret');
    const { token, expires } = new SessionManager(passwordCheckFromHash(hash), secret).issue();
    return sessionCookie(token, expires, req.protocol === 'https');
  };

  const savePassword = async (
    req: FastifyRequest<{ Body: { password: string } }>,
    reply: FastifyReply,
  ) => {
    if (config.viewer?.kind === 'plain') return reply.code(409).send(passwordFromEnv);
    const { password } = req.body;
    if (password.length < MIN_VIEWER_PASSWORD) return reply.code(400).send(tooShort);
    const hash = await hashPassword(password);
    settings.save({ ...settings.load(), viewerPasswordHash: hash });
    reloadAfterReply(reply);
    return reply.header('Set-Cookie', cookieFor(req, hash)).code(204).send();
  };

  app.post<{ Body: { password: string } }>(
    '/api/setup/password',
    { schema: passwordSchema },
    async (req, reply) => {
      if (config.setupComplete) return reply.code(409).send(alreadySetUp);
      return savePassword(req, reply);
    },
  );

  // "Set a new password" on this computer, before or after setup.
  app.post<{ Body: { password: string } }>(
    '/api/setup/reset-password',
    { schema: passwordSchema },
    async (req, reply) => savePassword(req, reply),
  );

  app.post<{ Body: { username: string; password: string; alias?: string } }>(
    '/api/setup/existing-camera',
    { schema: existingSchema },
    async (req, reply) => {
      if (config.setupComplete) return reply.code(409).send(alreadySetUp);
      const { username, password, alias } = req.body;
      const cam = config.camera;

      let cameras = await discoverCameras(cam);
      if (alias) cameras = cameras.filter((c) => c.alias.toLowerCase() === alias.toLowerCase());
      if (cameras.length === 0) return reply.code(404).send(noCamera);

      const outcomes = await Promise.all(
        cameras.map(async (device) => {
          try {
            const login = await findWorkingLogin(
              { host: device.host, apiPort: cam.apiPort, tls: { pinnedSha256: cam.certSha256 } },
              [{ label: 'your Kasa account', username, password, encoding: cam.passwordEncoding }],
            );
            login?.client.close();
            return login ? 'ok' : 'rejected';
          } catch (err) {
            req.log.warn({ host: device.host, err: (err as Error).message }, 'Camera login failed');
            return 'unreachable';
          }
        }),
      );
      const working = cameras.filter((_, i) => outcomes[i] === 'ok');
      if (working.length === 0) {
        return outcomes.includes('rejected')
          ? reply.code(401).send(wrongLogin)
          : reply.code(502).send(unreachable);
      }
      if (working.length > 1 && !alias) {
        const result: SetupExistingResult = { choose: working.map(toSetupCamera) };
        return result;
      }

      const chosen = working[0]!;
      settings.save({
        ...settings.load(),
        camera: { username, password, alias: chosen.alias, localOnly: false },
      });
      reloadAfterReply(reply);
      const result: SetupExistingResult = { saved: toSetupCamera(chosen) };
      return result;
    },
  );
}
