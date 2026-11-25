import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import readline from 'node:readline';
import { z } from 'zod';
import type { RemotePhase } from '@kasa/shared';
import type { Logger } from '../logger.js';
import { ensureDataDir } from '../security/dataDir.js';

export type TunnelEvent =
  | { type: 'login'; url: string }
  | { type: 'enable'; url: string }
  | { type: 'ready'; url: string }
  | { type: 'error'; message: string };

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('login'), url: z.string() }),
  z.object({ type: z.literal('enable'), url: z.string() }),
  z.object({ type: z.literal('ready'), url: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

function parseEvent(line: string): TunnelEvent | undefined {
  try {
    const parsed = eventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export interface TunnelOptions {
  /** The helper binary, or node for the test fake. */
  command: string;
  /** Arguments before the flags. The test fake uses its script path. */
  args?: string[];
  stateDir: string;
  /** The remote listener's port on 127.0.0.1. */
  targetPort: number;
  logger: Logger;
  /** Waits before each restart after the helper stops. Default 1 s, 5 s, 30 s. */
  backoffMs?: number[];
  /** How long the helper gets to exit after SIGTERM before SIGKILL. Default 3 s. */
  killAfterMs?: number;
}

const HOSTNAME = 'kasa-home';
const SECRET_ENV = 'KASA_TUNNEL_SECRET';
const STOPPED = 'The connection helper stopped.';

/**
 * Runs the kasa-tunnel helper and follows its events. While it is wanted, a
 * helper that exits is started again after a wait, and after the last wait
 * the phase becomes 'problem'. The helper doesn't watch its parent, so it is
 * always ended here: by stop(), or by a SIGKILL when this process exits.
 */
export class TunnelManager extends EventEmitter<{ change: [] }> {
  private currentSecret = '';
  private currentPhase: RemotePhase = 'off';
  private readyUrl: string | undefined;
  private currentLink: string | undefined;
  private lastError: string | undefined;
  private problem: string | undefined;
  private child: ChildProcess | undefined;
  private wanted = false;
  private failures = 0;
  private retry: NodeJS.Timeout | undefined;
  private readonly backoffMs: number[];
  private readonly killAfterMs: number;
  private readonly killOnExit = () => {
    this.child?.kill('SIGKILL');
  };

  constructor(private readonly opts: TunnelOptions) {
    super();
    this.backoffMs = opts.backoffMs ?? [1000, 5000, 30_000];
    this.killAfterMs = opts.killAfterMs ?? 3000;
  }

  /** What the helper must send in X-Kasa-Tunnel. 32 random bytes, new for each start(). */
  get secret(): string {
    return this.currentSecret;
  }

  phase(): RemotePhase {
    return this.currentPhase;
  }

  /** The public address, once the helper is ready. */
  url(): string | undefined {
    return this.readyUrl;
  }

  /** The public host name, from the ready event. */
  host(): string | undefined {
    if (!this.readyUrl) return undefined;
    try {
      return new URL(this.readyUrl).hostname;
    } catch {
      return undefined;
    }
  }

  /** Why the helper stopped, when the phase is 'problem'. */
  message(): string | undefined {
    return this.problem;
  }

  /** The sign-in or approve link the helper is waiting on. */
  link(): string | undefined {
    return this.currentLink;
  }

  /** Starts the helper. Does nothing while it is already wanted. */
  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.failures = 0;
    this.lastError = undefined;
    this.problem = undefined;
    this.currentSecret = randomBytes(32).toString('hex');
    this.launch();
  }

  /** Ends the helper: SIGTERM, then SIGKILL if it is still running after a while. */
  async stop(): Promise<void> {
    this.wanted = false;
    clearTimeout(this.retry);
    this.retry = undefined;
    const child = this.child;
    if (child) {
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => child.kill('SIGKILL'), this.killAfterMs);
        child.once('close', () => {
          clearTimeout(force);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    // start() may have run while the helper was exiting.
    if (!this.wanted) this.update('off');
  }

  /** Stops the helper and forgets the Tailscale login it kept in the state folder. */
  async signOut(): Promise<void> {
    await this.stop();
    await rm(this.opts.stateDir, { recursive: true, force: true });
  }

  private update(phase: RemotePhase, changes: { url?: string; link?: string } = {}): void {
    this.currentPhase = phase;
    this.readyUrl = changes.url;
    this.currentLink = changes.link;
    if (phase !== 'problem') this.problem = undefined;
    this.emit('change');
  }

  private launch(): void {
    this.update('starting');
    const { command, args = [], stateDir, targetPort, logger } = this.opts;
    let child: ChildProcess;
    try {
      ensureDataDir(stateDir);
      child = spawn(
        command,
        [
          ...args,
          '--state-dir',
          stateDir,
          '--target',
          `127.0.0.1:${targetPort}`,
          '--hostname',
          HOSTNAME,
        ],
        {
          // The secret goes in the environment, never on the command line.
          env: { ...process.env, [SECRET_ENV]: this.currentSecret },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Could not start the connection helper');
      this.stopped();
      return;
    }
    this.child = child;
    process.on('exit', this.killOnExit);

    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      if (this.child !== child) return;
      const event = parseEvent(line);
      if (event) this.handle(event);
    });
    readline.createInterface({ input: child.stderr! }).on('line', (line) => {
      logger.debug({ helper: line }, 'Connection helper output');
    });
    child.on('error', (err) => {
      logger.error({ err: err.message }, 'The connection helper failed');
    });
    child.once('close', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      process.off('exit', this.killOnExit);
      if (!this.wanted) return;
      logger.warn({ code, signal }, 'The connection helper stopped');
      this.stopped();
    });
  }

  private handle(event: TunnelEvent): void {
    switch (event.type) {
      case 'login':
        this.update('sign-in', { link: event.url });
        return;
      case 'enable':
        this.update('approve', { link: event.url });
        return;
      case 'ready':
        // A helper that got this far starts over with every retry.
        this.failures = 0;
        this.opts.logger.info({ url: event.url }, 'Remote access is on');
        this.update('on', { url: event.url });
        return;
      case 'error':
        this.lastError = event.message;
        this.opts.logger.warn({ message: event.message }, 'The connection helper had a problem');
        this.emit('change');
        return;
    }
  }

  /** The helper is gone while still wanted: wait and try again, or give up. */
  private stopped(): void {
    const wait = this.backoffMs[this.failures];
    if (wait === undefined) {
      this.wanted = false;
      this.problem = this.lastError ?? STOPPED;
      this.update('problem');
      return;
    }
    this.failures++;
    this.update('starting');
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.wanted) this.launch();
    }, wait);
    this.retry.unref();
  }
}
