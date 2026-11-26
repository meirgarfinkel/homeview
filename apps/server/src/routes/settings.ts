import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError, SettingsResponse } from '@kasa/shared';
import type { Config } from '../config.js';
import { isLocalRequest } from '../security/remoteRequest.js';
import { verifyPassword } from '../security/passwordHash.js';
import type { SettingsStore } from '../settings/store.js';
import type { ServerHooks } from '../app.js';
import { profileExists } from './onvifSetup.js';
import {
  existingCameraSchema,
  MIN_VIEWER_PASSWORD,
  reloadAfterReply,
  saveKasaCamera,
  saveViewerPassword,
} from './setup.js';

/**
 * The settings page's API. The onRequest hook in app.ts already requires a
 * session and a same-origin request for everything here.
 */

export interface SettingsRouteDeps {
  config: Config;
  settings: SettingsStore;
  reload?: () => Promise<void>;
  hooks?: ServerHooks;
  desktop: boolean;
}

const passwordFromEnv: ApiError = {
  error: 'password-from-env',
  message: 'The viewer password comes from VIEWER_PASSWORD, so change it there.',
};

const cameraFromEnv: ApiError = {
  error: 'camera-from-env',
  message: 'The camera login comes from KASA_USERNAME and KASA_PASSWORD, so change it there.',
};

const wrongPassword: ApiError = {
  error: 'wrong-password',
  message: 'That is not the current password.',
};

const tooShort: ApiError = {
  error: 'password-too-short',
  message: `Choose a password with at least ${MIN_VIEWER_PASSWORD} characters.`,
};

const localOnly: ApiError = {
  error: 'local-only',
  message: 'Only the computer running Kasa Home can do this.',
};

const notDesktop: ApiError = {
  error: 'not-available',
  message: 'This is only available in the Kasa Home app.',
};

const passwordSchema = {
  body: {
    type: 'object',
    required: ['current', 'password'],
    additionalProperties: false,
    properties: {
      current: { type: 'string', minLength: 1, maxLength: 256 },
      password: { type: 'string', minLength: 1, maxLength: 256 },
    },
  },
} as const;

const profileSchema = {
  body: {
    type: 'object',
    required: ['profileToken'],
    additionalProperties: false,
    properties: { profileToken: { type: 'string', minLength: 1, maxLength: 256 } },
  },
} as const;

const notOnvif: ApiError = {
  error: 'not-onvif',
  message: 'Only a standard camera has stream profiles to choose from.',
};

const noSuchProfile: ApiError = {
  error: 'no-such-profile',
  message: "The camera doesn't have that stream.",
};

const autostartSchema = {
  body: {
    type: 'object',
    required: ['enabled'],
    additionalProperties: false,
    properties: { enabled: { type: 'boolean' } },
  },
} as const;

export async function registerSettingsRoutes(
  app: FastifyInstance,
  deps: SettingsRouteDeps,
): Promise<void> {
  const { config, settings, hooks } = deps;

  app.get('/api/settings', async (req): Promise<SettingsResponse> => {
    const camera = config.camera.username
      ? {
          kind: config.camera.kind,
          username: config.camera.username,
          ...(config.camera.onvif?.profileToken
            ? { profileToken: config.camera.onvif.profileToken }
            : {}),
          ...(config.camera.alias ? { alias: config.camera.alias } : {}),
          localOnly: settings.load().camera?.localOnly ?? false,
        }
      : null;
    return {
      camera,
      local: isLocalRequest(req),
      desktop: deps.desktop,
      autostart: hooks?.getAutostart ? hooks.getAutostart() : null,
      managedByEnv: [
        ...(config.fromEnv.viewerPassword ? (['viewerPassword'] as const) : []),
        ...(config.fromEnv.camera ? (['camera'] as const) : []),
      ],
    };
  });

  app.put<{ Body: { current: string; password: string } }>(
    '/api/settings/viewer-password',
    { schema: passwordSchema },
    async (req, reply) => {
      if (config.fromEnv.viewerPassword) return reply.code(409).send(passwordFromEnv);
      const { current, password } = req.body;
      const stored = config.viewer?.kind === 'hash' ? config.viewer.hash : undefined;
      if (!stored || !(await verifyPassword(current, stored))) {
        req.log.warn({ ip: req.ip }, 'Wrong current password on a password change');
        return reply.code(403).send(wrongPassword);
      }
      if (password.length < MIN_VIEWER_PASSWORD) return reply.code(400).send(tooShort);
      return saveViewerPassword(deps, req, reply, password);
    },
  );

  app.put<{ Body: { username: string; password: string; alias?: string } }>(
    '/api/settings/camera',
    { schema: existingCameraSchema },
    async (req, reply) => {
      if (config.fromEnv.camera) return reply.code(409).send(cameraFromEnv);
      return saveKasaCamera(deps, req, reply);
    },
  );

  // A standard camera's stream profile, from this computer.
  app.post<{ Body: { profileToken: string } }>(
    '/api/settings/camera-profile',
    { schema: profileSchema },
    async (req, reply) => {
      if (!isLocalRequest(req)) return reply.code(403).send(localOnly);
      if (config.camera.kind !== 'onvif' || !config.camera.onvif || config.camera.onvif.rtspUrl) {
        return reply.code(409).send(notOnvif);
      }
      const { profileToken } = req.body;
      if (!(await profileExists(config, profileToken).catch(() => false))) {
        return reply.code(400).send(noSuchProfile);
      }
      const saved = settings.load();
      if (saved.camera?.onvif) {
        settings.save({
          ...saved,
          camera: { ...saved.camera, onvif: { ...saved.camera.onvif, profileToken } },
        });
      }
      reloadAfterReply(deps, reply);
      return reply.code(204).send();
    },
  );

  /** This computer only, and only where the desktop app gave us the hook. */
  const appOnly = (req: FastifyRequest, reply: FastifyReply, hook: unknown): boolean => {
    if (!isLocalRequest(req)) {
      void reply.code(403).send(localOnly);
      return false;
    }
    if (!hook) {
      void reply.code(404).send(notDesktop);
      return false;
    }
    return true;
  };

  app.put<{ Body: { enabled: boolean } }>(
    '/api/app/autostart',
    { schema: autostartSchema },
    async (req, reply) => {
      if (!appOnly(req, reply, hooks?.setAutostart)) return reply;
      hooks!.setAutostart!(req.body.enabled);
      return reply.code(204).send();
    },
  );

  app.post('/api/app/quit', async (req, reply) => {
    if (!appOnly(req, reply, hooks?.quit)) return reply;
    reply.raw.once('close', () => hooks!.quit!());
    return reply.code(204).send();
  });
}
