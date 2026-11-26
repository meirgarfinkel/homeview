import type { Logger } from '../logger.js';
import { isPrivateAddress } from '../security/network.js';
import type { Camera } from './camera.js';
import { discover, isCamera, type DiscoveredDevice } from './discovery.js';
import { fetchFingerprint, normalizeFingerprint } from './tls.js';

/**
 * Follows the camera when its IP address changes (a new DHCP lease, a
 * router reboot), so nobody has to pin KASA_HOST.
 *
 * The camera is identified by the device ID (or MAC) it reported at startup.
 * Every `intervalMs`, and soon after the stream starts failing, a discovery
 * broadcast looks for that ID. If it answers from a new address, the
 * camera's TLS certificate there must match the one seen before. Discovery
 * replies are unauthenticated, so without that check any device on the
 * network could claim the ID and receive the camera login.
 */

export interface CameraWatcherOptions {
  camera: Camera;
  device: DiscoveredDevice;
  apiPort: number;
  logger: Logger;
  /** Fingerprint from KASA_CERT_SHA256; otherwise learned from the camera. */
  pinnedSha256?: string | undefined;
  allowPublicHost?: boolean;
  intervalMs?: number;
  /** Shortest gap between two checks. */
  minGapMs?: number;
  discoveryPort?: number;
  /** Where to send discovery (default: broadcast). For tests. */
  discoveryTargets?: string[];
  discoverTimeoutMs?: number;
}

export type WatchResult = 'unchanged' | 'moved' | 'not-found' | 'rejected';

export class CameraWatcher {
  private fingerprint: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastCheck = 0;
  private running: Promise<WatchResult> | undefined;
  private readonly onState: (state: string) => void;

  constructor(private readonly opts: CameraWatcherOptions) {
    this.fingerprint = opts.pinnedSha256 ? normalizeFingerprint(opts.pinnedSha256) : undefined;
    this.onState = (state) => {
      if (state === 'reconnecting' || state === 'error') void this.check();
    };
  }

  start(): void {
    void this.learnFingerprint();
    this.timer = setInterval(() => void this.check(true), this.opts.intervalMs ?? 60_000);
    this.timer.unref();
    this.opts.camera.source.on('state', this.onState);
  }

  stop(): void {
    clearInterval(this.timer);
    this.opts.camera.source.off('state', this.onState);
  }

  /** Look for the camera; switch to its new address if it moved. */
  check(force = false): Promise<WatchResult> {
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastCheck < (this.opts.minGapMs ?? 10_000)) {
      return Promise.resolve('unchanged');
    }
    this.lastCheck = Date.now();
    this.running = this.doCheck().finally(() => (this.running = undefined));
    return this.running;
  }

  private matches(d: DiscoveredDevice): boolean {
    const { deviceId, mac } = this.opts.device;
    if (deviceId) return d.deviceId === deviceId;
    return mac !== '' && d.mac.toLowerCase() === mac.toLowerCase();
  }

  private async doCheck(): Promise<WatchResult> {
    const { camera, logger } = this.opts;
    const found = (
      await discover({
        timeoutMs: this.opts.discoverTimeoutMs ?? 2500,
        ...(this.opts.discoveryPort ? { port: this.opts.discoveryPort } : {}),
        ...(this.opts.discoveryTargets ? { targets: this.opts.discoveryTargets } : {}),
      })
    )
      .filter(isCamera)
      .find((d) => this.matches(d));
    if (!found) return 'not-found';
    if (found.host === camera.host) {
      if (!this.fingerprint) await this.learnFingerprint();
      return 'unchanged';
    }

    const log = logger.child({ from: camera.host, to: found.host });
    if (!isPrivateAddress(found.host) && !this.opts.allowPublicHost) {
      log.warn('Camera answered from a non-local address; not switching');
      return 'rejected';
    }
    if (!this.fingerprint) {
      log.warn(
        'Camera seems to have moved, but its certificate was never recorded, so the new address ' +
          "can't be verified. Restart HomeView to accept it.",
      );
      return 'rejected';
    }
    let seen: string;
    try {
      seen = await fetchFingerprint(found.host, this.opts.apiPort);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Could not check the camera at its new address');
      return 'rejected';
    }
    if (seen !== this.fingerprint) {
      log.warn(
        'A device claiming to be the camera has a different certificate; not switching. ' +
          'If the camera was reset, restart HomeView.',
      );
      return 'rejected';
    }
    log.info('Camera moved to a new address; following it');
    camera.relocate(found.host, found);
    return 'moved';
  }

  private async learnFingerprint(): Promise<void> {
    if (this.fingerprint) return;
    try {
      this.fingerprint = await fetchFingerprint(this.opts.camera.host, this.opts.apiPort);
    } catch {
      // Unreachable right now; the next check tries again.
    }
  }
}
