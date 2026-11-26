/**
 * Setup for standard (ONVIF/RTSP) cameras: find them, check a login, save.
 * Under /api/setup, so app.ts already allows only this computer. After setup
 * these also need a signed-in session, since they change the camera.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pino } from 'pino';
import type {
  ApiError,
  OnvifCheckError,
  OnvifCheckResult,
  OnvifLogin,
  OnvifProfileInfo,
  OnvifSaveBody,
  OnvifSaveResult,
  OnvifScanResult,
} from '@kasa/shared';
import { StreamAuthError } from '../camera/driver.js';
import { onvifDiscovery } from '../camera/createDriver.js';
import { deviceUrlFor } from '../camera/onvifDriver.js';
import type { Config } from '../config.js';
import { OnvifDevice } from '../onvif/device.js';
import { discoverOnvif } from '../onvif/discovery.js';
import { pickProfile } from '../onvif/pickProfile.js';
import { OnvifAuthError, OnvifUnreachableError } from '../onvif/soap.js';
import { probeRtsp, VIDEO_FORMAT_UNSUPPORTED } from '../rtsp/rtspSource.js';
import type { Logger } from '../logger.js';
import { isLocalRequest } from '../security/remoteRequest.js';
import { isPrivateAddress } from '../security/network.js';
import { withCamera, type OnvifSettings, type SettingsStore } from '../settings/store.js';

export interface OnvifSetupDeps {
  config: Config;
  settings: SettingsStore;
  isAuthenticated?: (req: FastifyRequest) => boolean;
  reloadAfter: (reply: FastifyReply) => void;
}

const MESSAGES: Record<OnvifCheckError, string> = {
  'bad-address': "That isn't a camera address on your home network.",
  'camera-login': "The camera didn't accept that username or password.",
  'video-format': VIDEO_FORMAT_UNSUPPORTED,
  'no-answer':
    'No answer from the camera. Make sure the camera is set up in its own app and on your Wi-Fi.',
  'onvif-off': "Something answered at that address, but it isn't a camera with ONVIF turned on.",
};

const STATUS: Record<OnvifCheckError, number> = {
  'bad-address': 400,
  'camera-login': 401,
  'video-format': 422,
  'no-answer': 504,
  'onvif-off': 502,
};

class CheckFailed extends Error {
  constructor(readonly code: OnvifCheckError) {
    super(MESSAGES[code]);
  }
}

const text = { type: 'string', minLength: 1, maxLength: 256 } as const;
const loginProps = {
  host: { type: 'string', minLength: 1, maxLength: 253 },
  port: { type: 'integer', minimum: 1, maximum: 65535 },
  rtspUrl: { type: 'string', minLength: 1, maxLength: 1024 },
  username: text,
  password: text,
} as const;
const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: loginProps,
  },
} as const;
const saveSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: { ...loginProps, profileToken: text, endpointId: text },
  },
} as const;

/** A host on this network (or any host when allowPublicHost), resolved. */
async function checkedHost(host: string, allowPublicHost: boolean): Promise<string> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (
    !net.isIP(bare) &&
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(bare)
  ) {
    throw new CheckFailed('bad-address');
  }
  let address: string;
  try {
    address = net.isIP(bare) ? bare : (await lookup(bare)).address;
  } catch {
    throw new CheckFailed('no-answer');
  }
  if (!allowPublicHost && !isPrivateAddress(address)) throw new CheckFailed('bad-address');
  return bare;
}

interface Checked {
  result: OnvifCheckResult;
  /** What to save, without the login. */
  onvif: Omit<OnvifSettings, 'profileToken'>;
  playable: OnvifProfileInfo[];
}

/** Reach the camera with this login and read what it can stream. Saves nothing. */
async function checkLogin(body: OnvifLogin, config: Config, endpointId?: string): Promise<Checked> {
  const { allowPublicHost } = config.camera;
  if ('rtspUrl' in body && body.rtspUrl) {
    let url: URL;
    try {
      url = new URL(body.rtspUrl);
    } catch {
      throw new CheckFailed('bad-address');
    }
    if (url.protocol !== 'rtsp:' || url.username || url.password)
      throw new CheckFailed('bad-address');
    const host = await checkedHost(url.hostname, allowPublicHost);
    let codec;
    try {
      codec = await probeRtsp({
        url: url.toString(),
        username: body.username,
        password: body.password,
      });
    } catch (err) {
      throw new CheckFailed(err instanceof StreamAuthError ? 'camera-login' : 'no-answer');
    }
    if (!codec) throw new CheckFailed('video-format');
    const profile: OnvifProfileInfo = {
      token: 'stream',
      name: 'Stream',
      codec,
      width: 0,
      height: 0,
    };
    return {
      result: { profiles: [profile], picked: profile.token },
      onvif: { host, onvifPort: 0, rtspUrl: url.toString(), identity: {} },
      playable: [profile],
    };
  }
  if (!('host' in body) || !body.host) throw new CheckFailed('bad-address');
  const host = await checkedHost(body.host, allowPublicHost);
  const port = body.port ?? 80;
  let device: OnvifDevice;
  try {
    device = await OnvifDevice.connect({
      deviceUrl: deviceUrlFor(host, port),
      username: body.username,
      password: body.password,
      allowPublicHost,
      logger: silent,
    });
    const info = await device.info();
    const profiles = await device.profiles();
    const playable = profiles.flatMap((p): OnvifProfileInfo[] =>
      p.codec === 'h264' || p.codec === 'h265'
        ? [{ token: p.token, name: p.name, codec: p.codec, width: p.width, height: p.height }]
        : [],
    );
    const picked = pickProfile(profiles);
    if (!picked) throw new CheckFailed('video-format');
    const mac = await device.macAddress();
    return {
      result: {
        ...(info.model ? { model: info.model } : {}),
        profiles: playable,
        picked: picked.token,
      },
      onvif: {
        host,
        onvifPort: port,
        identity: {
          ...(endpointId ? { endpointId } : {}),
          ...(info.serial ? { serial: info.serial } : {}),
          ...(mac ? { mac } : {}),
        },
      },
      playable,
    };
  } catch (err) {
    if (err instanceof CheckFailed) throw err;
    if (err instanceof OnvifAuthError) throw new CheckFailed('camera-login');
    if (err instanceof OnvifUnreachableError) throw new CheckFailed('no-answer');
    throw new CheckFailed('onvif-off');
  }
}

/** The camera calls log nothing here: a failed check is answered, not logged. */
const silent: Logger = pino({ level: 'silent' });

function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof CheckFailed) {
    const body: ApiError = { error: err.code, message: err.message };
    return reply.code(STATUS[err.code]).send(body);
  }
  throw err;
}

export function registerOnvifSetupRoutes(app: FastifyInstance, deps: OnvifSetupDeps): void {
  const { config, settings } = deps;

  /** Before setup: open (this computer only, by app.ts). After: also a session. */
  const allowed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!config.setupComplete) return true;
    if (isLocalRequest(req) && (deps.isAuthenticated?.(req) ?? false)) return true;
    void reply.code(403).send({
      error: 'sign-in-here',
      message: 'Sign in on this computer to change the camera.',
    } satisfies ApiError);
    return false;
  };

  app.post('/api/setup/onvif/scan', async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    const found = await discoverOnvif({ logger: req.log, ...onvifDiscovery(config) });
    const result: OnvifScanResult = {
      cameras: found.map((c) => ({
        endpointId: c.endpointId,
        host: c.host,
        port: Number(new URL(c.xaddr).port) || 80,
        ...(c.name ? { name: c.name } : {}),
      })),
    };
    return result;
  });

  app.post<{ Body: OnvifLogin }>(
    '/api/setup/onvif/check',
    { schema: loginSchema },
    async (req, reply) => {
      if (!allowed(req, reply)) return reply;
      try {
        return (await checkLogin(req.body, config)).result;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Body: OnvifSaveBody }>(
    '/api/setup/onvif/save',
    { schema: saveSchema },
    async (req, reply) => {
      if (!allowed(req, reply)) return reply;
      let checked: Checked;
      try {
        checked = await checkLogin(req.body, config, req.body.endpointId);
      } catch (err) {
        return fail(reply, err);
      }
      const wanted = req.body.profileToken;
      const profileToken = checked.playable.some((p) => p.token === wanted)
        ? wanted!
        : checked.result.picked;
      const saved = settings.load();
      settings.save(
        withCamera(saved, {
          kind: 'onvif',
          username: req.body.username,
          password: req.body.password,
          localOnly: saved.camera?.localOnly ?? false,
          onvif: { ...checked.onvif, ...(checked.onvif.rtspUrl ? {} : { profileToken }) },
        }),
      );
      deps.reloadAfter(reply);
      const result: OnvifSaveResult = {
        saved: {
          ...(checked.result.model ? { model: checked.result.model } : {}),
          host: checked.onvif.host,
        },
      };
      return result;
    },
  );
}

/** The saved standard camera's playable streams. For the settings page. */
export async function savedCameraProfiles(config: Config): Promise<OnvifProfileInfo[]> {
  const cam = config.camera.onvif;
  if (!cam || cam.rtspUrl) return [];
  const device = await OnvifDevice.connect({
    deviceUrl: deviceUrlFor(cam.host, cam.onvifPort),
    username: cam.username,
    password: cam.password,
    allowPublicHost: config.camera.allowPublicHost,
    logger: silent,
  });
  return (await device.profiles()).flatMap((p): OnvifProfileInfo[] =>
    p.codec === 'h264' || p.codec === 'h265'
      ? [{ token: p.token, name: p.name, codec: p.codec, width: p.width, height: p.height }]
      : [],
  );
}
