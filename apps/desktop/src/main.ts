import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, shell } from 'electron';
import { pino } from 'pino';
import { loggerOptions } from '../../server/src/logger.js';
import { ensureDataDir } from '../../server/src/security/dataDir.js';
import { startServer, type RunningServer } from '../../server/src/server.js';
import { SettingsStore } from '../../server/src/settings/store.js';
import { getAutostart, setAutostart } from './autostart.js';
import { openLogFile } from './logs.js';
import { safeStorageProtector } from './protector.js';
import { runSelfTest } from './selfTest.js';
import { createTray } from './tray.js';

// Before anything reads userData, so settings land in a "Kasa Home" folder.
app.setName('Kasa Home');

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

  let server: RunningServer | undefined;
  // The tray comes after the server, which needs to tell it about changes.
  let refreshTray = () => {};
  let stopped = false;
  const open = () => {
    if (server) void shell.openExternal(server.localUrl);
  };
  app.on('second-instance', open);

  const quit = async () => {
    if (stopped) return;
    stopped = true;
    await server?.stop().catch(() => undefined);
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
  const logger = pino(
    { level: 'info', redact: loggerOptions('info').redact },
    pino.destination(logFile),
  );

  try {
    server = await startServer({
      // Only these values: .env and the shell never change the installed app.
      env: { LOG_LEVEL: 'info' },
      settings: new SettingsStore(userData, safeStorageProtector(), logger),
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
      logger,
    });
  } catch (err) {
    logger.error({ err }, 'Kasa Home could not start');
    dialog.showErrorBox('Kasa Home could not start', (err as Error).message);
    stopped = true;
    app.quit();
    return;
  }

  const tray = createTray({
    localUrl: server.localUrl,
    open,
    getAutostart,
    setAutostart,
    showLogs: () => void shell.openPath(logFile),
    quit: () => void quit(),
  });
  refreshTray = tray.refresh;

  // A start at login passes --hidden and stays in the tray.
  if (!process.argv.includes('--hidden')) open();
}

if (process.argv.includes('--self-test')) {
  void runSelfTest(staticDir()).then((code) => app.exit(code));
} else {
  void run();
}
