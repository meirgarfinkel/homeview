/**
 * Updates, part three: checks GitHub once a day, downloads a newer HomeView in the background and
 * installs it when asked. Modelled on HomePix's updater.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import * as defaults from './install.js';
import type { Runner } from './install.js';
import {
  download as realDownload,
  fileFor,
  isNewer,
  latestRelease,
  UPDATE_FILES,
  versionOf,
  type InstallKind,
  type Release,
} from './release.js';

/** Same shape as UpdateStatus in @kasa/shared, which this package doesn't depend on. */
export type UpdateStatus =
  | { state: 'none' }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

export type CheckResult = 'up-to-date' | 'downloading' | 'ready' | 'not-installed';

interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

type Installers = Pick<
  typeof defaults,
  'replaceAppImage' | 'replaceMacApp' | 'installDeb' | 'startWindowsInstaller' | 'relaunch'
>;

export interface UpdaterOptions {
  kind: InstallKind | undefined;
  current: string;
  /** Where downloads go. */
  dir: string;
  runner: Runner;
  paths: { execPath: string; appImage?: string };
  quit(): void;
  logger: Logger;
  latest?: () => Promise<Release>;
  download?: typeof realDownload;
  /** Stand-ins for the installers, for tests. */
  installers?: Partial<Installers>;
}

const FIRST_CHECK_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class Updater extends EventEmitter<{ change: [UpdateStatus] }> {
  private state: UpdateStatus = { state: 'none' };
  private checking: Promise<CheckResult> | undefined;
  private installing = false;
  private timers: NodeJS.Timeout[] = [];
  private readonly installers: Installers;

  constructor(private readonly opts: UpdaterOptions) {
    super();
    this.installers = { ...defaults, ...opts.installers };
  }

  status(): UpdateStatus {
    return this.state;
  }

  private set(s: UpdateStatus): void {
    this.state = s;
    this.emit('change', s);
  }

  /** Look for a newer release and start downloading it. Two checks at once share one. */
  check(opts: { quiet?: boolean } = {}): Promise<CheckResult> {
    this.checking ??= this.runCheck(opts).finally(() => (this.checking = undefined));
    return this.checking;
  }

  private async runCheck(opts: { quiet?: boolean }): Promise<CheckResult> {
    const { kind } = this.opts;
    if (!kind) return 'not-installed';
    if (this.state.state === 'ready') return 'ready';
    if (this.state.state === 'downloading') return 'downloading';
    let release: Release;
    try {
      release = await (this.opts.latest ?? (() => latestRelease()))();
    } catch (err) {
      if (opts.quiet) this.opts.logger.warn(`Update check failed: ${(err as Error).message}`);
      throw err;
    }
    const asset = fileFor(release, kind);
    if (!asset || !isNewer(release.tag_name, this.opts.current)) return 'up-to-date';
    const version = versionOf(release.tag_name).join('.');
    this.set({ state: 'downloading', version });
    mkdirSync(this.opts.dir, { recursive: true });
    (this.opts.download ?? realDownload)(asset, this.file(kind))
      .then(() => {
        this.opts.logger.info(`HomeView ${version} is downloaded`);
        this.set({ state: 'ready', version });
      })
      .catch((err: Error) => {
        this.opts.logger.warn(`Update download failed: ${err.message}`);
        this.set({ state: 'error', message: err.message });
      });
    return 'downloading';
  }

  private file(kind: InstallKind): string {
    return path.join(this.opts.dir, UPDATE_FILES[kind]);
  }

  /** Put the downloaded update in place and restart into it. */
  async install(): Promise<void> {
    const { kind, runner, paths } = this.opts;
    if (!kind || this.state.state !== 'ready' || this.installing) return;
    this.installing = true; // stays set once HomeView is quitting into the new copy
    const file = this.file(kind);
    const i = this.installers;
    try {
      if (kind === 'windows') {
        i.startWindowsInstaller(file, runner); // it starts the new copy itself
        this.opts.quit();
        return;
      }
      if (kind === 'appimage') i.replaceAppImage(file, paths.appImage ?? paths.execPath);
      if (kind === 'mac') await i.replaceMacApp(file, defaults.macBundle(paths.execPath), runner);
      if (kind === 'deb' && (await i.installDeb(file, runner)) === 'opened') {
        this.installing = false;
        this.set({ state: 'none' }); // the software installer takes it from here
        return;
      }
      i.relaunch(kind, runner, paths);
      this.opts.quit();
    } catch (err) {
      this.opts.logger.error(`Update install failed: ${(err as Error).message}`);
      this.installing = false;
      this.set({ state: 'error', message: (err as Error).message });
    }
  }

  /** Check a minute after start, then once a day. */
  start(): void {
    const run = () => void this.check({ quiet: true }).catch(() => undefined);
    this.timers.push(
      setTimeout(() => {
        run();
        this.timers.push(setInterval(run, DAY_MS));
      }, FIRST_CHECK_MS),
    );
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

/** What a tray check found, as a notification line. */
export function checkMessage(result: CheckResult, s: UpdateStatus): string {
  if (result === 'ready' && s.state === 'ready') {
    return `HomeView ${s.version} is ready. Open HomeView to restart into it.`;
  }
  if (s.state === 'downloading') return `Downloading HomeView ${s.version}…`;
  return 'HomeView is up to date.';
}
