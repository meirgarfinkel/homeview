import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loginItems = vi.hoisted(() => ({
  get: vi.fn(() => ({ openAtLogin: false, wasOpenedAtLogin: false })),
  set: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getLoginItemSettings: loginItems.get, setLoginItemSettings: loginItems.set },
}));

const { getAutostart, linuxAutostartFile, setAutostart, startedAtLogin } =
  await import('../src/autostart.js');

const realPlatform = process.platform;
function onPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform });
}
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  loginItems.get.mockReset();
  loginItems.get.mockReturnValue({ openAtLogin: false, wasOpenedAtLogin: false });
  loginItems.set.mockReset();
});

describe('linuxAutostartFile', () => {
  it('writes a Linux autostart entry that starts hidden', () => {
    expect(linuxAutostartFile('/opt/Kasa Home/kasa-home')).toContain(
      'Exec="/opt/Kasa Home/kasa-home" --hidden',
    );
    expect(linuxAutostartFile('/x')).toContain('Name=Kasa Home');
  });

  it('escapes characters that are special inside a quoted Exec path', () => {
    expect(linuxAutostartFile('/home/a"b/$c')).toContain('Exec="/home/a\\"b/\\$c" --hidden');
  });
});

describe.runIf(process.platform === 'linux')('Linux autostart', () => {
  let config: string;
  const saved = process.env['XDG_CONFIG_HOME'];

  beforeEach(() => {
    config = mkdtempSync(path.join(tmpdir(), 'kasa-autostart-'));
    process.env['XDG_CONFIG_HOME'] = config;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = saved;
    rmSync(config, { recursive: true, force: true });
  });

  it('adds and removes the entry in the autostart folder', () => {
    const file = path.join(config, 'autostart', 'kasa-home.desktop');
    expect(getAutostart()).toBe(false);

    setAutostart(true);
    expect(getAutostart()).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('--hidden');

    setAutostart(false);
    expect(getAutostart()).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('turning it off when it is already off does nothing', () => {
    expect(() => setAutostart(false)).not.toThrow();
  });
});

describe.each(['darwin', 'win32'] as const)('autostart on %s', (platform) => {
  beforeEach(() => onPlatform(platform));

  it('uses a login item that starts hidden', () => {
    setAutostart(true);
    expect(loginItems.set).toHaveBeenLastCalledWith({ openAtLogin: true, args: ['--hidden'] });
    setAutostart(false);
    expect(loginItems.set).toHaveBeenLastCalledWith({ openAtLogin: false, args: ['--hidden'] });
  });

  it('reports the login item', () => {
    loginItems.get.mockReturnValue({ openAtLogin: true, wasOpenedAtLogin: false });
    expect(getAutostart()).toBe(true);
    expect(loginItems.get).toHaveBeenCalledWith({ args: ['--hidden'] });
  });
});

describe('startedAtLogin', () => {
  it('is true with --hidden on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      onPlatform(platform);
      expect(startedAtLogin(['app', '--hidden'])).toBe(true);
    }
  });

  it('is false for a launch by hand', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      onPlatform(platform);
      expect(startedAtLogin(['app'])).toBe(false);
    }
  });

  // macOS starts login items without their arguments.
  it('is true on macOS when the system opened it at login', () => {
    onPlatform('darwin');
    loginItems.get.mockReturnValue({ openAtLogin: true, wasOpenedAtLogin: true });
    expect(startedAtLogin(['app'])).toBe(true);
  });

  it('ignores the macOS-only flag elsewhere', () => {
    onPlatform('win32');
    loginItems.get.mockReturnValue({ openAtLogin: true, wasOpenedAtLogin: true });
    expect(startedAtLogin(['app'])).toBe(false);
  });
});
