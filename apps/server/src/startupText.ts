import { ConfigError } from './config.js';
import { CameraLocateError } from './kasa/camera.js';
import { PortsInUseError } from './server.js';

/**
 * What `pnpm start` prints in the terminal. The desktop app never shows
 * these: they name settings in .env.
 */

/** One line for a server started with nothing set up yet. */
export function notSetUpText(localUrl: string): string {
  return (
    `HomeView is not set up yet. Open ${localUrl} on this computer to set it up, ` +
    'or set VIEWER_PASSWORD (and KASA_USERNAME and KASA_PASSWORD for the camera) in .env and restart.'
  );
}

/** The text for a startup error meant for the person, or undefined for a bug. */
export function terminalErrorText(err: unknown): string | undefined {
  if (err instanceof PortsInUseError) {
    return `${err.message.replace(/\.$/, '')}, or set PORT in .env to a free port.`;
  }
  if (err instanceof ConfigError || err instanceof CameraLocateError) return err.message;
  return undefined;
}
