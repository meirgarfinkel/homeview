import { spawn } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { RemotePhase } from '@kasa/shared';
import { TunnelManager, type TunnelOptions } from '../src/remote/tunnel.js';
import { silentLogger, waitFor } from './helpers.js';

const FAKE = fileURLToPath(new URL('./fixtures/fakeTunnel.mjs', import.meta.url));
const PARENT = fileURLToPath(new URL('./fixtures/tunnelParent.ts', import.meta.url));
const READY = { event: { type: 'ready', url: 'https://homeview.example.ts.net' } };

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const managers: TunnelManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop();
  delete process.env['FAKE_TUNNEL_SCRIPT'];
  delete process.env['FAKE_TUNNEL_RECORD'];
});

interface Started {
  pid: number;
  argv: string[];
  secret: string;
}

/** A manager running the fake helper with this script. */
function manager(
  script: unknown[],
  opts: Partial<TunnelOptions> = {},
): { tunnel: TunnelManager; dir: string; starts: () => Started[]; phases: RemotePhase[] } {
  const dir = mkdtempSync(path.join(tmpdir(), 'kasa-tunnel-'));
  dirs.push(dir);
  const record = path.join(dir, 'starts.jsonl');
  process.env['FAKE_TUNNEL_SCRIPT'] = JSON.stringify(script);
  process.env['FAKE_TUNNEL_RECORD'] = record;
  const tunnel = new TunnelManager({
    command: process.execPath,
    args: [FAKE],
    stateDir: path.join(dir, 'tunnel'),
    targetPort: 4321,
    logger: silentLogger,
    ...opts,
  });
  managers.push(tunnel);
  const phases: RemotePhase[] = [];
  tunnel.on('change', () => {
    if (phases.at(-1) !== tunnel.phase()) phases.push(tunnel.phase());
  });
  const starts = () =>
    existsSync(record)
      ? readFileSync(record, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as Started)
      : [];
  return { tunnel, dir, starts, phases };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('TunnelManager', () => {
  it('follows the helper from sign-in through approval to on', async () => {
    const { tunnel, phases } = manager([
      { event: { type: 'login', url: 'https://login.tailscale.com/a/abc' } },
      { waitMs: 50 },
      { event: { type: 'enable', url: 'https://login.tailscale.com/f/funnel?node=n1' } },
      { waitMs: 50 },
      READY,
    ]);
    expect(tunnel.phase()).toBe('off');
    tunnel.start();
    expect(tunnel.phase()).toBe('starting');
    await waitFor(() => tunnel.phase() === 'sign-in');
    expect(tunnel.link()).toBe('https://login.tailscale.com/a/abc');
    await waitFor(() => tunnel.phase() === 'approve');
    expect(tunnel.link()).toBe('https://login.tailscale.com/f/funnel?node=n1');
    await waitFor(() => tunnel.phase() === 'on');
    expect(tunnel.url()).toBe('https://homeview.example.ts.net');
    expect(tunnel.host()).toBe('homeview.example.ts.net');
    expect(tunnel.link()).toBeUndefined();
    expect(phases).toEqual(['starting', 'sign-in', 'approve', 'on']);
  });

  it('ignores lines that are not events', async () => {
    const { tunnel } = manager([
      { event: 'not json at all' },
      { event: '{"type":"login"}' },
      { event: '[1,2,3]' },
      { event: { type: 'mystery', url: 'https://example.com' } },
      READY,
    ]);
    tunnel.start();
    await waitFor(() => tunnel.phase() === 'on');
    expect(tunnel.host()).toBe('homeview.example.ts.net');
  });

  it('restarts after the helper exits, then reports the problem', async () => {
    const { tunnel, starts, phases } = manager(
      [{ event: { type: 'error', message: 'Could not reach Tailscale.' } }, { exit: 1 }],
      { backoffMs: [10, 10] },
    );
    tunnel.start();
    await waitFor(() => tunnel.phase() === 'problem');
    expect(starts()).toHaveLength(3);
    expect(tunnel.message()).toBe('Could not reach Tailscale.');
    expect(phases).toEqual(['starting', 'problem']);
  });

  it('says the helper stopped when it gave no reason', async () => {
    const { tunnel } = manager([{ exit: 1 }], { backoffMs: [] });
    tunnel.start();
    await waitFor(() => tunnel.phase() === 'problem');
    expect(tunnel.message()).toBe('The connection helper stopped.');
  });

  it('starts over with a full set of retries once it was on', async () => {
    const { tunnel, starts } = manager([READY, { waitMs: 30 }, { exit: 1 }], {
      backoffMs: [10],
    });
    tunnel.start();
    // Each run reaches ready before it exits, so it never runs out of retries.
    await waitFor(() => starts().length >= 3);
    expect(tunnel.phase()).not.toBe('problem');
  });

  it('can be started again after a problem', async () => {
    const { tunnel, starts } = manager([{ exit: 1 }], { backoffMs: [] });
    tunnel.start();
    await waitFor(() => tunnel.phase() === 'problem');
    process.env['FAKE_TUNNEL_SCRIPT'] = JSON.stringify([READY]);
    tunnel.start();
    await waitFor(() => tunnel.phase() === 'on');
    expect(starts()).toHaveLength(2);
  });

  it('stop() turns it off and ends the helper', async () => {
    const { tunnel, starts } = manager([READY]);
    tunnel.start();
    await waitFor(() => tunnel.phase() === 'on');
    const [{ pid }] = starts() as [Started];
    expect(alive(pid)).toBe(true);
    await tunnel.stop();
    expect(tunnel.phase()).toBe('off');
    expect(tunnel.url()).toBeUndefined();
    expect(tunnel.host()).toBeUndefined();
    expect(alive(pid)).toBe(false);
  });

  it('kills a helper that ignores the request to stop', async () => {
    const { tunnel, starts } = manager([{ ignoreTerm: true }, READY], { killAfterMs: 100 });
    tunnel.start();
    await waitFor(() => tunnel.phase() === 'on');
    const [{ pid }] = starts() as [Started];
    await tunnel.stop();
    expect(alive(pid)).toBe(false);
    expect(tunnel.phase()).toBe('off');
  });

  it('does not restart a helper it stopped', async () => {
    const { tunnel, starts } = manager([READY], { backoffMs: [10] });
    tunnel.start();
    await waitFor(() => tunnel.phase() === 'on');
    await tunnel.stop();
    await new Promise((r) => setTimeout(r, 100));
    expect(starts()).toHaveLength(1);
    expect(tunnel.phase()).toBe('off');
  });

  it('passes the secret in the environment, never in the arguments', async () => {
    const { tunnel, dir, starts } = manager([READY]);
    tunnel.start();
    await waitFor(() => tunnel.phase() === 'on');
    const [run] = starts() as [Started];
    expect(tunnel.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(run.secret).toBe(tunnel.secret);
    expect(run.argv.join(' ')).not.toContain(tunnel.secret);
    expect(run.argv).toEqual([
      '--state-dir',
      path.join(dir, 'tunnel'),
      '--target',
      '127.0.0.1:4321',
      '--hostname',
      'homeview',
    ]);
  });

  it('makes a new secret each time it starts', async () => {
    const { tunnel } = manager([READY]);
    tunnel.start();
    const first = tunnel.secret;
    await tunnel.stop();
    tunnel.start();
    expect(tunnel.secret).not.toBe(first);
  });

  it('keeps its state folder owner-only', async () => {
    const { tunnel, dir } = manager([READY]);
    tunnel.start();
    await waitFor(() => tunnel.phase() === 'on');
    expect(statSync(path.join(dir, 'tunnel')).mode & 0o777).toBe(0o700);
  });

  it('ends the helper when the app is killed without a chance to clean up', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kasa-tunnel-'));
    dirs.push(dir);
    const record = path.join(dir, 'starts.jsonl');
    const parent = spawn(process.execPath, ['--import', 'tsx', PARENT, path.join(dir, 'tunnel')], {
      env: {
        ...process.env,
        FAKE_TUNNEL_SCRIPT: JSON.stringify([READY]),
        FAKE_TUNNEL_RECORD: record,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      let out = '';
      parent.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      await waitFor(() => out.includes('on'), 10_000);
      const { pid } = JSON.parse(readFileSync(record, 'utf8').trim()) as Started;
      expect(alive(pid)).toBe(true);
      // SIGKILL skips the exit handler, like a crash or a force quit.
      parent.kill('SIGKILL');
      await waitFor(() => !alive(pid), 5000);
    } finally {
      parent.kill('SIGKILL');
    }
  });

  it('signOut() stops the helper and removes its state', async () => {
    const { tunnel, dir } = manager([READY]);
    tunnel.start();
    await waitFor(() => tunnel.phase() === 'on');
    const state = path.join(dir, 'tunnel');
    mkdirSync(path.join(state, 'nested'), { recursive: true });
    writeFileSync(path.join(state, 'nested', 'tailscaled.state'), 'keys');
    await tunnel.signOut();
    expect(tunnel.phase()).toBe('off');
    expect(existsSync(state)).toBe(false);
  });
});
