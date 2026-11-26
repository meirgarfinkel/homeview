import type { Config } from '../config.js';
import { locateCamera } from '../kasa/camera.js';
import type { DiscoveredDevice } from '../kasa/discovery.js';
import type { Logger } from '../logger.js';
import type { CameraDriver } from './driver.js';
import { KasaDriver } from './kasaDriver.js';
import { OnvifUnreachableError } from '../onvif/soap.js';
import { findCamera, OnvifDriver, type CameraPlace } from './onvifDriver.js';

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

/**
 * The driver for the configured camera, at a place `locate` found. A
 * standard camera that doesn't answer at its saved address is looked for on
 * the network by its identity; onMoved hears where it was found.
 */
export async function createDriver(
  config: Config,
  logger: Logger,
  located: Located,
  hooks: { onMoved?: (place: CameraPlace) => void } = {},
): Promise<CameraDriver> {
  const { camera } = config;
  if (camera.kind === 'onvif') {
    if (!camera.onvif) throw new Error('The camera is not set up');
    const opts = {
      allowPublicHost: camera.allowPublicHost,
      logger: logger.child({ component: 'camera' }),
      discovery: onvifDiscovery(config),
      ...(hooks.onMoved ? { onMoved: hooks.onMoved } : {}),
    };
    const saved = { ...camera.onvif, host: located.host };
    try {
      return await OnvifDriver.create(saved, opts);
    } catch (err) {
      if (!(err instanceof OnvifUnreachableError) || saved.rtspUrl) throw err;
      const found = await findCamera(saved, opts);
      if (!found) throw err;
      logger.info({ from: saved.host, to: found.host }, 'Found the camera at a new address');
      const place = { host: found.host, onvifPort: found.onvifPort };
      const driver = await OnvifDriver.create({ ...saved, ...place }, opts);
      hooks.onMoved?.({ ...place, ...(found.endpointId ? { endpointId: found.endpointId } : {}) });
      return driver;
    }
  }
  return new KasaDriver(config, logger, located);
}

/** Where ONVIF discovery probes go: the multicast group, or the test targets. */
export function onvifDiscovery(config: Config): { targets?: string[]; port?: number } {
  const { discoveryTargets, onvifDiscoveryPort } = config.camera;
  return {
    ...(discoveryTargets ? { targets: discoveryTargets } : {}),
    ...(onvifDiscoveryPort ? { port: onvifDiscoveryPort } : {}),
  };
}
