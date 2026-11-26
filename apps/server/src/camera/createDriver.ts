import type { Config } from '../config.js';
import { locateCamera } from '../kasa/camera.js';
import type { DiscoveredDevice } from '../kasa/discovery.js';
import type { Logger } from '../logger.js';
import type { CameraDriver } from './driver.js';
import { KasaDriver } from './kasaDriver.js';

/** Where the camera is. `device` is what Kasa discovery said about it. */
export type Located = { host: string; device?: DiscoveredDevice };

/** Find the configured camera on the network. */
export async function locate(config: Config, logger: Logger): Promise<Located> {
  return locateCamera(config.camera, logger);
}

/** The driver for the configured camera, at a place `locate` found. */
export function createDriver(config: Config, logger: Logger, located: Located): CameraDriver {
  return new KasaDriver(config, logger, located);
}
