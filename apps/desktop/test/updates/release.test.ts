import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  download,
  fileFor,
  howInstalled,
  isNewer,
  latestRelease,
  versionOf,
  type Release,
  type ReleaseAsset,
} from '../../src/updates/release.js';

describe('howInstalled', () => {
  const base = { platform: 'linux' as NodeJS.Platform, packaged: true, execPath: '/usr/bin/x' };

  it('knows each kind of install', () => {
    expect(howInstalled({ ...base, platform: 'win32' })).toBe('windows');
    expect(howInstalled({ ...base, platform: 'darwin' })).toBe('mac');
    expect(howInstalled({ ...base, appImage: '/home/me/HomeView-x86_64.AppImage' })).toBe(
      'appimage',
    );
    expect(howInstalled({ ...base, execPath: '/opt/HomeView/homeview' })).toBe('deb');
  });

  it('never updates a copy run from source, or one it cannot place', () => {
    expect(howInstalled({ ...base, packaged: false, platform: 'win32' })).toBeUndefined();
    expect(howInstalled(base)).toBeUndefined();
  });
});

describe('versions', () => {
  it('reads a tag', () => {
    expect(versionOf('v1.2.3')).toEqual([1, 2, 3]);
    expect(versionOf('1.2.3')).toEqual([1, 2, 3]);
    expect(versionOf('v1.0.0-beta')).toEqual([]);
  });

  it('compares a release tag with this version', () => {
    expect(isNewer('v0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('v0.10.0', '0.9.0')).toBe(true);
    expect(isNewer('v0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('v0.0.9', '0.1.0')).toBe(false);
    expect(isNewer('v1.0.0-beta', '0.1.0')).toBe(false);
  });
});

describe('fileFor', () => {
  const asset = (name: string): ReleaseAsset => ({
    name,
    browser_download_url: `https://example.invalid/${name}`,
    size: 1,
  });
  const release: Release = {
    tag_name: 'v0.2.0',
    assets: [asset('HomeViewSetup.exe'), asset('HomeView.deb')],
  };

  it('picks the file for this kind of install', () => {
    expect(fileFor(release, 'windows')?.name).toBe('HomeViewSetup.exe');
    expect(fileFor(release, 'deb')?.name).toBe('HomeView.deb');
  });

  it('has nothing for a kind the release has no file for', () => {
    expect(fileFor(release, 'mac')).toBeUndefined();
  });
});

describe('latestRelease', () => {
  it('asks GitHub as HomeView and returns the release', async () => {
    let headers: Record<string, string> = {};
    const fake = (async (_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ tag_name: 'v0.2.0', assets: [] }));
    }) as typeof fetch;
    const release = await latestRelease('https://example.invalid/latest', fake);
    expect(release.tag_name).toBe('v0.2.0');
    expect(headers['User-Agent']).toBe('homeview');
  });

  it('fails on an error answer', async () => {
    const fake = (async () => new Response('nope', { status: 403 })) as typeof fetch;
    await expect(latestRelease('https://example.invalid/latest', fake)).rejects.toThrow(/403/);
  });
});

describe('download', () => {
  const body = Buffer.alloc(64 * 1024, 7);
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  let server: http.Server | undefined;
  let dir: string;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Serve `send` as the file; when it is short, 'drop' closes the connection, 'stall' goes quiet. */
  async function serve(send: Buffer, short: 'drop' | 'stall' = 'drop'): Promise<string> {
    dir = mkdtempSync(path.join(tmpdir(), 'homeview-dl-'));
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(body.length) });
      if (send.length === body.length) return res.end(send);
      res.write(send);
      if (short === 'drop') setTimeout(() => res.socket?.destroy(), 20);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/HomeView.deb`;
  }

  it('saves the file when its size and checksum match', async () => {
    const url = await serve(body);
    const dest = path.join(dir, 'HomeView.deb');
    const progress: number[] = [];
    await download(
      { name: 'HomeView.deb', browser_download_url: url, size: body.length, digest },
      dest,
      {
        onProgress: (done) => progress.push(done),
      },
    );
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(progress.at(-1)).toBe(body.length);
  });

  it('throws away a file whose checksum is wrong', async () => {
    const url = await serve(body);
    const dest = path.join(dir, 'HomeView.deb');
    const wrong = `sha256:${'0'.repeat(64)}`;
    await expect(
      download(
        { name: 'HomeView.deb', browser_download_url: url, size: body.length, digest: wrong },
        dest,
      ),
    ).rejects.toThrow('The download came through damaged. Please try again.');
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('throws away a download that was cut short', async () => {
    const url = await serve(body.subarray(0, 32 * 1024));
    const dest = path.join(dir, 'HomeView.deb');
    await expect(
      download(
        { name: 'HomeView.deb', browser_download_url: url, size: body.length, digest },
        dest,
      ),
    ).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('gives up on a download that stops arriving', async () => {
    const url = await serve(body.subarray(0, 32 * 1024), 'stall');
    const dest = path.join(dir, 'HomeView.deb');
    await expect(
      download(
        { name: 'HomeView.deb', browser_download_url: url, size: body.length, digest },
        dest,
        { stallMs: 200 },
      ),
    ).rejects.toThrow('The download stopped. Please try again.');
    expect(existsSync(`${dest}.part`)).toBe(false);
  });
});
