import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../../src/updates/install.js';
import type { Release } from '../../src/updates/release.js';
import { checkMessage, Updater, type UpdaterOptions } from '../../src/updates/updater.js';

const release = (tag: string): Release => ({
  tag_name: tag,
  assets: [
    {
      name: 'HomeView-x86_64.AppImage',
      browser_download_url: 'https://example.invalid/a',
      size: 3,
    },
  ],
});

const runner: Runner = {
  run: async () => ({ code: 0, stdout: '', stderr: '' }),
  spawnDetached: () => undefined,
  which: () => undefined,
  openPath: () => undefined,
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'homeview-updater-'));
  vi.clearAllMocks();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(over: Partial<UpdaterOptions> = {}) {
  const quit = vi.fn();
  const download = vi.fn(async (_asset: unknown, dest: string) => writeFileSync(dest, 'new'));
  const installers = {
    replaceAppImage: vi.fn(),
    relaunch: vi.fn(),
    startWindowsInstaller: vi.fn(),
    replaceMacApp: vi.fn(async () => undefined),
    installDeb: vi.fn(async () => 'installed' as const),
  };
  const updater = new Updater({
    kind: 'appimage',
    current: '0.1.0',
    dir,
    runner,
    paths: { execPath: '/tmp/.mount/homeview', appImage: '/home/me/HomeView-x86_64.AppImage' },
    quit,
    logger,
    latest: async () => release('v0.2.0'),
    download,
    installers,
    ...over,
  });
  return { updater, quit, download, installers };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe('Updater.check', () => {
  it('downloads a newer release, then has it ready', async () => {
    const { updater } = make();
    const seen: string[] = [];
    updater.on('change', (s) => seen.push(s.state));
    expect(await updater.check()).toBe('downloading');
    await settled();
    expect(updater.status()).toEqual({ state: 'ready', version: '0.2.0' });
    expect(seen).toEqual(['downloading', 'ready']);
  });

  it('is up to date when the release is this version', async () => {
    const { updater, download } = make({ latest: async () => release('v0.1.0') });
    expect(await updater.check()).toBe('up-to-date');
    expect(updater.status()).toEqual({ state: 'none' });
    expect(download).not.toHaveBeenCalled();
  });

  it('is up to date when the release has no file for this kind', async () => {
    const { updater } = make({ kind: 'mac' });
    expect(await updater.check()).toBe('up-to-date');
  });

  it('never updates a copy run from source', async () => {
    const { updater } = make({ kind: undefined });
    expect(await updater.check()).toBe('not-installed');
  });

  it('shows why a download failed', async () => {
    const { updater } = make({
      download: vi.fn(async () => {
        throw new Error('The download came through damaged. Please try again.');
      }),
    });
    await updater.check();
    await settled();
    expect(updater.status()).toEqual({
      state: 'error',
      message: 'The download came through damaged. Please try again.',
    });
  });

  it('downloads once when checked twice at the same time', async () => {
    const { updater, download } = make();
    const [a, b] = await Promise.all([updater.check(), updater.check()]);
    await settled();
    expect([a, b]).toEqual(['downloading', 'downloading']);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('a quiet check that fails stays quiet and logs it', async () => {
    const { updater } = make({
      latest: async () => {
        throw new Error('offline');
      },
    });
    await expect(updater.check({ quiet: true })).rejects.toThrow('offline');
    expect(updater.status()).toEqual({ state: 'none' });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('Updater.install', () => {
  async function ready(over: Partial<UpdaterOptions> = {}) {
    const made = make(over);
    await made.updater.check();
    await settled();
    return made;
  }

  it('swaps the AppImage, starts the new one and quits', async () => {
    const { updater, installers, quit } = await ready();
    await updater.install();
    expect(installers.replaceAppImage).toHaveBeenCalledWith(
      path.join(dir, 'HomeView-x86_64.AppImage'),
      '/home/me/HomeView-x86_64.AppImage',
    );
    expect(installers.relaunch).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('runs the Windows installer and quits, leaving the restart to it', async () => {
    const { updater, installers, quit } = await ready({
      kind: 'windows',
      latest: async () => ({
        tag_name: 'v0.2.0',
        assets: [
          { name: 'HomeViewSetup.exe', browser_download_url: 'https://x.invalid/s', size: 3 },
        ],
      }),
    });
    await updater.install();
    expect(installers.startWindowsInstaller).toHaveBeenCalledTimes(1);
    expect(installers.relaunch).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('installs once when Restart is pressed twice', async () => {
    const { updater, installers, quit } = await ready();
    await Promise.all([updater.install(), updater.install()]);
    expect(installers.replaceAppImage).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('does nothing without an update ready', async () => {
    const { updater, installers, quit } = make();
    await updater.install();
    expect(installers.replaceAppImage).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('shows why installing failed and keeps running', async () => {
    const { updater, quit } = await ready({
      kind: 'mac',
      latest: async () => ({
        tag_name: 'v0.2.0',
        assets: [{ name: 'HomeView.dmg', browser_download_url: 'https://x.invalid/d', size: 3 }],
      }),
      installers: {
        replaceMacApp: vi.fn(async () => {
          throw new Error(
            'Move HomeView into the Applications folder first, and open it from there.',
          );
        }),
      },
    });
    await updater.install();
    expect(updater.status()).toEqual({
      state: 'error',
      message: 'Move HomeView into the Applications folder first, and open it from there.',
    });
    expect(quit).not.toHaveBeenCalled();
  });

  it('keeps running when the .deb opened in the software installer', async () => {
    const { updater, quit } = await ready({
      kind: 'deb',
      latest: async () => ({
        tag_name: 'v0.2.0',
        assets: [{ name: 'HomeView.deb', browser_download_url: 'https://x.invalid/d', size: 3 }],
      }),
      installers: { installDeb: vi.fn(async () => 'opened' as const) },
    });
    await updater.install();
    expect(quit).not.toHaveBeenCalled();
    expect(updater.status()).toEqual({ state: 'none' });
  });
});

describe('Updater.start', () => {
  it('checks a minute after start, then every day', async () => {
    vi.useFakeTimers();
    try {
      const latest = vi.fn(async () => release('v0.1.0'));
      const { updater } = make({ latest });
      updater.start();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(latest).toHaveBeenCalledTimes(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(latest).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(latest).toHaveBeenCalledTimes(2);
      updater.stop();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      expect(latest).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('checkMessage', () => {
  it('says what a check found, for the tray notification', () => {
    expect(checkMessage('up-to-date', { state: 'none' })).toBe('HomeView is up to date.');
    expect(checkMessage('downloading', { state: 'downloading', version: '0.2.0' })).toBe(
      'Downloading HomeView 0.2.0…',
    );
    expect(checkMessage('ready', { state: 'ready', version: '0.2.0' })).toBe(
      'HomeView 0.2.0 is ready. Open HomeView to restart into it.',
    );
  });
});
