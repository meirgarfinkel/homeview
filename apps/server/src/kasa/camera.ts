import { lookup } from 'node:dns/promises';
import net from 'node:net';
import type { CameraInfo } from '@kasa/shared';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { isPrivateAddress } from '../security/network.js';
import { CameraSource } from './cameraSource.js';
import { CameraCredentials } from './credentials.js';
import { discover, isCamera, type DiscoverOptions, type DiscoveredDevice } from './discovery.js';
import { LinkieClient, type CameraSysinfo } from './linkieClient.js';
import { PtzController } from './ptz.js';

export class CameraLocateError extends Error {
  override name = 'CameraLocateError';
}

/**
 * Discovery settings for this camera config. Probes sent to known addresses
 * (KASA_HOST or the test targets) get a shorter wait than a broadcast.
 */
export function discoverOptions(cfg: Config['camera'], targets?: string[]): DiscoverOptions {
  const to = targets ?? cfg.discoveryTargets;
  return {
    timeoutMs: to ? 1500 : 3000,
    ...(to ? { targets: to } : {}),
    ...(cfg.discoveryPort ? { port: cfg.discoveryPort } : {}),
  };
}

/** Discovered cameras that may receive the login: LAN addresses only, unless allowed. */
export async function discoverCameras(cfg: Config['camera']): Promise<DiscoveredDevice[]> {
  const found = await discover(discoverOptions(cfg, cfg.host ? [cfg.host] : undefined));
  return found.filter((d) => isCamera(d) && (cfg.allowPublicHost || isPrivateAddress(d.host)));
}

/**
 * Work out which IP to talk to. With KASA_HOST set, use it (after checking
 * it is a LAN address); otherwise broadcast discovery and pick the camera
 * by its saved name (KASA_ALIAS). When only one camera answers, it is used
 * even if its name changed.
 */
export async function locateCamera(
  cfg: Config['camera'],
  logger: Logger,
): Promise<{ host: string; device?: DiscoveredDevice }> {
  if (cfg.host) {
    const address = net.isIP(cfg.host) ? cfg.host : (await lookup(cfg.host)).address;
    if (!isPrivateAddress(address) && !cfg.allowPublicHost) {
      throw new CameraLocateError(
        `KASA_HOST ${cfg.host} resolves to ${address}, which is not a local-network address. ` +
          'Refusing to send camera credentials off the LAN (set KASA_ALLOW_PUBLIC_HOST=true to override).',
      );
    }
    // Unauthenticated sysinfo tells us the expected password encoding.
    const [device] = await discover(discoverOptions(cfg, [address])).catch(() => []);
    return { host: address, ...(device ? { device } : {}) };
  }

  logger.info('KASA_HOST not set; searching the network for Kasa cameras');
  const cameras = (await discover(discoverOptions(cfg))).filter(isCamera);
  if (cameras.length === 0) {
    throw new CameraLocateError(
      'No Kasa camera answered discovery. Make sure it is powered on and on the same network, or set KASA_HOST.',
    );
  }
  let chosen = cameras[0]!;
  if (cfg.alias) {
    const match = cameras.find((c) => c.alias.toLowerCase() === cfg.alias!.toLowerCase());
    if (!match && cameras.length === 1) {
      // Renamed in the Kasa app since it was saved. With one camera there is no doubt.
      logger.warn(
        { saved: cfg.alias, found: chosen.alias, host: chosen.host },
        'The camera has a new name; using the only camera found',
      );
    } else if (!match) {
      throw new CameraLocateError(
        `No camera named "${cfg.alias}". Found: ${cameras.map((c) => `${c.alias} (${c.host})`).join(', ')}`,
      );
    }
    if (match) chosen = match;
  } else if (cameras.length > 1) {
    logger.warn(
      { cameras: cameras.map((c) => ({ alias: c.alias, host: c.host })) },
      'Several cameras found; using the first. Set KASA_ALIAS or KASA_HOST to choose.',
    );
  }
  logger.info({ host: chosen.host, alias: chosen.alias, model: chosen.model }, 'Found camera');
  return { host: chosen.host, device: chosen };
}

/** Everything the web layer needs to know about one camera. */
export class Camera {
  readonly credentials: CameraCredentials;
  private _host: string;
  readonly linkie: LinkieClient;
  readonly source: CameraSource;
  readonly ptz: PtzController;
  private infoCache: { at: number; value: CameraInfo } | undefined;

  constructor(host: string, cfg: Config, logger: Logger, device?: DiscoveredDevice) {
    this._host = host;
    const cam = cfg.camera;
    if (!cam.username || !cam.password) {
      throw new CameraLocateError(
        'No camera login yet. Set KASA_USERNAME and KASA_PASSWORD in .env, or finish setup in the app.',
      );
    }
    this.credentials = new CameraCredentials(cam.username, cam.password, cam.passwordEncoding);
    this.credentials.applyCipherOptions(device?.sysinfo.c_opt);
    const tls = { pinnedSha256: cam.certSha256 };
    this.linkie = new LinkieClient({
      host,
      port: cam.apiPort,
      credentials: this.credentials,
      tls,
      logger: logger.child({ component: 'linkie' }),
    });
    this.source = new CameraSource({
      host,
      port: cam.streamPort,
      path: cam.streamPath,
      credentials: this.credentials,
      tls,
      logger: logger.child({ component: 'stream' }),
    });
    this.ptz = new PtzController({
      linkie: this.linkie,
      logger: logger.child({ component: 'ptz' }),
      enabled: cfg.ptz.enabled,
      stepSpeed: cfg.ptz.stepSpeed,
    });
    if (device) this.infoCache = { at: Date.now(), value: toCameraInfo(host, device.sysinfo) };
  }

  get host(): string {
    return this._host;
  }

  /** The camera moved to a new IP: point every client at it. */
  relocate(host: string, device?: DiscoveredDevice): void {
    this._host = host;
    this.linkie.setHost(host);
    this.source.setHost(host);
    this.infoCache = device
      ? { at: Date.now(), value: toCameraInfo(host, device.sysinfo) }
      : undefined;
  }

  /** Camera details, cached for a minute. */
  async info(maxAgeMs = 60_000): Promise<CameraInfo> {
    if (this.infoCache && Date.now() - this.infoCache.at < maxAgeMs) return this.infoCache.value;
    const sysinfo = await this.linkie.getSysinfo();
    const value = toCameraInfo(this.host, sysinfo);
    this.infoCache = { at: Date.now(), value };
    return value;
  }
}

export function toCameraInfo(host: string, s: CameraSysinfo): CameraInfo {
  return {
    kind: 'kasa',
    alias: String(s.alias ?? 'Kasa camera'),
    model: String(s.model ?? 'unknown'),
    firmware: String(s.sw_ver ?? 'unknown'),
    host,
    ...(typeof s.resolution === 'string' ? { resolution: s.resolution } : {}),
    ...(typeof s.rssi === 'number' ? { rssi: s.rssi } : {}),
    ...(typeof s.led_status === 'string' ? { ledOn: s.led_status === 'on' } : {}),
    ...(typeof s.camera_switch === 'string' ? { cameraOn: s.camera_switch === 'on' } : {}),
  };
}
