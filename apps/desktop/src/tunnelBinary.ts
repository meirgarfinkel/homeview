import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Where the tunnel helper is: in the app's resources when installed, else in
 * the repo's build. Undefined when the file is not there, so the app runs on
 * without remote access.
 */
export function tunnelBinary(opts: {
  packaged: boolean;
  resourcesPath: string;
  appRoot: string;
  platform: NodeJS.Platform;
}): string | undefined {
  const name = opts.platform === 'win32' ? 'kasa-tunnel.exe' : 'kasa-tunnel';
  const osDir = opts.platform === 'win32' ? 'win' : opts.platform === 'darwin' ? 'mac' : 'linux';
  const file = opts.packaged
    ? path.join(opts.resourcesPath, 'tunnel', name)
    : path.join(opts.appRoot, '..', 'tunnel', 'bin', osDir, name);
  return existsSync(file) ? path.normalize(file) : undefined;
}
