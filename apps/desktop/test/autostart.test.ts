import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getLoginItemSettings: vi.fn(), setLoginItemSettings: vi.fn() },
}));

const { getAutostart, linuxAutostartFile, setAutostart } = await import('../src/autostart.js');

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
