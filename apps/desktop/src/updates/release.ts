/**
 * Updates, part one: is there a newer HomeView on GitHub, which of its files fits how this copy
 * was installed, and getting that file intact. Modelled on HomePix's updater.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export type InstallKind = 'windows' | 'mac' | 'appimage' | 'deb';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
  /** "sha256:<hex>", as GitHub reports it. */
  digest?: string;
}

export interface Release {
  tag_name: string;
  assets: ReleaseAsset[];
}

export const LATEST_RELEASE_URL =
  'https://api.github.com/repos/meirgarfinkel/homeview/releases/latest';

/** The release file each kind of install updates from. */
export const UPDATE_FILES: Record<InstallKind, string> = {
  windows: 'HomeViewSetup.exe',
  mac: 'HomeView.dmg',
  appimage: 'HomeView-x86_64.AppImage',
  deb: 'HomeView.deb',
};

/** Where the .deb puts the app. */
const DEB_DIR = '/opt/HomeView/';

/** How this copy was installed, or undefined when it can't update itself (run from source). */
export function howInstalled(env: {
  platform: NodeJS.Platform;
  packaged: boolean;
  execPath: string;
  appImage?: string;
}): InstallKind | undefined {
  if (!env.packaged) return undefined;
  if (env.platform === 'win32') return 'windows';
  if (env.platform === 'darwin') return 'mac';
  if (env.appImage) return 'appimage';
  return env.execPath.startsWith(DEB_DIR) ? 'deb' : undefined;
}

/** 'v1.2.3' → [1, 2, 3]; [] when it isn't a plain version (a beta, say). */
export function versionOf(tag: string): number[] {
  const parts = tag.replace(/^[vV]/, '').split('.');
  if (parts.some((p) => !/^\d+$/.test(p))) return [];
  return parts.map(Number);
}

export function isNewer(tag: string, current: string): boolean {
  const a = versionOf(tag);
  const b = versionOf(current);
  if (a.length === 0) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export function fileFor(release: Release, kind: InstallKind): ReleaseAsset | undefined {
  return release.assets.find((a) => a.name === UPDATE_FILES[kind]);
}

/** The newest published release, as GitHub describes it. */
export async function latestRelease(
  url = LATEST_RELEASE_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<Release> {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': 'homeview', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return (await res.json()) as Release;
}

const DAMAGED = 'The download came through damaged. Please try again.';
const STALLED = 'The download stopped. Please try again.';

/**
 * Download asset to dest, through a .part file, checked against the release's size and
 * checksum. Anything that doesn't match is deleted.
 */
export async function download(
  asset: ReleaseAsset,
  dest: string,
  opts: {
    signal?: AbortSignal;
    onProgress?(done: number, total: number): void;
    /** Give up when nothing arrives for this long. */
    stallMs?: number;
  } = {},
): Promise<void> {
  const part = `${dest}.part`;
  const hash = createHash('sha256');
  const stallMs = opts.stallMs ?? 60_000;
  const stall = new AbortController();
  let timer = setTimeout(() => stall.abort(), stallMs);
  const keepAlive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), stallMs);
  };
  const signal = opts.signal ? AbortSignal.any([opts.signal, stall.signal]) : stall.signal;
  let done = 0;
  try {
    const res = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'homeview' },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`The download answered ${res.status}`);
    const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
    body.on('data', (chunk: Buffer) => {
      keepAlive();
      hash.update(chunk);
      done += chunk.length;
      opts.onProgress?.(done, asset.size);
    });
    await pipeline(body, createWriteStream(part));
    const want = (asset.digest ?? '').replace(/^sha256:/, '');
    if (done !== asset.size || (want && hash.digest('hex') !== want)) throw new Error(DAMAGED);
    renameSync(part, dest);
  } catch (err) {
    rmSync(part, { force: true });
    throw stall.signal.aborted ? new Error(STALLED) : err;
  } finally {
    clearTimeout(timer);
  }
}
