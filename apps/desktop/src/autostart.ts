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

const LAUNCH_AGENT_LABEL = 'io.github.meirgarfinkel.kasahome';

const xml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The per-user LaunchAgent for macOS. Electron's login items can't be used
 * there: macOS starts them without their arguments, and macOS 13 and later
 * don't report wasOpenedAtLogin, so a start at login would open the browser.
 * launchd passes --hidden like the other systems.
 */
export function macLaunchAgent(execPath: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(execPath)}</string>`,
    `    <string>${HIDDEN}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function macLaunchAgentPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

/** The file that starts the app at login on Linux and macOS. Windows uses a login item. */
function autostartFile(): { path: string; text: () => string } | undefined {
  if (process.platform === 'linux') {
    // An AppImage's own path changes each run; APPIMAGE is the file the user has.
    const exec = process.env['APPIMAGE'] ?? process.execPath;
    return { path: linuxAutostartPath(), text: () => linuxAutostartFile(exec) };
  }
  if (process.platform === 'darwin') {
    // The executable inside the .app bundle.
    return { path: macLaunchAgentPath(), text: () => macLaunchAgent(process.execPath) };
  }
  return undefined;
}

export function getAutostart(): boolean {
  const file = autostartFile();
  if (file) return existsSync(file.path);
  return app.getLoginItemSettings({ args: [HIDDEN] }).openAtLogin;
}

export function setAutostart(on: boolean): void {
  const file = autostartFile();
  if (!file) {
    app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN] });
    return;
  }
  if (!on) {
    rmSync(file.path, { force: true });
    return;
  }
  mkdirSync(path.dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.text());
}

/** True when the system started the app at login (with --hidden), so it should stay in the tray. */
export function startedAtLogin(argv: readonly string[] = process.argv): boolean {
  return argv.includes(HIDDEN);
}
