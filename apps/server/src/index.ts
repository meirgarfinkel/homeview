import { ConfigError, resolveDataDir } from './config.js';
import { loadEnvFile } from './env.js';
import { CameraLocateError } from './kasa/camera.js';
import { PortsInUseError, startServer } from './server.js';
import { SettingsStore } from './settings/store.js';

async function main(): Promise<void> {
  loadEnvFile();
  const server = await startServer({ settings: new SettingsStore(resolveDataDir(process.env)) });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const force = setTimeout(() => process.exit(1), 5000).unref();
    await server.stop();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  if (
    err instanceof ConfigError ||
    err instanceof CameraLocateError ||
    err instanceof PortsInUseError
  ) {
    console.error(`\n${err.message}\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
