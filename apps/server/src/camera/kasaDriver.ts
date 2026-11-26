import type { CameraInfo } from '@kasa/shared';
import type { Config } from '../config.js';
import { Camera } from '../kasa/camera.js';
import { CameraWatcher } from '../kasa/cameraWatcher.js';
import type { DiscoveredDevice } from '../kasa/discovery.js';
import { syncTimeZone } from '../kasa/timeZone.js';
import type { Logger } from '../logger.js';
import type { CameraDriver, FrameSource, PtzControl } from './driver.js';
import type { Located } from './createDriver.js';

const TIME_ZONE_CHECK_MS = 60 * 60 * 1000;

/** A Kasa camera: the stream, pan/tilt over Linkie, following and clock sync. */
export class KasaDriver implements CameraDriver {
  readonly kind = 'kasa' as const;
  /** The Kasa client, for the Kasa-only setup and settings code. */
  readonly camera: Camera;
  /** What discovery said about the camera, kept so a reload can reuse it. */
  readonly device: DiscoveredDevice | undefined;
  private watcher: CameraWatcher | undefined;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    located: Located,
  ) {
    this.device = located.device;
    this.camera = new Camera(located.host, config, logger, located.device);
  }

  get host(): string {
    return this.camera.host;
  }

  get source(): FrameSource {
    return this.camera.source;
  }

  get ptz(): PtzControl {
    return this.camera.ptz;
  }

  info(maxAgeMs?: number): Promise<CameraInfo> {
    return this.camera.info(maxAgeMs);
  }

  start(): void {
    const { config, logger, camera, device } = this;
    // Check credentials early so a typo shows up in the log right away.
    camera.info(0).then(
      (info) => logger.info({ alias: info.alias, model: info.model }, 'Camera credentials OK'),
      (err: Error) => logger.error({ err: err.message }, 'Could not query the camera'),
    );

    // Follow the camera if its address changes, unless KASA_HOST pins it.
    if (!config.camera.host && device) {
      this.watcher = new CameraWatcher({
        camera,
        device,
        apiPort: config.camera.apiPort,
        pinnedSha256: config.camera.certSha256,
        allowPublicHost: config.camera.allowPublicHost,
        ...(config.camera.discoveryPort ? { discoveryPort: config.camera.discoveryPort } : {}),
        ...(config.camera.discoveryTargets
          ? { discoveryTargets: config.camera.discoveryTargets }
          : {}),
        logger: logger.child({ component: 'locate' }),
      });
      this.watcher.start();
    }

    // Keep the camera's clock (and its on-screen timestamp) in this time zone.
    const zone = config.camera.timeZone;
    if (zone) {
      const sync = () =>
        syncTimeZone(camera.linkie, zone, logger).catch((err: Error) =>
          logger.warn({ err: err.message }, "Could not check the camera's time zone"),
        );
      void sync();
      this.timers.push(setInterval(() => void sync(), TIME_ZONE_CHECK_MS).unref());
    }
  }

  async dispose(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.watcher?.stop();
    this.watcher = undefined;
    await this.camera.ptz.dispose();
  }
}
