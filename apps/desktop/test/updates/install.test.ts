import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultRunner,
  installDeb,
  macBundle,
  macCanUpdate,
  relaunch,
  replaceAppImage,
  replaceMacApp,
  startWindowsInstaller,
  type Runner,
} from '../../src/updates/install.js';

/** A Runner that records every call and answers from `answers`. */
function fakeRunner(
  answers: Partial<Record<string, (args: string[]) => number>> = {},
  found: Record<string, string> = {},
) {
  const calls: { cmd: string; args: string[]; detached?: boolean }[] = [];
  const opened: string[] = [];
  const runner: Runner = {
    async run(cmd, args) {
      calls.push({ cmd, args });
      const code = answers[cmd]?.(args) ?? 0;
      return { code, stdout: '', stderr: code ? `line one\n${cmd} said no` : '' };
    },
    async spawnDetached(cmd, args) {
      calls.push({ cmd, args, detached: true });
    },
    which: (cmd) => found[cmd],
    openPath: (p) => void opened.push(p),
  };
  return { runner, calls, opened };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'homeview-install-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('replaceAppImage', () => {
  it('puts the new AppImage where this one is, ready to run', () => {
    const here = path.join(dir, 'HomeView-x86_64.AppImage');
    const fresh = path.join(dir, 'updates', 'HomeView-x86_64.AppImage');
    mkdirSync(path.dirname(fresh));
    writeFileSync(here, 'old');
    writeFileSync(fresh, 'new');
    replaceAppImage(fresh, here);
    expect(readFileSync(here, 'utf8')).toBe('new');
    expect(statSync(here).mode & 0o777).toBe(0o755);
    expect(existsSync(fresh)).toBe(false);
  });
});

describe('macBundle', () => {
  it('finds the .app from the program inside it', () => {
    expect(macBundle('/Applications/HomeView.app/Contents/MacOS/HomeView')).toBe(
      '/Applications/HomeView.app',
    );
  });
});

describe('macCanUpdate', () => {
  it('only updates an app that was moved out of the disk image', () => {
    expect(macCanUpdate('/Applications/HomeView.app')).toBe(true);
    expect(macCanUpdate('/Users/me/Applications/HomeView.app')).toBe(true);
    expect(macCanUpdate('/Volumes/HomeView/HomeView.app')).toBe(false);
    expect(macCanUpdate('/private/var/folders/x/AppTranslocation/y/d/HomeView.app')).toBe(false);
    expect(macCanUpdate('/Users/me/Downloads/HomeView')).toBe(false);
  });
});

describe('defaultRunner.spawnDetached', () => {
  it('fails, instead of crashing HomeView, when the program cannot start', async () => {
    await expect(
      defaultRunner.spawnDetached(path.join(dir, 'no-such-installer'), []),
    ).rejects.toThrow();
  });
});

describe('replaceMacApp', () => {
  function setup() {
    const bundle = path.join(dir, 'Applications', 'HomeView.app');
    mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
    writeFileSync(path.join(bundle, 'old-marker'), '');
    const dmg = path.join(dir, 'HomeView.dmg');
    writeFileSync(dmg, '');
    return { bundle, dmg };
  }

  it('copies the new app out of the disk image and swaps it in', async () => {
    const { bundle, dmg } = setup();
    const { runner, calls } = fakeRunner({
      ditto: (args) => {
        mkdirSync(args[1]!, { recursive: true });
        writeFileSync(path.join(args[1]!, 'new-marker'), '');
        return 0;
      },
    });
    await replaceMacApp(dmg, bundle, runner);
    expect(existsSync(path.join(bundle, 'new-marker'))).toBe(true);
    expect(existsSync(path.join(bundle, 'old-marker'))).toBe(false);
    expect(existsSync(`${bundle}.old`)).toBe(false);
    expect(calls.map((c) => c.cmd)).toEqual(['hdiutil', 'ditto', 'hdiutil']);
    expect(calls[0]!.args.slice(0, 4)).toEqual(['attach', '-nobrowse', '-readonly', '-mountpoint']);
    expect(calls[1]!.args[0]!.endsWith('/HomeView.app')).toBe(true);
    expect(calls[2]!.args.slice(0, 2)).toEqual(['detach', '-quiet']);
  });

  it('asks to move the app first when it runs from the disk image', async () => {
    const { runner, calls } = fakeRunner();
    for (const bundle of [
      '/Volumes/HomeView/HomeView.app',
      '/private/var/folders/x/AppTranslocation/y/d/HomeView.app',
      '/Users/me/Downloads/HomeView',
    ]) {
      await expect(replaceMacApp(path.join(dir, 'HomeView.dmg'), bundle, runner)).rejects.toThrow(
        'Move HomeView into the Applications folder first, and open it from there.',
      );
    }
    expect(calls).toEqual([]);
  });

  it('leaves this app alone when the copy fails, and still detaches', async () => {
    const { bundle, dmg } = setup();
    const { runner, calls } = fakeRunner({ ditto: () => 1 });
    await expect(replaceMacApp(dmg, bundle, runner)).rejects.toThrow('ditto said no');
    expect(existsSync(path.join(bundle, 'old-marker'))).toBe(true);
    expect(calls.at(-1)!.args.slice(0, 2)).toEqual(['detach', '-quiet']);
  });
});

describe('installDeb', () => {
  it('opens the package in the software installer when it cannot ask for the password', async () => {
    const { runner, opened } = fakeRunner();
    expect(await installDeb('/tmp/HomeView.deb', runner)).toBe('opened');
    expect(opened).toEqual(['/tmp/HomeView.deb']);
  });

  it('installs with apt through pkexec', async () => {
    const { runner, calls } = fakeRunner({}, { pkexec: '/usr/bin/pkexec' });
    expect(await installDeb('/tmp/HomeView.deb', runner)).toBe('installed');
    expect(calls[0]).toEqual({
      cmd: '/usr/bin/pkexec',
      args: ['apt-get', 'install', '-y', '/tmp/HomeView.deb'],
    });
  });

  it('says the update was cancelled when the password prompt is closed', async () => {
    const { runner } = fakeRunner({ '/usr/bin/pkexec': () => 126 }, { pkexec: '/usr/bin/pkexec' });
    await expect(installDeb('/tmp/HomeView.deb', runner)).rejects.toThrow(
      'The update was cancelled.',
    );
  });

  it("passes on apt's last line when it fails", async () => {
    const { runner } = fakeRunner({ '/usr/bin/pkexec': () => 100 }, { pkexec: '/usr/bin/pkexec' });
    await expect(installDeb('/tmp/HomeView.deb', runner)).rejects.toThrow(
      '/usr/bin/pkexec said no',
    );
  });
});

describe('startWindowsInstaller', () => {
  it('runs the installer quietly and has it open HomeView after', async () => {
    const { runner, calls } = fakeRunner();
    await startWindowsInstaller('C:\\u\\HomeViewSetup.exe', runner);
    expect(calls).toEqual([
      { cmd: 'C:\\u\\HomeViewSetup.exe', args: ['/S', '--updated', '--force-run'], detached: true },
    ]);
  });
});

describe('relaunch', () => {
  // Wait for this copy (pid 4242) to be gone: the new one can't start while it holds the lock.
  const WAIT = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; ';

  it('opens the Mac app the Mac way, once this copy has quit', async () => {
    const { runner, calls } = fakeRunner();
    await relaunch(
      'mac',
      runner,
      { execPath: '/Applications/HomeView.app/Contents/MacOS/HomeView' },
      4242,
    );
    expect(calls[0]).toEqual({
      cmd: 'sh',
      args: ['-c', `${WAIT}exec open -n "$0"`, '/Applications/HomeView.app', '4242'],
      detached: true,
    });
  });

  it('starts the AppImage file, not the unpacked program, once this copy has quit', async () => {
    const { runner, calls } = fakeRunner();
    await relaunch(
      'appimage',
      runner,
      { execPath: '/tmp/.mount_x/homeview', appImage: '/home/me/HV.AppImage' },
      4242,
    );
    expect(calls[0]!.args).toEqual(['-c', `${WAIT}exec "$0"`, '/home/me/HV.AppImage', '4242']);
  });

  it('the wait really waits for the process to exit', async () => {
    const { execFile } = await import('node:child_process');
    const marker = path.join(dir, 'started');
    const sleeper = (await import('node:child_process')).spawn('sleep', ['0.6']);
    const started = Date.now();
    await new Promise<void>((resolve, reject) =>
      execFile('sh', ['-c', `${WAIT}exec touch "$0"`, marker, String(sleeper.pid)], (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    expect(existsSync(marker)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });
});
