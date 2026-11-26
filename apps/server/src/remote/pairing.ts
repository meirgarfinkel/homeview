import { randomBytes } from 'node:crypto';
import { LoginRateLimiter } from '../security/session.js';

const PAIR_WINDOW_MS = 15 * 60_000;

/** Single-use codes that let a new device pair. Kept in memory only. */
export class PairingCodes {
  private readonly codes = new Map<string, number>();

  constructor(private readonly ttlMs = 10 * 60_000) {}

  create(now = Date.now()): { code: string; expiresAt: Date } {
    this.prune(now);
    const code = randomBytes(16).toString('base64url');
    const expires = now + this.ttlMs;
    this.codes.set(code, expires);
    return { code, expiresAt: new Date(expires) };
  }

  /** True the first time a valid code is used, false after that. */
  consume(code: string, now = Date.now()): boolean {
    const expires = this.codes.get(code);
    if (expires === undefined) return false;
    this.codes.delete(code);
    return now <= expires;
  }

  private prune(now: number): void {
    for (const [code, expires] of this.codes) {
      if (now > expires) this.codes.delete(code);
    }
  }
}

/**
 * How often anyone may try to pair: 10 tries per address and 30 in all, per
 * 15 minutes. It lives with RemoteAccess, so a reload doesn't reset it.
 */
export class PairAttempts {
  private readonly perAddress = new LoginRateLimiter(10, PAIR_WINDOW_MS);
  private readonly overall = new LoginRateLimiter(30, PAIR_WINDOW_MS);

  /** Counts one try from this address. False once either limit is used up. */
  hit(ip: string, now = Date.now()): boolean {
    return this.perAddress.hit(ip, now) && this.overall.hit('all', now);
  }
}
