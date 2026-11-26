/**
 * A standard (ONVIF/RTSP) camera: the stream over RTSP, pan/tilt over ONVIF,
 * and following the camera when its address changes.
 */
import net from 'node:net';
import type { CameraInfo } from '@kasa/shared';
import type { Logger } from '../logger.js';
import { OnvifDevice, type OnvifDeviceInfo, type OnvifProfile } from '../onvif/device.js';
import { discoverOnvif, type DiscoveredOnvif } from '../onvif/discovery.js';
import { pickProfile } from '../onvif/pickProfile.js';
import { RtspSource, VIDEO_FORMAT_UNSUPPORTED } from '../rtsp/rtspSource.js';
import type { CameraDriver } from './driver.js';
import { OnvifPtz } from './onvifPtz.js';

export interface OnvifCameraConfig {
  host: string;
  onvifPort: number;
  username: string;
  password: string;
  /** The profile picked at setup; the pick rule runs when it's missing. */
  profileToken?: string;
  /** A typed-in stream address. When set, ONVIF isn't used at all. */
  rtspUrl?: string;
  identity: { endpointId?: string; serial?: string; mac?: string };
}

export interface OnvifDriverOptions {
  allowPublicHost: boolean;
  logger: Logger;
  discovery?: { targets?: string[]; port?: number; timeoutMs?: number };
  /** How often to check the camera is still where we think. */
  followIntervalMs?: number;
  /** Called after following the camera to a new address. */
  onMoved?: (place: CameraPlace) => void;
}

const FOLLOW_INTERVAL_MS = 30_000;
const FAILURES_BEFORE_SEARCH = 2;
const REACH_TIMEOUT_MS = 3000;

export function deviceUrlFor(host: string, port: number): string {
  const h = host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${port}/onvif/device_service`;
}

/** Can we open a TCP connection to host:port? */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(REACH_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export class OnvifDriver implements CameraDriver {
  readonly kind = 'onvif' as const;
  readonly source: RtspSource;
  readonly ptz: OnvifPtz | undefined;
  private _host: string;
  private port: number;
  private name: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private searching = false;
  private disposed = false;

  private constructor(
    private readonly cfg: OnvifCameraConfig,
    private readonly opts: OnvifDriverOptions,
    private device: OnvifDevice | undefined,
    private readonly details: OnvifDeviceInfo | undefined,
    private readonly profile: OnvifProfile | undefined,
    streamUrl: string,
  ) {
    this._host = cfg.host;
    this.port = cfg.onvifPort;
    this.source = new RtspSource({
      url: streamUrl,
      username: cfg.username,
      password: cfg.password,
      allowPublicHost: opts.allowPublicHost,
      logger: opts.logger.child({ component: 'rtsp' }),
    });
    if (device && profile && device.hasPtz && profile.hasPtz) {
      this.ptz = new OnvifPtz({
        device: () => this.device!,
        profileToken: profile.token,
        logger: opts.logger.child({ component: 'ptz' }),
      });
    }
  }

  static async create(cfg: OnvifCameraConfig, opts: OnvifDriverOptions): Promise<OnvifDriver> {
    if (cfg.rtspUrl) {
      return new OnvifDriver(cfg, opts, undefined, undefined, undefined, cfg.rtspUrl);
    }
    const device = await OnvifDevice.connect({
      deviceUrl: deviceUrlFor(cfg.host, cfg.onvifPort),
      username: cfg.username,
      password: cfg.password,
      allowPublicHost: opts.allowPublicHost,
      logger: opts.logger,
    });
    const details = await device.info();
    const profiles = await device.profiles();
    const saved = cfg.profileToken ? profiles.find((p) => p.token === cfg.profileToken) : undefined;
    const profile = saved ?? pickProfile(profiles);
    if (!profile) throw new Error(VIDEO_FORMAT_UNSUPPORTED);
    const streamUrl = await device.streamUri(profile.token);
    return new OnvifDriver(cfg, opts, device, details, profile, streamUrl);
  }

  get host(): string {
    return this._host;
  }

  /** The profile being watched, to save after setup. */
  get profileToken(): string | undefined {
    return this.profile?.token;
  }

  info(): Promise<CameraInfo> {
    const d = this.details;
    const p = this.profile;
    const model = d?.model || 'Camera';
    return Promise.resolve({
      kind: 'onvif',
      alias: this.name ?? model,
      model,
      ...(d?.firmware ? { firmware: d.firmware } : {}),
      host: this._host,
      ...(p && p.width && p.height ? { resolution: `${p.width}x${p.height}` } : {}),
    });
  }

  start(): void {
    if (!this.device || this.disposed) return;
    // Learn the camera's own name; it's what the family named it.
    void this.search().then((found) => {
      const me = found.find((c) => c.endpointId === this.cfg.identity.endpointId);
      if (me?.name) this.name = me.name;
    });
    this.timer = setInterval(
      () => void this.check(),
      this.opts.followIntervalMs ?? FOLLOW_INTERVAL_MS,
    );
    this.timer.unref();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.timer);
    await this.ptz?.dispose();
  }

  private search(): Promise<DiscoveredOnvif[]> {
    const d = this.opts.discovery;
    return discoverOnvif({
      logger: this.opts.logger,
      ...(d?.targets ? { targets: d.targets } : {}),
      ...(d?.port ? { port: d.port } : {}),
      ...(d?.timeoutMs ? { timeoutMs: d.timeoutMs } : {}),
    }).catch(() => []);
  }

  /** Is the camera still there? After a few misses, look for it elsewhere. */
  private async check(): Promise<void> {
    if (this.searching || this.disposed) return;
    if (await reachable(this._host, this.port)) {
      this.failures = 0;
      return;
    }
    if (++this.failures < FAILURES_BEFORE_SEARCH) return;
    this.searching = true;
    try {
      await this.follow();
    } finally {
      this.searching = false;
    }
  }

  private async follow(): Promise<void> {
    const found = await findCamera(this.cfg, this.opts);
    if (!found || this.disposed) {
      if (!found)
        this.opts.logger.warn('The camera is not answering and was not found on the network');
      return;
    }
    this.opts.logger.info({ from: this._host, to: found.host }, 'The camera moved; following it');
    this.device = found.device;
    this._host = found.host;
    this.port = found.onvifPort;
    this.failures = 0;
    if (found.name) this.name = found.name;
    this.source.setHost(found.host);
    this.opts.onMoved?.(placeOf(found));
  }
}

/** Where the camera was found, to save so the next start looks there. */
export interface CameraPlace {
  host: string;
  onvifPort: number;
  endpointId?: string;
}

interface Found extends CameraPlace {
  device: OnvifDevice;
  name?: string;
}

function placeOf(f: Found): CameraPlace {
  return {
    host: f.host,
    onvifPort: f.onvifPort,
    ...(f.endpointId ? { endpointId: f.endpointId } : {}),
  };
}

/**
 * Search the network for this camera. When its endpoint id is known, only a
 * device announcing that id gets the login. Without the id (a camera added
 * by typed address) each device is signed in to and asked for its serial or
 * MAC, never with a Basic challenge (see SoapClient).
 */
export async function findCamera(
  cfg: OnvifCameraConfig,
  opts: OnvifDriverOptions,
): Promise<Found | undefined> {
  const { identity } = cfg;
  const d = opts.discovery;
  let candidates = await discoverOnvif({
    logger: opts.logger,
    ...(d?.targets ? { targets: d.targets } : {}),
    ...(d?.port ? { port: d.port } : {}),
    ...(d?.timeoutMs ? { timeoutMs: d.timeoutMs } : {}),
  }).catch((): DiscoveredOnvif[] => []);
  if (identity.endpointId) {
    candidates = candidates.filter((c) => c.endpointId === identity.endpointId);
  } else if (!identity.serial && !identity.mac) {
    return undefined;
  }
  for (const candidate of candidates) {
    const onvifPort = Number(new URL(candidate.xaddr).port) || 80;
    let device: OnvifDevice;
    try {
      device = await OnvifDevice.connect({
        deviceUrl: deviceUrlFor(candidate.host, onvifPort),
        username: cfg.username,
        password: cfg.password,
        allowPublicHost: opts.allowPublicHost,
        logger: opts.logger,
      });
    } catch {
      continue;
    }
    const matches = async (): Promise<boolean> => {
      if (identity.endpointId) return true;
      if (identity.serial && (await device.info()).serial === identity.serial) return true;
      if (identity.mac && (await device.macAddress()) === identity.mac.toLowerCase()) return true;
      return false;
    };
    if (!(await matches().catch(() => false))) continue;
    return {
      device,
      host: candidate.host,
      onvifPort,
      endpointId: candidate.endpointId,
      ...(candidate.name ? { name: candidate.name } : {}),
    };
  }
  return undefined;
}
