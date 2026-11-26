import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, dialog, Notification, shell } from 'electron';
import { pino } from 'pino';
import { loggerOptions, type Logger } from '../../server/src/logger.js';
import { ensureDataDir } from '../../server/src/security/dataDir.js';
import { startServer, type RunningServer } from '../../server/src/server.js';
import { SettingsStore } from '../../server/src/settings/store.js';
import { getAutostart, setAutostart, startedAtLogin } from './autostart.js';
import { reopenOnActivate, stopWithin } from './lifecycle.js';
import { keepLogSmall, openLogFile } from './logs.js';
import { safeStorageProtector } from './protector.js';
import { runSelfTest } from './selfTest.js';
import { createTray } from './tray.js';
import { tunnelBinary } from './tunnelBinary.js';
import { defaultRunner, MOVE_FIRST, macBundle, macCanUpdate } from './updates/install.js';
import { howInstalled } from './updates/release.js';
import { checkFromTray, Updater } from './updates/updater.js';

// Before anything reads userData, so settings land in a "HomeView" folder.
app.setName('HomeView');
// Windows shows notifications only for the ID the installer gave the Start menu shortcut.
if (process.platform === 'win32') app.setAppUserModelId('io.github.meirgarfinkel.homeview');
// There are no windows, so the GPU is never needed.
app.disableHardwareAcceleration();

let logger: Logger | undefined;
let started = false;

/**
 * Say what went wrong and exit. Running on without a server or tray would
 * hold the single instance lock, so opening the app again would do nothing.
 */
function fail(err: unknown): void {
  const title = started ? 'HomeView stopped because of an error' : 'HomeView could not start';
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

/** The tunnel helper next to the app, or in the repo's build. */
function helperPath(): string | undefined {
  return tunnelBinary({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    platform: process.platform,
  });
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
  let stopUpdates = () => {};
  const open = () => {
    if (running.server) void shell.openExternal(running.server.localUrl);
  };
  app.on('second-instance', open);
  // macOS doesn't start a second instance when the app is opened again; it activates this one.
  const reopen = reopenOnActivate(app, open);

  const quit = async () => {
    if (stopped) return;
    stopped = true;
    stopUpdates();
    const server = running.server;
    if (server) {
      await stopWithin(
        () => server.stop(),
        5000,
        (err) => {
          if (logger) logger.error({ err }, 'Could not stop HomeView cleanly');
          else console.error('Could not stop HomeView cleanly:', err);
        },
      );
    }
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

  const helper = helperPath();
  if (!helper) log.warn('The tunnel helper is missing, so remote access is not available');
  const kind = howInstalled({
    platform: process.platform,
    packaged: app.isPackaged,
    execPath: process.execPath,
    ...(process.env['APPIMAGE'] ? { appImage: process.env['APPIMAGE'] } : {}),
  });
  const paths = {
    execPath: process.execPath,
    ...(process.env['APPIMAGE'] ? { appImage: process.env['APPIMAGE'] } : {}),
  };
  // A copy run from source never updates itself, so it gets no update hooks or tray item.
  const updater = kind
    ? new Updater({
        kind,
        current: app.getVersion(),
        dir: path.join(userData, 'updates'),
        runner: { ...defaultRunner, openPath: (p) => void shell.openPath(p) },
        paths,
        quit: () => void quit(),
        ...(kind === 'mac' && !macCanUpdate(macBundle(process.execPath))
          ? { blocked: () => MOVE_FIRST }
          : {}),
        logger: {
          info: (m) => log.info(m),
          warn: (m) => log.warn(m),
          error: (m) => log.error(m),
        },
      })
    : undefined;
  const notify = (body: string) => new Notification({ title: 'HomeView', body }).show();
  let checkingUpdates = false;

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
      ...(updater
        ? {
            updateStatus: () => updater.status(),
            installUpdate: () => void updater.install(),
            checkForUpdates: () => updater.check(),
          }
        : {}),
    },
    desktop: true,
    logger: log,
    tunnel: helper ? { command: helper } : undefined,
    openExternal: (url) => void shell.openExternal(url),
  });
  running.server = server;

  const tray = createTray({
    localUrl: server.localUrl,
    open,
    getAutostart,
    setAutostart,
    showLogs: () => void shell.openPath(logFile),
    quit: () => void quit(),
    ...(updater
      ? {
          checkingUpdates: () => checkingUpdates,
          checkForUpdates: () =>
            void checkFromTray(updater, notify, (on) => {
              checkingUpdates = on;
              refreshTray();
            }),
        }
      : {}),
  });
  refreshTray = tray.refresh;
  if (updater) {
    updater.start();
    stopUpdates = () => updater.stop();
  }
  started = true;

  // A start at login stays in the tray.
  if (!startedAtLogin()) open();
  reopen.started();
}

if (process.argv.includes('--self-test')) {
  void runSelfTest(staticDir(), helperPath()).then((code) => app.exit(code));
} else {
  run().catch(fail);
}
