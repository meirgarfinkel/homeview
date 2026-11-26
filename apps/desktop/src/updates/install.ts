/**
 * Updates, part two: putting a downloaded update in place, the way each kind of copy was
 * installed, and starting the new one. Modelled on HomePix's updater.
 */
import { execFile, spawn } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import type { InstallKind } from './release.js';

/** The outside programs the installers run, behind one seam so tests can stand in. */
export interface Runner {
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  spawnDetached(cmd: string, args: string[]): void;
  which(cmd: string): string | undefined;
  openPath(p: string): void;
}

export const defaultRunner: Runner = {
  run: (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr: stderr || (err && !stderr ? err.message : '') });
      });
    }),
  spawnDetached: (cmd, args) => {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  },
  which: (cmd) => {
    for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
      const full = path.join(dir, cmd);
      try {
        accessSync(full, constants.X_OK);
        return full;
      } catch {
        // not here
      }
    }
    return undefined;
  },
  openPath: (p) => {
    spawn('xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();
  },
};

/** The last line a failed program printed, for the message the person sees. */
function lastLine(text: string, fallback: string): string {
  return (
    text
      .trim()
      .split('\n')
      .filter((l) => l.trim())
      .at(-1) ?? fallback
  );
}

/** Put the new AppImage where this one is. A running AppImage can be replaced. */
export function replaceAppImage(newFile: string, appImage: string): void {
  chmodSync(newFile, 0o755);
  try {
    renameSync(newFile, appImage);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // On another drive: copy beside it, then swap.
    copyFileSync(newFile, `${appImage}.new`);
    chmodSync(`${appImage}.new`, 0o755);
    renameSync(`${appImage}.new`, appImage);
    rmSync(newFile, { force: true });
  }
}

/** The HomeView.app this program runs from (…/HomeView.app/Contents/MacOS/HomeView). */
export function macBundle(execPath: string): string {
  return path.resolve(execPath, '..', '..', '..');
}

const MOVE_FIRST = 'Move HomeView into the Applications folder first, and open it from there.';

/**
 * Copy HomeView.app out of the downloaded disk image and swap it in for this one. A running
 * app can be replaced; the new one starts on relaunch.
 */
export async function replaceMacApp(dmg: string, bundle: string, runner: Runner): Promise<void> {
  if (
    !bundle.endsWith('.app') ||
    bundle.includes('/AppTranslocation/') ||
    bundle.startsWith('/Volumes/')
  ) {
    throw new Error(MOVE_FIRST);
  }
  const mount = path.join(path.dirname(dmg), 'mounted');
  const fresh = `${bundle}.new`;
  const old = `${bundle}.old`;
  mkdirSync(mount, { recursive: true });
  const attach = await runner.run('hdiutil', [
    'attach',
    '-nobrowse',
    '-readonly',
    '-mountpoint',
    mount,
    dmg,
  ]);
  if (attach.code !== 0) throw new Error(lastLine(attach.stderr, "The update couldn't be opened."));
  try {
    rmSync(fresh, { recursive: true, force: true });
    const copy = await runner.run('ditto', [path.join(mount, 'HomeView.app'), fresh]);
    if (copy.code !== 0) {
      rmSync(fresh, { recursive: true, force: true });
      throw new Error(
        lastLine(copy.stderr, `Couldn't copy the new HomeView into ${path.dirname(bundle)}.`),
      );
    }
  } finally {
    await runner.run('hdiutil', ['detach', '-quiet', mount]);
  }
  rmSync(old, { recursive: true, force: true });
  renameSync(bundle, old);
  try {
    renameSync(fresh, bundle);
  } catch (err) {
    renameSync(old, bundle); // put this one back
    throw err;
  }
  rmSync(old, { recursive: true, force: true });
  rmSync(dmg, { force: true });
}

/**
 * Install the .deb. Linux asks for the password, then apt installs it. Without a way to ask
 * here, the software installer opens the file instead.
 */
export async function installDeb(file: string, runner: Runner): Promise<'installed' | 'opened'> {
  const pkexec = runner.which('pkexec');
  if (!pkexec) {
    runner.openPath(file);
    return 'opened';
  }
  const r = await runner.run(pkexec, ['apt-get', 'install', '-y', file]);
  // 126: the password prompt was closed; 127: not authorised.
  if (r.code === 126 || r.code === 127) throw new Error('The update was cancelled.');
  if (r.code !== 0)
    throw new Error(lastLine(r.stderr || r.stdout, "The package couldn't be installed."));
  rmSync(file, { force: true });
  return 'installed';
}

/**
 * Run the NSIS installer quietly. It closes this copy, updates it and opens the new one
 * (--force-run); --updated tells it this is an update, not a first install.
 */
export function startWindowsInstaller(file: string, runner: Runner): void {
  runner.spawnDetached(file, ['/S', '--updated', '--force-run']);
}

/** Start the new copy once this one has gone (one HomeView runs at a time). */
export function relaunch(
  kind: InstallKind,
  runner: Runner,
  paths: { execPath: string; appImage?: string },
): void {
  if (kind === 'mac') {
    runner.spawnDetached('sh', ['-c', 'sleep 1; exec open -n "$0"', macBundle(paths.execPath)]);
    return;
  }
  runner.spawnDetached('sh', ['-c', 'sleep 1; exec "$0"', paths.appImage ?? paths.execPath]);
}
