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
    const { identity } = this.cfg;
    const { logger } = this.opts;
    for (const candidate of await this.search()) {
      if (this.disposed) return;
      const port = Number(new URL(candidate.xaddr).port) || 80;
      let device: OnvifDevice;
      try {
        device = await OnvifDevice.connect({
          deviceUrl: deviceUrlFor(candidate.host, port),
          username: this.cfg.username,
          password: this.cfg.password,
          allowPublicHost: this.opts.allowPublicHost,
          logger,
        });
      } catch {
        continue;
      }
      const matches = async (): Promise<boolean> => {
        if (identity.endpointId && candidate.endpointId === identity.endpointId) return true;
        if (identity.serial && (await device.info()).serial === identity.serial) return true;
        if (identity.mac && (await device.macAddress()) === identity.mac.toLowerCase()) return true;
        return false;
      };
      if (!(await matches().catch(() => false))) continue;
      logger.info({ from: this._host, to: candidate.host }, 'The camera moved; following it');
      this.device = device;
      this._host = candidate.host;
      this.port = port;
      this.failures = 0;
      if (candidate.name) this.name = candidate.name;
      this.source.setHost(candidate.host);
      return;
    }
    logger.warn('The camera is not answering and was not found on the network');
  }
}
