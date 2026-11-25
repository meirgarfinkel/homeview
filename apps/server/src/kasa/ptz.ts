import type { PtzCapability, PtzDirection, PtzPreset } from '@kasa/shared';
import { CameraAuthError, LinkieError, type LinkieClient } from './linkieClient.js';
import type { Logger } from '../logger.js';

/**
 * Pan/tilt control over LINKIE module `smartlife.cam.ipcamera.ptz`.
 *
 * Command shapes come from the Kasa Android app (LinkieCameraCommand$PanTiltZoomControl):
 *   set_move          {direction: "top"|"bottom"|"left"|"right"|"top left"|..., speed: int}
 *   set_stop          {}
 *   get_position      -> {x, y}
 *   set_target        {x, y}
 *   get_all_preset    -> {maximum, preset_attr: [{index, name, ...}]}
 *   set_run_to_preset {index: int}
 *
 * set_move starts continuous motion, so every move is paired with a
 * server-side deadline that sends set_stop even if the browser never does
 * (closed tab, dropped Wi-Fi).
 */

export const PTZ_MODULE = 'ptz';

const DIRECTION: Record<PtzDirection, string> = {
  up: 'top',
  down: 'bottom',
  left: 'left',
  right: 'right',
};

/** err_codes that mean "this camera has no such module/method". */
const NOT_SUPPORTED_CODES = new Set([-1, -2, -40106, -40210]);

export class PtzUnsupportedError extends Error {
  constructor() {
    super('This camera does not support pan/tilt');
    this.name = 'PtzUnsupportedError';
  }
}

export interface PtzControllerOptions {
  linkie: LinkieClient;
  logger: Logger;
  enabled: boolean;
  speed: number;
  /** Stop automatically if no further move arrives within this window. */
  moveTimeoutMs?: number;
}

export class PtzController {
  private _capability: PtzCapability;
  private stopTimer: NodeJS.Timeout | undefined;
  private moving: PtzDirection | undefined;
  private readonly moveTimeoutMs: number;

  constructor(private readonly opts: PtzControllerOptions) {
    this._capability = opts.enabled ? 'unknown' : 'disabled';
    this.moveTimeoutMs = opts.moveTimeoutMs ?? 1500;
  }

  get capability(): PtzCapability {
    return this._capability;
  }

  /**
   * Start (or keep) moving in a direction. Clients repeat this every few
   * hundred ms while a button is held; motion stops when they call stop()
   * or stop repeating.
   */
  async move(direction: PtzDirection): Promise<void> {
    this.assertUsable();
    this.armDeadline();
    if (this.moving === direction) return;
    this.moving = direction;
    try {
      await this.run(() =>
        this.opts.linkie.call(PTZ_MODULE, 'set_move', {
          direction: DIRECTION[direction],
          speed: this.opts.speed,
        }),
      );
    } catch (err) {
      this.moving = undefined;
      clearTimeout(this.stopTimer);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.assertUsable();
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    this.moving = undefined;
    await this.run(() => this.opts.linkie.call(PTZ_MODULE, 'set_stop', {}));
  }

  async presets(): Promise<PtzPreset[]> {
    this.assertUsable();
    let reply: Record<string, unknown>;
    try {
      reply = await this.opts.linkie.call(PTZ_MODULE, 'get_all_preset', {});
    } catch (err) {
      // Presets are optional; a camera without any shouldn't disable pan/tilt.
      if (err instanceof LinkieError) return [];
      throw err;
    }
    const list = Array.isArray(reply['preset_attr']) ? reply['preset_attr'] : [];
    return list
      .map((p: Record<string, unknown>) => ({
        index: Number(p['index']),
        name: String(p['name'] ?? `Preset ${String(p['index'])}`),
      }))
      .filter((p) => Number.isInteger(p.index));
  }

  async goToPreset(index: number): Promise<void> {
    this.assertUsable();
    await this.opts.linkie.call(PTZ_MODULE, 'set_run_to_preset', { index });
  }

  /** Stop any motion; used on shutdown. */
  async dispose(): Promise<void> {
    clearTimeout(this.stopTimer);
    if (this.moving) await this.stop().catch(() => undefined);
  }

  private armDeadline(): void {
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.stopTimer = undefined;
      if (!this.moving) return;
      this.opts.logger.debug('PTZ move deadline passed; stopping');
      this.stop().catch((err) =>
        this.opts.logger.warn({ err: (err as Error).message }, 'PTZ auto-stop failed'),
      );
    }, this.moveTimeoutMs);
  }

  private assertUsable(): void {
    if (this._capability === 'disabled' || this._capability === 'unsupported') {
      throw new PtzUnsupportedError();
    }
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      if (this._capability === 'unknown') this._capability = 'supported';
      return result;
    } catch (err) {
      if (err instanceof LinkieError && NOT_SUPPORTED_CODES.has(err.errCode)) {
        this.opts.logger.warn({ err: err.message }, 'Camera rejected PTZ command; disabling PTZ');
        this._capability = 'unsupported';
        throw new PtzUnsupportedError();
      }
      if (!(err instanceof CameraAuthError)) {
        this.opts.logger.warn({ err: (err as Error).message }, 'PTZ command failed');
      }
      throw err;
    }
  }
}
