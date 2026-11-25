import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  ApiError,
  OnboardingAnswer,
  OnboardingStatus,
  SetupCamera,
  SetupExistingResult,
} from '@kasa/shared';
import type { Config } from '../config.js';
import { discoverCameras } from '../kasa/camera.js';
import type { DiscoveredDevice } from '../kasa/discovery.js';
import { findWorkingLogin } from '../kasa/setup.js';
import { Onboarding, OnboardingStateError, type OnboardingOptions } from '../setup/onboarding.js';
import { createWifiSwitcher, type WifiSwitcher } from '../setup/wifiSwitcher.js';
import { isLoopback } from '../security/network.js';
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
  /** True when the request has a valid session (or the page is open to all). */
  isAuthenticated?: (req: FastifyRequest) => boolean;
  /** Holds the onboarding job, so it outlives a rebuild of the app. */
  onboarding?: OnboardingSlot;
  /** How to get a Wi-Fi switcher. Defaults to the real one. */
  createSwitcher?: () => Promise<WifiSwitcher>;
  /** Replaces parts of the job's options. For tests. */
  onboardingOverrides?: Partial<
    Pick<OnboardingOptions, 'timeouts' | 'timeZone' | 'extraLogins'> & {
      discovery: { timeoutMs?: number };
    }
  >;
}

/** The one onboarding job of a server. It stays when the app is rebuilt. */
export interface OnboardingSlot {
  job?: Onboarding;
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

const wrongStep: ApiError = {
  error: 'wrong-step',
  message: "Setup isn't waiting for that now.",
};

const needNetwork: ApiError = { error: 'bad-answer', message: 'Choose a Wi-Fi network.' };

const noJob: ApiError = {
  error: 'no-onboarding',
  message: 'No camera setup is running.',
};

const jobRunning: ApiError = {
  error: 'onboarding-running',
  message: 'A camera setup is already running. Cancel it first.',
};

const needAccount: ApiError = {
  error: 'account-required',
  message: 'Enter the email and password of your TP-Link account to link the camera.',
};

const unauthorized: ApiError = { error: 'unauthorized', message: 'Sign in required' };

const loginRejected =
  'The camera did not accept any of the usual setup logins. Reset it again and try once more.';

/** The messages written for a terminal, reworded for the page. */
function forPage(status: OnboardingStatus): OnboardingStatus {
  if (status.error && /SETUP_LOGIN/.test(status.error.message)) {
    return { ...status, error: { ...status.error, message: loginRejected } };
  }
  return status;
}

const onboardingSchema = {
  body: {
    type: 'object',
    required: ['mode'],
    additionalProperties: false,
    properties: {
      mode: { enum: ['account', 'local'] },
      account: {
        type: 'object',
        required: ['username', 'password'],
        additionalProperties: false,
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 256 },
          password: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
    },
  },
} as const;

const answerSchema = {
  body: {
    type: 'object',
    required: ['type'],
    additionalProperties: false,
    properties: {
      type: { enum: ['camera-reset', 'wifi', 'retry'] },
      ssid: { type: 'string', minLength: 1, maxLength: 64 },
      passphrase: { type: 'string', maxLength: 256 },
      alias: { type: 'string', maxLength: 64 },
    },
  },
} as const;

const passwordSchema = {
  body: {
    type: 'object',
    required: ['password'],
    additionalProperties: false,
    properties: { password: { type: 'string', minLength: 1, maxLength: 256 } },
  },
} as const;

/** Rebuild with the new settings once this reply has gone out (or the client left). */
export function reloadAfterReply(
  deps: { reload?: () => Promise<void> },
  reply: FastifyReply,
): void {
  reply.raw.once('close', () => {
    deps
      .reload?.()
      .catch((err: Error) =>
        reply.log.error({ err: err.message }, 'Could not apply the new settings'),
      );
  });
}

const notApplied: ApiError = {
  error: 'reload-failed',
  message: 'The new password is saved, but Kasa Home could not start using it. Restart Kasa Home.',
};

/**
 * Save a new viewer password and reply once the rebuilt app uses it, with a
 * cookie for it. Replying first would let the page ask "am I signed in?" of
 * the old app, which still has the old password, and get "no".
 */
export async function saveViewerPassword(
  deps: { config: Config; settings: SettingsStore; reload?: () => Promise<void> },
  req: FastifyRequest,
  reply: FastifyReply,
  password: string,
): Promise<FastifyReply> {
  const hash = await hashPassword(password);
  deps.settings.save({ ...deps.settings.load(), viewerPasswordHash: hash });
  try {
    // Resolves once the new app is ready; it takes over right after this reply.
    await deps.reload?.();
  } catch (err) {
    req.log.error({ err: (err as Error).message }, 'Could not apply the new password');
    return reply.code(500).send(notApplied);
  }
  return reply
    .header('Set-Cookie', cookieForHash(deps.config, req, hash))
    .code(204)
    .send();
}

/**
 * A session cookie for a new password hash. The rebuilt app uses the same
 * secret and binds sessions to the same hash, so the cookie stays valid.
 */
export function cookieForHash(config: Config, req: FastifyRequest, hash: string): string {
  const secret = config.sessionSecret ?? loadOrCreateSecret(config.dataDir, 'session-secret');
  const { token, expires } = new SessionManager(passwordCheckFromHash(hash), secret).issue();
  return sessionCookie(token, expires, req.protocol === 'https');
}

export const existingCameraSchema = {
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

export type CameraLoginResult =
  | { fail: { status: number; body: ApiError } }
  | { choose: SetupCamera[] }
  | { chosen: DiscoveredDevice };

/**
 * Find the camera on the network and check that this login works on it.
 * Shared by first-run setup and the settings page.
 */
export async function checkCameraLogin(
  req: FastifyRequest,
  config: Config,
  login: { username: string; password: string; alias?: string | undefined },
): Promise<CameraLoginResult> {
  const { username, password, alias } = login;
  const cam = config.camera;

  let cameras = await discoverCameras(cam);
  if (alias) cameras = cameras.filter((c) => c.alias.toLowerCase() === alias.toLowerCase());
  if (cameras.length === 0) return { fail: { status: 404, body: noCamera } };

  const outcomes = await Promise.all(
    cameras.map(async (device) => {
      try {
        const found = await findWorkingLogin(
          { host: device.host, apiPort: cam.apiPort, tls: { pinnedSha256: cam.certSha256 } },
          [{ label: 'your Kasa account', username, password, encoding: cam.passwordEncoding }],
        );
        found?.client.close();
        return found ? 'ok' : 'rejected';
      } catch (err) {
        req.log.warn({ host: device.host, err: (err as Error).message }, 'Camera login failed');
        return 'unreachable';
      }
    }),
  );
  const working = cameras.filter((_, i) => outcomes[i] === 'ok');
  if (working.length === 0) {
    // A camera that couldn't be reached may be the right one, so only blame
    // the login when every camera answered and said no.
    return outcomes.includes('unreachable')
      ? { fail: { status: 502, body: unreachable } }
      : { fail: { status: 401, body: wrongLogin } };
  }
  if (working.length > 1 && !alias) return { choose: working.map(toSetupCamera) };
  return { chosen: working[0]! };
}

export function toSetupCamera(d: DiscoveredDevice): SetupCamera {
  return { alias: d.alias, model: d.model, host: d.host };
}

export async function registerSetupRoutes(app: FastifyInstance, deps: SetupDeps): Promise<void> {
  const { config, settings } = deps;

  const reloadAfter = (reply: FastifyReply) => reloadAfterReply(deps, reply);

  const savePassword = async (
    req: FastifyRequest<{ Body: { password: string } }>,
    reply: FastifyReply,
  ) => {
    if (config.viewer?.kind === 'plain') return reply.code(409).send(passwordFromEnv);
    const { password } = req.body;
    if (password.length < MIN_VIEWER_PASSWORD) return reply.code(400).send(tooShort);
    return saveViewerPassword(deps, req, reply, password);
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
    { schema: existingCameraSchema },
    async (req, reply) => {
      if (config.setupComplete) return reply.code(409).send(alreadySetUp);
      const { username, password } = req.body;
      const found = await checkCameraLogin(req, config, req.body);
      if ('fail' in found) return reply.code(found.fail.status).send(found.fail.body);
      if ('choose' in found) {
        const result: SetupExistingResult = { choose: found.choose };
        return result;
      }

      const chosen = found.chosen;
      settings.save({
        ...settings.load(),
        camera: { username, password, alias: chosen.alias, localOnly: false },
      });
      reloadAfter(reply);
      const result: SetupExistingResult = { saved: toSetupCamera(chosen) };
      return result;
    },
  );

  registerOnboardingRoutes(app, deps);
}

function registerOnboardingRoutes(app: FastifyInstance, deps: SetupDeps): void {
  const { config, settings } = deps;
  const slot = deps.onboarding ?? {};
  const url = '/api/setup/onboarding';

  /** This computer only, and before setup is complete or with a session. */
  const allowed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!isLoopback(req.ip)) {
      void reply.code(403).send({
        error: 'local-only',
        message: 'Only the computer running Kasa Home can do this.',
      });
      return false;
    }
    if (config.setupComplete && !(deps.isAuthenticated?.(req) ?? false)) {
      void reply.code(401).send(unauthorized);
      return false;
    }
    return true;
  };

  const finished = (job: Onboarding) => ['done', 'failed'].includes(job.status().phase);

  app.post<{
    Body: { mode: 'account' | 'local'; account?: { username: string; password: string } };
  }>(url, { schema: onboardingSchema }, async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    if (slot.job && !finished(slot.job)) return reply.code(409).send(jobRunning);
    const { mode } = req.body;
    const saved = settings.load().camera;
    const account =
      mode === 'account'
        ? (req.body.account ??
          (config.setupComplete && saved
            ? { username: saved.username, password: saved.password }
            : undefined))
        : undefined;
    if (mode === 'account' && !account) return reply.code(400).send(needAccount);

    const switcher = await (deps.createSwitcher ?? (() => createWifiSwitcher()))();
    const cam = config.camera;
    const over = deps.onboardingOverrides;
    const job = new Onboarding({
      mode,
      ...(account ? { account } : {}),
      switcher,
      apiPort: cam.apiPort,
      ...(cam.discoveryTargets ? { setupAddresses: cam.discoveryTargets } : {}),
      discovery: {
        ...(cam.discoveryTargets ? { targets: cam.discoveryTargets } : {}),
        ...(cam.discoveryPort ? { port: cam.discoveryPort } : {}),
        ...(over?.discovery ?? {}),
      },
      ...(over?.timeouts ? { timeouts: over.timeouts } : {}),
      ...(over?.timeZone ? { timeZone: over.timeZone } : {}),
      ...(over?.extraLogins ? { extraLogins: over.extraLogins } : {}),
      logger: req.log as unknown as OnboardingOptions['logger'],
      onSaved: (camera) => settings.save({ ...settings.load(), camera }),
      onEvent: (event) => {
        if (event.type === 'status' && event.status.phase === 'done') {
          deps
            .reload?.()
            .catch((err: Error) =>
              req.log.error({ err: err.message }, 'Could not apply the new settings'),
            );
        }
      },
    });
    slot.job = job;
    return reply.code(202).send(forPage(job.status()));
  });

  app.get(url, async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    if (!slot.job) return reply.code(404).send(noJob);
    return forPage(slot.job.status());
  });

  app.post<{ Body: OnboardingAnswer }>(
    `${url}/answer`,
    { schema: answerSchema },
    async (req, reply) => {
      if (!allowed(req, reply)) return reply;
      const job = slot.job;
      if (!job) return reply.code(404).send(noJob);
      const body = req.body;
      if (body.type === 'wifi' && !body.ssid) return reply.code(400).send(needNetwork);
      try {
        job.answer(
          body.type === 'wifi'
            ? {
                type: 'wifi',
                ssid: body.ssid,
                passphrase: body.passphrase ?? '',
                alias: body.alias ?? '',
              }
            : { type: body.type },
        );
      } catch (err) {
        if (err instanceof OnboardingStateError) return reply.code(409).send(wrongStep);
        throw err;
      }
      return forPage(job.status());
    },
  );

  app.delete(url, async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    await slot.job?.cancel();
    return reply.code(204).send();
  });
}
