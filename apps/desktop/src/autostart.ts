import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

const HIDDEN = '--hidden';

/** The autostart entry for Linux desktops, which Electron's login items don't cover. */
export function linuxAutostartFile(execPath: string): string {
  // Inside double quotes in Exec, these four characters need a backslash.
  const quoted = `"${execPath.replace(/["`$\\]/g, '\\$&')}"`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Kasa Home',
    'Comment=Watch your Kasa camera from any browser at home',
    `Exec=${quoted} ${HIDDEN}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function linuxAutostartPath(): string {
  const config = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(config, 'autostart', 'kasa-home.desktop');
}

export function getAutostart(): boolean {
  if (process.platform === 'linux') return existsSync(linuxAutostartPath());
  return app.getLoginItemSettings({ args: [HIDDEN] }).openAtLogin;
}

export function setAutostart(on: boolean): void {
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN] });
    return;
  }
  const file = linuxAutostartPath();
  if (!on) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  // An AppImage's own path changes each run; APPIMAGE is the file the user has.
  writeFileSync(file, linuxAutostartFile(process.env['APPIMAGE'] ?? process.execPath));
}

/**
 * True when the system started the app at login, so it should stay in the
 * tray. Windows and Linux pass --hidden; macOS starts login items without
 * their arguments but says so itself.
 */
export function startedAtLogin(argv: readonly string[] = process.argv): boolean {
  if (argv.includes(HIDDEN)) return true;
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
}
