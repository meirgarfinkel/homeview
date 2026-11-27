import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  STREAM_RESOLUTIONS,
  type ApiError,
  type OnvifProfilesResult,
  type SettingsResponse,
  type StreamResolution,
} from '@kasa/shared';
import type { Config } from '../config.js';
import { isLocalRequest } from '../security/remoteRequest.js';
import { verifyPassword } from '../security/passwordHash.js';
import type { SettingsStore } from '../settings/store.js';
import type { ServerHooks } from '../app.js';
import { savedCameraProfiles } from './onvifSetup.js';
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

const resolutionFromEnv: ApiError = {
  error: 'resolution-from-env',
  message: 'The video quality comes from KASA_STREAM_RESOLUTION, so change it there.',
};

const resolutionSchema = {
  body: {
    type: 'object',
    required: ['resolution'],
    additionalProperties: false,
    properties: {
      resolution: { anyOf: [{ type: 'null' }, { type: 'string', enum: [...STREAM_RESOLUTIONS] }] },
    },
  },
} as const;

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
  message: 'Only the computer running HomeView can do this.',
};

const notDesktop: ApiError = {
  error: 'not-available',
  message: 'This is only available in the HomeView app.',
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

const noAnswer: ApiError = {
  error: 'no-answer',
  message: 'No answer from the camera.',
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
      version: hooks?.appVersion ? hooks.appVersion() : null,
      streamResolution:
        (config.camera.streamResolution as SettingsResponse['streamResolution'] | undefined) ??
        null,
      cameraDefaultSize: settings.load().cameraDefaultSize ?? null,
      managedByEnv: [
        ...(config.fromEnv.viewerPassword ? (['viewerPassword'] as const) : []),
        ...(config.fromEnv.camera ? (['camera'] as const) : []),
        ...(config.fromEnv.streamResolution ? (['streamResolution'] as const) : []),
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

  // The stream size. Anyone signed in may change it: it only affects sharpness and data use.
  app.put<{ Body: { resolution: StreamResolution | null } }>(
    '/api/settings/stream-resolution',
    { schema: resolutionSchema },
    async (req, reply) => {
      if (config.fromEnv.streamResolution) return reply.code(409).send(resolutionFromEnv);
      const next = settings.load();
      if (req.body.resolution === null) delete next.streamResolution;
      else next.streamResolution = req.body.resolution;
      settings.save(next);
      reloadAfterReply(deps, reply);
      return reply.code(204).send();
    },
  );

  // A standard camera's streams, to choose from on this computer.
  app.get('/api/settings/camera-profiles', async (req, reply) => {
    if (!isLocalRequest(req)) return reply.code(403).send(localOnly);
    if (config.camera.kind !== 'onvif' || !config.camera.onvif || config.camera.onvif.rtspUrl) {
      return reply.code(409).send(notOnvif);
    }
    try {
      const result: OnvifProfilesResult = {
        profiles: await savedCameraProfiles(config),
        ...(config.camera.onvif.profileToken ? { current: config.camera.onvif.profileToken } : {}),
      };
      return result;
    } catch {
      return reply.code(504).send(noAnswer);
    }
  });

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
      const profiles = await savedCameraProfiles(config).catch(() => []);
      if (!profiles.some((p) => p.token === profileToken)) {
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

  app.get('/api/app/update', async (req, reply) => {
    if (!appOnly(req, reply, hooks?.updateStatus)) return reply;
    return hooks!.updateStatus!();
  });

  app.post('/api/app/update/install', async (req, reply) => {
    if (!appOnly(req, reply, hooks?.installUpdate)) return reply;
    reply.raw.once('close', () => hooks!.installUpdate!());
    return reply.code(202).send();
  });

  app.post('/api/app/update/check', async (req, reply) => {
    if (!appOnly(req, reply, hooks?.checkForUpdates)) return reply;
    try {
      return { result: await hooks!.checkForUpdates!() };
    } catch (err) {
      const failed: ApiError = { error: 'update-check-failed', message: (err as Error).message };
      return reply.code(502).send(failed);
    }
  });

  app.post('/api/app/quit', async (req, reply) => {
    if (!appOnly(req, reply, hooks?.quit)) return reply;
    reply.raw.once('close', () => hooks!.quit!());
    return reply.code(204).send();
  });
}
