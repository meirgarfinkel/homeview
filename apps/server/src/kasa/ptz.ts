import type { PtzCapability, PtzDirection, PtzPreset } from '@kasa/shared';
import { CameraAuthError, LinkieError, type LinkieClient } from './linkieClient.js';
import type { Logger } from '../logger.js';

/**
 * Pan/tilt control over LINKIE module `smartlife.cam.ipcamera.ptz`.
 *
 * Command shapes come from the Kasa Android app (LinkieCameraCommand$PanTiltZoomControl):
 *   set_move          {direction: "top"|"bottom"|"left"|"right"|..., speed: 1..10}
 *   set_stop          {}
 *   get_position      -> {x, y}
 *   set_target        {x, y}
 *   get_all_preset    -> {maximum, preset_attr: [{index, name, ...}]}
 *   set_run_to_preset {index: int}
 *
 * Measured on a KC410S:
 * - set_move is one fixed step (about 55 units at speed 2, 100 at speed 6).
 * - set_target moves smoothly (~450 units/s, any speed argument is ignored)
 *   and clamps a target past the edge to the end of travel.
 * - set_stop halts either at once.
 * - Every request needs a new TLS connection (the camera forces
 *   Connection: close). A handshake takes ~0.5 s and, while one runs, the
 *   camera answers nothing else for ~1.2 s, a stop included.
 *
 * So:
 *   step(dir)  one set_move at the step speed (a single tap).
 *   hold(dir)  one set_target at the far edge in that direction; the camera
 *              glides there and stops by itself at the end of travel.
 *   stop()     set_stop on a connection opened ahead of time and kept for
 *              stops only. Spare connections aren't replaced during a hold,
 *              so no handshake is running when the button is released.
 */

/** How long to keep spare connections ready after the last pan/tilt use. */
const WARM_MS = 20_000;

/** Further than the travel limit in any direction (KC410S: x ±1934, y ±387). */
const FAR = 99_999;

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
  /** Speed for a single tap (1-10). */
  stepSpeed: number;
  /** Stop a hold if the client hasn't repeated hold() within this window. */
  holdTimeoutMs?: number;
}

interface Position {
  x: number;
  y: number;
}

export type HoldEndReason = 'stopped' | 'released';

export class PtzController {
  private _capability: PtzCapability;
  private deadline: NodeJS.Timeout | undefined;
  private holdDirection: PtzDirection | undefined;
  private readonly holdTimeoutMs: number;
  /** Why the last hold ended; for logs and tests. */
  lastHoldEnd: HoldEndReason | undefined;

  constructor(private readonly opts: PtzControllerOptions) {
    this._capability = opts.enabled ? 'unknown' : 'disabled';
    this.holdTimeoutMs = opts.holdTimeoutMs ?? 1500;
  }

  get capability(): PtzCapability {
    return this._capability;
  }

  get holding(): PtzDirection | undefined {
    return this.holdDirection;
  }

  /** One step at the step speed. */
  async step(direction: PtzDirection): Promise<void> {
    this.assertUsable();
    this.opts.linkie.keepWarm(WARM_MS);
    if (this.holdDirection) await this.endHold('stopped');
    await this.sendMove(direction, this.opts.stepSpeed);
  }

  /**
   * Start (or keep) moving continuously. Clients repeat this every few
   * hundred ms while a button is held; if the repeats stop, motion stops.
   */
  async hold(direction: PtzDirection): Promise<void> {
    this.assertUsable();
    this.opts.linkie.keepWarm(WARM_MS);
    this.armDeadline();
    if (this.holdDirection === direction) return;
    this.holdDirection = direction;
    // Keep the spares as they are until the camera stops (see above).
    this.opts.linkie.pauseRefills(true);
    try {
      const at = await this.position();
      if (this.holdDirection !== direction) return; // released meanwhile
      await this.run(() =>
        this.opts.linkie.call(PTZ_MODULE, 'set_target', { ...edge(at, direction) }),
      );
      // Released while set_target was in flight: it may have landed after the stop.
      if (this.holdDirection !== direction) await this.sendStop();
    } catch (err) {
      if (this.holdDirection === direction) {
        this.holdDirection = undefined;
        clearTimeout(this.deadline);
        this.opts.linkie.pauseRefills(false);
      }
      throw err;
    }
  }

  /** Stop now. */
  async stop(): Promise<void> {
    this.assertUsable();
    if (this.holdDirection) {
      await this.endHold('stopped');
      return;
    }
    await this.sendStop();
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
    if (this.holdDirection) await this.endHold('stopped');
    await this.opts.linkie.call(PTZ_MODULE, 'set_run_to_preset', { index });
  }

  /** Stop any motion; used on shutdown. */
  async dispose(): Promise<void> {
    clearTimeout(this.deadline);
    if (this.holdDirection) await this.endHold('stopped').catch(() => undefined);
    this.opts.linkie.close();
  }

  private async endHold(reason: HoldEndReason): Promise<void> {
    clearTimeout(this.deadline);
    this.deadline = undefined;
    this.holdDirection = undefined;
    this.lastHoldEnd = reason;
    try {
      await this.sendStop();
    } finally {
      this.opts.linkie.pauseRefills(false);
    }
  }

  private async position(): Promise<Position> {
    const p = await this.run(() => this.opts.linkie.call(PTZ_MODULE, 'get_position', {}));
    return { x: Number(p['x']), y: Number(p['y']) };
  }

  /** set_stop skips the request queue and uses the connection kept for it. */
  private sendStop() {
    return this.run(() => this.opts.linkie.call(PTZ_MODULE, 'set_stop', {}, { urgent: true }));
  }

  private sendMove(direction: PtzDirection, speed: number) {
    return this.run(() =>
      this.opts.linkie.call(PTZ_MODULE, 'set_move', { direction: DIRECTION[direction], speed }),
    );
  }

  private armDeadline(): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      this.deadline = undefined;
      if (!this.holdDirection) return;
      this.opts.logger.debug('PTZ hold not renewed; stopping');
      this.endHold('released').catch((err) =>
        this.opts.logger.warn({ err: (err as Error).message }, 'PTZ auto-stop failed'),
      );
    }, this.holdTimeoutMs);
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

/** A target past the end of travel in one direction, keeping the other axis. */
function edge(at: Position, direction: PtzDirection): Position {
  switch (direction) {
    case 'left':
      return { x: -FAR, y: at.y };
    case 'right':
      return { x: FAR, y: at.y };
    case 'up':
      return { x: at.x, y: FAR };
    case 'down':
      return { x: at.x, y: -FAR };
  }
}
