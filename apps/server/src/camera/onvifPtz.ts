/** Pan/tilt for ONVIF cameras, shaped like the Kasa controller. */
import type { PtzCapability, PtzDirection, PtzPreset } from '@kasa/shared';
import { LinkieError } from '../kasa/linkieClient.js';
import type { Logger } from '../logger.js';
import type { OnvifDevice } from '../onvif/device.js';
import { OnvifFaultError } from '../onvif/soap.js';
import type { PtzControl } from './driver.js';

const HOLD_SPEED = 0.5;
const STEP_DISTANCE = 0.1;
const STEP_FALLBACK_MS = 300;
/** Same as the Kasa controller: stop a hold the page stopped repeating. */
const HOLD_TIMEOUT_MS = 1500;

const VECTOR: Record<PtzDirection, [number, number]> = {
  up: [0, 1],
  down: [0, -1],
  left: [-1, 0],
  right: [1, 0],
};

export interface OnvifPtzOptions {
  /** The current device; following the camera can replace it. */
  device: () => OnvifDevice;
  profileToken: string;
  logger: Logger;
  holdTimeoutMs?: number;
}

export class OnvifPtz implements PtzControl {
  readonly capability: PtzCapability = 'supported';
  private holdDirection: PtzDirection | undefined;
  private deadline: NodeJS.Timeout | undefined;
  /** Learned on the first step: does the camera take RelativeMove? */
  private relative: boolean | undefined;
  /** Preset tokens in camera order, from the last presets() call. */
  private tokens: string[] | undefined;

  constructor(private readonly opts: OnvifPtzOptions) {}

  private get device(): OnvifDevice {
    return this.opts.device();
  }

  async step(direction: PtzDirection): Promise<void> {
    if (this.holdDirection) await this.stop();
    const [x, y] = VECTOR[direction];
    const token = this.opts.profileToken;
    if (this.relative !== false) {
      try {
        await this.device.relativeMove(token, x * STEP_DISTANCE, y * STEP_DISTANCE);
        this.relative = true;
        return;
      } catch (err) {
        if (!(err instanceof OnvifFaultError) || this.relative === true) throw err;
        this.relative = false;
      }
    }
    await this.device.continuousMove(token, x * HOLD_SPEED, y * HOLD_SPEED);
    await new Promise((r) => setTimeout(r, STEP_FALLBACK_MS));
    await this.device.stop(token);
  }

  async hold(direction: PtzDirection): Promise<void> {
    this.armDeadline();
    if (this.holdDirection === direction) return;
    this.holdDirection = direction;
    const [x, y] = VECTOR[direction];
    try {
      await this.device.continuousMove(this.opts.profileToken, x * HOLD_SPEED, y * HOLD_SPEED);
    } catch (err) {
      if (this.holdDirection === direction) {
        this.holdDirection = undefined;
        clearTimeout(this.deadline);
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    clearTimeout(this.deadline);
    this.deadline = undefined;
    this.holdDirection = undefined;
    await this.device.stop(this.opts.profileToken);
  }

  async presets(): Promise<PtzPreset[]> {
    let list: { token: string; name: string }[];
    try {
      list = await this.device.presets(this.opts.profileToken);
    } catch (err) {
      // Presets are optional; a camera without them still pans.
      if (err instanceof OnvifFaultError) return [];
      throw err;
    }
    this.tokens = list.map((p) => p.token);
    return list.map((p, index) => ({ index, name: p.name || `Preset ${index + 1}` }));
  }

  async goToPreset(index: number): Promise<void> {
    if (!this.tokens) await this.presets();
    const token = this.tokens?.[index];
    if (token === undefined)
      throw new LinkieError(`There is no preset ${index + 1} on this camera`, -1);
    if (this.holdDirection) await this.stop();
    await this.device.gotoPreset(this.opts.profileToken, token);
  }

  async dispose(): Promise<void> {
    clearTimeout(this.deadline);
    if (this.holdDirection) await this.stop().catch(() => undefined);
  }

  private armDeadline(): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => {
      this.deadline = undefined;
      if (!this.holdDirection) return;
      this.opts.logger.debug('PTZ hold not renewed; stopping');
      this.stop().catch((err: Error) =>
        this.opts.logger.warn({ err: err.message }, 'PTZ auto-stop failed'),
      );
    }, this.opts.holdTimeoutMs ?? HOLD_TIMEOUT_MS);
  }
}
