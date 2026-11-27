import type { Config } from '../config.js';
import type { Settings } from './store.js';

/**
 * The size to save as the camera's default, when a Kasa camera is streaming at its default and
 * that size isn't saved yet. The camera reports only its top size, so this is the only way to
 * learn what its default is.
 */
export function defaultSizeToSave(
  config: Config,
  saved: Settings,
  width: number,
  height: number,
): string | undefined {
  if (config.camera.kind !== 'kasa' || config.camera.streamResolution !== undefined)
    return undefined;
  const size = `${width}x${height}`;
  return saved.cameraDefaultSize === size ? undefined : size;
}
