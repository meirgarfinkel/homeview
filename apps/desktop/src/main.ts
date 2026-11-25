import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, shell } from 'electron';
import { pino } from 'pino';
import { loggerOptions, type Logger } from '../../server/src/logger.js';
import { ensureDataDir } from '../../server/src/security/dataDir.js';
import { startServer, type RunningServer } from '../../server/src/server.js';
import { SettingsStore } from '../../server/src/settings/store.js';
import { getAutostart, setAutostart, startedAtLogin } from './autostart.js';
import { keepLogSmall, openLogFile } from './logs.js';
import { safeStorageProtector } from './protector.js';
import { runSelfTest } from './selfTest.js';
import { createTray } from './tray.js';

// Before anything reads userData, so settings land in a "Kasa Home" folder.
app.setName('Kasa Home');
// There are no windows, so the GPU is never needed.
app.disableHardwareAcceleration();

let logger: Logger | undefined;
let started = false;

/**
 * Say what went wrong and exit. Running on without a server or tray would
 * hold the single instance lock, so opening the app again would do nothing.
 */
function fail(err: unknown): void {
  const title = started ? 'Kasa Home stopped because of an error' : 'Kasa Home could not start';
  if (logger) logger.fatal({ err }, title);
  else console.error(`${title}:`, err);
  dialog.showErrorBox(title, err instanceof Error ? err.message : String(err));
  app.exit(1);
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', (err) => {
  if (logger) logger.error({ err }, 'Unhandled promise rejection');
  else console.error('Unhandled promise rejection:', err);
});

/** The built web app: next to the app when installed, else the repo's build. */
function staticDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'web');
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
}

async function run(): Promise<void> {
  // Opening the app again reaches the running one through this lock.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.dock?.hide();

  // Set once the server is up. Quitting and opening come earlier, so they look here.
  const running: { server?: RunningServer } = {};
  // The tray comes after the server, which needs to tell it about changes.
  let refreshTray = () => {};
  let stopped = false;
  const open = () => {
    if (running.server) void shell.openExternal(running.server.localUrl);
  };
  app.on('second-instance', open);

  const quit = async () => {
    if (stopped) return;
    stopped = true;
    await running.server?.stop().catch(() => undefined);
    app.quit();
  };
  // Quitting from outside (a log out, say) stops the server first too.
  app.on('before-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    void quit();
  });

  await app.whenReady();
  const userData = ensureDataDir(app.getPath('userData'));
  const logFile = openLogFile(path.join(userData, 'logs'));
  // Written as it happens, so the lines just before a crash are kept.
  const dest = pino.destination({ dest: logFile, sync: true, mode: 0o600 });
  keepLogSmall(path.dirname(logFile), dest);
  const log = pino({ level: 'info', redact: loggerOptions('info').redact }, dest);
  logger = log;

  const server = await startServer({
    // Only these values: .env and the shell never change the installed app.
    env: { LOG_LEVEL: 'info' },
    settings: new SettingsStore(userData, safeStorageProtector(), log),
    dataDir: userData,
    staticDir: staticDir(),
    hooks: {
      getAutostart,
      setAutostart: (on) => {
        setAutostart(on);
        refreshTray();
      },
      quit: () => void quit(),
    },
    desktop: true,
    logger: log,
  });
  running.server = server;

  const tray = createTray({
    localUrl: server.localUrl,
    open,
    getAutostart,
    setAutostart,
    showLogs: () => void shell.openPath(logFile),
    quit: () => void quit(),
  });
  refreshTray = tray.refresh;
  started = true;

  // A start at login stays in the tray.
  if (!startedAtLogin()) open();
}

if (process.argv.includes('--self-test')) {
  void runSelfTest(staticDir()).then((code) => app.exit(code));
} else {
  run().catch(fail);
}
