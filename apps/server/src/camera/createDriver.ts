import type { Config } from '../config.js';
import { locateCamera } from '../kasa/camera.js';
import type { DiscoveredDevice } from '../kasa/discovery.js';
import type { Logger } from '../logger.js';
import type { CameraDriver } from './driver.js';
import { KasaDriver } from './kasaDriver.js';
import { OnvifDriver } from './onvifDriver.js';

/** Where the camera is. `device` is what Kasa discovery said about it. */
export type Located = { host: string; device?: DiscoveredDevice };

/**
 * Find the configured camera on the network. A standard camera is where its
 * settings say; its driver follows it from there, so no search runs here.
 */
export async function locate(config: Config, logger: Logger): Promise<Located> {
  if (config.camera.kind === 'onvif') {
    if (!config.camera.onvif) throw new Error('The camera is not set up');
    return { host: config.camera.onvif.host };
  }
  return locateCamera(config.camera, logger);
}

/** The driver for the configured camera, at a place `locate` found. */
export async function createDriver(
  config: Config,
  logger: Logger,
  located: Located,
): Promise<CameraDriver> {
  const { camera } = config;
  if (camera.kind === 'onvif') {
    if (!camera.onvif) throw new Error('The camera is not set up');
    return OnvifDriver.create(
      { ...camera.onvif, host: located.host },
      {
        allowPublicHost: camera.allowPublicHost,
        logger: logger.child({ component: 'camera' }),
        ...(camera.discoveryTargets ? { discovery: { targets: camera.discoveryTargets } } : {}),
      },
    );
  }
  return new KasaDriver(config, logger, located);
}
