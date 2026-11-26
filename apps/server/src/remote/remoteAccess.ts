import path from 'node:path';
import type { RemoteStatus } from '@kasa/shared';
import type { RemoteGateDeps } from '../app.js';
import type { Logger } from '../logger.js';
import { DeviceStore } from './devices.js';
import { PairAttempts, PairingCodes } from './pairing.js';
import { TunnelManager, type TunnelOptions } from './tunnel.js';

/** The only links openLink() will hand to the system browser. */
const TAILSCALE_LOGIN = 'https://login.tailscale.com/';

/**
 * Remote access as a whole: the switch, the paired devices, pairing codes
 * and the tunnel helper. One lives for the whole server run, so a reload
 * never restarts the helper.
 */
export class RemoteAccess implements RemoteGateDeps {
  readonly devices: DeviceStore;
  readonly pairing = new PairingCodes();
  readonly pairAttempts = new PairAttempts();
  /** True when there is a helper to run, which means the desktop app. */
  readonly available: boolean;
  private tunnel: TunnelManager | undefined;
  private readonly dataDir: string;
  private readonly tunnelOptions: Omit<TunnelOptions, 'stateDir' | 'targetPort'> | undefined;
  private readonly openExternal: ((url: string) => void) | undefined;

  constructor(opts: {
    dataDir: string;
    tunnel?: Omit<TunnelOptions, 'stateDir' | 'targetPort'>;
    logger: Logger;
    openExternal?: (url: string) => void;
  }) {
    this.dataDir = opts.dataDir;
    this.devices = new DeviceStore(opts.dataDir, opts.logger);
    this.tunnelOptions = opts.tunnel;
    this.available = opts.tunnel !== undefined;
    this.openExternal = opts.openExternal;
  }

  /** Points the helper at the remote listener, and starts it if remote access was left on. */
  attach(targetPort: number): void {
    if (!this.tunnelOptions || this.tunnel) return;
    this.tunnel = new TunnelManager({
      ...this.tunnelOptions,
      stateDir: path.join(this.dataDir, 'tunnel'),
      targetPort,
    });
    if (this.devices.enabled) this.tunnel.start();
  }

  status(): RemoteStatus {
    const phase = this.tunnel?.phase() ?? 'off';
    const url = phase === 'on' ? this.tunnel?.url() : undefined;
    const message = phase === 'problem' ? this.tunnel?.message() : undefined;
    return {
      available: this.available,
      enabled: this.devices.enabled,
      phase,
      ...(url ? { url } : {}),
      ...(message ? { message } : {}),
      devices: this.devices.list(),
    };
  }

  /** Saves the switch and starts or stops the helper. Turning on needs the helper. */
  async setEnabled(on: boolean): Promise<void> {
    if (on && !this.available) throw new Error('Remote access needs the Kasa Home app');
    this.devices.setEnabled(on);
    if (on) this.tunnel?.start();
    else await this.tunnel?.stop();
  }

  /** Opens the sign-in or approve link in the browser. False if there is none to open. */
  openLink(): boolean {
    const link = this.tunnel?.link();
    if (!link?.startsWith(TAILSCALE_LOGIN) || !this.openExternal) return false;
    this.openExternal(link);
    return true;
  }

  /** Where a phone goes to pair with this code, while remote access is on. */
  pairUrl(code: string): string | undefined {
    if (this.tunnel?.phase() !== 'on') return undefined;
    const url = this.tunnel.url();
    return url ? `${url}/pair#${code}` : undefined;
  }

  /** Turns remote access off and forgets the Tailscale login. */
  async signOut(): Promise<void> {
    this.devices.setEnabled(false);
    await this.tunnel?.signOut();
  }

  /** Ends the helper and saves the last-seen times. The switch stays as it was. */
  async stop(): Promise<void> {
    try {
      await this.tunnel?.stop();
    } finally {
      this.devices.flush();
    }
  }

  secret(): string | undefined {
    const phase = this.tunnel?.phase() ?? 'off';
    return phase === 'off' || phase === 'problem' ? undefined : this.tunnel?.secret;
  }

  host(): string | undefined {
    return this.tunnel?.phase() === 'on' ? this.tunnel.host() : undefined;
  }
}
