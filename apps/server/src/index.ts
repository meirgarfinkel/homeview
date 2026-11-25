import { resolveDataDir } from './config.js';
import { loadEnvFile } from './env.js';
import { startServer } from './server.js';
import { SettingsStore } from './settings/store.js';
import { notSetUpText, terminalErrorText } from './startupText.js';

async function main(): Promise<void> {
  loadEnvFile();
  const server = await startServer({ settings: new SettingsStore(resolveDataDir(process.env)) });
  if (!server.setupComplete()) console.log(`\n${notSetUpText(server.localUrl)}\n`);

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
  const text = terminalErrorText(err);
  if (text) console.error(`\n${text}\n`);
  else console.error(err);
  process.exit(1);
});
