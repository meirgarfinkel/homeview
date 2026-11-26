import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tunnelBinary } from '../src/tunnelBinary.js';

describe('tunnelBinary', () => {
  let root: string;
  let resourcesPath: string;
  let appRoot: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'kasa-tunnel-bin-'));
    resourcesPath = path.join(root, 'resources');
    appRoot = path.join(root, 'desktop');
    mkdirSync(appRoot, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const touch = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    return file;
  };

  it('finds the packaged helper on Windows', () => {
    const file = touch(path.join(resourcesPath, 'tunnel', 'kasa-tunnel.exe'));
    expect(tunnelBinary({ packaged: true, resourcesPath, appRoot, platform: 'win32' })).toBe(file);
  });

  it('finds the packaged helper on macOS and Linux', () => {
    const file = touch(path.join(resourcesPath, 'tunnel', 'kasa-tunnel'));
    for (const platform of ['darwin', 'linux'] as const) {
      expect(tunnelBinary({ packaged: true, resourcesPath, appRoot, platform })).toBe(file);
    }
  });

  it('finds the helper in the repo build when not packaged', () => {
    const cases = [
      ['linux', 'linux', 'kasa-tunnel'],
      ['win32', 'win', 'kasa-tunnel.exe'],
      ['darwin', 'mac', 'kasa-tunnel'],
    ] as const;
    for (const [platform, dir, name] of cases) {
      const file = touch(path.join(root, 'tunnel', 'bin', dir, name));
      expect(tunnelBinary({ packaged: false, resourcesPath, appRoot, platform })).toBe(file);
    }
  });

  it('gives undefined when the file is missing', () => {
    expect(
      tunnelBinary({ packaged: true, resourcesPath, appRoot, platform: 'linux' }),
    ).toBeUndefined();
    expect(
      tunnelBinary({ packaged: false, resourcesPath, appRoot, platform: 'win32' }),
    ).toBeUndefined();
  });
});
